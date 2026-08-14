//! Supervisão do gateway Go — o processo `aibotd`.
//!
//! A divisão do AI-BOT põe o cérebro no Go: ele é a FONTE DA VERDADE do
//! protocolo, do histórico e da política. O Rust não reimplementa nada disso —
//! ele sobe o processo, faz a janela e serve as ferramentas de máquina. Este
//! arquivo é a primeira metade: achar o binário, subir com o ambiente certo,
//! esperar a porta responder e guardar o token.
//!
//! ## Por que o Rust sobe o Go, e não o contrário
//!
//! Quem tem janela é o Tauri. Se o gateway fosse um serviço do Windows, ele
//! ficaria de pé depois que a pessoa fechasse o app — um processo com a
//! conversa inteira, as chaves dos provedores e o direito de executar comando,
//! rodando sem ninguém olhando. Como sidecar, o ciclo de vida dele é o da
//! janela: abriu, subiu; fechou, morre.
//!
//! ## Por que esperar o `/health` em vez de sair conectando
//!
//! O gateway abre banco, carrega catálogo e materializa segredo antes de
//! escutar. Conectar o WebSocket "logo depois do spawn" dá recusa de conexão
//! numa máquina fria e sucesso numa máquina quente — o defeito que só aparece
//! no notebook do usuário. `/health` é o único ponto que diz "estou de pé", e
//! ele não pede token justamente para poder ser usado assim.
//!
//! ## HTTP na mão, aqui
//!
//! O cliente HTTP deste arquivo (`loopback_get`) fala com 127.0.0.1 e mais
//! nada. Trazer uma pilha HTTP completa para perguntar "você está vivo?" seria
//! dependência nova (política item 4) no processo que executa comando. São
//! trinta linhas de `TcpStream`, e elas também servem ao `runtime.status` das
//! ferramentas — ver `tools.rs`.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Endereço do gateway. LOOPBACK, e o padrão do lado Go (`config.DefaultBind`)
/// é o mesmo — as duas pontas precisam concordar sem ninguém configurar nada.
pub const BIND: &str = "127.0.0.1:8799";

/// Nome da pasta de dados dentro do diretório de configuração do app.
const DATA_DIR_NAME: &str = "AI-BOT";

/// Arquivo onde o gateway materializa o token no primeiro boot.
const TOKEN_FILE: &str = "token";

/// Cadência das tentativas de `/health`.
const HEALTH_INTERVAL: Duration = Duration::from_millis(150);

/// Orçamento total da espera pelo `/health`. Quinze segundos cobrem o primeiro
/// boot numa estação com antivírus mordendo o binário; acima disso é falha, e
/// dizer isso é melhor que deixar a janela em branco para sempre.
const HEALTH_BUDGET: Duration = Duration::from_secs(15);

/// Prazo de UMA tentativa de `/health`. Curto: em loopback, conexão recusada é
/// instantânea, e o que não pode acontecer é uma tentativa lenta comer o
/// orçamento inteiro.
const HEALTH_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(1_000);

/// Prazo da sondagem que descobre um gateway JÁ de pé (ver `start`).
const ADOPT_TIMEOUT: Duration = Duration::from_millis(400);

/// Teto do corpo lido pelo cliente HTTP. Nenhuma resposta legítima do gateway
/// chega perto disto; o teto existe para um servidor que responde para sempre
/// não encher a memória do app.
const MAX_HTTP_BODY: usize = 1 << 20;

/// `CREATE_NO_WINDOW`. Sem isto, um console preto pisca na tela A CADA abertura
/// do app — o gateway é um binário de console, e o Windows dá console a ele.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Estado do gateway supervisionado.
pub struct GatewayState {
    /// `None` quando o gateway não é nosso filho — ver a adoção em `start`.
    child: Mutex<Option<Child>>,
    /// Base HTTP, na forma `http://127.0.0.1:8799`.
    base: String,
    /// Token lido de `<data_dir>/token`.
    token: Mutex<String>,
}

/// O que o `lib.rs` guarda como estado do Tauri e o que a ponte de ferramentas
/// recebe. É `Arc` porque o mesmo gateway é observado pela janela, pela ponte e
/// pelo encerramento do app — três donos, nenhum deles o principal.
pub type GatewayHandle = Arc<GatewayState>;

