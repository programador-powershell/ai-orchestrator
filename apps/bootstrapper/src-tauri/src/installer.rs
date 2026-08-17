use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    process::Command,
    time::sleep,
};

const PRODUCT: &str = "AI-BOT";
const BOOTSTRAPPER_VERSION: &str = env!("CARGO_PKG_VERSION");
const OFFLINE_INSTALLER: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/offline-desktop-installer.exe"));
const OFFLINE_INSTALLER_SIZE: &str = env!("OFFLINE_INSTALLER_SIZE");
const OFFLINE_INSTALLER_SHA256: &str = env!("OFFLINE_INSTALLER_SHA256");
const OFFLINE_INSTALLER_VERSION: &str = env!("OFFLINE_INSTALLER_VERSION");

#[derive(Clone, Default)]
pub struct InstallState {
    paused: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    phase: &'static str,
    downloaded: u64,
    total: u64,
    bytes_per_second: u64,
    eta_seconds: Option<u64>,
    message: String,
}

#[derive(Deserialize)]
struct SignedManifest {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u8,
    product: String,
    channel: String,
    version: String,
    minimum_bootstrapper_version: String,
    publisher: String,
    components: Vec<ReleaseComponent>,
}

#[derive(Clone, Deserialize)]
struct ReleaseComponent {
    id: String,
    url: String,
    size: u64,
    sha256: String,
}

fn offline_manifest() -> Option<ReleaseManifest> {
    if OFFLINE_INSTALLER.is_empty() {
        return None;
    }
    let size = OFFLINE_INSTALLER_SIZE.parse().ok()?;
    Some(ReleaseManifest {
        schema_version: 1,
        product: PRODUCT.into(),
        channel: "local".into(),
        version: OFFLINE_INSTALLER_VERSION.into(),
        minimum_bootstrapper_version: BOOTSTRAPPER_VERSION.into(),
        publisher: "Local development build".into(),
        components: vec![ReleaseComponent {
            id: "desktop".into(),
            url: "embedded://desktop".into(),
            size,
            sha256: OFFLINE_INSTALLER_SHA256.into(),
        }],
    })
}

fn emit(
    app: &AppHandle,
    phase: &'static str,
    downloaded: u64,
    total: u64,
    speed: u64,
    eta: Option<u64>,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "installer-progress",
        ProgressEvent {
            phase,
            downloaded,
            total,
            bytes_per_second: speed,
            eta_seconds: eta,
            message: message.into(),
        },
    );
}

fn cache_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join(PRODUCT).join("Installer"))
        .ok_or_else(|| "LOCALAPPDATA não está disponível".into())
}

fn install_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join(PRODUCT))
        .ok_or_else(|| "LOCALAPPDATA não está disponível".into())
}

fn https_only(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "URL de release inválida".to_string())?;
    if url.scheme() != "https" {
        return Err("a distribuição exige HTTPS".into());
    }
    Ok(())
}

