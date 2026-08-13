use crate::jail::{Jail, CREATION_FLAGS};
use serde::Serialize;
use std::{path::PathBuf, process::Stdio, time::Instant};
use tokio::{
    process::Command,
    time::{timeout, Duration},
};

const OUTPUT_LIMIT_BYTES: usize = 200 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResult {
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    isolated: bool,
    /// O processo rodou dentro de um Job Object (árvore inteira contida)?
    /// Falso = caiu no caminho degradado; a UI precisa dizer isso ao usuário.
    jailed: bool,
}

fn truncated(bytes: &[u8]) -> String {
    let slice = &bytes[..bytes.len().min(OUTPUT_LIMIT_BYTES)];
    String::from_utf8_lossy(slice).into_owned()
}

/// Retorna a pasta de trabalho e, quando ela foi criada só para esta execução,
/// o caminho a remover ao final (jail efêmero em %TEMP%).
///
/// `session` tem precedência sobre `cwd` de propósito. `cwd` é um caminho
/// ARBITRÁRIO do chamador — aceitável no painel, onde uma pessoa escolhe; para
/// um agente seria a saída da caixa (bastaria pedir a pasta do usuário). O
/// agente só manda um id de sessão, e quem resolve o caminho é o registro.
fn workdir(cwd: Option<String>, session: Option<String>) -> Result<(PathBuf, Option<PathBuf>), String> {
    if let Some(id) = session.filter(|value| !value.trim().is_empty()) {
        // Sessão é persistente entre chamadas: NÃO entra na remoção do final.
        return Ok((crate::workspace::session_path(id.trim())?, None));
    }
    if let Some(value) = cwd.filter(|value| !value.trim().is_empty()) {
        let canonical = PathBuf::from(value)
            .canonicalize()
            .map_err(|_| "pasta de trabalho da sandbox não encontrada".to_string())?;
        if !canonical.is_dir() {
            return Err("a pasta de trabalho da sandbox deve ser um diretório".into());
        }
        return Ok((canonical, None));
    }
    let jail = std::env::temp_dir().join(format!("ai-jail-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&jail).map_err(|error| error.to_string())?;
    Ok((jail.clone(), Some(jail)))
}

#[tauri::command]
pub async fn sandbox_execute(
    command: String,
    cwd: Option<String>,
    session: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<SandboxResult, String> {
    let command = command.trim().to_owned();
    if command.is_empty() || command.len() > 8_192 {
        return Err("o comando deve ter entre 1 e 8.192 caracteres".into());
    }
    let (directory, ephemeral) = workdir(cwd, session)?;
    let limit = Duration::from_millis(timeout_ms.unwrap_or(15_000));
    let temp = directory.to_string_lossy().into_owned();
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let mut child_command = Command::new("cmd.exe");
    child_command
        .args(["/D", "/S", "/C", &command])
        .current_dir(&directory)
        .env_clear()
        .env("SystemRoot", &system_root)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("PATH", "C:\\Windows\\System32;C:\\Windows")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // CREATE_SUSPENDED: o processo nasce parado para ser preso ao Job Object
    // ANTES de rodar. Sem isso o filho poderia criar netos fora do job.
    #[cfg(windows)]
    child_command.creation_flags(CREATION_FLAGS);
    let start = Instant::now();
    // O Jail vive até o fim desta função: quando cai (timeout, erro ou sucesso)
    // o KILL_ON_JOB_CLOSE encerra a ÁRVORE inteira — não só o cmd.exe.
    //
    // Falhar aqui é ERRO, não degradação silenciosa: rodar sem job enquanto a
    // UI diz "sandbox" seria mentir sobre a garantia. E, como o processo nasce
    // suspenso, sem job ele também nunca sairia do lugar.
    let jail = Jail::new().map_err(|error| {
        if let Some(directory) = ephemeral.as_ref() {
            let _ = std::fs::remove_dir_all(directory);
        }
        format!("não foi possível criar o isolamento da sandbox: {error}")
    })?;
    let result = async {
        let mut child = child_command.spawn().map_err(|error| error.to_string())?;
        let pid = child
            .id()
            .ok_or_else(|| "processo da sandbox terminou antes de ser isolado".to_string())?;
        jail.capture_and_resume(pid).map_err(|error| {
            let _ = child.start_kill();
            format!("não foi possível isolar a sandbox: {error}")
        })?;
        timeout(limit, child.wait_with_output())
            .await
            .map_err(|_| format!("a sandbox excedeu o limite de {} ms", limit.as_millis()))?
            .map_err(|error| error.to_string())
    }
    .await;
    if let Some(jail) = ephemeral {
        let _ = std::fs::remove_dir_all(jail);
    }
    let output = result?;
    Ok(SandboxResult {
        command,
        exit_code: output.status.code(),
        stdout: truncated(&output.stdout),
        stderr: truncated(&output.stderr),
        duration_ms: start.elapsed().as_millis() as u64,
        isolated: true,
        jailed: cfg!(windows),
    })
}
