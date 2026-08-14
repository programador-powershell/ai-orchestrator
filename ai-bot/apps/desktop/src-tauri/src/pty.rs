//! ============================================================================
//! TERMINAL INTERATIVO (PTY) — ConPTY no Windows, unix98 no resto.
//! ============================================================================
//!
//! # LEIA ISTO ANTES DE MEXER: `pty_write` É TECLA DE HUMANO
//!
//! **`pty_write` NÃO PODE ENTRAR NO REGISTRO DE FERRAMENTAS DO AGENTE.**
//!
//! Todo o modelo de segurança do produto é aprovação por ação: o modelo propõe,
//! a pessoa deixa ou não. Um shell interativo é execução **sem portão de
//! aprovação** — o que é legítimo quando quem digita é a pessoa (são as mãos
//! dela) e é a porta lateral perfeita quando quem digita é o modelo: bastaria
//! escrever `rm -rf .\n` num PTY já aberto para contornar todos os portões de
//! uma vez, sem nenhum `tool.call` que alguém pudesse recusar.
//!
//! A separação exata, do lado do gateway Go
//! (`services/gateway/internal/supervisor/tools.go`):
//!
//! | Ferramenta        | Quem digita | Portão de aprovação |
//! |-------------------|-------------|---------------------|
//! | `proc.run`        | o modelo    | SIM — é por aí que o agente roda comando |
//! | `term.open`       | o modelo    | SIM — mas só ABRE o terminal PARA A PESSOA |
//! | `pty_write`       | **a pessoa**| **não existe como ferramenta** |
//!
//! Repare que `term.open` é ferramenta e mapeia para [`pty_spawn`]: abrir um
//! terminal para a pessoa usar é inofensivo, porque o que entra nele depois vem
//! do teclado dela. O que não pode existir é o caminho que faz o modelo digitar
//! dentro dele. Se algum dia alguém registrar `pty_write` como host tool, o
//! modelo de aprovação inteiro cai junto — e cai em silêncio, porque tudo
//! continua funcionando.
//!
//! Esta é a regra 2 do `CLAUDE.md` e a regra 4 (três superfícies de execução
//! separadas: `proc.run`, sandbox com Job Object, e `pty_*`). Fundi-las desfaz
//! o modelo de aprovação.
//!
//! # A outra regra: o renderer NÃO escolhe o executável
//!
//! Não existe parâmetro de caminho de binário aqui. O front manda um **enum
//! fechado** ([`ShellKind`]) e o Rust resolve o caminho. Se o renderer pudesse
//! mandar `{shell:"C:\\evil.exe"}`, um XSS na webview viraria execução
//! arbitrária. O teste `caminho_de_executavel_do_renderer_e_recusado` trava
//! essa garantia: ele falha se alguém acrescentar uma variante que carregue
//! string.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, State};

/// Teto de sessões vivas. ConPTY custa processo e handle; abrir dezenas sem
/// querer (uma por troca de aba, por exemplo) degradaria a máquina.
const MAX_SESSIONS: usize = 8;
/// Teto de um `pty_write`. Tecla de humano não chega perto disso; o teto existe
/// para colagem gigante não virar alocação sem limite.
const MAX_WRITE: usize = 64 * 1024;
/// Bloco de leitura do PTY.
const READ_BUF: usize = 8192;
/// Guarda do buffer de remontagem UTF-8. Sequência válida tem no máximo 4
/// bytes; acima disso é lixo, e segurar lixo indefinidamente esconderia saída
/// legítima da tela para sempre.
const MAX_CARRY: usize = 8;

