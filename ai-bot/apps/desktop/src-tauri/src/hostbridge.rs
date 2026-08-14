//! A ponte que serve as ferramentas de máquina ao gateway.
//!
//! Um WebSocket, aberto pelo Rust contra o gateway, por onde chegam os
//! `tool.call` endereçados ao host e voltam os `tool.result`.
//!
//! ## POR QUE UM SOCKET, E NÃO UM SERVIDOR HTTP NO RUST
//!
//! A alternativa óbvia seria o Rust subir um servidor e o Go chamar as
//! ferramentas por HTTP. Ela custa caro e não compra nada:
//!
//! - **seria uma segunda porta escutando na estação** — outra superfície para
//!   proteger, com token, origem, CORS e prazo próprios, e um segundo lugar
//!   onde essa proteção pode divergir da primeira. A porta serviria para
//!   EXECUTAR COMANDO na máquina do usuário: é o alvo mais valioso do app;
//! - **o servidor já existe** — o gateway é o servidor. Este processo é o
//!   cliente dele para a conversa e para os eventos; ser cliente também para as
//!   ferramentas mantém UMA conexão, UM token, UM protocolo;
//! - **quem inicia a conexão atravessa firewall pessoal sem pedir nada**. Um
//!   servidor novo em loopback dispara a caixa de diálogo do Windows Defender
//!   na primeira execução, e o usuário aprende a clicar "permitir" em avisos do
//!   AI-BOT.
//!
//! Existe uma alternativa HTTP no gateway (`POST /v1/host/tool-result`, com
//! Bearer). Ela não é usada aqui de propósito: seria um segundo caminho de
//! entrega para manter em pé e testar, resolvendo um problema que o socket já
//! resolve.
//!
//! ## A ponte SEGUE A SESSÃO
//!
//! O barramento do gateway é POR SESSÃO: o `tool.call` é publicado no tópico da
//! sessão que está no meio do turno, e quem não estiver inscrito naquele tópico
//! simplesmente não vê a chamada (`internal/eventbus`). Por isso a ponte não
//! abre uma sessão qualquer e fica quieta: ela abre com `sessionHint`, aceita a
//! sessão que o gateway resolveu no `ready` e reconecta quando a janela avisa
//! que trocou de conversa (`hostbridge_follow`). Sem isso, a ferramenta de
//! máquina falharia com "o aplicativo não está conectado" — com o aplicativo
//! aberto na frente da pessoa.

use serde_json::{json, Value};
use std::net::TcpStream;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;
use tungstenite::{Message, WebSocket};

/// Quem está do outro lado. O gateway usa isto para separar app de CLI no log.
const CLIENT: &str = "aibot-host";

/// Versão do host, reportada no `hello` para diagnóstico.
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Primeiro atraso da reconexão.
const BACKOFF_BASE: Duration = Duration::from_millis(500);

/// Teto do atraso. Acima disso a ponte parece morta; e como o gateway é local,
/// a espera longa não protege ninguém de sobrecarga.
const BACKOFF_MAX: Duration = Duration::from_secs(15);

/// Prazo do TCP e da escrita.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Batida do laço de leitura.
///
/// A leitura tem prazo curto DE PROPÓSITO: é o que dá à thread a chance de
/// olhar o correio de saída (resultados que ferramentas terminaram em outras
/// threads), de perceber que a janela trocou de sessão e de sair quando o app
/// fecha. Sem prazo, a thread ficaria presa dentro do `read` até chegar um byte
/// — e o app não fecharia.
const READ_TICK: Duration = Duration::from_millis(500);

/// Gerador de id de envelope. O gateway não exige unicidade global, mas um id
/// repetido no log torna impossível seguir uma chamada.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Estado da ponte.
pub struct BridgeState {
    /// `ws://127.0.0.1:8799/v1/stream`.
    url: String,
    token: String,
    /// Sessão que queremos acompanhar (o `sessionHint` do próximo `hello`).
    desired_session: Mutex<Option<String>>,
    /// Sessão que o gateway resolveu para a conexão atual.
    connected_session: Mutex<Option<String>>,
    connected: AtomicBool,
    stopped: AtomicBool,
}

pub type BridgeHandle = Arc<BridgeState>;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub connected: bool,
    pub url: String,
    pub session: Option<String>,
}

