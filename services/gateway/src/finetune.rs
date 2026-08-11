use crate::{
    error::ApiError,
    routes::{identity, rate_limit, require_role, user_id},
    state::AppState,
};
use axum::{
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, Row};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MIN_EXAMPLES: usize = 10;
const MAX_ISSUES: usize = 50;
const EVENT_PAGE_LIMIT: i64 = 200;
const SSE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(20);

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled")
}

// Trunca respeitando limites de char (mensagens de provedor podem ser longas).
fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_string()
    } else {
        value.chars().take(max).collect()
    }
}

// ---------------------------------------------------------------------------
// Validação de dataset (pura, sem IO) — o conteúdo nunca é persistido (LGPD).
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct ValidationReport {
    pub examples: usize,
    pub issues: Vec<String>,
}

impl ValidationReport {
    pub fn is_valid(&self) -> bool {
        self.issues.is_empty()
    }
}

fn validate_jsonl(
    data: &str,
    example_issue: impl Fn(&Value) -> Option<String>,
) -> ValidationReport {
    let mut examples = 0usize;
    let mut issues = Vec::new();
    for (index, line) in data.lines().enumerate() {
        let line_number = index + 1;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if issues.len() >= MAX_ISSUES {
            issues.push("validação interrompida: excesso de problemas".into());
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            issues.push(format!("linha {line_number}: JSON inválido"));
            continue;
        };
        match example_issue(&value) {
            None => examples += 1,
            Some(problem) => issues.push(format!("linha {line_number}: {problem}")),
        }
    }
    if examples < MIN_EXAMPLES {
        issues.push(format!(
            "dataset precisa de pelo menos {MIN_EXAMPLES} exemplos válidos (encontrados {examples})"
        ));
    }
    ValidationReport { examples, issues }
}

pub fn validate_chat_jsonl(data: &str) -> ValidationReport {
    validate_jsonl(data, chat_example_issue)
}

pub fn validate_dpo_jsonl(data: &str) -> ValidationReport {
    validate_jsonl(data, dpo_example_issue)
}

fn has_content(message: &Value) -> bool {
    match message.get("content") {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(parts)) => !parts.is_empty(),
        _ => false,
    }
}

fn chat_example_issue(value: &Value) -> Option<String> {
    let Some(messages) = value.get("messages").and_then(Value::as_array) else {
        return Some("campo messages ausente ou não é array".into());
    };
    let mut has_user = false;
    let mut has_assistant = false;
    for message in messages {
        if !has_content(message) {
            continue;
        }
        match message.get("role").and_then(Value::as_str) {
            Some("user") => has_user = true,
            Some("assistant") => has_assistant = true,
            _ => {}
        }
    }
    if !has_user {
        return Some("faltou mensagem user com conteúdo".into());
    }
    if !has_assistant {
        return Some("faltou mensagem assistant com conteúdo".into());
    }
    None
}

fn non_empty_output(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.trim().is_empty(),
        _ => false,
    }
}

fn dpo_example_issue(value: &Value) -> Option<String> {
    let input_ok = value
        .pointer("/input/messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| !messages.is_empty());
    if !input_ok {
        return Some("input.messages ausente ou vazio".into());
    }
    if !non_empty_output(value.get("preferred_output")) {
        return Some("preferred_output ausente ou vazio".into());
    }
    if !non_empty_output(value.get("non_preferred_output")) {
        return Some("non_preferred_output ausente ou vazio".into());
    }
    None
}

// ---------------------------------------------------------------------------
// Builder de payload (puro) e normalização de status do provedor.
// ---------------------------------------------------------------------------

pub struct JobSpec<'a> {
    pub base_model: &'a str,
    pub training_file_id: &'a str,
    pub validation_file_id: Option<&'a str>,
    pub suffix: Option<&'a str>,
    pub method: &'a str,
    pub hyperparams: &'a Value,
}

pub fn build_job_payload(spec: &JobSpec) -> Result<Value, String> {
    if spec.base_model.trim().is_empty() {
        return Err("baseModel é obrigatório".into());
    }
    if spec.training_file_id.trim().is_empty() {
        return Err("trainingFileId é obrigatório".into());
    }
    if !matches!(spec.method, "supervised" | "dpo") {
        return Err("method deve ser supervised ou dpo".into());
    }
    let mut hyperparameters = serde_json::Map::new();
    for key in ["n_epochs", "batch_size", "learning_rate_multiplier"] {
        if let Some(value) = spec.hyperparams.get(key) {
            if !value.is_null() {
                hyperparameters.insert(key.into(), value.clone());
            }
        }
    }
    let mut method = json!({ "type": spec.method });
    method[spec.method] = json!({ "hyperparameters": Value::Object(hyperparameters) });
    let mut payload = json!({
        "training_file": spec.training_file_id,
        "model": spec.base_model,
        "method": method,
    });
    if let Some(suffix) = spec.suffix.filter(|value| !value.trim().is_empty()) {
        payload["suffix"] = json!(suffix);
    }
    if let Some(validation) = spec
        .validation_file_id
        .filter(|value| !value.trim().is_empty())
    {
        payload["validation_file"] = json!(validation);
    }
    Ok(payload)
}

