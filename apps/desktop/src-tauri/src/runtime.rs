use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tauri::State;
use tokio::{
    fs,
    io::AsyncWriteExt,
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, Duration},
};

#[derive(Default)]
pub struct RuntimeManager {
    process: Arc<Mutex<Option<Child>>>,
    connection: Arc<Mutex<Option<(u16, String)>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    id: String,
    file_name: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    installed: bool,
    running: bool,
    variant: Option<String>,
    version: Option<String>,
    port: Option<u16>,
    /// Token do servidor local — permite apontar agentes externos (Claude Code,
    /// Codex) para o runtime. Fica em 127.0.0.1 e só existe enquanto ele roda.
    api_key: Option<String>,
    models: Vec<LocalModel>,
}

#[derive(Deserialize)]
struct SignedManifest {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    product: String,
    components: Vec<ReleaseComponent>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct ReleaseComponent {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) sha256: String,
}

fn root_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("Multiplike-AI").join("Runtime"))
        .ok_or_else(|| "LOCALAPPDATA indisponível".into())
}

fn safe_id(value: &str) -> Result<&str, String> {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        Ok(value)
    } else {
        Err("identificador inválido".into())
    }
}

async fn models() -> Result<Vec<LocalModel>, String> {
    let path = root_dir()?.join("models");
    fs::create_dir_all(&path).await.map_err(|e| e.to_string())?;
    let mut entries = fs::read_dir(path).await.map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let file = entry.path();
        if file
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("gguf"))
        {
            let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            result.push(LocalModel {
                id: name.trim_end_matches(".gguf").into(),
                file_name: name,
                size: metadata.len(),
            });
        }
    }
    Ok(result)
}

async fn status(manager: &RuntimeManager) -> Result<RuntimeStatus, String> {
    let root = root_dir()?;
    let variant_path = root.join("variant.txt");
    let installed = root.join("multiplike-ai-runtime.exe").exists();
    let variant = fs::read_to_string(variant_path)
        .await
        .ok()
        .map(|v| v.trim().to_owned());
    let stopped = {
        let mut process = manager.process.lock().await;
        match process.as_mut() {
            Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_some(),
            None => false,
        }
    };
    if stopped {
        *manager.process.lock().await = None;
        *manager.connection.lock().await = None;
    }
    let connection = manager.connection.lock().await;
    Ok(RuntimeStatus {
        installed,
        running: connection.is_some(),
        variant,
        version: None,
        port: connection.as_ref().map(|v| v.0),
        api_key: connection.as_ref().map(|v| v.1.clone()),
        models: models().await?,
    })
}

async fn release_component(variant: &str) -> Result<ReleaseComponent, String> {
    release_component_by_id(&format!("runtime-{variant}")).await
}

pub(crate) async fn release_component_by_id(id: &str) -> Result<ReleaseComponent, String> {
    let manifest_url = option_env!("RELEASE_MANIFEST_URL").unwrap_or(
        "https://github.com/__GITHUB_REPOSITORY__/releases/latest/download/installer-manifest.json",
    );
    require_https(manifest_url)?;
    let envelope: SignedManifest = reqwest::Client::new()
        .get(manifest_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let payload = STANDARD
        .decode(envelope.payload)
        .map_err(|_| "manifesto do runtime inválido".to_string())?;
    let signature_bytes = STANDARD
        .decode(envelope.signature)
        .map_err(|_| "assinatura do runtime inválida".to_string())?;
    let public_key_bytes = STANDARD
        .decode(
            option_env!("INSTALLER_MANIFEST_PUBLIC_KEY")
                .unwrap_or("__INSTALLER_MANIFEST_PUBLIC_KEY__"),
        )
        .map_err(|_| "chave pública de release não configurada".to_string())?;
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "chave pública de release inválida".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "assinatura Ed25519 inválida".to_string())?;
    VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "chave pública Ed25519 inválida".to_string())?
        .verify(&payload, &signature)
        .map_err(|_| "manifesto do runtime não é confiável".to_string())?;
    let manifest: ReleaseManifest = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    if manifest.product != "Multiplike-AI" {
        return Err("manifesto pertence a outro produto".into());
    }
    manifest
        .components
        .into_iter()
        .find(|component| component.id == id)
        .ok_or_else(|| format!("release não contém o componente {id}"))
}

fn require_https(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "URL inválida".to_string())?;
    if parsed.scheme() != "https" {
        return Err("downloads do runtime exigem HTTPS".into());
    }
    Ok(())
}