impl BridgeState {
    /// Passa a acompanhar outra sessão. A reconexão acontece sozinha, no
    /// próximo giro do laço.
    pub fn follow(&self, session: &str) {
        let session = session.trim();
        if session.is_empty() {
            return;
        }
        let mut slot = lock_or_recover(&self.desired_session);
        if slot.as_deref() == Some(session) {
            return;
        }
        *slot = Some(session.to_string());
    }

    /// Pede o encerramento da thread. O laço percebe na próxima batida.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    pub fn status(&self) -> BridgeStatus {
        BridgeStatus {
            connected: self.connected.load(Ordering::SeqCst),
            url: self.url.clone(),
            session: lock_or_recover(&self.connected_session).clone(),
        }
    }
}

/// Sobe a ponte numa thread própria.
///
/// Thread dedicada, e não uma tarefa assíncrona: as ferramentas de máquina são
/// síncronas e bloqueantes por natureza (um `cargo build` segura a thread por
/// minutos). Numa pool assíncrona compartilhada, essa espera bloquearia
/// executores que a janela também usa.
pub fn start(url: String, token: String) -> Result<BridgeHandle, String> {
    if token.trim().is_empty() {
        return Err("a ponte de ferramentas precisa do token do gateway".into());
    }
    let state: BridgeHandle = Arc::new(BridgeState {
        url,
        token,
        desired_session: Mutex::new(None),
        connected_session: Mutex::new(None),
        connected: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
    });

    let worker = Arc::clone(&state);
    std::thread::Builder::new()
        .name("aibot-hostbridge".into())
        .spawn(move || run(worker))
        .map_err(|error| format!("não foi possível subir a ponte de ferramentas: {error}"))?;

    Ok(state)
}

/// Laço de vida da ponte: conecta, serve, cai, espera, repete.
fn run(state: BridgeHandle) {
    // O correio de saída nasce FORA do laço de conexão. Um resultado que ficou
    // pronto enquanto o socket estava caído continua na fila e sai na conexão
    // seguinte — o gateway guarda a chamada pendente pelo `callId`, então ela
    // ainda é entregável.
    let (sender, outbox) = mpsc::channel::<String>();
    let mut backoff = BACKOFF_BASE;

    while !state.stopped.load(Ordering::SeqCst) {
        match serve(&state, &sender, &outbox) {
            Ok(()) => backoff = BACKOFF_BASE,
            Err(_error) => {
                // Sem log de erro a cada tentativa: o gateway pode demorar a
                // subir, e encher o log com a mesma linha de "conexão recusada"
                // esconde o que importa quando algo der errado de verdade.
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
        state.connected.store(false, Ordering::SeqCst);
        *lock_or_recover(&state.connected_session) = None;

        if state.stopped.load(Ordering::SeqCst) {
            return;
        }
        // A espera é picada para o fechamento do app não ter de aguardar
        // quinze segundos de backoff.
        let until = Instant::now() + backoff;
        while Instant::now() < until && !state.stopped.load(Ordering::SeqCst) {
            std::thread::sleep(READ_TICK.min(backoff));
        }
    }
}

/// Uma conexão inteira: handshake, `hello` e laço de mensagens.
///
/// Devolve `Ok` quando a saída foi ordeira (troca de sessão, app fechando,
/// fechamento pelo outro lado) e `Err` quando foi falha — é o que decide se o
/// backoff cresce.
fn serve(
    state: &BridgeState,
    sender: &Sender<String>,
    outbox: &Receiver<String>,
) -> Result<(), String> {
    let (authority, path) = split_ws_url(&state.url)?;
    let address = crate::gateway::resolve_authority(&authority)?;

    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|error| format!("não foi possível conectar em {authority}: {error}"))?;
    stream
        .set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| format!("não foi possível ajustar o prazo de escrita: {error}"))?;
    // Sem Nagle: as mensagens desta ponte são pequenas e o que importa é
    // chegarem AGORA. Com Nagle, um `tool.result` de 200 bytes pode esperar o
    // próximo pacote — 40 ms parados por nada.
    let _ = stream.set_nodelay(true);

    // Handshake ANTES do prazo de leitura: um `read` com prazo no meio do
    // handshake devolveria "interrompido" e derrubaria uma conexão que estava
    // apenas começando.
    let (mut socket, _response) = tungstenite::client::client(state.url.as_str(), stream)
        .map_err(|error| format!("o gateway recusou a ponte em {path}: {error}"))?;
    socket
        .get_mut()
        .set_read_timeout(Some(READ_TICK))
        .map_err(|error| format!("não foi possível ajustar o prazo de leitura: {error}"))?;

    let hint = lock_or_recover(&state.desired_session).clone();
    send_text(&mut socket, hello_envelope(&state.token, hint.as_deref()))?;

    loop {
        if state.stopped.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            return Ok(());
        }
        // A janela mandou acompanhar outra conversa: reconectar é a forma de
        // trocar de tópico no barramento, porque o `sessionHint` só é lido no
        // `hello`.
        {
            let desired = lock_or_recover(&state.desired_session).clone();
            let connected = lock_or_recover(&state.connected_session).clone();
            if connected.is_some() && desired.is_some() && desired != connected {
                let _ = socket.close(None);
                return Ok(());
            }
        }

        drain_outbox(&mut socket, outbox)?;

        match socket.read() {
            Ok(Message::Text(text)) => handle_text(state, sender, hint.as_deref(), text.as_str()),
            // Ping é respondido pela própria tungstenite; o `flush` do
            // `drain_outbox` é quem põe o pong no fio.
            Ok(_) => {}
            Err(tungstenite::Error::Io(error)) if is_timeout(&error) => {}
            Err(tungstenite::Error::ConnectionClosed)
            | Err(tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(error) => return Err(format!("a ponte caiu: {error}")),
        }
    }
}