/* ---------------------------- Eventos para a UI --------------------------- */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataEvent {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitEvent {
    pub id: String,
    /// Código REAL do processo: quem emite é a thread que chamou `wait()`.
    /// `None` só quando o próprio `wait()` falhou.
    pub exit_code: Option<u32>,
    /// `exited` (terminou sozinho) | `killed` (pedimos) | `error`.
    pub reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyErrorEvent {
    pub id: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
}

/* --------------------------------- Shell ---------------------------------- */

/// Tipo de shell que o renderer pode pedir.
///
/// **Não é caminho, e não pode virar caminho.** É um enum fechado justamente
/// para que a superfície de escolha do renderer seja "qual dos quatro", nunca
/// "qual arquivo do disco". Acrescentar uma variante `Custom(String)` aqui
/// reabriria a execução arbitrária a partir da tela.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    #[default]
    Default,
    PowerShell,
    Cmd,
    Bash,
}

/// Um candidato a shell: caminho absoluto + argumentos.
type Candidate = (String, Vec<String>);

/// Monta um caminho a partir de uma raiz vinda do **ambiente do processo**.
///
/// Usar variável de ambiente aqui NÃO reabre o buraco da regra do cabeçalho: o
/// ambiente é o do processo nativo, herdado do sistema. O que não pode existir
/// é caminho vindo do JS. Sem isto os caminhos ficariam cravados em
/// `C:\Program Files` e `C:\Windows`, que quebram em estação com Windows em
/// outro volume ou com Program Files redirecionado.
#[cfg(windows)]
fn from_env(var: &str, tail: &str) -> Option<String> {
    let base = std::env::var(var).ok()?;
    let base = base.trim_end_matches(['\\', '/']);
    if base.is_empty() {
        return None;
    }
    Some(format!(r"{base}\{tail}"))
}

#[cfg(windows)]
fn push_if(out: &mut Vec<Candidate>, caminho: Option<String>, args: &[&str]) {
    if let Some(caminho) = caminho {
        out.push((caminho, args.iter().map(|a| (*a).to_string()).collect()));
    }
}

#[cfg(windows)]
fn push_powershell(out: &mut Vec<Candidate>) {
    // PowerShell 7 instalado por MÁQUINA...
    push_if(
        out,
        from_env("ProgramFiles", r"PowerShell\7\pwsh.exe"),
        &["-NoLogo"],
    );
    // ...e por USUÁRIO (instalação sem admin).
    push_if(
        out,
        from_env("LOCALAPPDATA", r"Programs\PowerShell\7\pwsh.exe"),
        &["-NoLogo"],
    );
    // Windows PowerShell 5.1: não é o melhor, mas está em toda estação.
    push_if(
        out,
        from_env("SystemRoot", r"System32\WindowsPowerShell\v1.0\powershell.exe"),
        &["-NoLogo"],
    );
}

#[cfg(windows)]
fn push_cmd(out: &mut Vec<Candidate>) {
    push_if(out, from_env("SystemRoot", r"System32\cmd.exe"), &[]);
}

#[cfg(windows)]
fn push_bash(out: &mut Vec<Candidate>) {
    // Git for Windows por MÁQUINA (instalador com admin)...
    push_if(out, from_env("ProgramFiles", r"Git\bin\bash.exe"), &["-i"]);
    push_if(out, from_env("ProgramFiles", r"Git\usr\bin\bash.exe"), &["-i"]);
    // ...e por USUÁRIO, em %LOCALAPPDATA%\Programs\Git. Este é o padrão de
    // quem instala SEM direito de administrador — ou seja, o caso comum nas
    // estações do time. Cravar só `C:\Program Files\Git` fazia o `bash` cair
    // em SHELL_NOT_FOUND justamente na máquina de quem mais usa terminal.
    push_if(
        out,
        from_env("LOCALAPPDATA", r"Programs\Git\bin\bash.exe"),
        &["-i"],
    );
    push_if(
        out,
        from_env("LOCALAPPDATA", r"Programs\Git\usr\bin\bash.exe"),
        &["-i"],
    );
}

/// Resolve o tipo para um executável concreto, **conferindo que o arquivo
/// existe** antes de devolver.
///
/// A conferência não é preciosismo: sem ela, um `pwsh` ausente só apareceria
/// como falha genérica de spawn lá na frente, já com o PTY aberto e um
/// diagnóstico pior. A lista é tentada em ordem e a primeira que existe ganha,
/// então uma estação sem PowerShell 7 cai no 5.1 sozinha.
pub fn resolve_shell(kind: ShellKind) -> Result<(String, Vec<String>), String> {
    let mut candidatos: Vec<Candidate> = Vec::new();

    #[cfg(windows)]
    match kind {
        ShellKind::PowerShell => push_powershell(&mut candidatos),
        ShellKind::Cmd => push_cmd(&mut candidatos),
        ShellKind::Bash => push_bash(&mut candidatos),
        ShellKind::Default => {
            push_powershell(&mut candidatos);
            push_cmd(&mut candidatos);
        }
    }

    #[cfg(not(windows))]
    match kind {
        ShellKind::Bash => candidatos.push(("/bin/bash".into(), vec!["-l".into()])),
        ShellKind::PowerShell => candidatos.push(("/usr/bin/pwsh".into(), vec!["-NoLogo".into()])),
        // `cmd` não existe fora do Windows; cair no shell padrão é melhor que
        // recusar por um pedido que a tela pode fazer sem saber o host.
        ShellKind::Cmd | ShellKind::Default => {
            candidatos.push(("/bin/sh".into(), vec!["-l".into()]))
        }
    }

    for (caminho, args) in &candidatos {
        if PathBuf::from(caminho).is_file() {
            return Ok((caminho.clone(), args.clone()));
        }
    }
    // Último recurso no Unix é o SHELL do ambiente — de novo, variável de
    // ambiente do processo, NUNCA um caminho vindo do renderer.
    #[cfg(not(windows))]
    if let Ok(shell) = std::env::var("SHELL") {
        if PathBuf::from(&shell).is_file() {
            return Ok((shell, vec!["-l".into()]));
        }
    }
    Err(err(
        "SHELL_NOT_FOUND",
        format!("nenhum shell disponível para o tipo {kind:?}"),
    ))
}

/* --------------------------- Decodificador UTF-8 -------------------------- */

/// Decodifica bytes do PTY remontando caractere partido entre leituras.
///
/// O PTY entrega **bytes, não caracteres**: um `é` (2 bytes) ou um emoji (4)
/// pode cair metade num bloco de 8192 e metade no seguinte. `from_utf8_lossy`
/// por bloco transforma a metade órfã em `U+FFFD` de forma irreversível —
/// `café` vira `caf\u{FFFD}` e o `é` nunca mais volta, nem quando o resto do
/// byte chega. Um `ls` de pasta com acento já expõe isso.
///
/// O `carry` guarda o pedaço incompleto do fim de um bloco para o começo do
/// próximo completar. Byte genuinamente inválido (não só incompleto) vira
/// `U+FFFD` e é **consumido**: segurá-lo travaria o fluxo para sempre esperando
/// um final que não vem.
pub fn decode_stream(carry: &mut Vec<u8>, incoming: &[u8]) -> String {
    carry.extend_from_slice(incoming);
    let mut saida = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(texto) => {
                saida.push_str(texto);
                carry.clear();
                break;
            }
            Err(erro) => {
                let ate = erro.valid_up_to();
                if ate > 0 {
                    // `ate` vem do próprio `from_utf8`, então é fronteira válida.
                    saida.push_str(std::str::from_utf8(&carry[..ate]).unwrap_or_default());
                }
                match erro.error_len() {
                    // Byte inválido de verdade: marca, descarta e segue.
                    Some(tamanho) => {
                        saida.push('\u{FFFD}');
                        carry.drain(..ate + tamanho);
                    }
                    // Sequência incompleta no FIM do bloco: guarda o resto para
                    // o próximo bloco completar. É este ramo que salva o "é".
                    None => {
                        carry.drain(..ate);
                        if carry.len() > MAX_CARRY {
                            // Nunca deveria acontecer com UTF-8 (máx. 4 bytes).
                            // Sem esta guarda, um fluxo de bytes de continuação
                            // faria o buffer crescer para sempre e prenderia a
                            // saída dentro dele.
                            saida.push('\u{FFFD}');
                            carry.clear();
                        }
                        break;
                    }
                }
            }
        }
    }
    saida
}