/// Endereço do fluxo e token, entregues JUNTOS.
///
/// Existe um comando só para o par por um motivo de coerência, não de
/// conveniência: `url` e `token` valem em conjunto. Se a janela pedisse os dois
/// em duas chamadas, bastaria o gateway reiniciar entre elas para a tela abrir o
/// socket do endereço antigo com o token novo (ou o contrário) e levar um 1008
/// "não autorizado" que ninguém consegue explicar olhando a tela. Uma chamada só
/// tira essa janela de tempo do caminho.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    /// `ws://127.0.0.1:8799/v1/stream` — o mesmo endereço que a ponte usa.
    pub url: String,
    pub token: String,
}

/// Resumo para a tela. Não carrega o token: quem precisa dele pede em
/// `gateway_token`, e o resumo costuma acabar em log de diagnóstico.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    /// O `/health` respondeu 200 agora?
    pub healthy: bool,
    pub base: String,
    /// PID quando o processo é nosso filho.
    pub pid: Option<u32>,
    /// `false` quando adotamos um gateway que já estava de pé — e aí fechar o
    /// app NÃO o derruba. A tela precisa saber para não prometer o contrário.
    pub supervised: bool,
    /// Frase legível do estado (ou do motivo da falha).
    pub detail: String,
}

impl GatewayState {
    /// `host:porta`, que é o que o cliente HTTP e o WebSocket precisam.
    pub fn authority(&self) -> &str {
        self.base
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/')
    }

    /// URL do fluxo de eventos, para a ponte de ferramentas (`hostbridge.rs`).
    pub fn stream_url(&self) -> String {
        format!("ws://{}/v1/stream", self.authority())
    }

    /// Token do gateway. Cópia: o chamador não segura a trava.
    pub fn token(&self) -> String {
        lock_or_recover(&self.token).clone()
    }

    /// Encerra o gateway.
    ///
    /// ATENÇÃO — O AI-BOT PRECISA MATAR A ÁRVORE, NÃO SÓ O PAI. `Child::kill`
    /// encerra apenas o `aibotd.exe`. O gateway sobe servidores MCP como
    /// processos FILHOS (`internal/mcphub`), e no Windows matar o pai NÃO leva
    /// os filhos junto: eles ficam órfãos, vivos, com os direitos do usuário e
    /// sem ninguém para pedir que saiam. Fecha-se a janela e sobram processos.
    ///
    /// A correção definitiva é a mesma da sandbox: o gateway nasce
    /// `CREATE_SUSPENDED`, é atribuído a um Job Object com
    /// `KILL_ON_JOB_CLOSE` e só então é retomado — aí fechar o handle do job
    /// derruba a árvore inteira de uma vez (ver `jail.rs`). Enquanto isso não
    /// entra, o `taskkill /T` abaixo é o paliativo HONESTO: ele varre a árvore
    /// pelo PID do pai, e é melhor do que fingir que `kill()` bastou.
    ///
    /// Não devolve `Result` de propósito: isto roda no caminho de fechamento da
    /// janela, onde não há mais ninguém para ler um erro — o que importa é
    /// tentar todos os caminhos e não travar a saída.
    pub fn stop(&self) {
        let mut slot = lock_or_recover(&self.child);
        let Some(mut child) = slot.take() else {
            // Gateway adotado (não é nosso filho) ou já encerrado: derrubar um
            // processo que outra pessoa subiu seria efeito colateral que
            // ninguém pediu.
            return;
        };
        // Árvore primeiro, pai depois. A ordem importa: matando o pai antes, os
        // filhos perdem o vínculo e o `/T` já não os encontra.
        #[cfg(windows)]
        {
            let pid = child.id();
            let mut sweep = Command::new("taskkill.exe");
            sweep
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);
            let _ = sweep.status();
        }