// Estados transitórios desconhecidos viram "queued" (não-terminal) para o
// reconciliador continuar acompanhando; "cancelling" é tratado como cancelado.
pub fn normalize_status(provider_status: &str) -> &'static str {
    match provider_status {
        "pending" => "pending",
        "validating_files" => "validating_files",
        "queued" | "created" => "queued",
        "running" | "fine_tuning" => "running",
        "succeeded" | "success" => "succeeded",
        "failed" | "error" => "failed",
        "cancelled" | "canceled" | "cancelling" | "canceling" => "cancelled",
        _ => "queued",
    }
}

#[derive(Debug)]
pub struct ProviderJob {
    pub id: String,
    pub status: String,
    pub fine_tuned_model: Option<String>,
    pub trained_tokens: Option<i64>,
    pub error: Option<String>,
}

pub fn parse_provider_job(value: &Value) -> Result<ProviderJob, String> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("resposta do provedor sem id do job")?
        .to_string();
    let status = normalize_status(value.get("status").and_then(Value::as_str).unwrap_or(""));
    Ok(ProviderJob {
        id,
        status: status.to_string(),
        fine_tuned_model: value
            .get("fine_tuned_model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        trained_tokens: value.get("trained_tokens").and_then(Value::as_i64),
        error: value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .map(str::to_owned),
    })
}

