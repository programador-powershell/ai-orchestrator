use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Duration;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChatRequest {
    base_url: String,
    account: String,
    model: String,
    messages: Vec<ChatMessage>,
}

/// BYOK: a chave do provedor vive apenas no cofre nativo (keyring) e nunca
/// transita pelo lado JavaScript — o front informa somente o `account`.
#[tauri::command]
pub async fn provider_chat(request: ProviderChatRequest) -> Result<String, String> {
    let base_url = request.base_url.trim().trim_end_matches('/').to_owned();
    if base_url.is_empty() {
        return Err("baseUrl do provedor não configurada".into());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl do provedor deve usar http(s)".into());
    }
    let api_key = keyring::Entry::new("AI Orchestrator", &request.account)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|_| "chave do provedor não encontrada no cofre do sistema".to_string())?;
    let response: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "model": request.model,
            "messages": request.messages,
            "stream": false
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    response
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "resposta do provedor não contém choices[0].message.content".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFetchRequest {
    base_url: String,
    account: String,
    method: String,
    path: String,
    json_body: Option<Value>,
    /// Upload multipart: nome do arquivo + conteúdo texto + purpose (ex.: fine-tune).
    file_name: Option<String>,
    file_content: Option<String>,
    purpose: Option<String>,
}

/// Chamada genérica autenticada ao provedor (fine-tuning, files, jobs…):
/// a chave continua saindo APENAS do keyring, nunca do JavaScript.
#[tauri::command]
pub async fn provider_fetch(request: ProviderFetchRequest) -> Result<Value, String> {
    let base_url = request.base_url.trim().trim_end_matches('/').to_owned();
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl do provedor deve usar http(s)".into());
    }
    let path = request.path.trim();
    if !path.starts_with('/') {
        return Err("path deve começar com /".into());
    }
    let api_key = keyring::Entry::new("AI Orchestrator", &request.account)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|_| "chave do provedor não encontrada no cofre do sistema".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("{base_url}{path}");
    let method = request.method.to_uppercase();
    let mut builder = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("método não suportado: {method}")),
    };
    builder = builder.bearer_auth(&api_key);
    if let (Some(name), Some(content)) = (request.file_name, request.file_content) {
        let part = reqwest::multipart::Part::text(content)
            .file_name(name)
            .mime_str("application/jsonl")
            .map_err(|error| error.to_string())?;
        let mut form = reqwest::multipart::Form::new().part("file", part);
        if let Some(purpose) = request.purpose {
            form = form.text("purpose", purpose);
        }
        builder = builder.multipart(form);
    } else if let Some(body) = request.json_body {
        builder = builder.json(&body);
    }
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .unwrap_or_else(|_| Value::String("resposta não-JSON do provedor".into()));
    if !status.is_success() {
        return Err(format!("provedor respondeu {status}: {payload}"));
    }
    Ok(payload)
}