/* ---------------------------------- Estado -------------------------------- */

struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Mata o filho a partir de OUTRA thread. O `Child` foi movido para a
    /// thread que espera (`wait()` precisa de `&mut`), então guardar o `Child`
    /// aqui impediria o kill de pegar o lock enquanto a espera acontece.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    cwd: String,
    cols: u16,
    rows: u16,
    alive: Arc<AtomicBool>,
    /// Distingue "morreu sozinho" de "pedimos que morresse" no `pty-exit`.
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

fn err(code: &str, message: impl AsRef<str>) -> String {
    format!("{code}: {}", message.as_ref())
}

/// Contador de sessões, monotônico e por processo.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Gera o id da sessão.
///
/// Um contador basta: o id só precisa ser único entre as (no máximo oito)
/// sessões vivas deste processo, e nunca é reusado porque o contador só sobe.
/// Não usamos UUID de propósito — seria uma dependência inteira a homologar
/// para nomear oito terminais, e `pty-3` é bem mais legível num log de suporte
/// do que um hexadecimal de 36 caracteres.
fn next_session_id() -> String {
    format!("pty-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn lock_sessions(
    state: &PtyState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, Session>>, String> {
    state.sessions.lock().map_err(|_| {
        err(
            "LOCK_POISONED",
            "estado interno do PTY corrompido — reinicie o app",
        )
    })
}

fn valid_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let raw = cwd.filter(|value| !value.trim().is_empty());
    let candidato = match raw {
        Some(value) => PathBuf::from(value),
        None => std::env::current_dir().map_err(|erro| {
            err(
                "CWD_MISSING",
                format!("não foi possível obter o diretório atual: {erro}"),
            )
        })?,
    };
    let canonico = candidato.canonicalize().map_err(|erro| {
        err(
            "CWD_INVALID",
            format!("não foi possível resolver {}: {erro}", candidato.display()),
        )
    })?;
    if !canonico.is_dir() {
        return Err(err(
            "CWD_NOT_DIR",
            format!("cwd deve ser um diretório: {}", canonico.display()),
        ));
    }
    Ok(canonico)
}

/* --------------------------------- Comandos ------------------------------- */

/// Abre uma sessão de terminal e devolve o id.
///
/// Não existe parâmetro de caminho de executável — de propósito. Ver o
/// cabeçalho do módulo.
///
/// # Ordem de escuta (importa para quem chama do JS)
///
/// O shell começa a escrever assim que nasce, e isso acontece ANTES desta
/// função retornar o id. Quem só registrar o `listen("pty-data")` depois do
/// `await pty_spawn(...)` perde o banner e o primeiro prompt. O jeito certo é
/// assinar o evento ANTES de chamar, guardando o que chegar por id, e casar com
/// o id quando ele voltar.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<ShellKind>,
) -> Result<String, String> {
    let cols = cols.unwrap_or(80).clamp(20, 500);
    let rows = rows.unwrap_or(24).clamp(5, 200);

    {
        // Recolhe as que já morreram ANTES de conferir o teto: sessão encerrada
        // continua no mapa até alguém varrer (é ela que alimenta o `pty-exit`
        // e o `pty_list`), e sem esta varredura oito terminais fechados
        // bloqueariam a abertura do nono.
        let mut sessions = lock_sessions(&state)?;
        sessions.retain(|_, session| session.alive.load(Ordering::SeqCst));
        if sessions.len() >= MAX_SESSIONS {
            return Err(err(
                "SESSION_LIMIT",
                format!("limite de {MAX_SESSIONS} terminais abertos — feche algum antes"),
            ));
        }
    }

    // Monta tudo que pode falhar ANTES de abrir o PTY: falhar depois deixaria
    // um PTY órfão sem ninguém para fechá-lo.
    let caminho = valid_cwd(cwd)?;
    let (programa, argumentos) = resolve_shell(shell.unwrap_or_default())?;
    let cwd_str = caminho.to_string_lossy().into_owned();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|erro| {
            err(
                "OPENPTY_FAILED",
                format!("falha ao criar PTY (ConPTY/unix98): {erro}"),
            )
        })?;

    let mut cmd = CommandBuilder::new(&programa);
    for argumento in argumentos {
        cmd.arg(argumento);
    }
    cmd.cwd(&cwd_str);
    // Sem isto o programa dentro do PTY assume terminal burro e não emite cor.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|erro| {
        err(
            "SPAWN_FAILED",
            format!("não foi possível iniciar {programa}: {erro}"),
        )
    })?;

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|erro| {
        err(
            "READER_FAILED",
            format!("falha ao obter reader do PTY: {erro}"),
        )
    })?;
    let writer = pair.master.take_writer().map_err(|erro| {
        err(
            "WRITER_FAILED",
            format!("falha ao obter writer do PTY: {erro}"),
        )
    })?;

    let id = next_session_id();
    let alive = Arc::new(AtomicBool::new(true));
    let killed = Arc::new(AtomicBool::new(false));

    // ---- thread de LEITURA: só dados. Não emite exit. ----
    {
        let app = app.clone();
        let id = id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(lidos) => {
                        let data = decode_stream(&mut carry, &buf[..lidos]);
                        if data.is_empty() {
                            // Só metade de um caractere chegou: espera o resto
                            // em vez de emitir evento vazio.
                            continue;
                        }
                        if app
                            .emit("pty-data", PtyDataEvent { id: id.clone(), data })
                            .is_err()
                        {
                            // Webview sumiu: não há mais para quem entregar.
                            break;
                        }
                    }
                    Err(erro) => {
                        let _ = app.emit(
                            "pty-error",
                            PtyErrorEvent {
                                id: Some(id.clone()),
                                code: "READ_ERROR".into(),
                                message: format!("erro de leitura do PTY: {erro}"),
                            },
                        );
                        break;
                    }
                }
            }
        });
    }

    // ---- thread de ESPERA: chama wait(), emite UM exit com o código real ----
    //
    // Separar da leitura é o que torna o `exitCode` verdadeiro: sem um `wait()`
    // de verdade o código seria sempre `None` (e no Unix o filho viraria
    // zumbi), e adivinhar o fim por fechamento do reader emitiria evento
    // duplicado.
    {
        let app = app.clone();
        let id = id.clone();
        let alive = Arc::clone(&alive);
        let killed = Arc::clone(&killed);
        thread::spawn(move || {
            let resultado = child.wait();
            // `swap(false)` garante emissão única mesmo se algo mais tentar.
            if !alive.swap(false, Ordering::SeqCst) {
                return;
            }
            let (exit_code, reason) = match resultado {
                Ok(status) => (
                    Some(status.exit_code()),
                    if killed.load(Ordering::SeqCst) {
                        "killed"
                    } else {
                        "exited"
                    },
                ),
                Err(_) => (None, "error"),
            };
            let _ = app.emit(
                "pty-exit",
                PtyExitEvent {
                    id: id.clone(),
                    exit_code,
                    reason: reason.into(),
                },
            );
        });
    }

    {
        let mut sessions = lock_sessions(&state)?;
        sessions.insert(
            id.clone(),
            Session {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                killer: Mutex::new(killer),
                cwd: cwd_str,
                cols,
                rows,
                alive: Arc::clone(&alive),
                killed,
            },
        );
    }

    Ok(id)
}