#[derive(Debug)]
pub struct ProviderEvent {
    pub level: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Cliente de fine-tuning do provedor.
// ---------------------------------------------------------------------------

#[allow(async_fn_in_trait)]
pub trait FineTuneProvider {
    async fn upload_training_file(&self, jsonl: &str, file_name: &str) -> Result<String, ApiError>;
    async fn create_job(&self, spec: &JobSpec<'_>) -> Result<ProviderJob, ApiError>;
    async fn get_job(&self, provider_job_id: &str) -> Result<ProviderJob, ApiError>;
    async fn list_events(
        &self,
        provider_job_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<ProviderEvent>, ApiError>;
    async fn cancel(&self, provider_job_id: &str) -> Result<ProviderJob, ApiError>;
}

#[derive(Clone)]
pub struct OpenAiFineTune {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl OpenAiFineTune {
    pub fn new(http: reqwest::Client, base_url: Option<String>, api_key: String) -> Self {
        Self {
            http,
            base_url: base_url
                .unwrap_or_else(|| "https://api.openai.com/v1".into())
                .trim_end_matches('/')
                .to_string(),
            api_key,
        }
    }

    // Nunca inclui o corpo bruto no erro — só a mensagem estruturada, truncada.
    async fn provider_json(&self, response: reqwest::Response) -> Result<Value, ApiError> {
        let status = response.status();
        let value: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if status.is_success() {
            return Ok(value);
        }
        if status.is_server_error() {
            return Err(ApiError::ProvidersUnavailable);
        }
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("provider request failed");
        Err(ApiError::BadRequest(format!(
            "fine-tune provider returned HTTP {}: {}",
            status.as_u16(),
            truncate(message, 300)
        )))
    }
}

impl FineTuneProvider for OpenAiFineTune {
    async fn upload_training_file(&self, jsonl: &str, file_name: &str) -> Result<String, ApiError> {
        let part = reqwest::multipart::Part::bytes(jsonl.as_bytes().to_vec())
            .file_name(file_name.to_string())
            .mime_str("application/jsonl")
            .map_err(|error| ApiError::Internal(error.into()))?;
        let form = reqwest::multipart::Form::new()
            .text("purpose", "fine-tune")
            .part("file", part);
        let response = self
            .http
            .post(format!("{}/files", self.base_url))
            .bearer_auth(&self.api_key)
            .timeout(Duration::from_secs(120))
            .multipart(form)
            .send()
            .await?;
        let value = self.provider_json(response).await?;
        value
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| ApiError::BadRequest("provider did not return a file id".into()))
    }

    async fn create_job(&self, spec: &JobSpec<'_>) -> Result<ProviderJob, ApiError> {
        let payload = build_job_payload(spec).map_err(ApiError::BadRequest)?;
        let response = self
            .http
            .post(format!("{}/fine_tuning/jobs", self.base_url))
            .bearer_auth(&self.api_key)
            .timeout(Duration::from_secs(60))
            .json(&payload)
            .send()
            .await?;
        let value = self.provider_json(response).await?;
        parse_provider_job(&value).map_err(ApiError::BadRequest)
    }

    async fn get_job(&self, provider_job_id: &str) -> Result<ProviderJob, ApiError> {
        let response = self
            .http
            .get(format!(
                "{}/fine_tuning/jobs/{}",
                self.base_url,
                urlencoding::encode(provider_job_id)
            ))
            .bearer_auth(&self.api_key)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let value = self.provider_json(response).await?;
        parse_provider_job(&value).map_err(ApiError::BadRequest)
    }

    async fn list_events(
        &self,
        provider_job_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<ProviderEvent>, ApiError> {
        let mut url = format!(
            "{}/fine_tuning/jobs/{}/events?limit=100",
            self.base_url,
            urlencoding::encode(provider_job_id)
        );
        if let Some(after) = after {
            url.push_str("&after=");
            url.push_str(&urlencoding::encode(after));
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.api_key)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let value = self.provider_json(response).await?;
        let mut events = value
            .get("data")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| ProviderEvent {
                        level: item
                            .get("level")
                            .and_then(Value::as_str)
                            .unwrap_or("info")
                            .to_string(),
                        message: item
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // O provedor devolve do mais novo para o mais antigo.
        events.reverse();
        Ok(events)
    }

    async fn cancel(&self, provider_job_id: &str) -> Result<ProviderJob, ApiError> {
        let response = self
            .http
            .post(format!(
                "{}/fine_tuning/jobs/{}/cancel",
                self.base_url,
                urlencoding::encode(provider_job_id)
            ))
            .bearer_auth(&self.api_key)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let value = self.provider_json(response).await?;
        parse_provider_job(&value).map_err(ApiError::BadRequest)
    }
}

// Resolve credenciais do provedor do workspace (mesmo decrypt das rotas de chat).
async fn finetune_client(
    state: &AppState,
    workspace: Uuid,
    provider: Uuid,
) -> Result<OpenAiFineTune, ApiError> {
    let row = sqlx::query(
        "SELECT kind, base_url, encrypted_api_key FROM providers WHERE workspace_id=$1 AND id=$2 AND enabled=true",
    )
    .bind(workspace)
    .bind(provider)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    let kind: String = row.try_get("kind")?;
    if !matches!(kind.as_str(), "openai" | "openai-compatible") {
        return Err(ApiError::BadRequest(
            "fine-tuning requires an openai or openai-compatible provider".into(),
        ));
    }
    let base_url: Option<String> = row.try_get("base_url")?;
    if kind == "openai-compatible" && base_url.is_none() {
        return Err(ApiError::BadRequest(
            "custom provider requires baseUrl".into(),
        ));
    }
    let api_key = state
        .providers
        .secrets
        .open(row.try_get("encrypted_api_key")?)
        .map_err(ApiError::Internal)?;
    Ok(OpenAiFineTune::new(
        state.providers.http.clone(),
        base_url,
        api_key,
    ))
}

// usage_events guarda só metadados (sem conteúdo); mode fixo "finetune".
async fn log_finetune_usage(
    state: &AppState,
    workspace: Uuid,
    user: Uuid,
    provider: Uuid,
    capability: &str,
    model: &str,
    latency_ms: i32,
) {
    let _ = sqlx::query("INSERT INTO usage_events(workspace_id,user_id,provider_id,mode,capability,model,status_code,latency_ms) VALUES($1,$2,$3,'finetune',$4,$5,200,$6)")
        .bind(workspace)
        .bind(user)
        .bind(provider)
        .bind(capability)
        .bind(model)
        .bind(latency_ms)
        .execute(&state.pool)
        .await;
}

// ---------------------------------------------------------------------------
// Handlers HTTP (mesmo padrão de auth/RBAC das rotas de providers).
// ---------------------------------------------------------------------------

async fn authorized_user(
    state: &AppState,
    headers: &HeaderMap,
    workspace: Uuid,
    minimum: i16,
) -> Result<Uuid, ApiError> {
    let user = user_id(state, &identity(state, headers).await?).await?;
    require_role(state, user, workspace, minimum).await?;
    Ok(user)
}

fn job_json(row: &PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "workspaceId": row.get::<Uuid, _>("workspace_id"),
        "providerId": row.get::<Uuid, _>("provider_id"),
        "baseModel": row.get::<String, _>("base_model"),
        "suffix": row.get::<Option<String>, _>("suffix"),
        "method": row.get::<String, _>("method"),
        "hyperparams": row.get::<Value, _>("hyperparams"),
        "status": row.get::<String, _>("status"),
        "providerJobId": row.get::<Option<String>, _>("provider_job_id"),
        "providerFileId": row.get::<Option<String>, _>("provider_file_id"),
        "fineTunedModel": row.get::<Option<String>, _>("fine_tuned_model"),
        "error": row.get::<Option<String>, _>("error"),
        "trainingExamples": row.get::<i32, _>("training_examples"),
        "trainedTokens": row.get::<Option<i64>, _>("trained_tokens"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
    })
}

const JOB_COLUMNS: &str = "id,workspace_id,provider_id,base_model,suffix,method,hyperparams,status,provider_job_id,provider_file_id,fine_tuned_model,error,training_examples,trained_tokens,created_at,updated_at";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetQuery {
    #[serde(default, alias = "provider_id")]
    provider_id: Option<Uuid>,
}

pub async fn dataset_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(query): Query<DatasetQuery>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    state.metrics.request();
    let user = authorized_user(&state, &headers, workspace, 2).await?;
    rate_limit(&state, workspace).await?;

    let mut file: Option<(String, String)> = None;
    let mut format = String::from("chat");
    let mut provider_id = query.provider_id;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::BadRequest(format!("invalid multipart payload: {error}")))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                let name = field.file_name().unwrap_or("dataset.jsonl").to_string();
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|_| ApiError::BadRequest("could not read dataset file".into()))?;
                let text = String::from_utf8(bytes.to_vec())
                    .map_err(|_| ApiError::BadRequest("dataset must be UTF-8 JSONL".into()))?;
                file = Some((name, text));
            }
            "format" => {
                format = field
                    .text()
                    .await
                    .map_err(|_| ApiError::BadRequest("invalid format field".into()))?;
            }
            "providerId" | "provider_id" => {
                let raw = field
                    .text()
                    .await
                    .map_err(|_| ApiError::BadRequest("invalid providerId field".into()))?;
                provider_id =
                    Some(raw.trim().parse().map_err(|_| {
                        ApiError::BadRequest("providerId must be a valid UUID".into())
                    })?);
            }
            _ => {}
        }
    }
    let (file_name, contents) =
        file.ok_or_else(|| ApiError::BadRequest("multipart field file is required".into()))?;
    let provider_id =
        provider_id.ok_or_else(|| ApiError::BadRequest("providerId is required".into()))?;
    let report = match format.trim() {
        "chat" => validate_chat_jsonl(&contents),
        "dpo" => validate_dpo_jsonl(&contents),
        _ => return Err(ApiError::BadRequest("format must be chat or dpo".into())),
    };
    if !report.is_valid() {
        return Ok((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": { "code": "invalid_dataset", "message": "dataset validation failed" },
                "examples": report.examples,
                "issues": report.issues,
            })),
        )
            .into_response());
    }
    let client = finetune_client(&state, workspace, provider_id).await?;
    let started = Instant::now();
    let provider_file_id = client.upload_training_file(&contents, &file_name).await?;
    // LGPD: o conteúdo do dataset não é persistido — só o evento de uso.
    log_finetune_usage(
        &state,
        workspace,
        user,
        provider_id,
        "finetune.dataset",
        "-",
        started.elapsed().as_millis() as i32,
    )
    .await;
    Ok(Json(json!({
        "providerFileId": provider_file_id,
        "examples": report.examples,
        "issues": [],
    }))
    .into_response())
}

