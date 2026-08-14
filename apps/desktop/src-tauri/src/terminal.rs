use crate::runtime;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Instant,
};
use tokio::{
    process::Command,
    time::{timeout, Duration},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRuntime {
    id: String,
    label: String,
    commands: Vec<String>,
    installed: bool,
    source: String,
    managed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    runtime_required: Option<String>,
}

fn definitions() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
    vec![
        ("node", "Node.js", &["node", "npm", "npx"]),
        ("python", "Python", &["python", "py", "pip"]),
        ("go", "Go", &["go", "gofmt"]),
        ("rust", "Rust", &["cargo", "rustc", "rustup"]),
        ("deno", "Deno", &["deno"]),
        ("bun", "Bun", &["bun", "bunx"]),
        ("java", "Java", &["java", "javac", "jar"]),
        ("dotnet", ".NET", &["dotnet"]),
        ("php", "PHP", &["php"]),
        ("git", "Git", &["git"]),
    ]
}

fn managed_root() -> Option<PathBuf> {
    dirs::data_local_dir().map(|root| root.join("Multiplike-AI").join("Runtimes"))
}

fn runtime_definition(
    runtime_id: &str,
) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    definitions()
        .into_iter()
        .find(|(id, _, _)| *id == runtime_id)
}

fn managed_command_path(command: &str) -> Option<PathBuf> {
    let (runtime_id, _, _) = definitions()
        .into_iter()
        .find(|(_, _, commands)| commands.contains(&command))?;
    let root = managed_root()?.join(runtime_id);
    [root.clone(), root.join("bin")]
        .into_iter()
        .find_map(|directory| {
            [
                format!("{command}.exe"),
                format!("{command}.cmd"),
                format!("{command}.bat"),
                command.to_owned(),
            ]
            .into_iter()
            .map(|name| directory.join(name))
            .find(|path| path.is_file())
        })
}

fn command_exists(command: &str) -> bool {
    let managed = managed_command_path(command).is_some();
    managed
        || std::process::Command::new("where.exe")
            .arg(command)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

fn runtime_for(command: &str) -> Option<&'static str> {
    let first = command
        .trim_start()
        .split_whitespace()
        .next()?
        .trim_matches('"')
        .to_ascii_lowercase();
    let executable = first
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&first)
        .trim_end_matches(".exe");
    definitions()
        .into_iter()
        .find_map(|(id, _, commands)| commands.contains(&executable).then_some(id))
}

#[tauri::command]
pub fn terminal_catalog() -> Vec<LanguageRuntime> {
    definitions()
        .into_iter()
        .map(|(id, label, commands)| {
            let installed = commands.iter().any(|command| command_exists(command));
            let managed = managed_root().is_some_and(|root| root.join(id).is_dir());
            LanguageRuntime {
                id: id.into(),
                label: label.into(),
                commands: commands.iter().map(|command| (*command).into()).collect(),
                installed,
                source: if managed {
                    "Multiplike-AI".into()
                } else if installed {
                    "Sistema".into()
                } else {
                    "Catálogo assinado".into()
                },
                managed,
            }
        })
        .collect()
}

fn valid_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let candidate = cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "workspace do terminal não encontrado".to_string())?;
    if !canonical.is_dir() || !canonical.is_absolute() {
        return Err("workspace do terminal deve ser uma pasta absoluta existente".into());
    }
    Ok(canonical)
}

fn augmented_path() -> String {
    let mut entries: Vec<PathBuf> = managed_root()
        .into_iter()
        .flat_map(|root| {
            definitions().into_iter().flat_map(move |(id, _, _)| {
                let runtime = root.join(id);
                [runtime.clone(), runtime.join("bin")]
            })
        })
        .collect();
    if let Some(system) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&system));
    }
    std::env::join_paths(entries)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub async fn terminal_execute(
    command: String,
    cwd: Option<String>,
) -> Result<TerminalResult, String> {
    let command = command.trim().to_owned();
    if command.is_empty() || command.len() > 8_192 {
        return Err("o comando deve ter entre 1 e 8.192 caracteres".into());
    }
    if let Some(required) = runtime_for(&command) {
        let installed = definitions()
            .into_iter()
            .find(|(id, _, _)| *id == required)
            .is_some_and(|(_, _, commands)| commands.iter().any(|item| command_exists(item)));
        if !installed {
            if let Err(error) = install_runtime(required).await {
                return Ok(TerminalResult { command, exit_code: None, stdout: String::new(), stderr: format!("Runtime {required} indisponível. O provisionamento automático assinado não foi concluído: {error}"), duration_ms: 0, runtime_required: Some(required.into()) });
            }
        }
    }
    let cwd = valid_cwd(cwd)?;
    let start = Instant::now();
    let mut child = Command::new("cmd.exe");
    child
        .args(["/D", "/S", "/C", &command])
        .current_dir(cwd)
        .env("PATH", augmented_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    child.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(120), child.output())
        .await
        .map_err(|_| "o comando excedeu o limite de 120 segundos".to_string())?
        .map_err(|error| error.to_string())?;
    Ok(TerminalResult {
        command,
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        duration_ms: start.elapsed().as_millis() as u64,
        runtime_required: None,
    })
}