/// Escreve teclas na sessão.
///
/// **TECLA DE HUMANO — não registre isto como ferramenta do agente.** Ver o
/// cabeçalho do módulo: é o único ponto do app onde algo executa sem passar por
/// um portão de aprovação, e isso só é aceitável porque quem digita é a pessoa.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > MAX_WRITE {
        return Err(err("WRITE_TOO_LARGE", "payload de escrita excede 64 KiB"));
    }
    let sessions = lock_sessions(&state)?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| err("SESSION_NOT_FOUND", format!("sessão PTY inexistente: {id}")))?;
    if !session.alive.load(Ordering::SeqCst) {
        return Err(err("SESSION_DEAD", "sessão PTY já encerrou"));
    }
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| err("LOCK_POISONED", "writer do PTY bloqueado — reabra o terminal"))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|erro| err("WRITE_FAILED", format!("falha ao escrever no PTY: {erro}")))?;
    writer
        .flush()
        .map_err(|erro| err("FLUSH_FAILED", format!("falha ao flush do PTY: {erro}")))?;
    Ok(())
}

/// Informa o novo tamanho da janela ao processo (SIGWINCH no Unix, resize do
/// ConPTY no Windows).
///
/// Isto não é cosmético. O PTY nasce com 80x24 e o programa de dentro acredita
/// nesse número enquanto ninguém o corrigir: **sem `pty_resize` o `less`, o
/// `vim`, o `htop` e qualquer barra de progresso quebram a linha na coluna
/// errada** — o texto some na borda ou volta embrulhado no meio da tela,
/// mesmo com a janela do app larga. Quem redimensiona o `<div>` do xterm.js
/// precisa chamar isto no mesmo gesto, senão a tela e o processo passam a
/// discordar sobre quantas colunas existem.
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cols = cols.clamp(20, 500);
    let rows = rows.clamp(5, 200);
    let mut sessions = lock_sessions(&state)?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| err("SESSION_NOT_FOUND", format!("sessão PTY inexistente: {id}")))?;
    if !session.alive.load(Ordering::SeqCst) {
        return Err(err("SESSION_DEAD", "sessão PTY já encerrou"));
    }
    {
        let master = session
            .master
            .lock()
            .map_err(|_| err("LOCK_POISONED", "master do PTY bloqueado — reabra o terminal"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|erro| err("RESIZE_FAILED", format!("falha ao redimensionar PTY: {erro}")))?;
    }
    session.cols = cols;
    session.rows = rows;
    Ok(())
}