fn default_method() -> String {
    "supervised".into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FineTuneJobInput {
    provider_id: Uuid,
    base_model: String,
    suffix: Option<String>,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    hyperparams: Option<Value>,
    training_file_id: String,
    validation_file_id: Option<String>,
    #[serde(default)]
    training_examples: i32,
}

pub async fn job_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(input): Json<FineTuneJobInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    state.metrics.request();
    let user = authorized_user(&state, &headers, workspace, 2).await?;
    rate_limit(&state, workspace).await?;
    if input.training_examples < 0 {
        return Err(ApiError::BadRequest(
            "trainingExamples must be zero or positive".into(),
        ));
    }
    let hyperparams = input.hyperparams.clone().unwrap_or_else(|| json!({}));
    let spec = JobSpec {
        base_model: &input.base_model,
        training_file_id: &input.training_file_id,
        validation_file_id: input.validation_file_id.as_deref(),
        suffix: input.suffix.as_deref(),
        method: &input.method,
        hyperparams: &hyperparams,
    };
    // Valida o payload localmente antes de chamar o provedor.
    build_job_payload(&spec).map_err(ApiError::BadRequest)?;
    let client = finetune_client(&state, workspace, input.provider_id).await?;
    let started = Instant::now();
    // Erro do provedor não vira 4xx aqui: o job é registrado como failed.
    let (status, provider_job_id, error) = match client.create_job(&spec).await {
        Ok(job) => (job.status, Some(job.id), job.error),
        Err(ApiError::BadRequest(message)) => ("failed".to_string(), None, Some(message)),
        Err(ApiError::ProvidersUnavailable) => (
            "failed".to_string(),
            None,
            Some("fine-tune provider is unavailable".into()),
        ),
        Err(other) => return Err(other),
    };
    let row = sqlx::query(&format!(
        "INSERT INTO fine_tune_jobs(workspace_id,provider_id,base_model,suffix,method,hyperparams,status,provider_job_id,provider_file_id,error,training_examples) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING {JOB_COLUMNS}"
    ))
    .bind(workspace)
    .bind(input.provider_id)
    .bind(&input.base_model)
    .bind(&input.suffix)
    .bind(&input.method)
    .bind(&hyperparams)
    .bind(&status)
    .bind(&provider_job_id)
    .bind(&input.training_file_id)
    .bind(&error)
    .bind(input.training_examples)
    .fetch_one(&state.pool)
    .await?;
    log_finetune_usage(
        &state,
        workspace,
        user,
        input.provider_id,
        "finetune.job",
        &input.base_model,
        started.elapsed().as_millis() as i32,
    )
    .await;
    Ok((StatusCode::CREATED, Json(job_json(&row))))
}

