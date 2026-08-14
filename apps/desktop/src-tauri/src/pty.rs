//! Terminal INTERATIVO de verdade (PTY) — ConPTY no Windows, unix98 no resto.
//!
//! O `terminal_execute` roda um comando e devolve a saída inteira no fim: não
//! serve para `vim`, para um servidor de desenvolvimento, para um prompt que
//! pergunta algo, nem para ver o build acontecendo. Aqui o processo vive, a
//! saída chega em fluxo e as teclas vão para dentro dele.
//!
//! # A regra que não pode ser quebrada
//!
//! **`pty_write` é para tecla de HUMANO. O agente não recebe esta ferramenta.**
//!
//! Todo o modelo de segurança do app é aprovação por ação: o modelo propõe,
//! a pessoa deixa ou não. Um shell interativo é execução sem gate — o que é
//! legítimo quando quem digita é a pessoa (são as mãos dela), e é a porta
//! lateral perfeita quando quem digita é o modelo: bastaria escrever
//! `rm -rf .\n` num PTY aberto para contornar todos os gates de uma vez.
//! Nenhum comando `pty_*` deve entrar no registro de ferramentas do agente
//! (`src/lib/agent.ts`). Se algum dia um agente precisar de shell, o caminho é
//! `terminal_execute`, que passa pela aprovação.
//!
//! # Diferenças em relação ao rascunho que originou este arquivo
//!
//! 1. **Sem spawn de binário arbitrário.** O rascunho aceitava
//!    `shell: Option<String>` do renderer — `pty_spawn({shell:"C:\\x.exe"})`
//!    era execução arbitrária a partir da tela. Aqui o renderer escolhe um
//!    **tipo** ([`ShellKind`]) e o Rust resolve o caminho.
//! 2. **O ambiente do rodapé é respeitado.** O rascunho sempre abria local; com
//!    o rodapé em VPS o badge diria "VPS" e o shell tocaria a estação — o
//!    mesmo engano que a V.9 corrigiu no `terminal_execute`. Aqui a rota vem
//!    decidida (`ssh: Some(target)`) e o PTY local hospeda um `ssh -tt`, então
//!    o shell é o remoto de verdade, com host key conferida pelo OpenSSH do
//!    sistema.
//! 3. **`wait()` é chamado, então o código de saída é REAL.** O rascunho nunca
//!    esperava o filho: `exitCode` era sempre `None` (e no Unix ficava zumbi), e
//!    uma thread fazia busy-poll de 250 ms para emitir um `pty-exit` duplicado
//!    — o próprio comentário admitia a duplicidade. Aqui uma thread espera o
//!    filho e emite **um** `pty-exit`, com o código verdadeiro.
//! 4. **UTF-8 é decodificado em fluxo.** O rascunho fazia
//!    `from_utf8_lossy` por bloco de 8192 bytes: caractere multibyte partido no
//!    limite virava `U+FFFD`. Um `ls` de arquivo acentuado já bastava.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, State};

use crate::ssh::{build_interactive_args, validate_target, SshTarget};

/// Teto de sessões. ConPTY custa processo e handle; abrir dezenas sem querer
/// (um por troca de aba, por exemplo) degradaria a máquina.
const MAX_SESSIONS: usize = 8;
/// Teto de um `pty_write`. Tecla de humano não chega perto; o teto existe para
/// colagem gigante não virar alocação sem limite.
const MAX_WRITE: usize = 64 * 1024;
/// Bloco de leitura do PTY.
const READ_BUF: usize = 8192;
/// Guarda do buffer de remontagem UTF-8. Sequência válida tem no máximo 4
/// bytes; acima disso é lixo, e segurar lixo indefinidamente esconderia saída.
const MAX_CARRY: usize = 8;

/* ---------------------------- Eventos para a UI ------------------------ */

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
    /// Agora é o código REAL — ver o item 3 do cabeçalho.
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
    /// `local` ou `user@host` — o mesmo rótulo do rodapé, para a tela nunca
    /// afirmar um destino e a sessão tocar outro.
    pub target: String,
}

/* ------------------------------- Shell ------------------------------- */

/// Tipo de shell que o renderer pode pedir. **Não é caminho** — ver item 1.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShellKind {
    #[default]
    Default,
    PowerShell,
    Cmd,
    Bash,
}