/// Encerra a sessão. Idempotente: matar o que já morreu não é erro.
///
/// Não emite `pty-exit` aqui — quem emite é a thread de espera, com o código
/// real. Emitir dos dois lados produziria evento duplicado na tela.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = lock_sessions(&state)?;
    let Some(session) = sessions.remove(&id) else {
        return Ok(());
    };
    session.killed.store(true, Ordering::SeqCst);
    if let Ok(mut killer) = session.killer.lock() {
        // O processo pode já ter morrido sozinho — não é falha da operação.
        let _ = killer.kill();
    }
    Ok(())
}

/// Encerra todas e devolve quantas foram. Existe para o desligamento do app não
/// deixar shell órfão rodando com os direitos da pessoa.
#[tauri::command]
pub fn pty_kill_all(state: State<'_, PtyState>) -> Result<usize, String> {
    let mut sessions = lock_sessions(&state)?;
    let total = sessions.len();
    for (_, session) in sessions.drain() {
        session.killed.store(true, Ordering::SeqCst);
        if let Ok(mut killer) = session.killer.lock() {
            let _ = killer.kill();
        }
    }
    Ok(total)
}

/// Lista as sessões conhecidas.
#[tauri::command]
pub fn pty_list(state: State<'_, PtyState>) -> Result<Vec<PtySessionInfo>, String> {
    let sessions = lock_sessions(&state)?;
    Ok(sessions
        .iter()
        .map(|(id, session)| PtySessionInfo {
            id: id.clone(),
            cwd: session.cwd.clone(),
            cols: session.cols,
            rows: session.rows,
            alive: session.alive.load(Ordering::SeqCst),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ----------------------- o teste que trava a regra --------------------- */

    /// **Este é o teste que impede o renderer de escolher o executável.**
    ///
    /// `ShellKind` é um enum fechado, então serde recusa qualquer string que não
    /// seja uma das quatro variantes — inclusive um caminho de arquivo. Se
    /// alguém acrescentar `Custom(String)` para "facilitar", este teste passa a
    /// falhar e a revisão vê o buraco antes que ele chegue à produção.
    #[test]
    fn caminho_de_executavel_do_renderer_e_recusado() {
        // O que a tela PODE mandar: uma das variantes.
        let kind: ShellKind = serde_json::from_str("\"powerShell\"").expect("variante válida");
        assert_eq!(kind, ShellKind::PowerShell);

        // O que a tela NÃO PODE mandar: um caminho. A string JSON aqui é
        // exatamente C:\evil.exe.
        let malicioso = serde_json::from_str::<ShellKind>("\"C:\\\\evil.exe\"");
        assert!(
            malicioso.is_err(),
            "um caminho de executável NÃO pode desserializar para ShellKind — \
             isso seria execução arbitrária a partir da webview"
        );

        // Variações do mesmo ataque, todas recusadas pelo mesmo motivo.
        for tentativa in [
            "\"/bin/sh\"",
            "\"cmd.exe\"",
            "\"C:\\\\Windows\\\\System32\\\\calc.exe\"",
            "\"../../evil\"",
            "\"\"",
        ] {
            assert!(
                serde_json::from_str::<ShellKind>(tentativa).is_err(),
                "deveria recusar {tentativa}"
            );
        }
    }

    /* -------------------------- decodificação UTF-8 ------------------------ */

    /// O caso que motivou o `carry`: "café" partido no meio do "é".
    #[test]
    fn cafe_partido_no_meio_do_e_sai_inteiro() {
        let bytes = "café".as_bytes().to_vec();
        // c(1) a(1) f(1) + é(2 bytes: C3 A9) = 5 bytes.
        assert_eq!(bytes.len(), 5);
        assert_eq!(bytes[3], 0xC3, "primeiro byte do é");
        assert_eq!(bytes[4], 0xA9, "segundo byte do é");

        // A prova do bug que estamos evitando: decodificar o primeiro bloco
        // isoladamente com from_utf8_lossy PERDE o é para sempre.
        assert_eq!(String::from_utf8_lossy(&bytes[..4]), "caf\u{FFFD}");

        // Com o carry: o C3 fica guardado e nada de errado sai na tela.
        let mut carry = Vec::new();
        let primeiro = decode_stream(&mut carry, &bytes[..4]);
        assert_eq!(primeiro, "caf");
        assert!(
            !primeiro.contains('\u{FFFD}'),
            "meio caractere não pode virar U+FFFD: o resto ainda vai chegar"
        );
        assert_eq!(carry.as_slice(), &[0xC3], "o C3 tem de ficar guardado");

        // Segunda leitura completa o caractere.
        let segundo = decode_stream(&mut carry, &bytes[4..]);
        assert_eq!(segundo, "é");
        assert!(carry.is_empty());

        // O que a tela recebe somando os dois eventos é "café", não "caf\u{FFFD}".
        assert_eq!(format!("{primeiro}{segundo}"), "café");
    }

    #[test]
    fn ascii_passa_intacto() {
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, b"hello"), "hello");
        assert!(carry.is_empty());
    }

    #[test]
    fn entrada_vazia_nao_produz_nada() {
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, b""), "");
    }

    #[test]
    fn emoji_de_quatro_bytes_partido_remonta() {
        let bytes = "ok 🚀".as_bytes().to_vec();
        let corte = bytes.len() - 2;
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &bytes[..corte]), "ok ");
        assert_eq!(decode_stream(&mut carry, &bytes[corte..]), "🚀");
        assert!(carry.is_empty());
    }

    #[test]
    fn byte_a_byte_ainda_remonta_tudo() {
        // O pior caso possível: o PTY entregando um byte por leitura.
        let bytes = "árvore 🌳 café".as_bytes().to_vec();
        let mut carry = Vec::new();
        let mut saida = String::new();
        for byte in &bytes {
            saida.push_str(&decode_stream(&mut carry, &[*byte]));
        }
        assert_eq!(saida, "árvore 🌳 café");
        assert!(carry.is_empty());
    }

    #[test]
    fn byte_invalido_de_verdade_vira_marcador_e_nao_trava() {
        // 0xFF nunca é UTF-8 válido. Precisa ser CONSUMIDO, não segurado:
        // segurá-lo esperando um final que não vem travaria a saída.
        let mut carry = Vec::new();
        let saida = decode_stream(&mut carry, &[b'a', 0xFF, b'b']);
        assert_eq!(saida, "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    #[test]
    fn sequencia_incompleta_que_nunca_completa_nao_cresce_para_sempre() {
        // Só prefixos de continuação: sem a guarda de MAX_CARRY o buffer
        // cresceria sem limite e a saída ficaria presa dentro dele.
        let mut carry = Vec::new();
        let mut saida = String::new();
        for _ in 0..20 {
            saida.push_str(&decode_stream(&mut carry, &[0xE2]));
        }
        assert!(carry.len() <= MAX_CARRY, "carry passou da guarda de 8 bytes");
        assert!(saida.contains('\u{FFFD}'));
    }

    /* ------------------------------- shell -------------------------------- */

    #[test]
    fn shell_default_resolve_para_arquivo_que_existe() {
        // Não afirma QUAL shell (varia por máquina), só que resolve para um
        // caminho existente em vez de estourar na hora do spawn.
        let resolvido = resolve_shell(ShellKind::Default);
        assert!(resolvido.is_ok(), "shell padrão não resolveu: {resolvido:?}");
        let (caminho, _) = resolvido.expect("verificado logo acima");
        assert!(PathBuf::from(&caminho).is_file(), "{caminho} não é arquivo");
    }

    /// Nenhuma variante pode devolver caminho que não existe.
    ///
    /// Não exige que TODAS resolvam — uma estação sem Git legitimamente não tem
    /// `bash`, e falhar aí é a resposta certa. O que o teste proíbe é devolver
    /// `Ok` com um caminho inexistente, que viraria SPAWN_FAILED confuso lá na
    /// frente com o PTY já aberto.
    #[test]
    fn nenhuma_variante_devolve_caminho_inexistente() {
        for kind in [
            ShellKind::Default,
            ShellKind::PowerShell,
            ShellKind::Cmd,
            ShellKind::Bash,
        ] {
            if let Ok((caminho, _)) = resolve_shell(kind) {
                assert!(
                    PathBuf::from(&caminho).is_file(),
                    "{kind:?} devolveu {caminho}, que não existe"
                );
                assert!(
                    PathBuf::from(&caminho).is_absolute(),
                    "{kind:?} devolveu caminho relativo ({caminho}) — dependeria do cwd"
                );
            }
        }
    }
}