pub(crate) async fn verified_download(
    url: &str,
    expected_sha256: &str,
    target: &Path,
) -> Result<(), String> {
    require_https(url)?;
    let part = target.with_extension("part");
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    let actual = hex::encode(hash.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err("SHA-256 do download não corresponde ao manifesto".into());
    }
    fs::rename(part, target).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn runtime_status(state: State<'_, RuntimeManager>) -> Result<RuntimeStatus, String> {
    status(&state).await
}

#[tauri::command]
pub async fn runtime_install(
    state: State<'_, RuntimeManager>,
    variant: String,
) -> Result<RuntimeStatus, String> {
    if variant != "cpu" && variant != "vulkan" {
        return Err("variante inválida".into());
    }
    let component = release_component(&variant).await?;
    let root = root_dir()?;
    fs::create_dir_all(&root).await.map_err(|e| e.to_string())?;
    verified_download(
        &component.url,
        &component.sha256,
        &root.join("multiplike-ai-runtime.exe"),
    )
    .await?;
    fs::write(root.join("variant.txt"), variant)
        .await
        .map_err(|e| e.to_string())?;
    status(&state).await
}

#[tauri::command]
pub async fn runtime_start(
    state: State<'_, RuntimeManager>,
    model_id: String,
) -> Result<RuntimeStatus, String> {
    let id = safe_id(&model_id)?;
    let root = root_dir()?;
    let executable = root.join("multiplike-ai-runtime.exe");
    let model = root.join("models").join(format!("{id}.gguf"));
    if !executable.exists() || !model.exists() {
        return Err("runtime ou modelo não instalado".into());
    }
    runtime_stop(state.clone()).await?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let token = uuid::Uuid::new_v4().to_string();
    let child = Command::new(executable)
        .kill_on_drop(true)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--api-key",
            &token,
            "--model",
        ])
        .arg(model)
        .args(["--parallel", "4", "--metrics"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.process.lock().await = Some(child);
    *state.connection.lock().await = Some((port, token));
    let client = reqwest::Client::new();
    for _ in 0..120 {
        if client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return status(&state).await;
        }
        if !status(&state).await?.running {
            return Err("runtime local encerrou durante a inicialização".into());
        }
        sleep(Duration::from_millis(250)).await;
    }
    runtime_stop(state.clone()).await?;
    Err("runtime local não ficou pronto dentro de 30 segundos".into())
}

#[tauri::command]
pub async fn runtime_chat(
    state: State<'_, RuntimeManager>,
    messages: Value,
) -> Result<Value, String> {
    let (port, token) = state
        .connection
        .lock()
        .await
        .clone()
        .ok_or_else(|| "runtime local não está ativo".to_string())?;
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth(token)
        .json(&serde_json::json!({"model":"local","messages":messages,"stream":false}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Chat do runtime local COM STREAMING: os tokens chegam ao front pelo Channel
/// conforme o llama.cpp os gera, em vez de esperar a resposta inteira.
#[tauri::command]
pub async fn runtime_chat_stream(
    state: State<'_, RuntimeManager>,
    messages: Value,
    on_event: tauri::ipc::Channel<crate::providers::StreamEvent>,
) -> Result<String, String> {
    let (port, token) = state
        .connection
        .lock()
        .await
        .clone()
        .ok_or_else(|| "runtime local não está ativo".to_string())?;
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth(token)
        .json(&serde_json::json!({"model":"local","messages":messages,"stream":true}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let full = crate::providers::pump_sse(response, &on_event).await?;
    on_event
        .send(crate::providers::StreamEvent::Done(full.clone()))
        .map_err(|e| e.to_string())?;
    Ok(full)
}

#[tauri::command]
pub async fn runtime_stop(state: State<'_, RuntimeManager>) -> Result<RuntimeStatus, String> {
    shutdown(&state).await;
    status(&state).await
}

pub(crate) async fn shutdown(manager: &RuntimeManager) {
    if let Some(mut child) = manager.process.lock().await.take() {
        let _ = child.kill().await;
    }
    *manager.connection.lock().await = None;
}

#[tauri::command]
pub async fn runtime_list_models() -> Result<Vec<LocalModel>, String> {
    models().await
}

#[tauri::command]
pub async fn runtime_download_model(
    state: State<'_, RuntimeManager>,
    id: String,
    url: String,
    sha256: String,
) -> Result<RuntimeStatus, String> {
    let id = safe_id(&id)?;
    let directory = root_dir()?.join("models");
    fs::create_dir_all(&directory)
        .await
        .map_err(|e| e.to_string())?;
    verified_download(&url, &sha256, &directory.join(format!("{id}.gguf"))).await?;
    status(&state).await
}

#[tauri::command]
pub async fn runtime_remove_model(
    state: State<'_, RuntimeManager>,
    id: String,
) -> Result<RuntimeStatus, String> {
    let id = safe_id(&id)?;
    let path = root_dir()?.join("models").join(format!("{id}.gguf"));
    if path.exists() {
        fs::remove_file(path).await.map_err(|e| e.to_string())?;
    }
    status(&state).await
}

#[cfg(test)]
mod tests {
    use super::safe_id;

    #[test]
    fn model_ids_cannot_escape_the_runtime_directory() {
        assert!(safe_id("qwen3-8b_q4.gguf").is_ok());
        assert!(safe_id("../secrets").is_err());
        assert!(safe_id("model/path").is_err());
        assert!(safe_id("").is_err());
    }
}
