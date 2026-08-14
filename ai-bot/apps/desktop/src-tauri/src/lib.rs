//! AI-BOT — a camada NATIVA.
//!
//! # Quem faz o quê
//!
//! ```text
//! React -> interface (uma tela só, dinâmica por especialista)
//! Rust  -> integração NATIVA: o que não pode sair da máquina
//! Go    -> cérebro/orquestrador (services/gateway, binário "aibotd")
//! ```
//!
//! O gateway Go é a FONTE DA VERDADE do protocolo. Este lado não reimplementa
//! nada dele: sobe o processo, faz a janela e serve as ferramentas de MÁQUINA
//! que o Go não pode executar. Sempre que houver dúvida sobre um campo do
//! envelope, a resposta está em `services/gateway/internal/protocol` — repetir
//! a validação aqui criaria uma segunda verdade que diverge em silêncio.
//!
//! # O contrato com os módulos vizinhos
//!
//! Este arquivo é o ponto onde os módulos se encontram, então ele é também
//! onde o contrato entre eles fica escrito. Cada módulo precisa expor
//! exatamente isto:
//!
//! - `gateway`    — `start(&AppHandle) -> Result<GatewayHandle, String>`, que
//!   sobe o `aibotd` OU adota um que já esteja escutando; o alias
//!   `GatewayHandle = Arc<GatewayState>`, que é o estado gerenciado; os
//!   acessores `GatewayState::stream_url()` e `GatewayState::token()`, que é o
//!   par que a ponte recebe; o método `GatewayState::stop(&self)`, síncrono e
//!   sem `Result` porque roda no fechamento da janela; e os comandos
//!   `gateway_status`, `gateway_token` e `gateway_info` — este último devolve
//!   endereço e token JUNTOS porque os dois só valem em conjunto (ver o porquê
//!   em gateway.rs) e é o que a janela chama para abrir o próprio socket.
//! - `hostbridge` — `start(url, token) -> Result<BridgeHandle, String>`, que
//!   abre o WebSocket em `GatewayState::stream_url()`, autentica no primeiro
//!   frame `hello` com `GatewayState::token()` e traduz `tool.call` em
//!   `tool.result` chamando `tools`. Reconecta sozinha. Recebe ENDEREÇO e TOKEN
//!   já resolvidos, e não o `GatewayHandle`: depois de conectada ela não precisa
//!   de mais nada do gateway, e uma thread que não segura o handle não segura
//!   junto o `Child` que o encerramento precisa colher. O `BridgeHandle`
//!   devolvido é estado gerenciado porque os comandos `hostbridge_follow` e
//!   `hostbridge_status` o recebem — o primeiro é o que faz a ponte acompanhar
//!   a conversa aberta na janela.
//! - `tools`      — as ferramentas de máquina. São chamadas pelo `hostbridge`,
//!   NUNCA pelo webview — por isso nenhuma aparece no `generate_handler!`
//!   abaixo. Toda ferramenta de risco passa pela aprovação do gateway antes de
//!   chegar aqui; expor uma delas como comando Tauri seria dar ao JS um atalho
//!   que contorna esse portão.
//!
//!   O módulo é código PURO (não conhece Tauri) e, por isso, expõe um GANCHO
//!   que só o `setup` abaixo sabe preencher: `set_project_root(Option<PathBuf>)`
//!   — a pasta a que todo caminho de arquivo fica confinado. ENQUANTO ELE NÃO É
//!   CHAMADO, TODA FERRAMENTA DE MÁQUINA FALHA com "esta sessão não tem pasta de
//!   projeto aberta" — um erro que parece de política e é de fiação.
//!
//!   Houve um segundo gancho (`set_terminal_opener`) enquanto `term.open`
//!   existia. Ele saiu junto com a ferramenta: ver o porquê em `tools.rs`.
//! - `jail`       — Job Object do Windows (isolamento de árvore de processo).
//!   Serve o `tools`; sem comando próprio.
//! - `pdf`        — extrator de texto de PDF, escrito na casa por não haver
//!   crate homologada. Serve o `tools`; sem comando próprio.
//! - `pty`        — `PtyState: Default` e os seis comandos `pty_*`. Hoje eles só
//!   são alcançáveis pela JANELA (tecla de humano); enquanto não existir painel
//!   de terminal na interface, ninguém os chama — nem o agente, que perdeu o
//!   `term.open` justamente por isso.
//! - `vault`      — os três comandos `credential_*`.
//! - `windows`    — o comando `open_avatar_lab`.
//!
//! # As três superfícies de execução, e por que continuam separadas
//!
//! 1. `proc.run` — comando único, com timeout, PASSANDO pela aprovação do
//!    gateway. É o caminho do agente.
//! 2. Sandbox com Job Object — a árvore inteira morre junto (`jail`).
//! 3. `pty_*` — terminal interativo, TECLA DE HUMANO.
//!
//! Fundir qualquer par delas desfaz o modelo de aprovação. O caso mais caro é
//! o terceiro: um shell interativo é execução sem portão, o que é correto
//! quando quem digita é a pessoa e é a porta lateral perfeita quando quem
//! digita é o modelo — bastaria escrever `rm -rf .\n` num PTY já aberto.
//! Nenhum comando `pty_*` pode entrar no registro de ferramentas do agente.
//!
//! # Sobre a CSP, que mora no tauri.conf.json e não pode ser comentada lá
//!
//! JSON não tem comentário e o Tauri recusa chave desconhecida na
//! configuração, então o raciocínio da CSP fica aqui:
//!
//! - `style-src 'self' 'unsafe-inline'` — o React aplica `style={{…}}` como
//!   atributo inline, e é assim que as superfícies mudam de layout por
//!   especialista. Sem `'unsafe-inline'` o app abre sem estilo nenhum.
//!   Armadilha conhecida: se algum dia entrar um `<style>` INLINE no HTML, o
//!   Tauri injeta nonce em `style-src`, e nonce ANULA `'unsafe-inline'` — o
//!   sintoma é a tela perder o estilo sem nenhum erro de console.
//! - `script-src 'self'` — SEM `'unsafe-inline'`, de propósito. Esta é a
//!   diretiva que realmente vale contra injeção; as outras são defesa em
//!   profundidade. Script inline legítimo continua funcionando porque o
//!   `tauri-build` calcula o `sha256-` dele em tempo de compilação (ver
//!   build.rs), o que só acontece porque `security.csp` é não-nulo.
//! - `connect-src` lista `http://127.0.0.1:8799` e `ws://127.0.0.1:8799`
//!   (o gateway) mais `ipc:` e `http://ipc.localhost`, que é como o IPC do
//!   Tauri 2 aparece para o WebView2 no Windows. Sem os dois últimos, todo
//!   `invoke()` é bloqueado pela própria CSP.
//! - Em DESENVOLVIMENTO nada disso é aplicado: o header de CSP só é emitido
//!   pelo protocolo de asset do Tauri, e com `devUrl` apontando para o Vite a
//!   página vem de um servidor externo. Não adianta tentar validar a CSP em
//!   dev — não há o que validar. O teste válido é o build empacotado.
//! - A CSP NÃO limita `invoke()`. Qualquer script que execute alcança todos os
//!   comandos da lista abaixo. Por isso a lista é curta e por isso as
//!   ferramentas de máquina não estão nela.