/// Manda para o fio tudo o que as threads de ferramenta deixaram prontas.
fn drain_outbox<S>(socket: &mut WebSocket<S>, outbox: &Receiver<String>) -> Result<(), String>
where
    S: std::io::Read + std::io::Write,
{
    loop {
        match outbox.try_recv() {
            Ok(payload) => send_text(socket, payload)?,
            Err(mpsc::TryRecvError::Empty) => break,
            // O emissor original vive na thread da ponte; desconectar só
            // acontece no encerramento.
            Err(mpsc::TryRecvError::Disconnected) => break,
        }
    }
    // `flush` põe no fio o que a tungstenite enfileirou sozinha — o pong da
    // resposta ao ping do gateway. Sem ele, o gateway veria a ponte muda.
    match socket.flush() {
        Ok(()) => Ok(()),
        Err(tungstenite::Error::Io(error)) if is_timeout(&error) => Ok(()),
        Err(error) => Err(format!("não foi possível escrever na ponte: {error}")),
    }
}

fn send_text<S>(socket: &mut WebSocket<S>, payload: String) -> Result<(), String>
where
    S: std::io::Read + std::io::Write,
{
    socket
        .send(Message::text(payload))
        .map_err(|error| format!("não foi possível escrever na ponte: {error}"))
}