async fn signed_manifest() -> Result<ReleaseManifest, String> {
    let url = option_env!("RELEASE_MANIFEST_URL").ok_or_else(|| {
        "Este instalador é um build de desenvolvimento e não possui um canal de download. Baixe o AI-BOT Setup em uma Release publicada.".to_string()
    })?;
    if url.contains("__") {
        return Err(
            "Este instalador foi gerado sem configurar o canal de distribuição. Baixe novamente o AI-BOT Setup em uma Release publicada."
                .into(),
        );
    }
    https_only(url)?;
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|_| {
            "Não foi possível acessar o servidor de instalação. Verifique sua conexão, proxy ou firewall."
                .to_string()
        })?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(
            "Ainda não existe uma versão publicada neste canal. Baixe o instalador pela página oficial de Releases."
                .into(),
        );
    }
    let envelope: SignedManifest = response
        .error_for_status()
        .map_err(|error| {
            format!(
                "O servidor de instalação respondeu com {}.",
                error
                    .status()
                    .map_or_else(|| "um erro".into(), |status| status.as_u16().to_string())
            )
        })?
        .json()
        .await
        .map_err(|e| format!("manifesto inválido: {e}"))?;

    let payload = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "payload do manifesto inválido".to_string())?;
    let signature_bytes = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "assinatura do manifesto inválida".to_string())?;
    let configured_public_key = option_env!("INSTALLER_MANIFEST_PUBLIC_KEY").ok_or_else(|| {
        "Este instalador não possui a chave de verificação do canal de distribuição. Baixe-o novamente pela página oficial de Releases."
            .to_string()
    })?;
    let public_key_bytes = STANDARD
        .decode(configured_public_key)
        .map_err(|_| "chave pública do instalador não foi configurada no build".to_string())?;
    let public_key: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| "chave pública Ed25519 deve ter 32 bytes".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "assinatura Ed25519 inválida".to_string())?;
    VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "chave pública Ed25519 inválida".to_string())?
        .verify(&payload, &signature)
        .map_err(|_| "o manifesto não foi assinado pelo publicador esperado".to_string())?;

    let manifest: ReleaseManifest = serde_json::from_slice(&payload)
        .map_err(|e| format!("payload do manifesto inválido: {e}"))?;
    if manifest.schema_version != 1 || manifest.product != PRODUCT {
        return Err("manifesto incompatível com este produto".into());
    }
    let current = Version::parse(BOOTSTRAPPER_VERSION).map_err(|e| e.to_string())?;
    let minimum = Version::parse(&manifest.minimum_bootstrapper_version)
        .map_err(|_| "versão mínima inválida".to_string())?;
    if current < minimum {
        return Err("este instalador está desatualizado; baixe a versão mais recente".into());
    }
    Ok(manifest)
}