/// Resolve o tipo para um executável concreto, conferindo que existe.
pub fn resolve_shell(kind: ShellKind) -> Result<(String, Vec<String>), String> {
    #[cfg(windows)]
    let candidatos: Vec<(&str, Vec<String>)> = match kind {
        ShellKind::PowerShell => vec![
            (r"C:\Program Files\PowerShell\7\pwsh.exe", vec!["-NoLogo".into()]),
            (
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                vec!["-NoLogo".into()],
            ),
        ],
        ShellKind::Cmd => vec![(r"C:\Windows\System32\cmd.exe", vec![])],
        // Git Bash é o `bash` que existe numa estação Windows do time.
        ShellKind::Bash => vec![
            (r"C:\Program Files\Git\bin\bash.exe", vec!["-i".into()]),
            (r"C:\Program Files\Git\usr\bin\bash.exe", vec!["-i".into()]),
        ],
        ShellKind::Default => vec![
            (r"C:\Program Files\PowerShell\7\pwsh.exe", vec!["-NoLogo".into()]),
            (
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                vec!["-NoLogo".into()],
            ),
            (r"C:\Windows\System32\cmd.exe", vec![]),
        ],
    };
    #[cfg(not(windows))]
    let candidatos: Vec<(&str, Vec<String>)> = match kind {
        ShellKind::Bash => vec![("/bin/bash", vec!["-l".into()])],
        ShellKind::PowerShell => vec![("/usr/bin/pwsh", vec!["-NoLogo".into()])],
        // `cmd` não existe fora do Windows; cair no shell padrão é melhor que
        // recusar por um pedido que a tela pode fazer sem saber o host.
        ShellKind::Cmd | ShellKind::Default => vec![("/bin/sh", vec!["-l".into()])],
    };

    for (caminho, args) in &candidatos {
        if PathBuf::from(caminho).is_file() {
            return Ok(((*caminho).to_string(), args.clone()));
        }
    }
    // Fora da lista, o último recurso é o SHELL do ambiente (Unix) — nunca um
    // caminho vindo do renderer.
    #[cfg(not(windows))]
    if let Ok(shell) = std::env::var("SHELL") {
        if PathBuf::from(&shell).is_file() {
            return Ok((shell, vec!["-l".into()]));
        }
    }
    Err(format!(
        "SHELL_NOT_FOUND: nenhum shell disponível para o tipo {kind:?}"
    ))
}

/* -------------------------- Decodificador UTF-8 ------------------------ */

/// Decodifica bytes do PTY remontando caractere partido entre leituras.
///
/// O PTY entrega bytes, não caracteres: um `ç` (2 bytes) ou um emoji (4) pode
/// cair metade num bloco de 8192 e metade no seguinte. `from_utf8_lossy` por
/// bloco transformava a metade em `U+FFFD` — bastava um `ls` de pasta com
/// acento para a saída sair corrompida.
///
/// Byte genuinamente inválido (não só incompleto) vira `U+FFFD` e é consumido:
/// segurá-lo travaria o fluxo para sempre esperando um final que não vem.
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
                    // `ate` vem de `from_utf8`, então é fronteira válida.
                    saida.push_str(std::str::from_utf8(&carry[..ate]).unwrap_or_default());
                }
                match erro.error_len() {
                    // Byte inválido de verdade: descarta e segue.
                    Some(tamanho) => {
                        saida.push('\u{FFFD}');
                        carry.drain(..ate + tamanho);
                    }
                    // Sequência incompleta no FIM: guarda o resto para o
                    // próximo bloco completar.
                    None => {
                        carry.drain(..ate);
                        if carry.len() > MAX_CARRY {
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

/* -------------------------------- Estado ------------------------------ */

struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Mata o filho de OUTRA thread. O `Child` foi movido para a thread que
    /// espera (`wait()` precisa de `&mut`), então guardar o `Child` aqui
    /// impediria o kill de pegar o lock enquanto a espera acontece.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    cwd: String,
    target: String,
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

/* -------------------------------- Comandos ---------------------------- */

/// Abre uma sessão. `ssh: Some(target)` roteia para o servidor (item 2).
///
/// Não existe parâmetro de caminho de executável — de propósito (item 1).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<ShellKind>,
    ssh: Option<SshTarget>,
) -> Result<String, String> {
    let cols = cols.unwrap_or(80).clamp(20, 500);
    let rows = rows.unwrap_or(24).clamp(5, 200);

    {
        let sessions = lock_sessions(&state)?;
        if sessions.len() >= MAX_SESSIONS {
            return Err(err(
                "SESSION_LIMIT",
                format!("limite de {MAX_SESSIONS} terminais abertos — feche algum antes"),
            ));
        }
    }

    // Monta o comando ANTES de abrir o PTY: falhar aqui não deixa PTY órfão.
    let (programa, argumentos, cwd_str, rotulo) = match &ssh {
        Some(target) => {
            validate_target(target)?;
            // O cwd local não vale para sessão remota: quem entra na pasta é o
            // `cd` do payload remoto (`remoteWorkdir`). Dizer o contrário na
            // tela seria o engano do item 2 com outra roupa.
            (
                "ssh".to_string(),
                build_interactive_args(target),
                target
                    .remote_workdir
                    .clone()
                    .unwrap_or_else(|| "~".to_string()),
                format!("{}@{}", target.user, target.host),
            )
        }
        None => {
            let caminho = valid_cwd(cwd)?;
            let (programa, argumentos) = resolve_shell(shell.unwrap_or_default())?;
            let texto = caminho.to_string_lossy().into_owned();
            (programa, argumentos, texto, "local".to_string())
        }
    };

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
    if ssh.is_none() {
        cmd.cwd(&cwd_str);
    }
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
        err("READER_FAILED", format!("falha ao obter reader do PTY: {erro}"))
    })?;
    let writer = pair.master.take_writer().map_err(|erro| {
        err("WRITER_FAILED", format!("falha ao obter writer do PTY: {erro}"))
    })?;

    let id = uuid::Uuid::new_v4().to_string();
    let alive = Arc::new(AtomicBool::new(true));
    let killed = Arc::new(AtomicBool::new(false));

    // ---- thread de LEITURA: só dados. Não emite exit (ver item 3). ----
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
                            // Webview sumiu: não há para quem entregar.
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

    // ---- thread de ESPERA: chama wait(), emite UM exit com código real ----
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
                target: rotulo,
                cols,
                rows,
                alive: Arc::clone(&alive),
                killed,
            },
        );
    }

    Ok(id)
}