/// Prazo estourado não é queda.
///
/// São dois `ErrorKind` porque as plataformas discordam: no Windows o prazo de
/// leitura chega como `TimedOut`, no Unix como `WouldBlock`. Tratar só um dos
/// dois derrubaria e reconectaria a ponte duas vezes por segundo.
fn is_timeout(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/* ------------------------------- mensagens -------------------------------- */

/// Trata um envelope vindo do gateway.
///
/// `hint` é a sessão que ESTA conexão pediu no `hello` — ver o `ready` abaixo.
fn handle_text(state: &BridgeState, sender: &Sender<String>, hint: Option<&str>, text: &str) {
    let Ok(envelope) = serde_json::from_str::<Value>(text) else {
        // Texto que não é JSON não é do protocolo. Derrubar a conexão por causa
        // dele daria a um frame malformado o poder de desligar as ferramentas.
        return;
    };
    let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");

    if kind == "ready" {
        if let Some(session) = envelope
            .get("payload")
            .and_then(|payload| payload.get("session"))
            .and_then(Value::as_str)
        {
            *lock_or_recover(&state.connected_session) = Some(session.to_string());
            // A sessão que o gateway RESOLVEU passa a ser a desejada — é o que
            // impede o laço "peço X, recebo Y, reconecto pedindo X" de girar
            // para sempre quando X já não existe no store.
            //
            // Só que isso vale apenas se ninguém pediu outra coisa no meio do
            // caminho: se a janela chamou `follow` entre o nosso `hello` e este
            // `ready`, sobrescrever aqui perderia o pedido dela em silêncio — e
            // silêncio, aqui, é ferramenta de máquina que nunca chega.
            let mut desired = lock_or_recover(&state.desired_session);
            if desired.as_deref() == hint {
                *desired = Some(session.to_string());
            }
            state.connected.store(true, Ordering::SeqCst);
        }
        return;
    }

    if kind != "tool.call" {
        return;
    }
    // Só o que é endereçado ao HOST. O mesmo tópico carrega as chamadas que o
    // gateway executa sozinho (fs, git, memória); executá-las aqui seria uma
    // segunda implementação da mesma ferramenta, com outro comportamento.
    let destination = envelope
        .get("to")
        .and_then(|to| to.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if destination != "host" {
        return;
    }

    let Some(payload) = envelope.get("payload") else {
        return;
    };
    let call_id = payload
        .get("callId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool = payload
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() || tool.is_empty() {
        return;
    }
    let args = payload.get("args").cloned().unwrap_or(Value::Null);
    let session = envelope
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // Cada ferramenta roda na SUA thread. Executar aqui prenderia o laço de
    // leitura pelo tempo do comando — dois minutos sem ler o socket, sem
    // responder ping e sem receber a chamada seguinte.
    //
    // As cópias existem porque a thread pode NÃO nascer: quando o `spawn`
    // falha, o fechamento é descartado junto com o que ele levou, e o caminho
    // de erro abaixo ainda precisa dizer de qual chamada estamos falando.
    let worker_sender = sender.clone();
    let worker_session = session.clone();
    let worker_call_id = call_id.clone();
    let worker_tool = tool.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("aibot-tool-{tool}"))
        .spawn(move || {
            let started = Instant::now();
            let outcome = run_tool(&worker_tool, &args);
            let elapsed = started.elapsed().as_millis() as u64;
            let envelope = result_envelope(
                &worker_session,
                &worker_call_id,
                &worker_tool,
                outcome,
                elapsed,
            );
            // Erro aqui só acontece se a ponte inteira já morreu.
            let _ = worker_sender.send(envelope);
        });

    if let Err(error) = spawned {
        let envelope = result_envelope(
            &session,
            &call_id,
            &tool,
            Err(format!(
                "a máquina não conseguiu abrir uma thread para a ferramenta: {error}"
            )),
            0,
        );
        let _ = sender.send(envelope);
    }
}

/// Executa a ferramenta, transformando PÂNICO em erro de ferramenta.
///
/// O código das ferramentas evita `unwrap`, mas fatiar texto e indexar vetor
/// ainda podem entrar em pânico com uma entrada suficientemente estranha (um
/// DOCX corrompido, por exemplo). Sem esta rede, a thread morreria sem enviar
/// resposta e o turno ficaria pendurado por QUINZE MINUTOS, que é o prazo do
/// gateway para o host. Um erro na hora vale mais que um turno travado.
fn run_tool(tool: &str, args: &Value) -> Result<String, String> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| crate::tools::execute(tool, args))) {
        Ok(result) => result,
        Err(_) => Err(format!(
            "a ferramenta {tool} quebrou no meio da execução nesta máquina — o arquivo de entrada pode estar corrompido"
        )),
    }
}

/// Primeiro frame: quem somos e o token.
///
/// O token vai NO FRAME, nunca na URL: query string entra em log de proxy, em
/// histórico e em mensagem de erro — e o WebSocket não passa por CORS, então
/// esse segredo é a única coisa que separa o AI-BOT de qualquer página aberta
/// no navegador da estação.
/// `liveOnly` pede ao gateway para NÃO reenviar o histórico.
///
/// Sem ele, o `hello` sai com `resumeFrom` ausente — que o Go lê como zero, ou
/// seja, "replay desde o começo". A cada reconexão (e esta ponte reconecta
/// sozinha, inclusive a cada troca de sessão) o gateway despejaria a conversa
/// INTEIRA num cliente que só olha `tool.call`: cada `token` de cada resposta
/// passada, para ser descartado no `handle_text`. Numa sessão longa isso é
/// megabytes de JSON e segundos de CPU por reconexão, sem uma única linha de uso.
///
/// Mandar `resumeFrom: <último seq>` NÃO resolveria: a ponte não numera nada —
/// quem tem cursor é a janela, e inventar um aqui criaria uma segunda contagem
/// para divergir da dela. O que a ponte quer é o que vier DAQUI PARA A FRENTE,
/// e é isso que este campo diz.
fn hello_envelope(token: &str, session_hint: Option<&str>) -> String {
    let mut payload = json!({
        "client": CLIENT,
        "version": CLIENT_VERSION,
        "token": token,
        "liveOnly": true,
    });
    if let (Some(hint), Some(map)) = (session_hint, payload.as_object_mut()) {
        map.insert("sessionHint".into(), json!(hint));
    }
    envelope("hello", session_hint.unwrap_or_default(), payload, None)
}