async fn download(
    app: &AppHandle,
    state: &InstallState,
    component: &ReleaseComponent,
    target: &Path,
) -> Result<(), String> {
    https_only(&component.url)?;
    let part = target.with_extension("exe.part");
    let mut offset = fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0)
        .min(component.size);
    if fs2::available_space(target.parent().unwrap_or_else(|| Path::new(".")))
        .map_err(|e| e.to_string())?
        < component.size.saturating_sub(offset) + 64 * 1024 * 1024
    {
        return Err("espaço em disco insuficiente para concluir a instalação".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(&component.url);
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("download interrompido: {e}"))?
        .error_for_status()
        .map_err(|e| format!("servidor de download respondeu: {e}"))?;
    if offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        offset = 0;
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&part)
        .await
        .map_err(|e| e.to_string())?;
    if offset == 0 {
        file.set_len(0).await.map_err(|e| e.to_string())?;
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let initial = offset;
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    emit(
        app,
        "downloading",
        offset,
        component.size,
        0,
        None,
        "Baixando o cliente pré-compilado…",
    );

    while let Some(chunk) = stream.next().await {
        if state.cancelled.load(Ordering::Relaxed) {
            return Err("__cancelled__".into());
        }
        while state.paused.load(Ordering::Relaxed) {
            emit(
                app,
                "paused",
                offset,
                component.size,
                0,
                None,
                "Seu progresso foi preservado. Retome quando quiser.",
            );
            sleep(Duration::from_millis(200)).await;
            if state.cancelled.load(Ordering::Relaxed) {
                return Err("__cancelled__".into());
            }
        }
        let chunk = chunk.map_err(|e| format!("download interrompido: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        offset += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(180) {
            let elapsed = started.elapsed().as_secs_f64().max(0.01);
            let speed = ((offset - initial) as f64 / elapsed) as u64;
            let eta = (speed > 0).then(|| component.size.saturating_sub(offset) / speed);
            emit(
                app,
                "downloading",
                offset,
                component.size,
                speed,
                eta,
                "Baixando o cliente pré-compilado…",
            );
            last_emit = Instant::now();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    if offset != component.size {
        return Err(format!(
            "o download terminou incompleto ({offset} de {} bytes)",
            component.size
        ));
    }
    fs::rename(part, target).await.map_err(|e| e.to_string())
}

async fn materialize_offline(
    app: &AppHandle,
    state: &InstallState,
    target: &Path,
) -> Result<(), String> {
    let total = OFFLINE_INSTALLER.len() as u64;
    let part = target.with_extension("exe.part");
    let mut file = fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut written = 0u64;

    emit(
        app,
        "downloading",
        0,
        total,
        0,
        None,
        "Preparando o pacote local do aplicativo…",
    );
    for chunk in OFFLINE_INSTALLER.chunks(512 * 1024) {
        if state.cancelled.load(Ordering::Relaxed) {
            return Err("__cancelled__".into());
        }
        while state.paused.load(Ordering::Relaxed) {
            emit(
                app,
                "paused",
                written,
                total,
                0,
                None,
                "O pacote local foi pausado. Retome quando quiser.",
            );
            sleep(Duration::from_millis(120)).await;
            if state.cancelled.load(Ordering::Relaxed) {
                return Err("__cancelled__".into());
            }
        }
        file.write_all(chunk).await.map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
        let elapsed = started.elapsed().as_secs_f64().max(0.01);
        let speed = (written as f64 / elapsed) as u64;
        let eta = (speed > 0).then(|| total.saturating_sub(written) / speed);
        emit(
            app,
            "downloading",
            written,
            total,
            speed,
            eta,
            "Preparando o pacote local do aplicativo…",
        );
        sleep(Duration::from_millis(12)).await;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    fs::rename(part, target).await.map_err(|e| e.to_string())
}

async fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).await.map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if hex::encode(digest.finalize()).eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("o checksum do instalador é inválido; o arquivo foi rejeitado".into())
    }
}

#[cfg(windows)]
async fn verify_authenticode(path: &Path, publisher: &str) -> Result<(), String> {
    let escaped_path = path.to_string_lossy().replace('\'', "''");
    let script = format!("$s=Get-AuthenticodeSignature -LiteralPath '{escaped_path}'; [pscustomobject]@{{Status=$s.Status.ToString();Subject=$s.SignerCertificate.Subject}} | ConvertTo-Json -Compress");
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("não foi possível validar a assinatura Authenticode".into());
    }
    #[derive(Deserialize)]
    struct SignatureInfo {
        #[serde(rename = "Status")]
        status: String,
        #[serde(rename = "Subject")]
        subject: Option<String>,
    }
    let info: SignatureInfo = serde_json::from_slice(&output.stdout)
        .map_err(|_| "resposta Authenticode inválida".to_string())?;
    if info.status != "Valid" {
        return Err(format!(
            "assinatura Authenticode rejeitada: {}",
            info.status
        ));
    }
    if !info
        .subject
        .unwrap_or_default()
        .to_lowercase()
        .contains(&publisher.to_lowercase())
    {
        return Err("o publisher Authenticode não corresponde ao manifesto".into());
    }
    Ok(())
}

#[cfg(not(windows))]
async fn verify_authenticode(_path: &Path, _publisher: &str) -> Result<(), String> {
    Err("Authenticode só pode ser validado no Windows".into())
}