        let _ = child.kill();
        // `wait` colhe o processo. Sem isso ele vira zumbi até o app morrer —
        // e o app pode demorar a morrer.
        let _ = child.wait();
    }

    /// Estado atual, com uma sondagem de `/health` na hora.
    pub fn status(&self) -> GatewayStatus {
        let pid = lock_or_recover(&self.child).as_ref().map(|child| child.id());
        let probe = loopback_get(self.authority(), "/health", ADOPT_TIMEOUT);
        let (healthy, detail) = match probe {
            Ok(reply) if reply.status == 200 => (true, reply.body.trim().to_string()),
            Ok(reply) => (
                false,
                format!("o gateway respondeu {} em /health", reply.status),
            ),
            Err(error) => (false, error),
        };
        GatewayStatus {
            healthy,
            base: self.base.clone(),
            pid,
            supervised: pid.is_some(),
            detail,
        }
    }
}

/// Sobe (ou adota) o gateway e devolve o handle já com token.
///
/// A ADOÇÃO não é conveniência de desenvolvedor: se alguém já está escutando em
/// 8799 — um `aibotd serve` num terminal, uma janela anterior que não morreu —
/// subir um segundo processo dá "endereço já em uso" e ele sai na hora. Aí o
/// app mostraria "o gateway não subiu" com um gateway perfeitamente de pé na
/// máquina. Perguntar antes custa uma requisição.
pub fn start(app: &AppHandle) -> Result<GatewayHandle, String> {
    let base = format!("http://{BIND}");
    let data_dir = data_dir(app)?;

    // 1. Já tem alguém de pé? Então o processo não é nosso, e o `stop` não o
    //    derruba.
    if let Ok(reply) = loopback_get(BIND, "/health", ADOPT_TIMEOUT) {
        if reply.status == 200 {
            let token = read_token(&data_dir)?;
            return Ok(Arc::new(GatewayState {
                child: Mutex::new(None),
                base,
                token: Mutex::new(token),
            }));
        }
    }

    // 2. Achar o binário.
    let binary = find_binary()?;

    // 3. Subir.
    let mut child = spawn(&binary, &data_dir)?;

    // 4. Esperar a porta. Falhou: o filho não pode ficar para trás — um gateway
    //    meio subido segura a porta 8799 e impede a próxima tentativa.
    if let Err(error) = wait_for_health(BIND, &mut child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    // 5. Token. Só agora: o arquivo é escrito pelo gateway no boot, e ler antes
    //    do `/health` pegaria a estação onde ele ainda não existe.
    let token = read_token(&data_dir)?;

    Ok(Arc::new(GatewayState {
        child: Mutex::new(Some(child)),
        base,
        token: Mutex::new(token),
    }))
}

/* ------------------------------ localização ------------------------------ */

/// Nome do executável por plataforma.
fn binary_name() -> &'static str {
    if cfg!(windows) {
        "aibotd.exe"
    } else {
        "aibotd"
    }
}

/// Procura o gateway em dois lugares, nesta ordem:
///
/// 1. **ao lado do executável do app** — é onde o empacotamento deixa o
///    sidecar, e é o único caminho que garante que o gateway é o da MESMA
///    versão do app;
/// 2. **no PATH** — o caso de quem compila o Go à mão, em desenvolvimento.
///
/// O erro cita OS DOIS lugares, com o caminho de verdade. "aibotd não
/// encontrado" manda a pessoa adivinhar onde o app procurou.
fn find_binary() -> Result<PathBuf, String> {
    let name = binary_name();

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));

    if let Some(dir) = exe_dir.as_ref() {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    let ao_lado = exe_dir
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| "(não foi possível descobrir a pasta do aplicativo)".to_string());
    Err(format!(
        "não encontrei o gateway `{name}`. Procurei ao lado do aplicativo, em {ao_lado}, \
e depois em cada pasta do PATH. Se você compilou o gateway à mão, ponha o binário \
em uma das duas."
    ))
}

/// Pasta de dados do gateway: `<app_config_dir>/AI-BOT`.
///
/// Em domínio com perfil roaming o `%APPDATA%` viaja pela rede junto com o
/// usuário — e aqui dentro moram token, chave mestra e o log das conversas.
/// Quem não quer isso trafegando aponta `AIBOT_DATA_DIR` para `%LOCALAPPDATA%`
/// na política da máquina; o padrão segue o do gateway para os dois lados
/// concordarem sem configuração.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("não foi possível descobrir a pasta de configuração: {error}"))?;
    let dir = base.join(DATA_DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("não foi possível criar {}: {error}", dir.display()))?;
    Ok(dir)
}

