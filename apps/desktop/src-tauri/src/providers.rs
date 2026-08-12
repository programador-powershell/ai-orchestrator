use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;
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
    /// Id do turno — permite ao front cancelar este stream (botão Parar).
    stream_id: Option<String>,
}

/// Ids de streams que o front pediu para cancelar. O loop de leitura consulta
/// a cada chunk e encerra o consumo do provedor (para de gastar tokens).
fn cancelled_streams() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_cancelled(stream_id: &Option<String>) -> bool {
    let Some(id) = stream_id else { return false };
    cancelled_streams()
        .lock()
        .map(|set| set.contains(id))
        .unwrap_or(false)
}

fn clear_cancelled(stream_id: &Option<String>) {
    if let Some(id) = stream_id {
        if let Ok(mut set) = cancelled_streams().lock() {
            set.remove(id);
        }
    }
}

/// Cancela um stream em andamento (chamado pelo botão Parar do composer).
#[tauri::command]
pub fn provider_chat_cancel(stream_id: String) -> Result<(), String> {
    cancelled_streams()
        .lock()
        .map_err(|_| "estado de cancelamento indisponível".to_string())?
        .insert(stream_id);
    Ok(())
}

/// Eventos de streaming enviados ao front conforme os tokens chegam.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum StreamEvent {
    /// Um pedaço de texto do assistente (delta incremental).
    Delta(String),
    /// Pedaço do raciocínio do modelo (bloco "pensando", separado da resposta).
    Reasoning(String),
    /// Fim do stream — carrega o texto completo para conferência.
    Done(String),
}

fn read_key(account: &str) -> Result<String, String> {
    keyring::Entry::new("AI Orchestrator", account)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|_| "chave do provedor não encontrada no cofre do sistema".to_string())
}

/// `http://` só é aceito contra a própria máquina (runtime local). Para
/// qualquer outro host a chave BYOK cruzaria a rede em texto claro.
fn is_loopback_url(url: &str) -> bool {
    let rest = match url.strip_prefix("http://") {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or_else(|| rest.split('/').next().unwrap_or(""));
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/').to_owned();
    if trimmed.is_empty() {
        return Err("baseUrl do provedor não configurada".into());
    }
    if trimmed.starts_with("https://") {
        return Ok(trimmed);
    }
    if is_loopback_url(&trimmed) {
        return Ok(trimmed);
    }
    if trimmed.starts_with("http://") {
        return Err(
            "baseUrl sem TLS: a chave do provedor não trafega em http:// fora da própria máquina"
                .into(),
        );
    }
    Err("baseUrl do provedor deve usar http(s)".into())
}

/// Extrai o texto de `choices[0].delta.content` de uma linha `data:` do SSE.
fn parse_sse_delta(data: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(data).ok()?;
    parsed
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(str::to_owned)
}

/// Extrai o RACIOCÍNIO do chunk. Provedores usam nomes diferentes para o campo;
/// sem isto o conteúdo de modelos de raciocínio seria descartado.
fn parse_sse_reasoning(data: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(data).ok()?;
    let delta = parsed.get("choices")?.get(0)?.get("delta")?;
    ["reasoning_content", "reasoning", "thinking"]
        .iter()
        .find_map(|field| delta.get(field).and_then(Value::as_str))
        .map(str::to_owned)
}

/// true quando o chunk traz `finish_reason` — sinal terminal de provedores que
/// não mandam `[DONE]`.
fn has_finish_reason(data: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    parsed
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("finish_reason"))
        .map(|reason| !reason.is_null())
        .unwrap_or(false)
}