#[derive(Deserialize)]
pub struct ListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

pub async fn jobs_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    authorized_user(&state, &headers, workspace, 1).await?;
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let rows = sqlx::query(&format!(
        "SELECT {JOB_COLUMNS} FROM fine_tune_jobs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ))
    .bind(workspace)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "jobs": rows.iter().map(job_json).collect::<Vec<_>>(),
        "limit": limit,
        "offset": offset,
    })))
}

pub async fn job_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, job)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    authorized_user(&state, &headers, workspace, 1).await?;
    let row = sqlx::query(&format!(
        "SELECT {JOB_COLUMNS} FROM fine_tune_jobs WHERE workspace_id=$1 AND id=$2"
    ))
    .bind(workspace)
    .bind(job)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(job_json(&row)))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    after: i64,
}

fn event_json(row: &PgRow) -> Value {
    json!({
        "seq": row.get::<i32, _>("seq"),
        "level": row.get::<String, _>("level"),
        "message": row.get::<String, _>("message"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
    })
}

pub async fn job_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, job)): Path<(Uuid, Uuid)>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Value>, ApiError> {
    authorized_user(&state, &headers, workspace, 1).await?;
    let status: String =
        sqlx::query_scalar("SELECT status FROM fine_tune_jobs WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(job)
            .fetch_optional(&state.pool)
            .await?
            .ok_or(ApiError::NotFound)?;
    let after = query.after.clamp(0, i32::MAX as i64) as i32;
    let rows = sqlx::query(
        "SELECT seq,level,message,created_at FROM fine_tune_job_events WHERE job_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
    )
    .bind(job)
    .bind(after)
    .bind(EVENT_PAGE_LIMIT)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "jobId": job,
        "status": status,
        "events": rows.iter().map(event_json).collect::<Vec<_>>(),
    })))
}

// SSE de eventos com replay via Last-Event-ID (id = seq). Não passa pelo
// rate limit por workspace: o limite de 120/min é aplicado por chamada de
// função dentro de cada handler (não é middleware), então basta não chamá-lo
// aqui — uma conexão SSE é longa e faria o polling do cliente estourar o limite.
pub async fn job_events_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, job)): Path<(Uuid, Uuid)>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    authorized_user(&state, &headers, workspace, 1).await?;
    let exists: Option<String> =
        sqlx::query_scalar("SELECT status FROM fine_tune_jobs WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(job)
            .fetch_optional(&state.pool)
            .await?;
    exists.ok_or(ApiError::NotFound)?;
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i64>().ok())
        .map(|value| value.clamp(0, i32::MAX as i64) as i32)
        .unwrap_or(0);
    let stream = event_stream(state, job, cursor);
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    ))
}

struct SseCursor {
    state: AppState,
    job: Uuid,
    cursor: i32,
    pending: VecDeque<Event>,
    finished: bool,
    first_poll: bool,
}

fn event_stream(
    state: AppState,
    job: Uuid,
    cursor: i32,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let initial = SseCursor {
        state,
        job,
        cursor,
        pending: VecDeque::new(),
        finished: false,
        first_poll: true,
    };
    futures_util::stream::unfold(initial, |mut sse| async move {
        loop {
            if let Some(event) = sse.pending.pop_front() {
                return Some((Ok(event), sse));
            }
            if sse.finished {
                return None;
            }
            if sse.first_poll {
                sse.first_poll = false;
            } else {
                tokio::time::sleep(SSE_POLL_INTERVAL).await;
            }
            match poll_job_events(&sse.state, sse.job, sse.cursor).await {
                Ok((events, status, summary)) => {
                    for (seq, event) in events {
                        sse.cursor = seq;
                        sse.pending.push_back(event);
                    }
                    if is_terminal(&status) {
                        // JSON compacto não contém quebras de linha.
                        sse.pending.push_back(
                            Event::default().event("complete").data(summary.to_string()),
                        );
                        sse.finished = true;
                    }
                }
                Err(error) => {
                    tracing::warn!(job=%sse.job, error=%error, "fine-tune SSE poll failed");
                    sse.finished = true;
                }
            }
        }
    })
}

async fn poll_job_events(
    state: &AppState,
    job: Uuid,
    after: i32,
) -> Result<(Vec<(i32, Event)>, String, Value), ApiError> {
    let row = sqlx::query(
        "SELECT status,fine_tuned_model,error,trained_tokens FROM fine_tune_jobs WHERE id=$1",
    )
    .bind(job)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    let status: String = row.try_get("status")?;
    let summary = json!({
        "status": status,
        "fineTunedModel": row.get::<Option<String>, _>("fine_tuned_model"),
        "error": row.get::<Option<String>, _>("error"),
        "trainedTokens": row.get::<Option<i64>, _>("trained_tokens"),
    });
    let rows = sqlx::query(
        "SELECT seq,level,message,created_at FROM fine_tune_job_events WHERE job_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
    )
    .bind(job)
    .bind(after)
    .bind(EVENT_PAGE_LIMIT)
    .fetch_all(&state.pool)
    .await?;
    let events = rows
        .iter()
        .map(|row| {
            let seq: i32 = row.get("seq");
            (
                seq,
                Event::default()
                    .id(seq.to_string())
                    .data(event_json(row).to_string()),
            )
        })
        .collect();
    Ok((events, status, summary))
}