/// Resposta de uma ferramenta.
fn result_envelope(
    session: &str,
    call_id: &str,
    tool: &str,
    outcome: Result<String, String>,
    elapsed: u64,
) -> String {
    let (ok, output, error) = match outcome {
        Ok(output) => (true, output, String::new()),
        // A mensagem de erro NUNCA fica vazia: o gateway trata resultado sem
        // detalhe como "a ferramenta falhou sem detalhe", e o modelo tentaria
        // de novo sem saber o que corrigir.
        Err(error) if error.trim().is_empty() => (
            false,
            String::new(),
            format!("a ferramenta {tool} falhou sem dizer o motivo"),
        ),
        Err(error) => (false, String::new(), error),
    };
    envelope(
        "tool.result",
        session,
        json!({
            "callId": call_id,
            "tool": tool,
            "ok": ok,
            "output": output,
            "error": error,
            "elapsedMs": elapsed,
        }),
        Some(json!({ "kind": "supervisor" })),
    )
}

/// Monta o envelope do protocolo canônico.
///
/// `ts` fica DE FORA de propósito. Quem numera e data o histórico é o gateway
/// (o `seq` é dele, e o relógio do host não acrescenta nada); e um `ts` fora do
/// formato que o Go espera faria o `json.Unmarshal` do envelope INTEIRO falhar,
/// jogando a mensagem no lixo sem aviso. Campo ausente vira o valor zero, que é
/// exatamente o que se quer dizer.
fn envelope(kind: &str, session: &str, payload: Value, to: Option<Value>) -> String {
    let mut frame = json!({
        "v": 1,
        "id": next_id(),
        "seq": 0,
        "session": session,
        "kind": kind,
        "from": { "kind": "tool", "id": "host" },
        "payload": payload,
    });
    if let (Some(to), Some(map)) = (to, frame.as_object_mut()) {
        map.insert("to".into(), to);
    }
    frame.to_string()
}

fn next_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("host-{millis}-{sequence}")
}

/* --------------------------------- apoio ---------------------------------- */

/// Separa `ws://host:porta/caminho` em autoridade e caminho.
///
/// Feito na mão porque é uma URL só, sempre em loopback e sempre nossa —
/// carregar um analisador de URL completo para isto seria dependência para
/// resolver um `find('/')`. Só `ws://` é aceito: `wss://` exigiria TLS, e TLS
/// contra 127.0.0.1 pede um certificado que não existe.
fn split_ws_url(url: &str) -> Result<(String, String), String> {
    let rest = url.strip_prefix("ws://").ok_or_else(|| {
        format!("a ponte só fala ws:// em loopback, e recebeu {url:?}")
    })?;
    if rest.is_empty() {
        return Err(format!("endereço da ponte sem host: {url:?}"));
    }
    match rest.find('/') {
        Some(at) => Ok((rest[..at].to_string(), rest[at..].to_string())),
        None => Ok((rest.to_string(), "/".to_string())),
    }
}

/// Trava que sobrevive a envenenamento — ver o mesmo raciocínio em `gateway.rs`.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/* ------------------------------- comandos --------------------------------- */

/// A janela avisa qual conversa está aberta.
///
/// Não é firula de sincronia de estado: sem isto a ponte fica inscrita em outro
/// tópico do barramento e NENHUMA ferramenta de máquina chega até ela. Chamado
/// pelo front assim que o `ready` da conversa traz a sessão.
#[tauri::command]
pub fn hostbridge_follow(state: State<'_, BridgeHandle>, session: String) -> Result<(), String> {
    if session.trim().is_empty() {
        return Err("informe a sessão que a janela está mostrando".into());
    }
    state.follow(&session);
    Ok(())
}