/// Consome um corpo SSE de chat/completions emitindo cada delta pelo Channel.
/// Trata chunk que parte caractere UTF-8 no meio (decodifica só o prefixo
/// válido) e encerra cedo quando o stream é cancelado pelo botão Parar.
pub async fn pump_sse_cancellable(
    response: reqwest::Response,
    on_event: &Channel<StreamEvent>,
    stream_id: &Option<String>,
) -> Result<String, String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full = String::new();
    let mut raw: Vec<u8> = Vec::new();
    let mut saw_terminal = false;
    while let Some(chunk) = stream.next().await {
        if is_cancelled(stream_id) {
            clear_cancelled(stream_id);
            return Ok(full);
        }
        let bytes = chunk.map_err(|error| error.to_string())?;
        raw.extend_from_slice(&bytes);
        let decoded = match std::str::from_utf8(&raw) {
            Ok(text) => {
                let owned = text.to_owned();
                raw.clear();
                owned
            }
            Err(error) => {
                let valid = error.valid_up_to();
                let owned = String::from_utf8_lossy(&raw[..valid]).into_owned();
                raw.drain(..valid);
                owned
            }
        };
        buffer.push_str(&decoded);
        // Eventos SSE são separados por linha em branco; processa os completos.
        while let Some(boundary) = buffer.find("\n\n") {
            let event = buffer[..boundary].to_owned();
            buffer.drain(..boundary + 2);
            for line in event.lines() {
                let data = line.strip_prefix("data:").map(str::trim);
                let Some(data) = data else { continue };
                if data == "[DONE]" {
                    saw_terminal = true;
                    continue;
                }
                if has_finish_reason(data) {
                    saw_terminal = true;
                }
                if let Some(reasoning) = parse_sse_reasoning(data) {
                    if !reasoning.is_empty() {
                        on_event
                            .send(StreamEvent::Reasoning(reasoning))
                            .map_err(|error| error.to_string())?;
                    }
                }
                if let Some(delta) = parse_sse_delta(data) {
                    if !delta.is_empty() {
                        full.push_str(&delta);
                        on_event
                            .send(StreamEvent::Delta(delta))
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
    }
    if !saw_terminal {
        // EOF sem [DONE] nem finish_reason = conexão cortada no meio. Entregar
        // como sucesso mostraria resposta truncada como se estivesse completa.
        return Err(
            "a resposta foi interrompida antes de terminar — o provedor cortou o stream"
                .to_string(),
        );
    }
    Ok(full)
}

/// Variante sem cancelamento (runtime local).
pub async fn pump_sse(
    response: reqwest::Response,
    on_event: &Channel<StreamEvent>,
) -> Result<String, String> {
    pump_sse_cancellable(response, on_event, &None).await
}

/// Chat com STREAMING: a chave sai só do keyring; os deltas chegam ao front
/// pelo Channel conforme o provedor os envia (SSE `stream: true`), em vez de
/// esperar a resposta inteira. Retorna o texto completo ao final.
#[tauri::command]
pub async fn provider_chat_stream(
    request: ProviderChatRequest,
    on_event: Channel<StreamEvent>,
) -> Result<String, String> {
    let base_url = validate_base_url(&request.base_url)?;
    let api_key = read_key(&request.account)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "model": request.model,
            "messages": request.messages,
            "stream": true
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;

    let full = pump_sse_cancellable(response, &on_event, &request.stream_id).await?;
    clear_cancelled(&request.stream_id);
    on_event
        .send(StreamEvent::Done(full.clone()))
        .map_err(|error| error.to_string())?;
    Ok(full)
}

/// BYOK: a chave do provedor vive apenas no cofre nativo (keyring) e nunca
/// transita pelo lado JavaScript — o front informa somente o `account`.
#[tauri::command]
pub async fn provider_chat(request: ProviderChatRequest) -> Result<String, String> {
    let base_url = validate_base_url(&request.base_url)?;
    let api_key = read_key(&request.account)?;
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

#[cfg(test)]
mod tests {
    use super::{parse_sse_delta, validate_base_url};

    #[test]
    fn extracts_delta_content() {
        let data = r#"{"choices":[{"delta":{"content":"olá"}}]}"#;
        assert_eq!(parse_sse_delta(data).as_deref(), Some("olá"));
    }

    #[test]
    fn detects_finish_reason_as_terminal() {
        use super::has_finish_reason;
        assert!(has_finish_reason(
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#
        ));
        assert!(has_finish_reason(
            r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#
        ));
        // Sem sinal terminal: chunk normal de conteúdo e finish_reason nulo.
        assert!(!has_finish_reason(
            r#"{"choices":[{"delta":{"content":"oi"},"finish_reason":null}]}"#
        ));
        assert!(!has_finish_reason(
            r#"{"choices":[{"delta":{"content":"oi"}}]}"#
        ));
        assert!(!has_finish_reason("{quebrado"));
    }

    #[test]
    fn extracts_reasoning_from_known_fields() {
        use super::parse_sse_reasoning;
        let deepseek = r#"{"choices":[{"delta":{"reasoning_content":"pensando"}}]}"#;
        assert_eq!(parse_sse_reasoning(deepseek).as_deref(), Some("pensando"));
        let alt = r#"{"choices":[{"delta":{"thinking":"hmm"}}]}"#;
        assert_eq!(parse_sse_reasoning(alt).as_deref(), Some("hmm"));
        let only_content = r#"{"choices":[{"delta":{"content":"oi"}}]}"#;
        assert_eq!(parse_sse_reasoning(only_content), None);
    }

    #[test]
    fn ignores_lines_without_content() {
        assert_eq!(parse_sse_delta(r#"{"choices":[{"delta":{}}]}"#), None);
        assert_eq!(parse_sse_delta("{quebrado"), None);
        assert_eq!(parse_sse_delta(r#"{"choices":[]}"#), None);
    }

    #[test]
    fn rejects_non_http_base_url() {
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("  ").is_err());
        // http:// remoto é recusado: a chave BYOK não trafega sem TLS.
        assert!(validate_base_url("http://api.exemplo.com/v1").is_err());
        assert!(validate_base_url("http://192.168.0.10/v1").is_err());
        // loopback continua valendo — é o runtime local (llama.cpp).
        assert_eq!(
            validate_base_url("http://127.0.0.1:8080/v1").unwrap(),
            "http://127.0.0.1:8080/v1"
        );
        assert!(validate_base_url("http://localhost:1234").is_ok());
        assert_eq!(
            validate_base_url("https://api.openai.com/v1/").unwrap(),
            "https://api.openai.com/v1"
        );
    }
}

/// Chamada genérica autenticada ao provedor (fine-tuning, files, jobs…):
/// a chave continua saindo APENAS do keyring, nunca do JavaScript.
#[tauri::command]
pub async fn provider_fetch(request: ProviderFetchRequest) -> Result<Value, String> {
    // Mesmo validador do chat: sem TLS a chave do keyring vazaria na rede.
    let base_url = validate_base_url(&request.base_url)?;
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
