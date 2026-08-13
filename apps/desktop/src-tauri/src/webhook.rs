//! Webhook de saída das automações da aba Work.
//!
//! Por que passa pelo Rust e não por `fetch` no webview:
//!
//! 1. **A URL é a credencial.** Um webhook de Slack/Teams autentica por URL.
//!    O renderer nunca a recebe: o JS manda só a REFERÊNCIA (`secretRef`) e é
//!    aqui que ela é lida do cofre do SO — mesmo princípio de
//!    `credential_exists`, que existe justamente para não levar segredo para o
//!    heap do webview. Assim ela também não cai no `localStorage` do quadro.
//! 2. **SSRF.** `guard_public_host` resolve o DNS antes de sair; validação em
//!    JS não resolve nome e portanto não protege de DNS rebinding. E
//!    `tauri.conf.json` está com `csp: null`, ou seja, o renderer não teria
//!    nenhuma restrição de destino.
//! 3. **CORS.** A origem é `tauri.localhost`; um POST `application/json`
//!    dispara preflight `OPTIONS`, que endpoints de webhook não respondem.
//!
//! Redirect é PROIBIDO aqui (ao contrário do research_fetch, que reavalia cada
//! salto): um webhook legítimo não redireciona, e seguir 302 com o corpo em
//! mãos é uma forma barata de exfiltrar o payload.

use crate::research::guard_public_host;
use serde::Serialize;
use std::time::Duration;

/// Prefixo da conta no cofre — mantém os webhooks num espaço próprio, longe
/// das chaves de provedor.
const KEYRING_SERVICE: &str = "AI Orchestrator";
const SECRET_PREFIX: &str = "webhook.";
/// A resposta é conteúdo NÃO CONFIÁVEL e vai para o log renderizado no rail.
const MAX_RESPONSE_BYTES: usize = 2 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookOutcome {
    status: u16,
    ok: bool,
    /// Trecho da resposta, truncado. Nunca a URL.
    excerpt: String,
}

/// Nome da conta no cofre para uma referência de webhook.
pub fn account_for(secret_ref: &str) -> String {
    format!("{SECRET_PREFIX}{secret_ref}")
}

/// Valida a URL guardada no cofre. Separado do envio para poder ser testado.
fn parse_target(raw: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw.trim()).map_err(|_| "URL de webhook inválida".to_string())?;
    // Mais estrito que o research_fetch (que aceita http): aqui sai payload
    // corporativo, e a própria URL é segredo — em claro na rede, não.
    if parsed.scheme() != "https" {
        return Err("o webhook precisa ser https".into());
    }
    guard_public_host(&parsed)?;
    Ok(parsed)
}

#[tauri::command]
pub async fn webhook_post(secret_ref: String, body: String) -> Result<WebhookOutcome, String> {
    if secret_ref.trim().is_empty() {
        return Err("referência de webhook vazia".into());
    }
    if body.len() > MAX_BODY_BYTES {
        return Err("corpo do webhook excede o limite".into());
    }
    let account = account_for(secret_ref.trim());
    let url = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|_| format!("webhook \"{secret_ref}\" não está no cofre"))?;
    let target = parse_target(&url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(target)
        .header("Content-Type", "application/json")
        .header("User-Agent", "AI Orchestrator Work/1.0")
        .body(body)
        .send()
        .await
        // A mensagem de erro do reqwest inclui a URL — que é o segredo.
        // Nunca propagar o texto cru.
        .map_err(|error| {
            if error.is_timeout() {
                "o webhook não respondeu no tempo limite".to_string()
            } else if error.is_connect() {
                "não foi possível conectar ao webhook".to_string()
            } else {
                "falha ao chamar o webhook".to_string()
            }
        })?;

    let status = response.status();
    let bytes = response.bytes().await.unwrap_or_default();
    let slice = &bytes[..bytes.len().min(MAX_RESPONSE_BYTES)];
    Ok(WebhookOutcome {
        status: status.as_u16(),
        ok: status.is_success(),
        excerpt: String::from_utf8_lossy(slice).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exige_https() {
        let erro = parse_target("http://exemplo.com/hook").unwrap_err();
        assert!(erro.contains("https"), "erro inesperado: {erro}");
    }

    #[test]
    fn recusa_url_invalida() {
        assert!(parse_target("nao é url").is_err());
        assert!(parse_target("").is_err());
    }

    #[test]
    fn recusa_rede_interna_antes_de_enviar() {
        for alvo in [
            "https://localhost/hook",
            "https://127.0.0.1/hook",
            "https://10.0.0.5/hook",
            "https://169.254.169.254/latest/meta-data",
            "https://192.168.1.10/hook",
            "https://algo.internal/hook",
        ] {
            assert!(parse_target(alvo).is_err(), "deveria bloquear {alvo}");
        }
    }

    #[test]
    fn conta_do_cofre_tem_prefixo_proprio() {
        assert_eq!(account_for("teams-ti"), "webhook.teams-ti");
    }
}
