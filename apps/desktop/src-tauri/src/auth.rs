use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::{timeout, Duration},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcConfig {
    client_id: String,
    authorization_endpoint: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcSession {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
}

fn account(base_url: &str) -> String {
    format!("oidc:{}", base_url.trim_end_matches('/'))
}

fn store(base_url: &str, session: &OidcSession) -> Result<(), String> {
    let value = serde_json::to_string(session).map_err(|e| e.to_string())?;
    keyring::Entry::new("AI Orchestrator", &account(base_url))
        .map_err(|e| e.to_string())?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

async fn refresh(base_url: &str, session: &OidcSession) -> Result<OidcSession, String> {
    let refresh_token = session
        .refresh_token
        .as_ref()
        .ok_or_else(|| "sessão expirada; autentique novamente".to_string())?;
    let value: Value = reqwest::Client::new()
        .post(format!(
            "{}/v1/auth/refresh",
            base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({"refreshToken":refresh_token}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    token_session(value, session.refresh_token.clone())
}

fn token_session(value: Value, previous_refresh: Option<String>) -> Result<OidcSession, String> {
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "OIDC não retornou access_token".to_string())?
        .to_owned();
    let refresh_token = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(previous_refresh);
    let expires_in = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    Ok(OidcSession {
        access_token,
        refresh_token,
        expires_at: chrono::Utc::now().timestamp() + expires_in - 30,
    })
}

#[tauri::command]
pub async fn oidc_restore(gateway_base_url: String) -> Result<Option<OidcSession>, String> {
    let entry = keyring::Entry::new("AI Orchestrator", &account(&gateway_base_url))
        .map_err(|e| e.to_string())?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut session: OidcSession = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    if session.expires_at <= chrono::Utc::now().timestamp() {
        session = refresh(&gateway_base_url, &session).await?;
        store(&gateway_base_url, &session)?;
    }
    Ok(Some(session))
}

#[tauri::command]
pub async fn oidc_logout(gateway_base_url: String) -> Result<(), String> {
    let entry = keyring::Entry::new("AI Orchestrator", &account(&gateway_base_url))
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn oidc_login(gateway_base_url: String) -> Result<OidcSession, String> {
    let base = gateway_base_url.trim_end_matches('/');
    let config: OidcConfig = reqwest::Client::new()
        .get(format!("{base}/v1/auth/config"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let mut verifier_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = uuid::Uuid::new_v4().to_string();
    let mut authorization =
        url::Url::parse(&config.authorization_endpoint).map_err(|e| e.to_string())?;
    authorization
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", "openid profile email offline_access")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    open::that(authorization.as_str())
        .map_err(|e| format!("não foi possível abrir o navegador: {e}"))?;

    let (mut socket, _) = timeout(Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| "tempo de autenticação esgotado".to_string())?
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; 8192];
    let size = socket.read(&mut buffer).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "callback OIDC inválido".to_string())?;
    let callback =
        url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
    let params: std::collections::HashMap<_, _> = callback.query_pairs().into_owned().collect();
    if params.get("state") != Some(&state) {
        return Err("estado OIDC inválido".into());
    }
    let code = params.get("code").ok_or_else(|| {
        params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| "OIDC não retornou código".into())
    })?;
    let page = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>AI Orchestrator</title><style>body{background:#071315;color:#eafff7;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}p{color:#85a099}</style><div><h1>Login concluído</h1><p>Você já pode fechar esta janela.</p></div>";
    socket
        .write_all(page.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let token: Value = reqwest::Client::new()
        .post(format!("{base}/v1/auth/token"))
        .json(&serde_json::json!({"code":code,"codeVerifier":verifier,"redirectUri":redirect_uri}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let session = token_session(token, None)?;
    store(&gateway_base_url, &session)?;
    Ok(session)
}