/* -------------------------------- processo -------------------------------- */

fn spawn(binary: &Path, data_dir: &Path) -> Result<Child, String> {
    let mut command = Command::new(binary);
    command
        // Subcomando explícito: o padrão do `aibotd` já é `serve`, mas depender
        // do padrão de outro binário é depender de uma decisão que não é nossa.
        .arg("serve")
        .env("AIBOT_BIND", BIND)
        .env("AIBOT_DATA_DIR", data_dir)
        // A pasta de trabalho do gateway é a de dados, e não a do app. O gateway
        // usa o diretório corrente como raiz de repositório quando
        // `AIBOT_REPO_ROOT` está ausente; herdando a nossa, ele passaria a
        // achar que a pasta de instalação do AI-BOT é um projeto do usuário.
        .current_dir(data_dir)
        .stdin(Stdio::null())
        // Saída descartada de propósito: cano sem leitor ENCHE e trava o
        // processo que escreve — e o gateway loga cada turno. Quem precisa do
        // log roda `aibotd serve` num terminal, onde ele vai para a tela.
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .spawn()
        .map_err(|error| format!("não foi possível subir {}: {error}", binary.display()))
}

/// Espera o `/health` responder 200, tentando a cada 150 ms por até 15 s.
///
/// A cada rodada também pergunta se o processo MORREU. Sem isso, um gateway que
/// sai em cem milissegundos (porta ocupada, chave mestra ilegível) faria o app
/// esperar os quinze segundos inteiros para então dizer "não respondeu" — em
/// vez de dizer que ele saiu com código 1, que é a informação útil.
fn wait_for_health(authority: &str, child: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_BUDGET;
    let mut last = String::from("nenhuma tentativa chegou a ser feita");

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "o gateway saiu antes de responder ({status}). Última tentativa: {last}"
                ))
            }
            Ok(None) => {}
            Err(error) => return Err(format!("não foi possível acompanhar o gateway: {error}")),
        }

        match loopback_get(authority, "/health", HEALTH_ATTEMPT_TIMEOUT) {
            Ok(reply) if reply.status == 200 => return Ok(()),
            Ok(reply) => {
                last = format!("HTTP {} — {}", reply.status, trim_for_message(&reply.body));
            }
            Err(error) => last = error,
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "o gateway não respondeu em {} em {} s. Última tentativa: {last}",
                authority,
                HEALTH_BUDGET.as_secs()
            ));
        }
        std::thread::sleep(HEALTH_INTERVAL);
    }
}

/// Lê o token do arquivo que o gateway materializa no boot.
fn read_token(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join(TOKEN_FILE);
    let raw = std::fs::read_to_string(&path).map_err(|error| {
        format!(
            "não foi possível ler o token em {}: {error}. \
Se o gateway estiver rodando com outra pasta de dados (AIBOT_DATA_DIR), \
o token dele sai em `aibotd token`.",
            path.display()
        )
    })?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Err(format!(
            "o arquivo de token {} está vazio — apague-o e reabra o aplicativo para o gateway gerar outro",
            path.display()
        ));
    }
    Ok(token)
}

/* ------------------------------ cliente HTTP ------------------------------ */

