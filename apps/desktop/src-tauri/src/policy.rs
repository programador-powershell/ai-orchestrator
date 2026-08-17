//! Política gerenciada no cliente.
//!
//! A verificação da assinatura acontece AQUI, no Rust — nunca no JS: o webview
//! é exatamente a superfície que a política não pode confiar. A chave pública
//! é embarcada no build (`POLICY_PUBLIC_KEY`); na edição `managed` a ausência
//! da chave ou da assinatura é falha dura, não degradação silenciosa.
//!
//! O documento verificado fica em arquivo comum (não no keyring: o blob passa
//! do limite do Credential Manager). Adulterar o arquivo não ajuda — a
//! assinatura é reverificada em toda leitura.

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use std::{fs, path::PathBuf};

/// Chave pública Ed25519 (base64 padrão, 32 bytes) gravada no binário pelo
/// build de release. `option_env!` para o dev não precisar dela.
const EMBEDDED_PUBKEY: Option<&str> = option_env!("POLICY_PUBLIC_KEY");

const MANAGED: bool = cfg!(feature = "managed");

fn policy_path() -> Result<PathBuf, String> {
    let directory = dirs::data_dir()
        .ok_or("diretório de dados indisponível")?
        .join("AI-BOT");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("policy.json"))
}

fn verifying_key() -> Result<Option<VerifyingKey>, String> {
    let Some(encoded) = EMBEDDED_PUBKEY else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("POLICY_PUBLIC_KEY inválida: {error}"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "POLICY_PUBLIC_KEY deve ter exatamente 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// Reconstrói os MESMOS bytes que o gateway assinou: JSON com chaves
/// ordenadas (serde_json usa BTreeMap) contendo só os campos canônicos.
fn canonical_message(body: &Value) -> String {
    serde_json::json!({
        "issuedAt": body.get("issuedAt").cloned().unwrap_or(Value::Null),
        "expiresAt": body.get("expiresAt").cloned().unwrap_or(Value::Null),
        "profile": body.get("profile").cloned().unwrap_or(Value::Null),
        "policy": body.get("policy").cloned().unwrap_or(Value::Null),
    })
    .to_string()
}

/// Devolve `true` quando a assinatura foi verificada. Sem chave embarcada, a
/// edição full aceita e marca como não-verificada; a managed recusa — chave
/// ausente é build errado, não caso de uso.
fn verify_body(body: &Value) -> Result<bool, String> {
    match verifying_key()? {
        Some(key) => {
            let signature = body
                .get("signature")
                .and_then(Value::as_str)
                .ok_or("política sem assinatura — o gateway precisa da POLICY_SIGNING_KEY")?;
            // base64url sem padding: o formato que o jsonwebtoken emite.
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(signature)
                .map_err(|error| format!("assinatura ilegível: {error}"))?;
            let signature = Signature::from_slice(&bytes).map_err(|error| error.to_string())?;
            key.verify_strict(canonical_message(body).as_bytes(), &signature)
                .map_err(|_| {
                    "assinatura da política inválida — documento adulterado ou chave errada"
                        .to_string()
                })?;
            Ok(true)
        }
        None if MANAGED => Err(
            "edição managed sem POLICY_PUBLIC_KEY embarcada — build inválido, política recusada"
                .into(),
        ),
        None => Ok(false),
    }
}

/// Ainda dentro da validade + graça offline?
fn within_grace(body: &Value) -> bool {
    let Some(expires) = body.get("expiresAt").and_then(Value::as_str) else {
        return false;
    };
    let Ok(expires) = chrono::DateTime::parse_from_rfc3339(expires) else {
        return false;
    };
    let grace_hours = body
        .pointer("/policy/offlineGraceHours")
        .and_then(Value::as_u64)
        .unwrap_or(72);
    let deadline = expires + chrono::Duration::hours(grace_hours as i64);
    chrono::Utc::now() < deadline
}

fn annotate(mut body: Value, verified: bool) -> Value {
    if let Some(map) = body.as_object_mut() {
        map.insert("verified".into(), Value::Bool(verified));
    }
    body
}

/// Busca o bootstrap no gateway, verifica e grava o cache. O token nunca é
/// logado; o corpo devolvido ao JS carrega `verified` para a UI informar.
#[tauri::command]
pub async fn bootstrap_sync(base_url: String, token: String) -> Result<Value, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("gateway não configurado".into());
    }
    let response = reqwest::Client::new()
        .get(format!("{base}/v1/bootstrap"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "bootstrap falhou: HTTP {}",
            response.status().as_u16()
        ));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    let verified = verify_body(&body)?;
    let path = policy_path()?;
    fs::write(
        &path,
        serde_json::to_vec(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(annotate(body, verified))
}

/// Cache local: verificado de novo a cada leitura e sujeito à graça offline.
/// Fora da graça devolve None — quem chama decide travar no login.
#[tauri::command]
pub fn bootstrap_cached() -> Result<Option<Value>, String> {
    let path = policy_path()?;
    let Ok(raw) = fs::read(&path) else {
        return Ok(None);
    };
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return Ok(None);
    };
    let verified = verify_body(&body)?;
    if !within_grace(&body) {
        return Ok(None);
    }
    Ok(Some(annotate(body, verified)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed_body(seed: [u8; 32]) -> (Value, VerifyingKey) {
        let key = SigningKey::from_bytes(&seed);
        let mut body = serde_json::json!({
            "issuedAt": "2026-01-01T00:00:00+00:00",
            "expiresAt": "2099-01-01T00:00:00+00:00",
            "profile": {"subject": "daniel"},
            "policy": {"allowedModes": ["chat"], "offlineGraceHours": 72},
        });
        let message = canonical_message(&body);
        let signature = key.sign(message.as_bytes());
        body.as_object_mut().unwrap().insert(
            "signature".into(),
            Value::String(
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            ),
        );
        (body, key.verifying_key())
    }

    #[test]
    fn mensagem_canonica_ignora_campos_extras_e_ordena() {
        let body = serde_json::json!({
            "signature": "x", "etag": "y", "verified": true,
            "policy": {"b": 1, "a": 2}, "profile": {},
            "issuedAt": "i", "expiresAt": "e",
        });
        let message = canonical_message(&body);
        assert!(!message.contains("signature"));
        assert!(!message.contains("etag"));
        assert!(message.find("\"a\":2").unwrap() < message.find("\"b\":1").unwrap());
    }

    #[test]
    fn assinatura_valida_verifica_e_adulteracao_falha() {
        let (body, key) = signed_body([9u8; 32]);
        let signature_str = body.get("signature").and_then(Value::as_str).unwrap();
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signature_str)
            .unwrap();
        let signature = Signature::from_slice(&bytes).unwrap();
        assert!(key
            .verify_strict(canonical_message(&body).as_bytes(), &signature)
            .is_ok());

        // adultera a política: os bytes canônicos mudam e a assinatura cai
        let mut tampered = body.clone();
        tampered.as_object_mut().unwrap().insert(
            "policy".into(),
            serde_json::json!({"allowedModes": ["chat","code"]}),
        );
        assert!(key
            .verify_strict(canonical_message(&tampered).as_bytes(), &signature)
            .is_err());
    }

    #[test]
    fn graca_offline_respeita_expiracao_mais_graca() {
        let mut body = serde_json::json!({
            "expiresAt": "2000-01-01T00:00:00+00:00",
            "policy": {"offlineGraceHours": 0},
        });
        assert!(!within_grace(&body));
        // expirado ontem mas com graça enorme: ainda vale
        body["policy"]["offlineGraceHours"] = serde_json::json!(1_000_000);
        assert!(within_grace(&body));
        // sem expiresAt não há o que honrar
        assert!(!within_grace(&serde_json::json!({})));
    }
}