async fn run_install(app: AppHandle, state: InstallState) -> Result<(), String> {
    let is_offline = !OFFLINE_INSTALLER.is_empty();
    emit(
        &app,
        "preparing",
        0,
        0,
        0,
        None,
        if is_offline {
            "Carregando o pacote local…"
        } else {
            "Consultando a versão mais recente…"
        },
    );
    let manifest = match offline_manifest() {
        Some(manifest) => manifest,
        None => signed_manifest().await?,
    };
    let component = manifest
        .components
        .iter()
        .find(|item| item.id == "desktop")
        .cloned()
        .ok_or_else(|| "o release não contém o cliente desktop".to_string())?;
    let cache = cache_dir()?;
    fs::create_dir_all(&cache)
        .await
        .map_err(|e| e.to_string())?;
    let installer = cache.join(format!("AI-BOT-{}-setup.exe", manifest.version));
    let needs_materialization = if installer.exists() {
        match verify_sha256(&installer, &component.sha256).await {
            Ok(()) => false,
            Err(_) => {
                fs::remove_file(&installer)
                    .await
                    .map_err(|e| e.to_string())?;
                true
            }
        }
    } else {
        true
    };
    if needs_materialization {
        if is_offline {
            materialize_offline(&app, &state, &installer).await?;
        } else {
            download(&app, &state, &component, &installer).await?;
        }
    }

    emit(
        &app,
        "verifying",
        component.size,
        component.size,
        0,
        None,
        "Validando integridade e assinatura digital…",
    );
    if let Err(error) = verify_sha256(&installer, &component.sha256).await {
        let _ = fs::remove_file(&installer).await;
        return Err(error);
    }
    if manifest.channel == "stable" {
        if let Err(error) = verify_authenticode(&installer, &manifest.publisher).await {
            let _ = fs::remove_file(&installer).await;
            return Err(error);
        }
    }

    emit(
        &app,
        "installing",
        component.size,
        component.size,
        0,
        None,
        "Instalando somente para o seu usuário…",
    );
    let destination = install_dir()?;
    fs::create_dir_all(&destination)
        .await
        .map_err(|e| e.to_string())?;
    let status = Command::new(&installer)
        .arg("/S")
        .arg(format!("/D={}", destination.display()))
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("não foi possível iniciar o instalador: {e}"))?;
    if !status.success() {
        return Err(format!(
            "o instalador terminou com o código {:?}",
            status.code()
        ));
    }

    emit(
        &app,
        "starting",
        component.size,
        component.size,
        0,
        Some(0),
        "Abrindo o AI-BOT…",
    );
    let executable = destination.join("ai-bot-desktop.exe");
    if !executable.exists() {
        return Err("a instalação terminou, mas o aplicativo não foi encontrado".into());
    }
    Command::new(executable)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("não foi possível abrir o aplicativo: {e}"))?;
    emit(
        &app,
        "complete",
        component.size,
        component.size,
        0,
        Some(0),
        "Instalação concluída com sucesso.",
    );
    sleep(Duration::from_millis(900)).await;
    app.exit(0);
    Ok(())
}

fn spawn_install(app: AppHandle, state: InstallState) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    state.cancelled.store(false, Ordering::SeqCst);
    state.paused.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let result = run_install(app.clone(), state.clone()).await;
        state.running.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            if error == "__cancelled__" {
                emit(
                    &app,
                    "cancelled",
                    0,
                    0,
                    0,
                    None,
                    "O arquivo parcial foi preservado para uma retomada futura.",
                );
            } else {
                emit(&app, "error", 0, 0, 0, None, error);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn begin_install(app: AppHandle, state: State<'_, InstallState>) -> Result<(), String> {
    spawn_install(app, state.inner().clone())
}

#[tauri::command]
pub fn pause_install(state: State<'_, InstallState>) {
    state.paused.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn resume_install(state: State<'_, InstallState>) {
    state.paused.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_install(state: State<'_, InstallState>) {
    state.cancelled.store(true, Ordering::SeqCst);
    state.paused.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn retry_install(app: AppHandle, state: State<'_, InstallState>) -> Result<(), String> {
    spawn_install(app, state.inner().clone())
}

#[tauri::command]
pub fn close_installer(app: AppHandle, state: State<'_, InstallState>) {
    state.cancelled.store(true, Ordering::SeqCst);
    state.paused.store(false, Ordering::SeqCst);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::{https_only, OFFLINE_INSTALLER, OFFLINE_INSTALLER_SHA256, OFFLINE_INSTALLER_SIZE};
    use sha2::{Digest, Sha256};

    #[test]
    fn release_downloads_require_https() {
        assert!(https_only("https://github.com/example/release.exe").is_ok());
        assert!(https_only("http://example.com/release.exe").is_err());
        assert!(https_only("file:///C:/release.exe").is_err());
    }

    #[test]
    fn embedded_installer_metadata_matches_its_bytes() {
        if OFFLINE_INSTALLER.is_empty() {
            return;
        }
        assert_eq!(
            OFFLINE_INSTALLER.len(),
            OFFLINE_INSTALLER_SIZE.parse::<usize>().unwrap()
        );
        assert_eq!(
            hex::encode(Sha256::digest(OFFLINE_INSTALLER)),
            OFFLINE_INSTALLER_SHA256
        );
    }
}
