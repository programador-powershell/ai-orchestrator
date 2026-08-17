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
    /// Presente nos gateways novos: o desktop (public client) troca o code
    /// DIRETO com o IdP. Ausente = gateway antigo → cai no proxy legado.
    #[serde(default)]
    token_endpoint: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcSession {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    /// Guardados na sessão para o refresh direto com o IdP funcionar sem
    /// refazer a descoberta — e com o MESMO scope (refresh multi-recurso do
    /// Entra sem scope devolve token com aud imprevisível).
    #[serde(default)]
    token_endpoint: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

fn account(base_url: &str) -> String {
    format!("oidc:{}", base_url.trim_end_matches('/'))
}

fn store(base_url: &str, session: &OidcSession) -> Result<(), String> {
    let value = serde_json::to_string(session).map_err(|e| e.to_string())?;
    keyring::Entry::new("AI-BOT", &account(base_url))
        .map_err(|e| e.to_string())?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

async fn refresh(base_url: &str, session: &OidcSession) -> Result<OidcSession, String> {
    let refresh_token = session
        .refresh_token
        .as_ref()
        .ok_or_else(|| "sessão expirada; autentique novamente".to_string())?;
    // Public client: renova DIRETO no IdP, com o mesmo scope da autorização.
    if let (Some(endpoint), Some(client_id)) = (&session.token_endpoint, &session.client_id) {
        let mut form = vec![
            ("grant_type", "refresh_token".to_string()),
            ("client_id", client_id.clone()),
            ("refresh_token", refresh_token.clone()),
        ];
        if let Some(scope) = &session.scope {
            form.push(("scope", scope.clone()));
        }
        let value: Value = reqwest::Client::new()
            .post(endpoint)
            .form(&form)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let mut renewed = token_session(value, session.refresh_token.clone())?;
        renewed.token_endpoint = session.token_endpoint.clone();
        renewed.client_id = session.client_id.clone();
        renewed.scope = session.scope.clone();
        return Ok(renewed);
    }
    // Gateway antigo: proxy legado.
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
        token_endpoint: None,
        client_id: None,
        scope: None,
    })
}

/// Credencial que o IdP recusou de vez (refresh revogado) precisa SAIR do
/// keyring: senão vira zumbi, retentada a cada reinício para sempre.
fn discard(gateway_base_url: &str) {
    let conta = account(gateway_base_url);
    // Nos dois serviços: credencial revogada sob o nome antigo seria
    // ressuscitada pelo fallback de leitura a cada reinício.
    for servico in [crate::rebrand::SERVICO, crate::rebrand::SERVICO_ANTIGO] {
        if let Ok(entry) = keyring::Entry::new(servico, &conta) {
            let _ = entry.delete_credential();
        }
    }
}

/// `force` renova mesmo com o token ainda válido pelo relógio. É o caso do
/// 401: o gateway já disse que o token não serve — revogação, rotação de
/// chave ou desvio de relógio não aparecem em `expires_at`.
#[tauri::command]
pub async fn oidc_restore(
    gateway_base_url: String,
    force: Option<bool>,
) -> Result<Option<OidcSession>, String> {
    // Passa pelo fallback do rebranding: a sessão salva antes da 0.11.0 está
    // sob o serviço antigo, e não achá-la mandaria a pessoa refazer o SSO sem
    // motivo. `segredo_com_fallback` já regrava sob o nome novo ao achar.
    let value = match crate::rebrand::segredo_com_fallback(&account(&gateway_base_url)) {
        Some(value) => value,
        None => return Ok(None),
    };
    let mut session: OidcSession = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    let expired = session.expires_at <= chrono::Utc::now().timestamp();
    if expired || force.unwrap_or(false) {
        match refresh(&gateway_base_url, &session).await {
            Ok(renewed) => {
                session = renewed;
                store(&gateway_base_url, &session)?;
            }
            Err(error) => {
                // Refresh recusado: a credencial não volta mais. Apaga e pede
                // login novo, em vez de falhar em silêncio a cada partida.
                discard(&gateway_base_url);
                return Err(error);
            }
        }
    }
    Ok(Some(session))
}

#[tauri::command]
pub async fn oidc_logout(gateway_base_url: String) -> Result<(), String> {
    let conta = account(&gateway_base_url);
    // Apaga nos DOIS serviços. Sair da conta e deixar a sessão antiga viva no
    // cofre seria a pior versão possível deste bug: um "logout" que devolve
    // sucesso e mantém o refresh token gravado na máquina.
    if let Ok(antiga) = keyring::Entry::new(crate::rebrand::SERVICO_ANTIGO, &conta) {
        let _ = antiga.delete_credential();
    }
    let entry = keyring::Entry::new(crate::rebrand::SERVICO, &conta).map_err(|e| e.to_string())?;
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
    // "localhost", não "127.0.0.1": o Entra casa host e path do redirect
    // exatamente e só ignora a PORTA no loopback quando o host é localhost.
    // Registrar no portal: http://localhost/callback (plataforma
    // "Mobile and desktop applications" — public client, sem client_secret).
    let redirect_uri = format!("http://localhost:{port}/callback");
    let mut verifier_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = uuid::Uuid::new_v4().to_string();
    let mut authorization =
        url::Url::parse(&config.authorization_endpoint).map_err(|e| e.to_string())?;
    let scope = config
        .scope
        .clone()
        .unwrap_or_else(|| "openid profile email offline_access".into());
    authorization
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scope)
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
    let page = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>AI-BOT</title><style>body{background:#071315;color:#eafff7;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}p{color:#85a099}</style><div><h1>Login concluído</h1><p>Você já pode fechar esta janela.</p></div>";
    socket
        .write_all(page.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    // Public client: a troca do code acontece DIRETO com o IdP, sem
    // client_secret e sem o gateway no meio — o gateway só VALIDA o token
    // (JWKS) nas chamadas seguintes. Gateway antigo (sem tokenEndpoint na
    // config pública) cai no proxy legado.
    let token: Value = match &config.token_endpoint {
        Some(endpoint) => reqwest::Client::new()
            .post(endpoint)
            .form(&[
                ("grant_type", "authorization_code".to_string()),
                ("client_id", config.client_id.clone()),
                ("code", code.clone()),
                ("code_verifier", verifier.clone()),
                ("redirect_uri", redirect_uri.clone()),
                ("scope", scope.clone()),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?,
        None => reqwest::Client::new()
            .post(format!("{base}/v1/auth/token"))
            .json(&serde_json::json!({"code":code,"codeVerifier":verifier,"redirectUri":redirect_uri}))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?,
    };
    let mut session = token_session(token, None)?;
    session.token_endpoint = config.token_endpoint.clone();
    session.client_id = Some(config.client_id.clone());
    session.scope = Some(scope);
    store(&gateway_base_url, &session)?;
    Ok(session)
}