/// Escreve teclas na sessão. **Tecla de humano** — ver o cabeçalho do módulo.
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

/// Informa o novo tamanho da janela ao processo (SIGWINCH).
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

/// Encerra a sessão. Idempotente.
///
/// Não emite `pty-exit` aqui: quem emite é a thread de espera, com o código
/// real. Emitir dos dois lados era a duplicidade do rascunho (item 3).
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = lock_sessions(&state)?;
    let Some(session) = sessions.remove(&id) else {
        return Ok(());
    };
    session.killed.store(true, Ordering::SeqCst);
    if let Ok(mut killer) = session.killer.lock() {
        // Processo pode já ter morrido — não é falha da operação.
        let _ = killer.kill();
    }
    Ok(())
}

/// Encerra todas. Existe para o desligamento do app não deixar shell órfão.
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
            target: session.target.clone(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn caractere_de_dois_bytes_partido_entre_leituras_remonta() {
        // "ção" — o `ç` é C3 A7. Parte no meio dele.
        let bytes = "ção".as_bytes().to_vec();
        let mut carry = Vec::new();
        let primeiro = decode_stream(&mut carry, &bytes[..1]);
        // Metade de caractere não pode ser emitida como U+FFFD.
        assert_eq!(primeiro, "");
        let segundo = decode_stream(&mut carry, &bytes[1..]);
        assert_eq!(segundo, "ção");
        assert!(carry.is_empty());
    }

    #[test]
    fn emoji_de_quatro_bytes_partido_remonta() {
        let bytes = "ok 🚀".as_bytes().to_vec();
        let corte = bytes.len() - 2;
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &bytes[..corte]), "ok ");
        assert_eq!(decode_stream(&mut carry, &bytes[corte..]), "🚀");
    }

    #[test]
    fn byte_a_byte_ainda_remonta_tudo() {
        let bytes = "árvore 🌳 ok".as_bytes().to_vec();
        let mut carry = Vec::new();
        let mut saida = String::new();
        for byte in &bytes {
            saida.push_str(&decode_stream(&mut carry, &[*byte]));
        }
        assert_eq!(saida, "árvore 🌳 ok");
        assert!(carry.is_empty());
    }

    #[test]
    fn byte_invalido_de_verdade_vira_marcador_e_nao_trava() {
        // 0xFF nunca é UTF-8 válido. Precisa ser consumido, não segurado:
        // segurá-lo esperando um final que não vem travaria a saída.
        let mut carry = Vec::new();
        let saida = decode_stream(&mut carry, &[b'a', 0xFF, b'b']);
        assert_eq!(saida, "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    #[test]
    fn sequencia_incompleta_que_nunca_completa_nao_cresce_para_sempre() {
        // Só prefixos de continuação: sem a guarda de MAX_CARRY o buffer
        // cresceria sem limite e a saída ficaria presa nele.
        let mut carry = Vec::new();
        let mut saida = String::new();
        for _ in 0..20 {
            saida.push_str(&decode_stream(&mut carry, &[0xE2]));
        }
        assert!(carry.len() <= MAX_CARRY);
        assert!(saida.contains('\u{FFFD}'));
    }

    #[test]
    fn shell_default_resolve_para_algo_que_existe() {
        // Não afirma QUAL shell (varia por máquina), só que resolve para um
        // caminho existente em vez de estourar.
        let resolvido = resolve_shell(ShellKind::Default);
        assert!(resolvido.is_ok(), "shell padrão não resolveu: {resolvido:?}");
        let (caminho, _) = resolvido.unwrap();
        assert!(PathBuf::from(&caminho).is_file(), "{caminho} não é arquivo");
    }

    #[test]
    fn shell_kind_desconhecido_nao_aceita_caminho_do_renderer() {
        // O tipo é um enum fechado: não existe variante que carregue caminho.
        // Este teste trava a garantia do item 1 do cabeçalho — se alguém
        // acrescentar `Custom(String)`, ele para de compilar.
        let json = serde_json::to_string(&serde_json::json!("powerShell")).unwrap();
        let kind: ShellKind = serde_json::from_str(&json).unwrap();
        assert_eq!(kind, ShellKind::PowerShell);
        assert!(serde_json::from_str::<ShellKind>("\"C:\\\\evil.exe\"").is_err());
    }
}
