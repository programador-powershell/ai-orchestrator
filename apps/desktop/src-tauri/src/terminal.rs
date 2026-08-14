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

/// Limite padrao de um comando avulso.
const TIMEOUT_PADRAO_MS: u64 = 120_000;
/// Piso: menos que isto e erro de quem chama, nao configuracao.
const TIMEOUT_MIN_MS: u64 = 1_000;
/// Teto: uma hora. Existe para um valor absurdo nao virar processo eterno.
const TIMEOUT_MAX_MS: u64 = 3_600_000;

/// Prazo efetivo, preso na faixa aceitavel.
///
/// Publico para o teste — a regra que importa (0 vira o piso, 10^9 vira o
/// teto) some se ficar escondida dentro do comando.
pub fn prazo_ms(pedido: Option<u64>) -> u64 {
    pedido
        .unwrap_or(TIMEOUT_PADRAO_MS)
        .clamp(TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
}

#[tauri::command]
pub async fn terminal_execute(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<TerminalResult, String> {
    let command = command.trim().to_owned();
    if command.is_empty() || command.len() > 8_192 {
        return Err("o comando deve ter entre 1 e 8.192 caracteres".into());
    }
    /*
     * O app NAO INSTALA. Regra da organizacao, verificada aqui.
     *
     * Este e um dos tres caminhos que o MODELO dirige (terminal_execute). O terminal
     * interativo fica de fora de proposito: la quem digita sao as maos de
     * quem opera, e essa pessoa responde pelo que faz — a mesma razao pela
     * qual `pty_*` nunca entrou no registro de ferramentas do agente.
     *
     * O gate de aprovacao nao substitui esta checagem: quem clica "aprovar"
     * raramente distingue `npm i -D vitest` de `npm i -g`, e a diferenca
     * entre as duas e a maquina inteira.
     */
    if let Some(recusa) = crate::instalacao::tenta_instalar(&command) {
        return Err(format!("{}: {}", recusa.codigo, recusa.motivo));
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

    /*
     * Carga DOCKER vai pela microVM do `sbx`, quando ele existe.
     *
     * Construir imagem exige um daemon, e usar o daemon do host significa que
     * o build alcanca a rede, o socket e as imagens do host — um `Dockerfile`
     * com `RUN curl ... | sh` roda com o alcance do daemon, nao o do processo.
     * O `sbx` da daemon, filesystem e rede proprios.
     *
     * Sem `sbx` instalado o comando roda como sempre rodou: a ausencia dele
     * reduz a garantia, nao impede o build. Quem precisa saber qual garantia
     * valeu pergunta em `sbx_status`.
     *
     * Fora do Docker nada muda — o isolamento dos demais comandos e o Job
     * Object de `jail.rs`, que e o certo para eles.
     */
    let (programa, argumentos) = match crate::sbx::envolver(&command, cwd.to_str()) {
        Some((caminho, args)) => (caminho, args),
        None => (
            "cmd.exe".to_string(),
            vec!["/D".into(), "/S".into(), "/C".into(), command.clone()],
        ),
    };

    let mut child = Command::new(&programa);
    child
        .args(&argumentos)
        .current_dir(cwd)
        .env("PATH", augmented_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    child.creation_flags(0x08000000);
    /*
     * O prazo passou a ser de quem chama.
     *
     * 120s fixos matavam `docker build` de qualquer projeto real — e o erro
     * chegava como "excedeu o limite", que faz a pessoa procurar defeito no
     * Dockerfile em vez de no prazo. Continua havendo teto (uma hora) porque
     * sem nenhum o comando travado vira processo eterno sem dono.
     */
    let prazo = prazo_ms(timeout_ms);
    let output = timeout(Duration::from_millis(prazo), child.output())
        .await
        .map_err(|_| format!("o comando excedeu o limite de {} segundos", prazo / 1_000))?
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