#[tauri::command]
pub fn hostbridge_status(state: State<'_, BridgeHandle>) -> Result<BridgeStatus, String> {
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(frame: &str) -> Value {
        serde_json::from_str(frame).expect("o envelope precisa ser JSON")
    }

    #[test]
    fn hello_leva_o_token_no_payload_e_nunca_na_url() {
        let frame = parse(&hello_envelope("segredo", Some("s1")));
        assert_eq!(frame["kind"], "hello");
        assert_eq!(frame["v"], 1);
        assert_eq!(frame["payload"]["token"], "segredo");
        assert_eq!(frame["payload"]["sessionHint"], "s1");
        assert_eq!(frame["session"], "s1");
    }

    /// A ponte NÃO quer histórico: ela só serve `tool.call`. Se este campo cair
    /// do `hello`, o gateway volta a reenviar a conversa inteira a cada
    /// reconexão — e o sintoma (app lento ao trocar de conversa) não aponta
    /// para cá.
    #[test]
    fn hello_pede_apenas_o_que_vier_daqui_para_a_frente() {
        let frame = parse(&hello_envelope("segredo", Some("s1")));
        assert_eq!(frame["payload"]["liveOnly"], true);
        assert!(
            frame["payload"].get("resumeFrom").is_none(),
            "a ponte não tem cursor para pedir replay: {frame}"
        );
    }

    #[test]
    fn hello_sem_sessao_nao_inventa_hint() {
        let frame = parse(&hello_envelope("segredo", None));
        assert!(frame["payload"].get("sessionHint").is_none());
        assert_eq!(frame["session"], "");
    }

    /// `ts` ausente é decisão: um formato de data errado faria o Go descartar o
    /// envelope inteiro no `Unmarshal`.
    #[test]
    fn envelope_nao_carrega_data() {
        let frame = parse(&hello_envelope("x", None));
        assert!(frame.get("ts").is_none(), "veio: {frame}");
    }

    #[test]
    fn resultado_de_sucesso_traz_saida_e_tempo() {
        let frame = parse(&result_envelope(
            "s1",
            "h9",
            "proc.run",
            Ok("tudo certo".into()),
            42,
        ));
        assert_eq!(frame["kind"], "tool.result");
        assert_eq!(frame["to"]["kind"], "supervisor");
        assert_eq!(frame["payload"]["callId"], "h9");
        assert_eq!(frame["payload"]["tool"], "proc.run");
        assert_eq!(frame["payload"]["ok"], true);
        assert_eq!(frame["payload"]["output"], "tudo certo");
        assert_eq!(frame["payload"]["elapsedMs"], 42);
    }

    #[test]
    fn resultado_de_erro_nunca_vai_sem_motivo() {
        let frame = parse(&result_envelope("s1", "h9", "office.open", Err("   ".into()), 3));
        assert_eq!(frame["payload"]["ok"], false);
        let motivo = frame["payload"]["error"].as_str().unwrap_or_default();
        assert!(!motivo.trim().is_empty(), "erro sem motivo: {frame}");
        assert!(motivo.contains("office.open"), "veio: {motivo}");
    }

    #[test]
    fn url_da_ponte_e_separada_em_host_e_caminho() {
        let (authority, path) =
            split_ws_url("ws://127.0.0.1:8799/v1/stream").expect("deveria separar");
        assert_eq!(authority, "127.0.0.1:8799");
        assert_eq!(path, "/v1/stream");
    }

    #[test]
    fn esquema_diferente_de_ws_e_recusado() {
        assert!(split_ws_url("wss://127.0.0.1:8799/v1/stream").is_err());
        assert!(split_ws_url("http://127.0.0.1:8799/v1/stream").is_err());
    }

    #[test]
    fn ids_de_envelope_nao_se_repetem() {
        let primeiro = next_id();
        let segundo = next_id();
        assert_ne!(primeiro, segundo);
    }

    /// A ponte só serve o que é endereçado ao host — o resto do tópico é do
    /// gateway.
    #[test]
    fn seguir_sessao_so_muda_quando_e_diferente() {
        let state = BridgeState {
            url: "ws://127.0.0.1:8799/v1/stream".into(),
            token: "t".into(),
            desired_session: Mutex::new(None),
            connected_session: Mutex::new(None),
            connected: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        };
        state.follow("  ");
        assert_eq!(*lock_or_recover(&state.desired_session), None);
        state.follow(" s7 ");
        assert_eq!(
            lock_or_recover(&state.desired_session).as_deref(),
            Some("s7")
        );
    }
}
