use crate::{
    crypto::SecretBox,
    error::ApiError,
    models::{ChatRequest, ModelTarget},
};
use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct ProviderClient {
    pub http: reqwest::Client,
    pub pool: PgPool,
    pub secrets: SecretBox,
}

struct Provider {
    id: Uuid,
    kind: String,
    base_url: Option<String>,
    api_key: String,
}

impl ProviderClient {
    async fn provider(&self, workspace_id: Uuid, id: Uuid) -> Result<Provider, ApiError> {
        let row = sqlx::query("SELECT id, kind, base_url, encrypted_api_key FROM providers WHERE workspace_id=$1 AND id=$2 AND enabled=true")
            .bind(workspace_id).bind(id).fetch_optional(&self.pool).await?.ok_or(ApiError::NotFound)?;
        Ok(Provider {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            base_url: row.try_get("base_url")?,
            api_key: self
                .secrets
                .open(row.try_get("encrypted_api_key")?)
                .map_err(ApiError::Internal)?,
        })
    }

    pub async fn chat(
        &self,
        workspace_id: Uuid,
        target: &ModelTarget,
        request: &ChatRequest,
        timeout_ms: u64,
        temperature: Option<f32>,
        max_tokens: Option<u32>,
    ) -> Result<(Uuid, Response), ApiError> {
        let provider = self.provider(workspace_id, target.provider_id).await?;
        if provider.kind == "anthropic" {
            return self
                .anthropic(
                    provider,
                    target,
                    request,
                    timeout_ms,
                    temperature,
                    max_tokens,
                )
                .await;
        }
        if provider.kind == "gemini" {
            return self
                .gemini(
                    provider,
                    target,
                    request,
                    timeout_ms,
                    temperature,
                    max_tokens,
                )
                .await;
        }
        self.openai_compatible(
            provider,
            target,
            request,
            timeout_ms,
            temperature,
            max_tokens,
        )
        .await
    }