fn archive_entries_are_safe(listing: &str) -> bool {
    listing
        .lines()
        .filter(|line| !line.trim().is_empty())
        .all(|line| {
            let path = Path::new(line.trim());
            !path.is_absolute()
                && path.components().all(|component| {
                    !matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
        })
}

async fn install_runtime(runtime_id: &str) -> Result<(), String> {
    let known: HashMap<_, _> = definitions()
        .into_iter()
        .map(|(id, label, _)| (id, label))
        .collect();
    if !known.contains_key(runtime_id) {
        return Err("runtime desconhecido".into());
    }
    let root = managed_root().ok_or("LOCALAPPDATA indisponível")?;
    let destination = root.join(runtime_id);
    if destination.is_dir() {
        return Ok(());
    }
    let component = runtime::release_component_by_id(&format!("language-{runtime_id}")).await?;
    let cache = dirs::data_local_dir()
        .ok_or("LOCALAPPDATA indisponível")?
        .join("Multiplike-AI")
        .join("Installer");
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|error| error.to_string())?;
    let archive = cache.join(format!("language-{runtime_id}.tar.gz"));
    runtime::verified_download(&component.url, &component.sha256, &archive).await?;
    let mut list = Command::new("tar.exe");
    list.args(["-tf", archive.to_string_lossy().as_ref()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    list.creation_flags(0x08000000);
    let listing = list
        .output()
        .await
        .map_err(|error| format!("tar.exe indisponível: {error}"))?;
    if !listing.status.success()
        || !archive_entries_are_safe(&String::from_utf8_lossy(&listing.stdout))
    {
        return Err("o pacote de runtime contém caminhos inválidos".into());
    }
    let staging = root.join(format!(".{runtime_id}-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|error| error.to_string())?;
    let mut extract = Command::new("tar.exe");
    extract
        .args([
            "-xf",
            archive.to_string_lossy().as_ref(),
            "-C",
            staging.to_string_lossy().as_ref(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    extract.creation_flags(0x08000000);
    let result = extract.output().await.map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "falha ao extrair runtime: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    let (_, _, commands) = runtime_definition(runtime_id).ok_or("runtime desconhecido")?;
    let primary = commands[0];
    let valid = [
        staging.join(format!("{primary}.exe")),
        staging.join("bin").join(format!("{primary}.exe")),
        staging.join(primary),
        staging.join("bin").join(primary),
    ]
    .into_iter()
    .any(|path| path.is_file());
    if !valid {
        return Err(format!("pacote de runtime não contém o comando {primary}"));
    }
    tokio::fs::rename(staging, destination)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_runtime_install(runtime_id: String) -> Result<(), String> {
    install_runtime(&runtime_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_runtime_without_executing_it() {
        assert_eq!(runtime_for("python main.py"), Some("python"));
        assert_eq!(runtime_for("cargo test"), Some("rust"));
        assert_eq!(runtime_for("custom-tool run"), None);
    }

    #[test]
    fn rejects_unknown_runtime_installs() {
        assert!(runtime_definition("ruby").is_none());
        assert!(runtime_definition("python").is_some());
    }

    #[test]
    fn blocks_archive_path_traversal() {
        assert!(archive_entries_are_safe("bin/node.exe\nREADME.txt\n"));
        assert!(!archive_entries_are_safe("../escape.exe\n"));
        assert!(!archive_entries_are_safe("C:\\escape.exe\n"));
    }
}