/// Resposta mínima: o que o app olha é o código e o corpo.
pub(crate) struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// GET em loopback.
///
/// Fala **HTTP/1.0** de propósito. Em HTTP/1.1 o servidor Go responde com
/// `Transfer-Encoding: chunked` sempre que não sabe o tamanho de antemão, e aí
/// este cliente precisaria de um decodificador de chunk só para ler
/// `/v1/models`. Em 1.0 não existe chunk: o servidor escreve o corpo e fecha, e
/// "ler até o fim" é a leitura correta. Trinta linhas contra uma dependência.
///
/// Não manda `Accept-Encoding`, então não há compressão para desfazer. E só
/// serve loopback: não segue redirecionamento, não faz TLS e não resolve nome
/// que não seja o endereço literal do gateway.
pub(crate) fn loopback_get(
    authority: &str,
    path: &str,
    timeout: Duration,
) -> Result<HttpReply, String> {
    let address = resolve_authority(authority)?;
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("não foi possível falar com {authority}: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|_| stream.set_write_timeout(Some(timeout)))
        .map_err(|error| format!("não foi possível ajustar os prazos do socket: {error}"))?;

    let request =
        format!("GET {path} HTTP/1.0\r\nHost: {authority}\r\nAccept: application/json\r\nUser-Agent: aibot-host\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("não foi possível enviar o pedido a {authority}: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("não foi possível enviar o pedido a {authority}: {error}"))?;

    let mut raw = Vec::new();
    // `take` é o teto: um servidor que responde para sempre não pode encher a
    // memória do aplicativo.
    (&mut stream)
        .take(MAX_HTTP_BODY as u64)
        .read_to_end(&mut raw)
        .map_err(|error| format!("não foi possível ler a resposta de {authority}: {error}"))?;

    parse_reply(&raw)
}

/// Separa o cabeçalho do corpo e lê o código de status.
fn parse_reply(raw: &[u8]) -> Result<HttpReply, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = match text.split_once("\r\n\r\n") {
        Some(parts) => parts,
        // Servidor que responde com LF puro existe; é fora da norma, mas
        // recusar por isso seria falhar por um detalhe que não é nosso.
        None => text
            .split_once("\n\n")
            .ok_or_else(|| "resposta HTTP sem fim de cabeçalho".to_string())?,
    };

    let status_line = head.lines().next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("resposta HTTP sem código de status: {status_line:?}"))?;

    Ok(HttpReply {
        status,
        body: body.to_string(),
    })
}

/// `127.0.0.1:8799` vira `SocketAddr` sem passar por DNS.
///
/// A ponte de ferramentas usa a mesma função (`hostbridge.rs`): duas formas de
/// resolver o mesmo endereço seriam duas formas de errar a porta.
pub(crate) fn resolve_authority(authority: &str) -> Result<SocketAddr, String> {
    if let Ok(address) = authority.parse::<SocketAddr>() {
        return Ok(address);
    }
    authority
        .to_socket_addrs()
        .map_err(|error| format!("endereço inválido {authority}: {error}"))?
        .next()
        .ok_or_else(|| format!("endereço {authority} não resolveu para nenhum destino"))
}

/* --------------------------------- apoio ---------------------------------- */

/// Trava que sobrevive a envenenamento.
///
/// Envenenar acontece quando uma thread entra em pânico segurando a trava. Aqui
/// o dado protegido é um `Child` e um `String` — nenhum dos dois fica
/// inconsistente por causa de um pânico alheio, e desistir de PARAR o gateway
/// por causa disso seria trocar um defeito por um processo órfão.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Corta a mensagem de erro para caber num aviso de tela.
fn trim_for_message(text: &str) -> String {
    const LIMIT: usize = 300;
    let clean = text.trim();
    if clean.len() <= LIMIT {
        return clean.to_string();
    }
    let mut cut = LIMIT;
    while cut > 0 && !clean.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &clean[..cut])
}

/* ------------------------------- comandos --------------------------------- */

#[tauri::command]
pub fn gateway_status(state: State<'_, GatewayHandle>) -> Result<GatewayStatus, String> {
    Ok(state.status())
}

/// Entrega o token do gateway à janela.
///
/// Isto NÃO contradiz a regra "segredo nunca cruza para o webview" — vale a
/// pena dizer por quê, porque a leitura apressada acende o alarme errado. A
/// regra protege segredo de TERCEIRO (chave de provedor, senha de conector),
/// que o JS nunca precisa ver: ele manda `secretRef` e a leitura acontece no
/// cofre do SO. Este token é outra coisa: é a credencial do socket LOCAL que a
/// própria janela precisa abrir, e o gateway autentica no primeiro frame do
/// WebSocket. Sem ele, a janela não fala com o próprio cérebro do app.
///
/// O que continua valendo: o token vai no frame de `hello`, NUNCA na URL — query
/// string entra em log de proxy, em histórico e em `Referer`.
#[tauri::command]
pub fn gateway_token(state: State<'_, GatewayHandle>) -> Result<String, String> {
    let token = state.token();
    if token.is_empty() {
        return Err("o gateway ainda não entregou um token nesta sessão".into());
    }
    Ok(token)
}