/// Régua de desempenho compartilhada pelos benchmarks `#[ignore]` dos módulos
/// quentes (`pty`, `pdf`, `tools`, `hostbridge`). Só existe em teste: nada dela
/// entra no binário que a pessoa instala.
#[cfg(test)]
mod bench;
mod gateway;
mod hostbridge;
mod jail;
mod pdf;
mod pty;
mod tools;
mod vault;
mod windows;

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager, WindowEvent};
use tokio::time::timeout;

/// Quanto o encerramento espera o gateway sair por conta própria.
///
/// Finito porque o botão de fechar não pode ficar refém de um processo travado:
/// depois deste prazo o `app.exit(0)` acontece de qualquer jeito. Curto porque
/// três segundos é o limite do que uma pessoa aceita entre clicar no X e a
/// janela sumir.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Rótulo da janela principal — o mesmo do `tauri.conf.json`.
///
/// Mora numa constante porque é a chave de uma DECISÃO (ver `closing_ends_app`):
/// escrito à mão dentro do `if`, um erro de digitação viraria "nenhuma janela
/// encerra o app" sem erro de compilação e sem nada na tela.
const MAIN_WINDOW_LABEL: &str = "main";

/// Fechar esta janela encerra o aplicativo inteiro?
///
/// Só a `main`. O laboratório de avatares (`avatars`) é uma janela auxiliar: a
/// pessoa abre, mexe no retrato e fecha. Derrubar o app junto transformaria
/// "terminei de mexer no avatar" em "perdi a conversa" — e o laboratório é
/// justamente a janela que mais se abre e fecha numa sessão.
fn closing_ends_app(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

/// Encerra o aplicativo derrubando junto o que ele criou.
///
/// A ordem importa e nenhuma das três etapas é opcional:
///
/// 1. A ponte de ferramentas reconecta SOZINHA. Avisá-la primeiro é o que
///    impede que ela passe o encerramento inteiro reabrindo um socket contra um
///    gateway que já está morrendo — e, pior, aceitando um `tool.call` novo
///    enquanto o app fecha.
/// 2. O gateway Go, quando é filho deste processo, segura a porta 8799 e sobe
///    servidores MCP como filhos dele. Deixá-lo vivo faz a próxima abertura do
///    AI-BOT encontrar a porta ocupada, e o usuário vê um app permanentemente
///    "offline" sem nada na tela explicando por quê. Quando o gateway foi
///    ADOTADO (já estava de pé antes do app), `stop()` não encosta nele — matar
///    processo que outra pessoa subiu é efeito colateral que ninguém pediu.
/// 3. Os terminais do PTY são processos separados. No Windows, matar o pai não
///    mata o filho: fechar o app sem esta varredura deixa um `powershell.exe`
///    por aba aberta vivo no gerenciador de tarefas.
///
/// # Por que os três estados chegam por `try_state`, e não por argumento
///
/// Esta função é chamada de DOIS lugares — o comando abaixo e o fechamento da
/// janela — e o segundo não tem extrator de estado nenhum: `on_window_event`
/// entrega janela e evento, mais nada. Além disso `state()` entra em PÂNICO
/// quando o estado não existe, e este é exatamente o momento em que ele pode não
/// existir (encerramento pela metade, ou boot que registrou uns e não outros).
/// Cada etapa é independente: a ausência de uma não pode cancelar as outras.
async fn shutdown(app: &AppHandle) {
    // Não bloqueia: o laço da ponte só percebe o pedido na próxima batida, e
    // esperar por ela seria esperar até meio segundo por nada — o processo sai
    // logo abaixo e leva a thread junto.
    if let Some(bridge) = app.try_state::<hostbridge::BridgeHandle>() {
        bridge.stop();
    }

    // Erro aqui é ignorado de propósito: já estamos saindo, e transformar
    // "um terminal não quis morrer" em falha do botão de fechar troca um
    // problema pequeno por um app que não fecha.
    if let Some(terminals) = app.try_state::<pty::PtyState>() {
        let _ = pty::pty_kill_all(terminals);
    }

    // O `Arc` é clonado ANTES do `await`: `State` é um empréstimo do estado
    // gerenciado, e segurá-lo atravessando um ponto de suspensão prenderia o
    // mapa inteiro pelo tempo do encerramento.
    let gateway = app
        .try_state::<gateway::GatewayHandle>()
        .map(|state| state.inner().clone());
    if let Some(handle) = gateway {
        // `stop()` é SÍNCRONO e bloqueia (ele varre a árvore com `taskkill /T` e
        // depois colhe o filho), então vai para a pool de bloqueio em vez de
        // prender uma worker do tokio.
        let _ = timeout(SHUTDOWN_GRACE, tokio::task::spawn_blocking(move || handle.stop())).await;
    }

    app.exit(0);
}

/// O mesmo encerramento, exposto à janela.
///
/// Continua existindo para o caminho "sair" da interface (um atalho, um item de
/// menu), mas ele NÃO é o caminho principal: quem fecha o app é o X da barra de
/// título, e esse passa pelo `on_window_event` lá embaixo. Depender só deste
/// comando seria depender de um webview que pode estar travado justamente na
/// hora em que o encerramento importa.
#[tauri::command]
async fn app_shutdown(app: AppHandle) -> Result<(), String> {
    shutdown(&app).await;
    Ok(())
}

/// Troca a pasta de projeto da sessão.
///
/// O `setup` já deixa um padrão (a pasta de onde o app foi aberto); este comando
/// é como a pessoa escolhe outra depois, pela tela. Ele NÃO é uma ferramenta de
/// máquina e não executa nada: só move a raiz a que `tools::resolve_inside`
/// confina todo caminho de arquivo.
///
/// Por que a validação acontece aqui e também lá dentro: esta camada existe para
/// a MENSAGEM — "a pasta não existe" e "isso é um arquivo, não uma pasta" são
/// coisas diferentes para quem está na tela, e o erro de `canonicalize` do
/// sistema não distingue as duas em português. A checagem de `tools` continua
/// sendo a que vale, porque ela também canonicaliza (é o caminho canônico que o
/// confinamento compara depois).
#[tauri::command]
fn set_project_root(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("informe a pasta do projeto".into());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.exists() {
        return Err(format!("a pasta {trimmed:?} não existe nesta máquina"));
    }
    if !candidate.is_dir() {
        return Err(format!("{trimmed:?} não é uma pasta"));
    }
    tools::set_project_root(Some(candidate))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let outcome = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // O PtyState nasce vazio e não depende de nada, então pode ser
        // registrado já. O do gateway não pode: ele só existe DEPOIS de subir
        // (ou adotar) o processo, e por isso é registrado no setup.
        .manage(pty::PtyState::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // Falha aqui ABORTA o boot, e isso é deliberado. `start` já tenta o
            // caminho gentil: se alguém já está escutando em 8799 — um
            // `aibotd serve` num terminal, uma janela anterior que não morreu —
            // ele ADOTA esse processo em vez de subir um segundo e colidir. Ou
            // seja, chegar num `Err` aqui significa que não há gateway e não foi
            // possível criar um; sem ele não há `GatewayHandle` para gerenciar,
            // e uma janela cujo `gateway_status` entra em pânico ao ser chamado
            // é pior do que uma janela que não abre com o motivo escrito.
            let gateway = gateway::start(&handle)?;

            // Registrado ANTES de conectar a ponte: a ponte emite evento para a
            // janela, a janela reage chamando `gateway_status`, e um estado
            // ainda não gerenciado nesse instante é pânico em tempo de execução.
            app.manage(gateway.clone());

            // A ponte tem reconexão própria — ela não exige que o gateway já
            // esteja respondendo `/health` neste momento. Recebe endereço e
            // token JÁ resolvidos: é tudo de que ela precisa, e passar o handle
            // inteiro faria a thread da ponte segurar o `Child` do gateway que
            // o encerramento tem de colher.
            let bridge = hostbridge::start(gateway.stream_url(), gateway.token())?;

            // Gerenciado porque `hostbridge_follow` e `hostbridge_status` o
            // recebem como estado. Sem isto, a primeira troca de conversa na
            // janela seria pânico em tempo de execução, e não erro de comando.
            app.manage(bridge);

            // --- o gancho das ferramentas de máquina ---
            //
            // A pasta de onde o aplicativo foi aberto é um PADRÃO, não a escolha
            // final: quem abre o AI-BOT de dentro de um projeto quer trabalhar
            // nele, e sem nenhuma raiz TODA ferramenta que toca arquivo ou roda
            // comando responde "esta sessão não tem pasta de projeto aberta" —
            // um erro que parece política e é fiação. A interface troca depois
            // pelo comando `set_project_root` abaixo.
            //
            // Falhar aqui NÃO aborta o boot: sem raiz o app ainda serve para
            // conversar, e a pessoa ainda pode escolher a pasta na tela. Abortar
            // trocaria "algumas ferramentas indisponíveis" por "o app não abre".
            if let Err(error) = tools::set_project_root(std::env::current_dir().ok()) {
                eprintln!(
                    "[aibot] a pasta de onde o app foi aberto não serve como raiz de projeto: {error}"
                );
            }

            // O segundo gancho — o abridor de terminal — vivia aqui e saiu com o
            // `term.open`. Ele volta junto com a ferramenta, no dia em que a
            // interface tiver painel de terminal: ver o bloco correspondente em
            // `tools.rs`.

            Ok(())
        })
        // ------------------------- FECHAR A JANELA -------------------------
        //
        // Este é o ÚNICO encerramento que acontece na prática: ninguém procura
        // um item de menu "sair", a pessoa clica no X da barra de título. Sem
        // este gancho, o `app_shutdown` acima só rodaria se a interface o
        // chamasse — e a interface pode estar travada exatamente quando o
        // encerramento importa.
        //
        // O que sobrevive quando este caminho não existe não parece um defeito:
        // o `aibotd` continua segurando a porta 8799, os servidores MCP filhos
        // dele continuam de pé e cada sessão de PTY deixa um `powershell.exe`
        // vivo. Na abertura seguinte o app ADOTA o gateway órfão, tudo funciona,
        // e o único sintoma é o gerenciador de tarefas enchendo em silêncio.
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if !closing_ends_app(window.label()) {
                return;
            }
            // O encerramento é ASSÍNCRONO (o gateway pode levar até
            // SHUTDOWN_GRACE para sair) e este gancho roda na thread da
            // interface. Deixar o fechamento seguir agora mataria a janela — e
            // com ela o `AppHandle` — no meio da varredura; segurar a thread
            // aqui congelaria a tela com o app inteiro parado. Por isso:
            // impede o fechamento, faz a limpeza fora, e quem realmente fecha é
            // o `app.exit(0)` no fim de `shutdown`.
            api.prevent_close();
            let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move { shutdown(&app).await });
        })
        .invoke_handler(tauri::generate_handler![
            // --- o processo Go ---
            gateway::gateway_status,
            gateway::gateway_token,
            // Endereço e token de uma vez: é assim que a janela abre o próprio
            // socket sem correr o risco de casar um com o outro fora de tempo.
            gateway::gateway_info,
            // --- a ponte de ferramentas ---
            // Não abrem ferramenta nenhuma ao JS: `follow` apenas troca o tópico
            // do barramento que a ponte acompanha (sem isso, ferramenta de
            // máquina nenhuma chega até ela) e `status` é diagnóstico de tela.
            hostbridge::hostbridge_follow,
            hostbridge::hostbridge_status,
            // --- cofre do SO: o JS manda identificador, nunca segredo ---
            vault::credential_store,
            vault::credential_exists,
            vault::credential_delete,
            // --- janelas ---
            windows::open_avatar_lab,
            // --- ciclo de vida ---
            app_shutdown,
            // Move a raiz a que as ferramentas ficam confinadas. Não executa
            // nada e não abre arquivo nenhum — por isso pode estar aqui sem
            // contrariar a regra de que ferramenta de máquina não vira comando.
            set_project_root,
            // --- terminal interativo: TECLA DE HUMANO ---
            // Estes seis existem para a pessoa digitar. Nenhum deles pode
            // entrar no registro de ferramentas do agente; ver o cabeçalho
            // deste arquivo e o de src/pty.rs.
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_list
        ])
        .run(tauri::generate_context!());

    // `expect` aqui despejaria um panic do Rust na cara de quem só queria abrir
    // o programa — texto que não ajuda o usuário nem o suporte. Falha de boot
    // do Tauri é quase sempre WebView2 ausente ou configuração inválida, e as
    // duas merecem uma frase legível.
    if let Err(error) = outcome {
        eprintln!("[aibot] o aplicativo não pôde iniciar: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A regra do fechamento: a `main` derruba o app, o resto não.
    ///
    /// Sem a distinção, fechar o laboratório de avatares mataria a conversa
    /// aberta; sem o gancho nenhum, o X da janela principal deixaria o gateway,
    /// os MCP e os shells vivos. O teste trava as duas pontas.
    #[test]
    fn so_a_janela_principal_encerra_o_aplicativo() {
        assert!(closing_ends_app(MAIN_WINDOW_LABEL));
        assert!(
            !closing_ends_app(windows::AVATAR_LAB_LABEL),
            "fechar o laboratório de avatares NÃO pode derrubar o app"
        );
        assert!(!closing_ends_app("qualquer-outra"));
    }

    /// O rótulo é um acoplamento com o `tauri.conf.json`, e acoplamento por
    /// string quebra em silêncio: renomear a janela lá deixaria `closing_ends_app`
    /// respondendo `false` para todo mundo — nenhum erro de compilação, nenhum
    /// aviso, e o encerramento simplesmente pararia de acontecer.
    #[test]
    fn os_rotulos_de_janela_batem_com_o_tauri_conf() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json precisa ser JSON válido");
        let labels: Vec<&str> = config["app"]["windows"]
            .as_array()
            .expect("app.windows precisa ser uma lista")
            .iter()
            .filter_map(|window| window["label"].as_str())
            .collect();
        assert!(
            labels.contains(&MAIN_WINDOW_LABEL),
            "nenhuma janela do tauri.conf.json se chama {MAIN_WINDOW_LABEL:?}: {labels:?}"
        );
        assert!(
            labels.contains(&windows::AVATAR_LAB_LABEL),
            "nenhuma janela do tauri.conf.json se chama {:?}: {labels:?}",
            windows::AVATAR_LAB_LABEL
        );
    }

    /// O gancho de fechamento é fiação: `closing_ends_app` pode estar correto e
    /// mesmo assim nunca ser consultado, que era exatamente o defeito anterior
    /// (`app_shutdown` existia, ninguém o chamava). Não há como instanciar o
    /// `Builder` num teste sem subir uma janela de verdade, então o que dá para
    /// travar é a presença da fiação no fonte.
    #[test]
    fn o_fechamento_da_janela_esta_ligado_ao_encerramento() {
        // Só o código de PRODUÇÃO: as agulhas abaixo aparecem literalmente
        // dentro deste teste, e procurá-las no arquivo inteiro faria o teste
        // encontrar a si mesmo e passar mesmo com a fiação removida. O corte é
        // no início deste módulo — tudo o que vem antes é produção.
        let fonte = include_str!("lib.rs");
        let producao = fonte.split("mod tests {").next().unwrap_or_default();
        assert!(
            producao.contains(".on_window_event("),
            "sem on_window_event, fechar a janela não encerra nada"
        );
        assert!(
            producao.contains("WindowEvent::CloseRequested"),
            "o encerramento tem de reagir ao CloseRequested"
        );
        assert!(
            producao.contains("shutdown(&app)"),
            "o gancho tem de chamar o MESMO corpo de encerramento do comando"
        );
    }
}
