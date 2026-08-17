//! Chamada JSON-RPC a um servidor MCP externo.
//!
//! Por que passa pelo Rust e não por `fetch` no webview — as mesmas três
//! razões do `webhook.rs`, com uma quarta que é específica daqui:
//!
//! 1. **O token é segredo.** Um Bearer de conector corporativo (Jira, por
//!    exemplo) dava acesso ao sistema inteiro em nome da pessoa. Ele ficava em
//!    `settings.mcpServers`, que o zustand persiste no `localStorage` do
//!    webview — em texto puro, em disco, em qualquer backup do perfil. Agora
//!    o JS manda só o NOME do conector e o token é lido do cofre do SO aqui,
//!    como já acontecia com a chave BYOK e com a URL de webhook.
//! 2. **SSRF.** `guard_public_host` resolve o DNS antes de sair; validação em
//!    JS não resolve nome e portanto não protege de rebinding.
//! 3. **CORS.** A origem é `tauri.localhost` e um POST `application/json`
//!    dispara preflight, que servidor MCP nenhum responde.
//! 4. **A blocklist do admin virava enfeite.** Em JS ela era checada no
//!    renderer — quem abrisse o devtools passava por cima. Aqui ela é a mesma
//!    política assinada que o resto do app aplica.

use crate::research::guard_public_host;
use serde::Serialize;
use std::time::Duration;

const KEYRING_SERVICE: &str = "AI-BOT";
/// Espaço próprio no cofre — longe das chaves de provedor e dos webhooks.
const SECRET_PREFIX: &str = "mcp.";
const MAX_BODY_BYTES: usize = 256 * 1024;
/// A resposta é conteúdo NÃO CONFIÁVEL: vira texto para o modelo.
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOutcome {
    status: u16,
    ok: bool,
    body: String,
}

/// Nome da conta no cofre para um conector.
pub fn account_for(name: &str) -> String {
    format!("{SECRET_PREFIX}{name}")
}

/// Valida a URL do conector. Separado do envio para poder ser testado.
fn parse_target(raw: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw.trim()).map_err(|_| "URL de conector inválida".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("o conector precisa usar http:// ou https://".into());
    }
    // HTTP em claro só faz sentido para um MCP rodando na própria máquina; para
    // fora, o token viajaria legível na rede.
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if parsed.scheme() == "http" && !loopback {
        return Err("conector remoto precisa ser https — o token não trafega em claro".into());
    }
    if !loopback {
        guard_public_host(&parsed)?;
    }
    crate::blocklist::guard_blocklist(&parsed)?;
    Ok(parsed)
}

#[tauri::command]
pub async fn mcp_rpc(name: String, url: String, body: String) -> Result<McpOutcome, String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("corpo da chamada MCP excede o limite".into());
    }
    let target = parse_target(&url)?;

    // Token OPCIONAL: conector sem autenticação é caso legítimo. A ausência
    // no cofre não é erro — é "sem token".
    let token = keyring::Entry::new(KEYRING_SERVICE, &account_for(name.trim()))
        .ok()
        .and_then(|entry| entry.get_password().ok());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .post(target)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", "AI-BOT MCP/1.0")
        .body(body);
    if let Some(valor) = token {
        request = request.bearer_auth(valor);
    }

    let response = request.send().await.map_err(|error| {
        // A mensagem do reqwest carrega a URL; aqui ela não é segredo, mas o
        // texto cru não acrescenta nada útil ao modelo.
        if error.is_timeout() {
            "o conector MCP não respondeu no tempo limite".to_string()
        } else if error.is_connect() {
            "não foi possível conectar ao conector MCP".to_string()
        } else {
            "falha ao chamar o conector MCP".to_string()
        }
    })?;

    let status = response.status();
    let bytes = response.bytes().await.unwrap_or_default();
    let slice = &bytes[..bytes.len().min(MAX_RESPONSE_BYTES)];
    Ok(McpOutcome {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(slice).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conta_do_cofre_tem_prefixo_proprio() {
        assert_eq!(account_for("jira"), "mcp.jira");
    }

    #[test]
    fn conector_remoto_em_http_e_recusado() {
        let erro = parse_target("http://mcp.exemplo.com/rpc").unwrap_err();
        assert!(erro.contains("https"), "erro inesperado: {erro}");
    }

    #[test]
    fn mcp_local_em_http_passa() {
        assert!(parse_target("http://localhost:3000/mcp").is_ok());
        assert!(parse_target("http://127.0.0.1:3000/mcp").is_ok());
    }

    #[test]
    fn recusa_rede_interna_em_https() {
        for alvo in [
            "https://10.0.0.5/mcp",
            "https://169.254.169.254/mcp",
            "https://192.168.1.10/mcp",
            "https://algo.internal/mcp",
        ] {
            assert!(parse_target(alvo).is_err(), "deveria bloquear {alvo}");
        }
    }

    #[test]
    fn recusa_url_invalida() {
        assert!(parse_target("nao é url").is_err());
        assert!(parse_target("").is_err());
        assert!(parse_target("ftp://host/mcp").is_err());
    }
}