    async fn openai_compatible(
        &self,
        provider: Provider,
        target: &ModelTarget,
        request: &ChatRequest,
        timeout_ms: u64,
        temperature: Option<f32>,
        max_tokens: Option<u32>,
    ) -> Result<(Uuid, Response), ApiError> {
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| match provider.kind.as_str() {
                "openai" => "https://api.openai.com/v1".into(),
                "moonshot" => "https://api.moonshot.ai/v1".into(),
                "deepseek" => "https://api.deepseek.com".into(),
                "mistral" => "https://api.mistral.ai/v1".into(),
                "openai-compatible" => String::new(),
                _ => "https://api.openai.com/v1".into(),
            });
        if base.is_empty() {
            return Err(ApiError::BadRequest(
                "custom provider requires baseUrl".into(),
            ));
        }
        let mut body = json!({ "model": target.model, "messages": request.messages, "stream": request.stream });
        if let Some(value) = temperature {
            body["temperature"] = json!(value);
        }
        if let Some(value) = max_tokens {
            body["max_tokens"] = json!(value);
        }
        let upstream = self
            .http
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .bearer_auth(&provider.api_key)
            .timeout(Duration::from_millis(timeout_ms))
            .json(&body)
            .send()
            .await?;
        if !upstream.status().is_success() {
            return Err(ApiError::ProvidersUnavailable);
        }
        let status = upstream.status();
        let content_type = if request.stream {
            "text/event-stream"
        } else {
            "application/json"
        };
        let stream = upstream
            .bytes_stream()
            .map(|value| value.map_err(std::io::Error::other));
        let response = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from_stream(stream))
            .map_err(|e| ApiError::Internal(e.into()))?;
        Ok((provider.id, response))
    }

    async fn anthropic(
        &self,
        provider: Provider,
        target: &ModelTarget,
        request: &ChatRequest,
        timeout_ms: u64,
        temperature: Option<f32>,
        max_tokens: Option<u32>,
    ) -> Result<(Uuid, Response), ApiError> {
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| "https://api.anthropic.com/v1".into());
        let system = request
            .messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        let messages: Vec<_> = request
            .messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| json!({"role":m.role,"content":m.content}))
            .collect();
        let mut body = json!({"model":target.model,"max_tokens":max_tokens.unwrap_or(4096),"system":system,"messages":messages,"stream":false});
        if let Some(value) = temperature {
            body["temperature"] = json!(value);
        }
        let upstream = self
            .http
            .post(format!("{}/messages", base.trim_end_matches('/')))
            .timeout(Duration::from_millis(timeout_ms))
            .header("x-api-key", &provider.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;
        if !upstream.status().is_success() {
            return Err(ApiError::ProvidersUnavailable);
        }
        let value: Value = upstream.json().await?;
        let text = value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .and_then(|v| v.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok((provider.id, normalized_response(text, request.stream)?))
    }

    async fn gemini(
        &self,
        provider: Provider,
        target: &ModelTarget,
        request: &ChatRequest,
        timeout_ms: u64,
        temperature: Option<f32>,
        max_tokens: Option<u32>,
    ) -> Result<(Uuid, Response), ApiError> {
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".into());
        let contents: Vec<_> = request.messages.iter().filter(|m| m.role != "system").map(|m| json!({"role":if m.role=="assistant"{"model"}else{"user"},"parts":[{"text":m.content.as_str().unwrap_or("")}]})).collect();
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            base.trim_end_matches('/'),
            urlencoding::encode(&target.model),
            urlencoding::encode(&provider.api_key)
        );
        let mut generation = json!({});
        if let Some(value) = temperature {
            generation["temperature"] = json!(value);
        }
        if let Some(value) = max_tokens {
            generation["maxOutputTokens"] = json!(value);
        }
        let upstream = self
            .http
            .post(url)
            .timeout(Duration::from_millis(timeout_ms))
            .json(&json!({"contents":contents,"generationConfig":generation}))
            .send()
            .await?;
        if !upstream.status().is_success() {
            return Err(ApiError::ProvidersUnavailable);
        }
        let value: Value = upstream.json().await?;
        let text = value
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok((provider.id, normalized_response(text, request.stream)?))
    }

    pub async fn generic(
        &self,
        workspace_id: Uuid,
        target: &ModelTarget,
        capability: &str,
        payload: Value,
        timeout_ms: u64,
    ) -> Result<(Uuid, Response), ApiError> {
        let provider = self.provider(workspace_id, target.provider_id).await?;
        if capability == "embedding" && matches!(provider.kind.as_str(), "gemini" | "imagen") {
            return self
                .gemini_embedding(provider, target, payload, timeout_ms)
                .await;
        }
        if capability == "image" && provider.kind == "imagen" {
            return self.imagen(provider, target, payload, timeout_ms).await;
        }
        if capability == "image" && provider.kind == "black-forest-labs" {
            return self.flux(provider, target, payload, timeout_ms).await;
        }
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| match provider.kind.as_str() {
                "openai" | "openai-images" => "https://api.openai.com/v1".into(),
                "gemini" | "imagen" => "https://generativelanguage.googleapis.com/v1beta".into(),
                "black-forest-labs" => "https://api.bfl.ai/v1".into(),
                "mistral" => "https://api.mistral.ai/v1".into(),
                _ => String::new(),
            });
        if base.is_empty() {
            return Err(ApiError::BadRequest("provider requires baseUrl".into()));
        }
        let path = match capability {
            "image" => "images/generations",
            "embedding" => "embeddings",
            _ => return Err(ApiError::BadRequest("unsupported capability".into())),
        };
        let mut body = payload;
        body["model"] = Value::String(target.model.clone());
        let upstream = self
            .http
            .post(format!("{}/{path}", base.trim_end_matches('/')))
            .bearer_auth(&provider.api_key)
            .timeout(Duration::from_millis(timeout_ms))
            .json(&body)
            .send()
            .await?;
        if !upstream.status().is_success() {
            return Err(ApiError::ProvidersUnavailable);
        }
        let status = upstream.status();
        let stream = upstream
            .bytes_stream()
            .map(|value| value.map_err(std::io::Error::other));
        let response = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from_stream(stream))
            .map_err(|e| ApiError::Internal(e.into()))?;
        Ok((provider.id, response))
    }

    async fn gemini_embedding(
        &self,
        provider: Provider,
        target: &ModelTarget,
        payload: Value,
        timeout_ms: u64,
    ) -> Result<(Uuid, Response), ApiError> {
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".into());
        let input = payload
            .get("input")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ApiError::BadRequest("Gemini embedding input must be a string".into())
            })?;
        let url = format!(
            "{}/models/{}:embedContent",
            base.trim_end_matches('/'),
            urlencoding::encode(&target.model)
        );
        let value: Value = self
            .http
            .post(url)
            .header("x-goog-api-key", &provider.api_key)
            .timeout(Duration::from_millis(timeout_ms))
            .json(&json!({"model":format!("models/{}",target.model),"content":{"parts":[{"text":input}]}}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let embedding = value
            .pointer("/embedding/values")
            .cloned()
            .unwrap_or_else(|| json!([]));
        Ok((
            provider.id,
            json_response(
                json!({"object":"list","model":target.model,"data":[{"object":"embedding","index":0,"embedding":embedding}]}),
            )?,
        ))
    }

    async fn imagen(
        &self,
        provider: Provider,
        target: &ModelTarget,
        payload: Value,
        timeout_ms: u64,
    ) -> Result<(Uuid, Response), ApiError> {
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".into());
        let prompt = payload
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest("image prompt is required".into()))?;
        let count = payload
            .get("n")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 4);
        let url = format!(
            "{}/models/{}:predict",
            base.trim_end_matches('/'),
            urlencoding::encode(&target.model)
        );
        let value: Value = self.http.post(url).header("x-goog-api-key",&provider.api_key)
            .timeout(Duration::from_millis(timeout_ms)).json(&json!({"instances":[{"prompt":prompt}],"parameters":{"sampleCount":count,"outputOptions":{"mimeType":"image/png"}}}))
            .send().await?.error_for_status()?.json().await?;
        let data = value.get("predictions").and_then(Value::as_array).cloned().unwrap_or_default().into_iter()
            .map(|item| json!({"b64_json":item.get("bytesBase64Encoded").and_then(Value::as_str).unwrap_or("")})).collect::<Vec<_>>();
        Ok((
            provider.id,
            json_response(json!({"created":chrono::Utc::now().timestamp(),"data":data}))?,
        ))
    }

    async fn flux(
        &self,
        provider: Provider,
        target: &ModelTarget,
        payload: Value,
        timeout_ms: u64,
    ) -> Result<(Uuid, Response), ApiError> {
        let base = provider
            .base_url
            .clone()
            .unwrap_or_else(|| "https://api.bfl.ai/v1".into());
        let started: Value = self
            .http
            .post(format!(
                "{}/{}",
                base.trim_end_matches('/'),
                urlencoding::encode(&target.model)
            ))
            .header("x-key", &provider.api_key)
            .timeout(Duration::from_millis(timeout_ms))
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let polling_url = started
            .get("polling_url")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::ProvidersUnavailable)?
            .to_owned();
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(750)).await;
            let result: Value = self
                .http
                .get(&polling_url)
                .header("x-key", &provider.api_key)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            match result.get("status").and_then(Value::as_str) {
                Some("Ready") => {
                    let url = result
                        .pointer("/result/sample")
                        .and_then(Value::as_str)
                        .ok_or(ApiError::ProvidersUnavailable)?;
                    return Ok((
                        provider.id,
                        json_response(
                            json!({"created":chrono::Utc::now().timestamp(),"data":[{"url":url}]}),
                        )?,
                    ));
                }
                Some("Error" | "Failed") => return Err(ApiError::ProvidersUnavailable),
                _ => {}
            }
        }
        Err(ApiError::ProvidersUnavailable)
    }
}

fn normalized_response(text: &str, stream: bool) -> Result<Response, ApiError> {
    let value = json!({"id":format!("chatcmpl-{}",Uuid::new_v4()),"object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]});
    let (content_type, body) = if stream {
        let chunk = json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
        (
            "text/event-stream",
            format!("data: {chunk}\n\ndata: [DONE]\n\n"),
        )
    } else {
        ("application/json", value.to_string())
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))
        .map_err(|e| ApiError::Internal(e.into()))
}

fn json_response(value: Value) -> Result<Response, ApiError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .map_err(|error| ApiError::Internal(error.into()))
}