/// Endereço do fluxo e token, de uma vez — é o que a janela chama para abrir o
/// WebSocket (ver `apps/desktop/src/lib/store.ts`).
///
/// ## Por que UM comando devolve os DOIS
///
/// O par precisa ser COERENTE: o token só autentica o gateway que o gerou. Duas
/// chamadas separadas podem pegar o gateway no meio de um reinício e casar o
/// endereço de antes com o token de depois — a conexão é recusada com 1008 e a
/// tela fica "offline" sem nada que explique o motivo. Aqui os dois saem da
/// MESMA leitura de estado, então ou os dois são os velhos, ou os dois são os
/// novos.
///
/// Vale o mesmo raciocínio de `gateway_token` sobre o segredo cruzar para o
/// webview: este token é a credencial do socket LOCAL que a própria janela
/// precisa abrir, não segredo de terceiro.
///
/// O erro com token vazio é deliberado: devolver `{ url, token: "" }` faria a
/// janela tentar conectar e apanhar do gateway sem saber por quê — que é
/// exatamente o buraco que o fallback silencioso do lado do JS abriu.
#[tauri::command]
pub fn gateway_info(state: State<'_, GatewayHandle>) -> Result<GatewayInfo, String> {
    let token = state.token();
    if token.is_empty() {
        return Err("o gateway ainda não entregou um token nesta sessão".into());
    }
    Ok(GatewayInfo {
        url: state.stream_url(),
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autoridade_sai_da_base_sem_esquema() {
        let state = GatewayState {
            child: Mutex::new(None),
            base: "http://127.0.0.1:8799".into(),
            token: Mutex::new(String::new()),
        };
        assert_eq!(state.authority(), "127.0.0.1:8799");
        assert_eq!(state.stream_url(), "ws://127.0.0.1:8799/v1/stream");
    }

    /// A janela lê `info.url` e `info.token` (ver `src/lib/store.ts`) e, se não
    /// achar os dois, cai num fallback com token vazio que a deixa offline sem
    /// mensagem. Renomear campo aqui quebraria a tela em silêncio — o teste é o
    /// que faz esse rename aparecer na compilação dos testes.
    #[test]
    fn info_do_gateway_sai_com_os_nomes_que_a_janela_le() {
        let state = GatewayState {
            child: Mutex::new(None),
            base: "http://127.0.0.1:8799".into(),
            token: Mutex::new("segredo".into()),
        };
        let info = GatewayInfo {
            url: state.stream_url(),
            token: state.token(),
        };
        let json = serde_json::to_value(&info).expect("deveria serializar");
        assert_eq!(json["url"], "ws://127.0.0.1:8799/v1/stream");
        assert_eq!(json["token"], "segredo");
    }

    #[test]
    fn resposta_http_e_separada_em_status_e_corpo() {
        let raw = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}";
        let reply = parse_reply(raw).expect("deveria interpretar");
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, "{\"status\":\"ok\"}");
    }

    #[test]
    fn resposta_de_erro_preserva_o_codigo() {
        let raw = b"HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"nao autorizado\"}";
        let reply = parse_reply(raw).expect("deveria interpretar");
        assert_eq!(reply.status, 401);
        assert!(reply.body.contains("nao autorizado"));
    }

    #[test]
    fn resposta_sem_fim_de_cabecalho_e_recusada() {
        assert!(parse_reply(b"HTTP/1.0 200 OK\r\n").is_err());
    }

    #[test]
    fn endereco_literal_nao_passa_por_dns() {
        let address = resolve_authority("127.0.0.1:8799").expect("endereço literal");
        assert_eq!(address.port(), 8799);
        assert!(address.ip().is_loopback());
    }

    /// Cortar no meio de um caractere multibyte faria pânico no `&texto[..n]`.
    #[test]
    fn corte_de_mensagem_respeita_acento() {
        let longo = "á".repeat(400);
        let cortado = trim_for_message(&longo);
        assert!(cortado.ends_with('…'));
        assert!(cortado.len() <= 303);
    }
}