pub async fn job_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, job)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    state.metrics.request();
    authorized_user(&state, &headers, workspace, 2).await?;
    rate_limit(&state, workspace).await?;
    let row = sqlx::query(
        "SELECT status,provider_id,provider_job_id FROM fine_tune_jobs WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(job)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    let status: String = row.try_get("status")?;
    if is_terminal(&status) {
        return Err(ApiError::BadRequest(
            "job is already in a terminal state".into(),
        ));
    }
    let provider_id: Uuid = row.try_get("provider_id")?;
    let provider_job_id: Option<String> = row.try_get("provider_job_id")?;
    let new_status = match provider_job_id {
        Some(provider_job_id) => {
            let client = finetune_client(&state, workspace, provider_id).await?;
            client.cancel(&provider_job_id).await?.status
        }
        // Job nunca chegou ao provedor: cancela localmente.
        None => "cancelled".to_string(),
    };
    let updated = sqlx::query(&format!(
        "UPDATE fine_tune_jobs SET status=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING {JOB_COLUMNS}"
    ))
    .bind(workspace)
    .bind(job)
    .bind(&new_status)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(job_json(&updated)))
}

pub async fn models_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    authorized_user(&state, &headers, workspace, 1).await?;
    let rows = sqlx::query(
        "SELECT id,provider_id,job_id,base_model,model_id,label,created_at FROM fine_tuned_models WHERE workspace_id=$1 ORDER BY created_at DESC",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "id": row.get::<Uuid, _>("id"),
                    "providerId": row.get::<Uuid, _>("provider_id"),
                    "jobId": row.get::<Option<Uuid>, _>("job_id"),
                    "baseModel": row.get::<String, _>("base_model"),
                    "modelId": row.get::<String, _>("model_id"),
                    "label": row.get::<Option<String>, _>("label"),
                    "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                })
            })
            .collect(),
    )))
}

// ---------------------------------------------------------------------------
// Reconciliador: sincroniza jobs não-terminais com o provedor a cada ~20s.
// ---------------------------------------------------------------------------

pub async fn reconciler(state: AppState) {
    let mut ticker = tokio::time::interval(RECONCILE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        if let Err(error) = reconcile_cycle(&state).await {
            // Erros de rede/banco não derrubam a task: loga e tenta no próximo ciclo.
            tracing::warn!(error=%error, "fine-tune reconcile cycle failed");
        }
    }
}

async fn reconcile_cycle(state: &AppState) -> Result<(), ApiError> {
    let jobs = sqlx::query(
        "SELECT id,workspace_id,provider_id,provider_job_id,base_model,suffix FROM fine_tune_jobs \
         WHERE status IN ('pending','validating_files','queued','running') AND provider_job_id IS NOT NULL \
         ORDER BY created_at LIMIT 50",
    )
    .fetch_all(&state.pool)
    .await?;
    // Cache de clientes por provider_id: evita N+1 de decrypt dentro do ciclo.
    let mut clients: HashMap<Uuid, OpenAiFineTune> = HashMap::new();
    for row in jobs {
        let job_id: Uuid = row.get("id");
        if let Err(error) = reconcile_job(state, &mut clients, &row).await {
            tracing::warn!(job=%job_id, error=%error, "fine-tune job reconcile failed");
        }
    }
    Ok(())
}

async fn reconcile_job(
    state: &AppState,
    clients: &mut HashMap<Uuid, OpenAiFineTune>,
    row: &PgRow,
) -> Result<(), ApiError> {
    let job_id: Uuid = row.try_get("id")?;
    let workspace_id: Uuid = row.try_get("workspace_id")?;
    let provider_id: Uuid = row.try_get("provider_id")?;
    let provider_job_id: String = row.try_get("provider_job_id")?;
    let base_model: String = row.try_get("base_model")?;
    let suffix: Option<String> = row.try_get("suffix")?;

    let client = match clients.get(&provider_id) {
        Some(client) => client.clone(),
        None => {
            let client = finetune_client(state, workspace_id, provider_id).await?;
            clients.insert(provider_id, client.clone());
            client
        }
    };

    let provider_job = client.get_job(&provider_job_id).await?;

    // Eventos novos: seq monotônico por job = max(seq)+1. O provedor devolve a
    // lista completa (mais recente primeiro; já reordenada para cronológica),
    // então os já gravados são pulados pela contagem.
    match client.list_events(&provider_job_id, None).await {
        Ok(events) => {
            let max_seq: i32 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(seq),0) FROM fine_tune_job_events WHERE job_id=$1",
            )
            .bind(job_id)
            .fetch_one(&state.pool)
            .await?;
            let mut seq = max_seq;
            for event in events.iter().skip(max_seq.max(0) as usize) {
                seq += 1;
                sqlx::query(
                    "INSERT INTO fine_tune_job_events(job_id,seq,level,message) VALUES($1,$2,$3,$4) ON CONFLICT (job_id,seq) DO NOTHING",
                )
                .bind(job_id)
                .bind(seq)
                .bind(&event.level)
                .bind(truncate(&event.message, 2000))
                .execute(&state.pool)
                .await?;
            }
        }
        // Falha só nos eventos não impede a atualização de status.
        Err(error) => {
            tracing::warn!(job=%job_id, error=%error, "fine-tune events fetch failed")
        }
    }

    sqlx::query(
        "UPDATE fine_tune_jobs SET status=$2,fine_tuned_model=COALESCE($3,fine_tuned_model),trained_tokens=COALESCE($4,trained_tokens),error=COALESCE($5,error),updated_at=now() WHERE id=$1",
    )
    .bind(job_id)
    .bind(&provider_job.status)
    .bind(&provider_job.fine_tuned_model)
    .bind(provider_job.trained_tokens)
    .bind(&provider_job.error)
    .execute(&state.pool)
    .await?;

    if provider_job.status == "succeeded" {
        if let Some(model_id) = &provider_job.fine_tuned_model {
            sqlx::query(
                "INSERT INTO fine_tuned_models(workspace_id,provider_id,job_id,base_model,model_id,label) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,model_id) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(provider_id)
            .bind(job_id)
            .bind(&base_model)
            .bind(model_id)
            .bind(&suffix)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Testes unitários (sem rede e sem banco).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn chat_line(user: &str, assistant: &str) -> String {
        json!({"messages":[{"role":"user","content":user},{"role":"assistant","content":assistant}]})
            .to_string()
    }

    fn dpo_line(prompt: &str) -> String {
        json!({
            "input": {"messages":[{"role":"user","content":prompt}]},
            "preferred_output": [{"role":"assistant","content":"bom"}],
            "non_preferred_output": [{"role":"assistant","content":"ruim"}],
        })
        .to_string()
    }

    #[test]
    fn accepts_valid_chat_dataset() {
        let data = (0..10)
            .map(|i| chat_line(&format!("pergunta {i}"), &format!("resposta {i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let report = validate_chat_jsonl(&data);
        assert_eq!(report.examples, 10);
        assert!(report.is_valid(), "issues: {:?}", report.issues);
    }

    #[test]
    fn flags_invalid_chat_lines_with_line_numbers() {
        let lines = vec![
            chat_line("oi", "olá"),
            "isto não é json".to_string(),
            json!({"messages":[{"role":"user","content":"sem resposta"}]}).to_string(),
            json!({"foo":"bar"}).to_string(),
            json!({"messages":[{"role":"user","content":""},{"role":"assistant","content":"x"}]})
                .to_string(),
        ];
        let report = validate_chat_jsonl(&lines.join("\n"));
        assert_eq!(report.examples, 1);
        assert!(report.issues.iter().any(|issue| issue.contains("linha 2")));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("linha 3") && issue.contains("assistant")));
        assert!(report.issues.iter().any(|issue| issue.contains("linha 4")));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("linha 5") && issue.contains("user")));
    }

    #[test]
    fn requires_minimum_chat_examples() {
        let data = (0..9)
            .map(|i| chat_line(&format!("p{i}"), &format!("r{i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let report = validate_chat_jsonl(&data);
        assert_eq!(report.examples, 9);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("pelo menos 10")));
    }

    #[test]
    fn ignores_blank_lines() {
        let data = (0..10)
            .map(|i| chat_line(&format!("p{i}"), &format!("r{i}")))
            .collect::<Vec<_>>()
            .join("\n\n");
        let report = validate_chat_jsonl(&data);
        assert_eq!(report.examples, 10);
        assert!(report.is_valid());
    }

    #[test]
    fn accepts_valid_dpo_dataset() {
        let data = (0..10)
            .map(|i| dpo_line(&format!("pergunta {i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let report = validate_dpo_jsonl(&data);
        assert_eq!(report.examples, 10);
        assert!(report.is_valid(), "issues: {:?}", report.issues);
    }

    #[test]
    fn flags_invalid_dpo_lines() {
        let lines = vec![
            dpo_line("ok"),
            json!({"input":{"messages":[]},"preferred_output":[{"a":1}],"non_preferred_output":[{"a":1}]})
                .to_string(),
            json!({"input":{"messages":[{"role":"user","content":"x"}]},"non_preferred_output":[{"a":1}]})
                .to_string(),
            json!({"input":{"messages":[{"role":"user","content":"x"}]},"preferred_output":[{"a":1}],"non_preferred_output":[]})
                .to_string(),
        ];
        let report = validate_dpo_jsonl(&lines.join("\n"));
        assert_eq!(report.examples, 1);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("linha 2") && issue.contains("input.messages")));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("linha 3") && issue.contains("preferred_output")));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("linha 4") && issue.contains("non_preferred_output")));
    }

    #[test]
    fn builds_supervised_payload_with_filtered_hyperparams() {
        let hyperparams = json!({"n_epochs":3,"learning_rate_multiplier":0.5,"nao_suportado":"x"});
        let payload = build_job_payload(&JobSpec {
            base_model: "gpt-4.1-mini",
            training_file_id: "file-1",
            validation_file_id: Some("file-2"),
            suffix: Some("clone"),
            method: "supervised",
            hyperparams: &hyperparams,
        })
        .unwrap();
        assert_eq!(payload["training_file"], "file-1");
        assert_eq!(payload["validation_file"], "file-2");
        assert_eq!(payload["model"], "gpt-4.1-mini");
        assert_eq!(payload["suffix"], "clone");
        assert_eq!(payload["method"]["type"], "supervised");
        assert_eq!(
            payload["method"]["supervised"]["hyperparameters"]["n_epochs"],
            3
        );
        assert_eq!(
            payload["method"]["supervised"]["hyperparameters"]["learning_rate_multiplier"],
            0.5
        );
        assert!(payload["method"]["supervised"]["hyperparameters"]
            .get("nao_suportado")
            .is_none());
        assert!(payload["method"].get("dpo").is_none());
    }

    #[test]
    fn builds_dpo_payload_without_optional_fields() {
        let hyperparams = json!({});
        let payload = build_job_payload(&JobSpec {
            base_model: "gpt-4.1-mini",
            training_file_id: "file-1",
            validation_file_id: None,
            suffix: None,
            method: "dpo",
            hyperparams: &hyperparams,
        })
        .unwrap();
        assert_eq!(payload["method"]["type"], "dpo");
        assert_eq!(payload["method"]["dpo"]["hyperparameters"], json!({}));
        assert!(payload.get("suffix").is_none());
        assert!(payload.get("validation_file").is_none());
    }

    #[test]
    fn rejects_invalid_job_specs() {
        let hyperparams = json!({});
        assert!(build_job_payload(&JobSpec {
            base_model: "m",
            training_file_id: "file-1",
            validation_file_id: None,
            suffix: None,
            method: "rlhf",
            hyperparams: &hyperparams,
        })
        .is_err());
        assert!(build_job_payload(&JobSpec {
            base_model: " ",
            training_file_id: "file-1",
            validation_file_id: None,
            suffix: None,
            method: "supervised",
            hyperparams: &hyperparams,
        })
        .is_err());
        assert!(build_job_payload(&JobSpec {
            base_model: "m",
            training_file_id: "",
            validation_file_id: None,
            suffix: None,
            method: "supervised",
            hyperparams: &hyperparams,
        })
        .is_err());
    }

    #[test]
    fn normalizes_provider_statuses() {
        assert_eq!(normalize_status("validating_files"), "validating_files");
        assert_eq!(normalize_status("queued"), "queued");
        assert_eq!(normalize_status("running"), "running");
        assert_eq!(normalize_status("succeeded"), "succeeded");
        assert_eq!(normalize_status("failed"), "failed");
        assert_eq!(normalize_status("cancelled"), "cancelled");
        assert_eq!(normalize_status("canceled"), "cancelled");
        assert_eq!(normalize_status("cancelling"), "cancelled");
        assert_eq!(normalize_status("pending"), "pending");
        // Desconhecido permanece não-terminal para o reconciliador acompanhar.
        assert_eq!(normalize_status("alguma_coisa_nova"), "queued");
    }

    #[test]
    fn parses_provider_job_payload() {
        let running = json!({"id":"ftjob-1","status":"running","fine_tuned_model":null,"trained_tokens":null,"error":{}});
        let job = parse_provider_job(&running).unwrap();
        assert_eq!(job.id, "ftjob-1");
        assert_eq!(job.status, "running");
        assert!(job.fine_tuned_model.is_none());
        assert!(job.trained_tokens.is_none());
        assert!(job.error.is_none());

        let done = json!({"id":"ftjob-2","status":"succeeded","fine_tuned_model":"ft:gpt-4.1-mini:acme::abc","trained_tokens":12345,"error":{"message":""}});
        let job = parse_provider_job(&done).unwrap();
        assert_eq!(job.status, "succeeded");
        assert_eq!(
            job.fine_tuned_model.as_deref(),
            Some("ft:gpt-4.1-mini:acme::abc")
        );
        assert_eq!(job.trained_tokens, Some(12345));

        let failed =
            json!({"id":"ftjob-3","status":"failed","error":{"message":"invalid training file"}});
        let job = parse_provider_job(&failed).unwrap();
        assert_eq!(job.status, "failed");
        assert_eq!(job.error.as_deref(), Some("invalid training file"));

        assert!(parse_provider_job(&json!({"status":"running"})).is_err());
    }

    #[test]
    fn terminal_status_detection() {
        assert!(is_terminal("succeeded"));
        assert!(is_terminal("failed"));
        assert!(is_terminal("cancelled"));
        assert!(!is_terminal("pending"));
        assert!(!is_terminal("validating_files"));
        assert!(!is_terminal("queued"));
        assert!(!is_terminal("running"));
    }
}
