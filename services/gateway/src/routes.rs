use crate::{
    auth::{RefreshExchange, TokenExchange},
    error::ApiError,
    models::{
        Capability, ChatRequest, DesignReplicationRequest, Identity, Mode, OrchestrationGraph,
        OrchestrationNodeKind, OrchestrationPlan, RouteConfig,
    },
    state::AppState,
    usage::{SseUsageScanner, TokenUsage},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use axum::body::Body;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub(crate) async fn identity(state: &AppState, headers: &HeaderMap) -> Result<Identity, ApiError> {
    state.auth.identity(headers).await
}

pub(crate) async fn user_id(state: &AppState, identity: &Identity) -> Result<Uuid, ApiError> {
    let row = sqlx::query("INSERT INTO users (oidc_subject,email,display_name) VALUES ($1,$2,$3) ON CONFLICT (oidc_subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,updated_at=now() RETURNING id")
        .bind(&identity.subject).bind(&identity.email).bind(&identity.name).fetch_one(&state.pool).await?;
    Ok(row.try_get("id")?)
}

pub(crate) async fn require_role(
    state: &AppState,
    user: Uuid,
    workspace: Uuid,
    minimum: i16,
) -> Result<String, ApiError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role::text FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await?;
    let role = role.ok_or(ApiError::NotFound)?;
    let rank = match role.as_str() {
        "owner" => 3,
        "admin" => 2,
        "member" => 1,
        _ => 0,
    };
    if rank < minimum {
        return Err(ApiError::Forbidden);
    }
    Ok(role)
}

pub(crate) async fn rate_limit(state: &AppState, workspace: Uuid) -> Result<(), ApiError> {
    let minute = chrono::Utc::now().timestamp() / 60;
    let key = format!("rate:{workspace}:{minute}");
    let mut connection = state
        .redis
        .get_multiplexed_tokio_connection()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let count: i64 = redis::cmd("INCR")
        .arg(&key)
        .query_async(&mut connection)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    if count == 1 {
        let _: i64 = redis::cmd("EXPIRE")
            .arg(&key)
            .arg(120)
            .query_async(&mut connection)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    }
    if count > 120 {
        return Err(ApiError::RateLimited);
    }
    Ok(())
}

pub async fn health(State(state): State<AppState>) -> Response {
    let postgres = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    let redis = match state.redis.get_multiplexed_tokio_connection().await {
        Ok(mut conn) => redis::cmd("PING")
            .query_async::<String>(&mut conn)
            .await
            .is_ok(),
        Err(_) => false,
    };
    let status = if postgres && redis {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(json!({"status":if status==StatusCode::OK{"ok"}else{"degraded"},"postgres":postgres,"redis":redis}))).into_response()
}

pub async fn metrics(State(state): State<AppState>) -> Response {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        state.metrics.render(),
    )
        .into_response()
}

pub async fn oidc_config(State(state): State<AppState>) -> Result<Json<impl Serialize>, ApiError> {
    Ok(Json(state.auth.public_config().await?))
}

pub async fn oidc_token(
    State(state): State<AppState>,
    Json(request): Json<TokenExchange>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.auth.exchange(request).await?))
}

pub async fn oidc_refresh(
    State(state): State<AppState>,
    Json(request): Json<RefreshExchange>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.auth.refresh(request).await?))
}

pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = identity(&state, &headers).await?;
    let id = user_id(&state, &identity).await?;
    Ok(Json(
        json!({"id":id,"subject":identity.subject,"email":identity.email,"name":identity.name}),
    ))
}

/// Bootstrap do cliente gerenciado: perfil + política efetiva, com etag para
/// revalidação barata (If-None-Match → 304). O workspace vem da associação do
/// usuário, não de um campo digitado; a assinatura entra na S3.
pub async fn bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let identity = identity(&state, &headers).await?;
    let user = user_id(&state, &identity).await?;

    // O primeiro workspace do usuário (ordem estável por nome). Sem
    // associação não há política a herdar — 404, como qualquer recurso
    // que não existe para ele.
    let membership = sqlx::query(
        "SELECT w.id, w.name, m.role::text AS role FROM workspaces w \
         JOIN workspace_members m ON m.workspace_id = w.id \
         WHERE m.user_id = $1 ORDER BY w.name LIMIT 1",
    )
    .bind(user)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    let workspace: Uuid = membership.get("id");

    let policy = crate::policy::resolve(&state, workspace, user, &identity.groups).await?;
    let etag = crate::policy::policy_etag(&policy);

    if headers
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"'))
        == Some(etag.as_str())
    {
        return Ok(axum::http::StatusCode::NOT_MODIFIED.into_response());
    }

    let issued_at = chrono::Utc::now().to_rfc3339();
    let expires_at = (chrono::Utc::now() + chrono::Duration::hours(6)).to_rfc3339();
    let profile = json!({
        "userId": user,
        "subject": identity.subject,
        "email": identity.email,
        "name": identity.name,
        "groups": identity.groups,
        "workspaceId": workspace,
        "workspaceName": membership.get::<String, _>("name"),
        "role": membership.get::<String, _>("role"),
    });
    let policy_value =
        serde_json::to_value(&policy).map_err(|error| ApiError::Internal(error.into()))?;
    // Assinatura Ed25519 sobre a mensagem canônica — o cliente managed RECUSA
    // política sem assinatura; sem a seed configurada (dev) segue nula.
    let signature = match &state.config.policy_signing_seed {
        Some(seed) => Value::String(crate::policy::sign_bootstrap(
            seed,
            &crate::policy::signing_message(&issued_at, &expires_at, &profile, &policy_value),
        )?),
        None => Value::Null,
    };
    let body = json!({
        "schemaVersion": 1,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "etag": etag,
        "signature": signature,
        "profile": profile,
        "policy": policy_value,
    });
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        axum::http::header::ETAG,
        axum::http::HeaderValue::from_str(&format!("\"{etag}\""))
            .map_err(|error| ApiError::Internal(error.into()))?,
    );
    Ok(response)
}

pub async fn workspaces(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let identity = identity(&state, &headers).await?;
    let id = user_id(&state, &identity).await?;
    let rows = sqlx::query("SELECT w.id,w.name,m.role::text AS role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.name")
        .bind(id).fetch_all(&state.pool).await?;
    Ok(Json(Value::Array(rows.into_iter().map(|row| json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),"role":row.get::<String,_>("role")})).collect())))
}

pub async fn routing_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 1).await?;
    let rows = sqlx::query(
        "SELECT config FROM route_configs WHERE workspace_id=$1 ORDER BY mode,capability",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.into_iter().map(|row| row.get("config")).collect(),
    )))
}

pub async fn routing_patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(routes): Json<Vec<RouteConfig>>,
) -> Result<Json<Value>, ApiError> {
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 2).await?;
    let mut transaction = state.pool.begin().await?;
    for route in &routes {
        if !route
            .allowed_capabilities
            .iter()
            .any(|cap| cap.as_str() == route.capability.as_str())
        {
            return Err(ApiError::BadRequest(
                "route capability must be allowed".into(),
            ));
        }
        sqlx::query("INSERT INTO route_configs(workspace_id,mode,capability,config) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,mode,capability) DO UPDATE SET config=EXCLUDED.config,updated_at=now()")
            .bind(workspace).bind(route.mode.as_str()).bind(route.capability.as_str()).bind(serde_json::to_value(route).map_err(|e| ApiError::Internal(e.into()))?).execute(&mut *transaction).await?;
    }
    transaction.commit().await?;
    Ok(Json(json!({"updated":routes.len()})))
}

pub async fn orchestration_validate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(graph): Json<OrchestrationGraph>,
) -> Result<Json<OrchestrationPlan>, ApiError> {
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 1).await?;
    rate_limit(&state, workspace).await?;
    let plan = plan_orchestration(&graph).map_err(ApiError::BadRequest)?;
    Ok(Json(plan))
}

/// `pub(crate)` porque o run durável CONGELA o plano no momento da criação
/// (ver migration 0009): o mesmo validador da rota tem de valer ali.
pub(crate) fn plan_orchestration(
    graph: &OrchestrationGraph,
) -> Result<OrchestrationPlan, String> {
    if graph.schema_version != 1 {
        return Err("unsupported orchestration schemaVersion".into());
    }
    if graph.name.trim().is_empty() {
        return Err("graph name is required".into());
    }
    if graph.nodes.is_empty() || graph.nodes.len() > 128 {
        return Err("graph must contain between 1 and 128 nodes".into());
    }
    if !(1..=32).contains(&graph.max_concurrency) {
        return Err("maxConcurrency must be between 1 and 32".into());
    }

    let mut indices = BTreeMap::new();
    for (index, node) in graph.nodes.iter().enumerate() {
        if node.id.trim().is_empty() || node.name.trim().is_empty() {
            return Err("every node requires a non-empty id and name".into());
        }
        if indices.insert(node.id.clone(), index).is_some() {
            return Err(format!("duplicate node id: {}", node.id));
        }
        if node.depends_on.len() > 32 {
            return Err(format!("node {} has too many dependencies", node.id));
        }
    }

    let mut indegree = vec![0usize; graph.nodes.len()];
    let mut outgoing = vec![Vec::<usize>::new(); graph.nodes.len()];
    for (index, node) in graph.nodes.iter().enumerate() {
        let mut unique_dependencies = BTreeSet::new();
        for dependency in &node.depends_on {
            if dependency == &node.id {
                return Err(format!("node {} cannot depend on itself", node.id));
            }
            if !unique_dependencies.insert(dependency) {
                return Err(format!(
                    "node {} repeats dependency {}",
                    node.id, dependency
                ));
            }
            let Some(&dependency_index) = indices.get(dependency) else {
                return Err(format!(
                    "node {} depends on missing node {}",
                    node.id, dependency
                ));
            };
            indegree[index] += 1;
            outgoing[dependency_index].push(index);
        }
    }

    let mut ready = indegree
        .iter()
        .enumerate()
        .filter_map(|(index, degree)| (*degree == 0).then_some(index))
        .collect::<BTreeSet<_>>();
    let mut waves = Vec::new();
    let mut depth = vec![1usize; graph.nodes.len()];
    let mut predecessor = vec![None; graph.nodes.len()];
    let mut processed = 0usize;

    while !ready.is_empty() {
        let selected = ready
            .iter()
            .copied()
            .take(graph.max_concurrency)
            .collect::<Vec<_>>();
        for index in &selected {
            ready.remove(index);
        }
        waves.push(
            selected
                .iter()
                .map(|index| graph.nodes[*index].id.clone())
                .collect(),
        );
        processed += selected.len();
        for parent in selected {
            for &child in &outgoing[parent] {
                let candidate_depth = depth[parent] + 1;
                if candidate_depth > depth[child] {
                    depth[child] = candidate_depth;
                    predecessor[child] = Some(parent);
                }
                indegree[child] -= 1;
                if indegree[child] == 0 {
                    ready.insert(child);
                }
            }
        }
    }

    if processed != graph.nodes.len() {
        let blocked = graph
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(index, node)| (indegree[index] > 0).then_some(node.id.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "graph contains a dependency cycle involving: {blocked}"
        ));
    }

    let mut cursor = depth
        .iter()
        .enumerate()
        .max_by_key(|(index, value)| (**value, std::cmp::Reverse(*index)))
        .map(|(index, _)| index)
        .unwrap_or_default();
    let mut critical_path = vec![graph.nodes[cursor].id.clone()];
    while let Some(parent) = predecessor[cursor] {
        cursor = parent;
        critical_path.push(graph.nodes[cursor].id.clone());
    }
    critical_path.reverse();

    let mut warnings = Vec::new();
    if !graph
        .nodes
        .iter()
        .any(|node| node.kind == OrchestrationNodeKind::Human)
    {
        warnings.push("graph has no human approval gate".into());
    }
    let root_count = graph
        .nodes
        .iter()
        .filter(|node| node.depends_on.is_empty())
        .count();
    if root_count > graph.max_concurrency {
        warnings.push(format!(
            "{root_count} root nodes will be throttled by maxConcurrency {}",
            graph.max_concurrency
        ));
    }
    let max_parallelism = waves.iter().map(Vec::len).max().unwrap_or_default();
    Ok(OrchestrationPlan {
        valid: true,
        graph_name: graph.name.clone(),
        waves,
        critical_path,
        max_parallelism,
        warnings,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    name: String,
    kind: String,
    base_url: Option<String>,
    api_key: Option<String>,
    enabled: Option<bool>,
    settings: Option<Value>,
}

fn validate_provider(input: &ProviderInput) -> Result<(), ApiError> {
    const KINDS: &[&str] = &[
        "openai",
        "anthropic",
        "gemini",
        "moonshot",
        "deepseek",
        "mistral",
        "openai-compatible",
        "openai-images",
        "imagen",
        "black-forest-labs",
    ];
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(ApiError::BadRequest("unsupported provider kind".into()));
    }
    if input.kind == "openai-compatible" && input.base_url.is_none() {
        return Err(ApiError::BadRequest(
            "custom provider requires baseUrl".into(),
        ));
    }
    if let Some(base_url) = &input.base_url {
        let parsed = reqwest::Url::parse(base_url)
            .map_err(|_| ApiError::BadRequest("provider baseUrl is invalid".into()))?;
        if parsed.scheme() != "https" {
            return Err(ApiError::BadRequest(
                "provider baseUrl must use HTTPS".into(),
            ));
        }
    }
    Ok(())
}

pub async fn providers_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 2).await?;
    let rows = sqlx::query("SELECT id,name,kind,base_url,enabled,settings,created_at,updated_at FROM providers WHERE workspace_id=$1 ORDER BY name").bind(workspace).fetch_all(&state.pool).await?;
    Ok(Json(Value::Array(rows.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"baseUrl":r.get::<Option<String>,_>("base_url"),"enabled":r.get::<bool,_>("enabled"),"settings":r.get::<Value,_>("settings"),"hasApiKey":true})).collect())))
}

pub async fn providers_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(input): Json<ProviderInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_provider(&input)?;
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 2).await?;
    let key = input
        .api_key
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("apiKey is required".into()))?;
    let encrypted = state
        .providers
        .secrets
        .seal(&key)
        .map_err(ApiError::Internal)?;
    let row = sqlx::query("INSERT INTO providers(workspace_id,name,kind,base_url,encrypted_api_key,enabled,settings) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id")
        .bind(workspace).bind(input.name).bind(input.kind).bind(input.base_url).bind(encrypted).bind(input.enabled.unwrap_or(true)).bind(input.settings.unwrap_or_else(|| json!({}))).fetch_one(&state.pool).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":row.get::<Uuid,_>("id")})),
    ))
}

pub async fn providers_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, provider)): Path<(Uuid, Uuid)>,
    Json(input): Json<ProviderInput>,
) -> Result<Json<Value>, ApiError> {
    validate_provider(&input)?;
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 2).await?;
    let encrypted = match input.api_key {
        Some(value) if !value.is_empty() => Some(
            state
                .providers
                .secrets
                .seal(&value)
                .map_err(ApiError::Internal)?,
        ),
        _ => None,
    };
    let result = sqlx::query("UPDATE providers SET name=$3,kind=$4,base_url=$5,encrypted_api_key=COALESCE($6,encrypted_api_key),enabled=$7,settings=$8,updated_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(workspace).bind(provider).bind(input.name).bind(input.kind).bind(input.base_url).bind(encrypted).bind(input.enabled.unwrap_or(true)).bind(input.settings.unwrap_or_else(||json!({}))).execute(&state.pool).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({"updated":true})))
}

pub async fn providers_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, provider)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let id = user_id(&state, &identity(&state, &headers).await?).await?;
    require_role(&state, id, workspace, 2).await?;
    let result = sqlx::query("DELETE FROM providers WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(provider)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Rota efetiva: a do GRUPO sobrepõe a do workspace.
///
/// O admin escolhe o modelo por área — código com um modelo forte, atendimento
/// com um barato — e a diferença aparece direto na relatoria de custo.
///
/// A decisão é feita AQUI, no servidor, e não no cliente. O cliente pede
/// `{kind: "workspace"}` e recebe o que a política mandar: se a escolha
/// estivesse do outro lado, bastaria editar o pedido para usar outro modelo.
///
/// Desempate entre dois grupos que definem o mesmo modo: maior `priority`
/// vence, empate pelo nome. Sem ordem explícita, a rota dependeria da ordem
/// de retorno do banco e mudaria sozinha entre consultas.
async fn route(
    state: &AppState,
    workspace: Uuid,
    user_groups: &[Uuid],
    mode: &Mode,
    capability: Capability,
) -> Result<RouteConfig, ApiError> {
    if !user_groups.is_empty() {
        let group_value: Option<Value> = sqlx::query_scalar(
            "SELECT r.config FROM group_route_configs r \
             JOIN ad_groups g ON g.id = r.group_id \
             WHERE r.group_id = ANY($1) AND r.mode = $2 AND r.capability = $3 \
             ORDER BY g.priority DESC, g.name ASC LIMIT 1",
        )
        .bind(user_groups)
        .bind(mode.as_str())
        .bind(capability.as_str())
        .fetch_optional(&state.pool)
        .await?;
        if let Some(value) = group_value {
            return serde_json::from_value(value).map_err(|e| ApiError::Internal(e.into()));
        }
    }
    let value: Option<Value> = sqlx::query_scalar(
        "SELECT config FROM route_configs WHERE workspace_id=$1 AND mode=$2 AND capability=$3",
    )
    .bind(workspace)
    .bind(mode.as_str())
    .bind(capability.as_str())
    .fetch_optional(&state.pool)
    .await?;
    serde_json::from_value(value.ok_or(ApiError::NotFound)?)
        .map_err(|e| ApiError::Internal(e.into()))
}

/// Ids internos dos grupos do usuário, para congelar no evento.
/// Falha de consulta não pode derrubar a chamada: sem grupo, o evento ainda
/// vale por usuário e por modelo.
async fn group_uuids(state: &AppState, workspace: Uuid, token_groups: &[String]) -> Vec<Uuid> {
    crate::policy::match_groups(state, workspace, token_groups)
        .await
        .unwrap_or_default()
}

#[derive(Clone)]
struct UsageRecord {
    workspace: Uuid,
    user: Uuid,
    provider: Uuid,
    mode: Mode,
    capability: String,
    model: String,
    latency_ms: i32,
    /// Grupos do usuário NO MOMENTO da chamada — congelados de propósito para
    /// o relatório de um mês fechado não mudar quando alguém troca de área.
    group_ids: Vec<Uuid>,
}

async fn log_usage(state: AppState, usage: UsageRecord, tokens: TokenUsage) {
    let _ = sqlx::query(
        "INSERT INTO usage_events(workspace_id,user_id,provider_id,mode,capability,model,\
         status_code,latency_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,group_ids) \
         VALUES($1,$2,$3,$4,$5,$6,200,$7,$8,$9,$10,$11,$12)",
    )
    .bind(usage.workspace)
    .bind(usage.user)
    .bind(usage.provider)
    .bind(usage.mode.as_str())
    .bind(usage.capability)
    .bind(usage.model)
    .bind(usage.latency_ms)
    // NULL quando o provedor não informou: 0 seria lido como "não consumiu".
    .bind((!tokens.is_empty()).then_some(tokens.input))
    .bind((!tokens.is_empty()).then_some(tokens.output))
    .bind((!tokens.is_empty()).then_some(tokens.cache_read))
    .bind((!tokens.is_empty()).then_some(tokens.cache_write))
    .bind(&usage.group_ids[..])
    .execute(&state.pool)
    .await;
}

/// Envolve a resposta para CONTAR os tokens sem atrapalhar o repasse.
///
/// O caminho OpenAI faz passthrough do corpo — o gateway nunca desserializa a
/// resposta. Em vez de bufferizar tudo (que quebraria o streaming e a
/// percepção de velocidade), os pedaços são inspecionados de passagem e a
/// gravação acontece quando o corpo termina, no `Drop` do tap.
fn tap_usage(response: Response, state: AppState, record: UsageRecord, kind: String) -> Response {
    struct Tap {
        state: AppState,
        record: UsageRecord,
        kind: String,
        scanner: SseUsageScanner,
    }
    impl Drop for Tap {
        fn drop(&mut self) {
            let tokens = self.scanner.finish(&self.kind);
            // O evento é gravado mesmo sem contagem: modo, modelo e latência
            // continuam valendo, e a ausência de token fica visível como NULL.
            tokio::spawn(log_usage(self.state.clone(), self.record.clone(), tokens));
        }
    }

    let (parts, body) = response.into_parts();
    let tap = Arc::new(Mutex::new(Tap {
        state,
        record,
        kind: kind.clone(),
        scanner: SseUsageScanner::new(),
    }));
    let stream = body.into_data_stream().map(move |chunk| {
        if let Ok(bytes) = &chunk {
            if let Ok(mut guard) = tap.lock() {
                let kind = guard.kind.clone();
                guard.scanner.push(bytes, &kind);
            }
        }
        chunk
    });
    Response::from_parts(parts, Body::from_stream(stream))
}

pub async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(request): Json<ChatRequest>,
) -> Result<Response, ApiError> {
    state.metrics.request();
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, 1).await?;
    // Módulo fora da política do grupo: 404 — para o usuário ele não existe.
    crate::policy::ensure_mode_allowed(&state, workspace, user, &caller.groups, &request.mode)
        .await?;
    rate_limit(&state, workspace).await?;
    // Grupos resolvidos uma vez: servem para escolher a rota E para congelar
    // no evento de uso.
    let groups = group_uuids(&state, workspace, &caller.groups).await;
    let route = route(&state, workspace, &groups, &request.mode, Capability::Chat).await?;
    let timeout = route.timeout_ms.unwrap_or(90_000).clamp(1_000, 180_000);
    let targets = std::iter::once(&route.primary).chain(route.fallbacks.iter());
    let started = Instant::now();
    for (index, target) in targets.enumerate() {
        match state
            .providers
            .chat(
                workspace,
                target,
                &request,
                timeout,
                route.temperature,
                route.max_tokens,
            )
            .await
        {
            Ok((provider, kind, response)) => {
                if index > 0 {
                    state.metrics.fallback();
                }
                let record = UsageRecord {
                    workspace,
                    user,
                    provider,
                    mode: request.mode.clone(),
                    capability: "chat".into(),
                    model: target.model.clone(),
                    latency_ms: started.elapsed().as_millis() as i32,
                    group_ids: groups.clone(),
                };
                // A gravação sai no fim do corpo, com os tokens em mãos.
                return Ok(tap_usage(response, state.clone(), record, kind));
            }
            Err(error) => {
                state.metrics.provider_failure();
                tracing::warn!(provider=%target.provider_id,model=%target.model,error=%error,"provider attempt failed");
            }
        }
    }
    Err(ApiError::ProvidersUnavailable)
}

#[derive(Deserialize)]
pub struct CapabilityRequest {
    mode: Mode,
    #[serde(flatten)]
    payload: serde_json::Map<String, Value>,
}

async fn generic(
    state: AppState,
    headers: HeaderMap,
    workspace: Uuid,
    request: CapabilityRequest,
    capability: Capability,
) -> Result<Response, ApiError> {
    state.metrics.request();
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, 1).await?;
    crate::policy::ensure_mode_allowed(&state, workspace, user, &caller.groups, &request.mode)
        .await?;
    rate_limit(&state, workspace).await?;
    let groups = group_uuids(&state, workspace, &caller.groups).await;
    let route = route(&state, workspace, &groups, &request.mode, capability.clone()).await?;
    let timeout = route.timeout_ms.unwrap_or(90_000).clamp(1_000, 180_000);
    for (index, target) in std::iter::once(&route.primary)
        .chain(route.fallbacks.iter())
        .enumerate()
    {
        match state
            .providers
            .generic(
                workspace,
                target,
                capability.as_str(),
                Value::Object(request.payload.clone()),
                timeout,
            )
            .await
        {
            Ok((provider, kind, response)) => {
                if index > 0 {
                    state.metrics.fallback();
                }
                let record = UsageRecord {
                    workspace,
                    user,
                    provider,
                    mode: request.mode.clone(),
                    capability: capability.as_str().into(),
                    model: target.model.clone(),
                    latency_ms: 0,
                    group_ids: groups.clone(),
                };
                return Ok(tap_usage(response, state.clone(), record, kind));
            }
            Err(_) => state.metrics.provider_failure(),
        }
    }
    Err(ApiError::ProvidersUnavailable)
}

pub async fn images(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(request): Json<CapabilityRequest>,
) -> Result<Response, ApiError> {
    generic(state, headers, workspace, request, Capability::Image).await
}
pub async fn embeddings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(request): Json<CapabilityRequest>,
) -> Result<Response, ApiError> {
    generic(state, headers, workspace, request, Capability::Embedding).await
}

const MAX_DESIGN_SOURCE_BYTES: usize = 2 * 1024 * 1024;

pub async fn design_replication(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(request): Json<DesignReplicationRequest>,
) -> Result<Json<Value>, ApiError> {
    state.metrics.request();
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, 1).await?;
    // Replicação de design pertence ao módulo Design.
    crate::policy::ensure_mode_allowed(&state, workspace, user, &caller.groups, &Mode::Design)
        .await?;
    rate_limit(&state, workspace).await?;

    if request.mode != "static" && request.mode != "ultra" {
        return Err(ApiError::BadRequest("mode must be static or ultra".into()));
    }
    if request.mode == "ultra" {
        return Err(ApiError::BadRequest(
            "ultra capture requires the isolated browser worker; use static until it is enabled"
                .into(),
        ));
    }

    let (resolved_url, html) = fetch_public_text(&request.source_url).await?;
    let title = extract_tag_text(&html, "title").unwrap_or_else(|| {
        resolved_url
            .host_str()
            .unwrap_or("Untitled site")
            .to_string()
    });
    let colors = extract_colors(&html);
    let css_variables = extract_css_variables(&html);
    let fonts = extract_css_values(&html, "font-family:", 12);
    let animations = extract_identifiers(&html, "@keyframes", 20);
    let layout_signals = [
        ("flex", "display:flex"),
        ("grid", "display:grid"),
        ("fixed", "position:fixed"),
        ("sticky", "position:sticky"),
        ("glass", "backdrop-filter"),
        ("container", "container-type"),
    ]
    .into_iter()
    .filter(|(_, marker)| normalized_contains(&html, marker))
    .map(|(name, _)| name.to_string())
    .collect::<Vec<_>>();
    let pages = discover_pages(&resolved_url, &html, request.max_pages.clamp(1, 20));
    let normalized = html.to_ascii_lowercase();
    let component_fingerprints = [
        "header", "nav", "main", "section", "article", "button", "form",
    ]
    .into_iter()
    .filter(|tag| normalized.contains(&format!("<{tag}")))
    .count();

    Ok(Json(json!({
        "id": Uuid::new_v4(),
        "status": "ready",
        "sourceUrl": resolved_url.as_str(),
        "title": title,
        "mode": request.mode,
        "pages": pages,
        "tokens": {
            "colors": colors,
            "cssVariables": css_variables,
            "fonts": fonts
        },
        "analysis": {
            "stylesheets": normalized.matches("stylesheet").count(),
            "inlineStyleBlocks": normalized.matches("<style").count(),
            "componentFingerprints": component_fingerprints,
            "layoutSignals": layout_signals,
            "animations": animations
        },
        "artifacts": [
            "DESIGN.md",
            "references/LAYOUT.md",
            "references/COMPONENTS.md",
            "references/ANIMATIONS.md",
            "tokens/colors.json",
            "tokens/typography.json"
        ]
    })))
}

async fn fetch_public_text(source: &str) -> Result<(reqwest::Url, String), ApiError> {
    let mut current = reqwest::Url::parse(source)
        .map_err(|_| ApiError::BadRequest("sourceUrl must be a valid HTTP(S) URL".into()))?;

    for _ in 0..5 {
        let aprovados = validate_public_url(&current).await?;
        // O cliente é montado a CADA salto com o IP aprovado fixado. Sem isto
        // a checagem acima não valeria para a conexão: o reqwest resolveria o
        // nome de novo e um DNS de TTL curto entregaria outro destino (o
        // clássico rebinding). O nome continua valendo para SNI e certificado.
        let host = current.host_str().unwrap_or_default().to_string();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .resolve_to_addrs(&host, &aprovados)
            .build()
            .map_err(|error| ApiError::Internal(error.into()))?;
        let response = client
            .get(current.clone())
            .header(
                reqwest::header::USER_AGENT,
                "Multiplike-AI-Design-Capture/0.1",
            )
            .send()
            .await
            .map_err(|error| ApiError::BadRequest(format!("could not fetch source: {error}")))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    ApiError::BadRequest("source redirected without a Location header".into())
                })?;
            current = current
                .join(location)
                .map_err(|_| ApiError::BadRequest("source returned an invalid redirect".into()))?;
            continue;
        }
        if !response.status().is_success() {
            return Err(ApiError::BadRequest(format!(
                "source returned HTTP {}",
                response.status()
            )));
        }
        if let Some(length) = response.content_length() {
            if length as usize > MAX_DESIGN_SOURCE_BYTES {
                return Err(ApiError::BadRequest(
                    "source exceeds the 2 MiB capture limit".into(),
                ));
            }
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !content_type.is_empty() && !content_type.contains("text/html") {
            return Err(ApiError::BadRequest("source must return HTML".into()));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|error| ApiError::BadRequest(format!("source stream failed: {error}")))?;
            if body.len() + chunk.len() > MAX_DESIGN_SOURCE_BYTES {
                return Err(ApiError::BadRequest(
                    "source exceeds the 2 MiB capture limit".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((current, String::from_utf8_lossy(&body).into_owned()));
    }
    Err(ApiError::BadRequest(
        "source exceeded the redirect limit".into(),
    ))
}

/// Valida o destino e devolve os endereços APROVADOS.
///
/// Devolver a lista não é detalhe de implementação: é o que fecha o DNS
/// rebinding. Antes esta função resolvia o nome, aprovava e ia embora — o
/// `reqwest` resolvia de novo na hora de conectar, e um domínio do atacante
/// com TTL 0 podia responder um IP público na validação e `169.254.169.254`
/// na conexão. Quem chama fixa estes endereços no cliente, então a conexão
/// acontece exatamente contra o que foi aprovado.
async fn validate_public_url(url: &reqwest::Url) -> Result<Vec<SocketAddr>, ApiError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest(
            "sourceUrl must use HTTP or HTTPS".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ApiError::BadRequest("sourceUrl has no host".into()))?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(ApiError::BadRequest(
            "local and private sources are not allowed".into(),
        ));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ApiError::BadRequest("sourceUrl has no valid port".into()))?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| ApiError::BadRequest("source host could not be resolved".into()))?;
    let mut aprovados = Vec::new();
    for address in addresses {
        if !is_public_ip(address.ip()) {
            return Err(ApiError::BadRequest(
                "local and private sources are not allowed".into(),
            ));
        }
        aprovados.push(address);
    }
    if aprovados.is_empty() {
        return Err(ApiError::BadRequest(
            "source host could not be resolved".into(),
        ));
    }
    Ok(aprovados)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || octets[0] == 0
        || octets[0] >= 224
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    // Endereço IPv4 embutido volta para a regra v4 ANTES de qualquer outra
    // coisa. Sem isto, `::ffff:169.254.169.254` não casa nenhum dos padrões
    // v6 abaixo e é classificado como público — um caminho direto para o
    // endpoint de metadados da nuvem, que é justamente o que esta guarda
    // existe para fechar. Vale para o mapeado (`::ffff:a.b.c.d`) e para o
    // compatível (`::a.b.c.d`), que alguns resolvedores ainda produzem.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    if let Some(v4) = ip.to_ipv4() {
        return is_public_v4(v4);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7 — endereço local único (a rede interna da empresa).
        || (segments[0] & 0xfe00) == 0xfc00
        // fe80::/10 — link-local.
        || (segments[0] & 0xffc0) == 0xfe80)
}

fn normalized_contains(source: &str, marker: &str) -> bool {
    source
        .to_ascii_lowercase()
        .replace([' ', '\n', '\r', '\t'], "")
        .contains(marker)
}

fn extract_tag_text(source: &str, tag: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let open = lower.find(&format!("<{tag}"))?;
    let start = lower[open..].find('>')? + open + 1;
    let end = lower[start..].find(&format!("</{tag}>"))? + start;
    let value = source[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!value.is_empty()).then_some(value.chars().take(160).collect())
}

fn extract_colors(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut colors = BTreeSet::new();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'#' {
            continue;
        }
        let available = &bytes[index + 1..bytes.len().min(index + 9)];
        let count = available
            .iter()
            .take_while(|byte| byte.is_ascii_hexdigit())
            .count();
        let size = if count >= 8 {
            8
        } else if count >= 6 {
            6
        } else if count >= 3 {
            3
        } else {
            continue;
        };
        colors.insert(format!(
            "#{}",
            String::from_utf8_lossy(&available[..size]).to_ascii_uppercase()
        ));
        if colors.len() >= 32 {
            break;
        }
    }
    colors.into_iter().collect()
}

/// Fim de fatia que nunca cai no meio de um caractere.
///
/// O HTML vem de uma página que o usuário aponta e é UTF-8 válido (passou por
/// `from_utf8_lossy`), então um emoji ou um acento cruzando o índice fixo
/// fazia o `&s[..n]` entrar em PANIC — derrubando a task da requisição, sem
/// `CatchPanicLayer` no caminho. Um membro comum reproduzia isso à vontade
/// apontando a captura para um servidor dele.
fn corte_seguro(texto: &str, limite: usize) -> usize {
    if limite >= texto.len() {
        return texto.len();
    }
    let mut corte = limite;
    while corte > 0 && !texto.is_char_boundary(corte) {
        corte -= 1;
    }
    corte
}

fn extract_css_variables(source: &str) -> Vec<Value> {
    let mut values = Vec::new();
    let mut cursor = source;
    while let Some(start) = cursor.find("--") {
        cursor = &cursor[start + 2..];
        let name_len = cursor
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
            .map(char::len_utf8)
            .sum::<usize>();
        if name_len < 2 {
            continue;
        }
        let name = &cursor[..name_len];
        let rest = &cursor[name_len..];
        let Some(colon) = rest.find(':') else {
            continue;
        };
        if colon > 4 {
            continue;
        }
        let raw_value = &rest[colon + 1..corte_seguro(rest, colon + 97)];
        let end = raw_value.find([';', '}']).unwrap_or(raw_value.len());
        let value = raw_value[..end].trim();
        if !value.is_empty()
            && !values
                .iter()
                .any(|item: &Value| item.get("name") == Some(&Value::String(format!("--{name}"))))
        {
            values.push(json!({"name": format!("--{name}"), "value": value}));
        }
        if values.len() >= 48 {
            break;
        }
    }
    values
}

fn extract_css_values(source: &str, marker: &str, limit: usize) -> Vec<String> {
    let lower = source.to_ascii_lowercase();
    let mut values = BTreeSet::new();
    let mut offset = 0;
    while let Some(found) = lower[offset..].find(marker) {
        let start = offset + found + marker.len();
        // `start` vem de um índice na versão em MINÚSCULAS: `to_ascii_lowercase`
        // preserva o comprimento em bytes, então ele é válido no original —
        // mas o fim continua precisando de fronteira de caractere.
        let tail = &source[corte_seguro(source, start)..corte_seguro(source, start + 160)];
        let end = tail.find([';', '}']).unwrap_or(tail.len());
        let value = tail[..end].trim().trim_matches(['\'', '"']);
        if !value.is_empty() {
            values.insert(value.chars().take(100).collect());
        }
        if values.len() >= limit {
            break;
        }
        offset = start;
    }
    values.into_iter().collect()
}

fn extract_identifiers(source: &str, marker: &str, limit: usize) -> Vec<String> {
    let lower = source.to_ascii_lowercase();
    let mut values = BTreeSet::new();
    let mut offset = 0;
    while let Some(found) = lower[offset..].find(marker) {
        let start = offset + found + marker.len();
        let value = source[start..]
            .trim_start()
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
            .collect::<String>();
        if !value.is_empty() {
            values.insert(value);
        }
        if values.len() >= limit {
            break;
        }
        offset = start;
    }
    values.into_iter().collect()
}

fn discover_pages(base: &reqwest::Url, html: &str, max_pages: u8) -> Vec<Value> {
    let mut pages = vec![json!({"path": base.path(), "title": "Homepage"})];
    if max_pages <= 1 {
        return pages;
    }
    let mut seen = BTreeSet::from([base.path().to_string()]);
    for quote in ['"', '\''] {
        let marker = format!("href={quote}");
        let mut cursor = html;
        while let Some(start) = cursor.find(&marker) {
            cursor = &cursor[start + marker.len()..];
            let Some(end) = cursor.find(quote) else { break };
            let href = &cursor[..end];
            cursor = &cursor[end + 1..];
            let Ok(url) = base.join(href) else { continue };
            if url.host_str() != base.host_str()
                || url.path() == "/"
                || !seen.insert(url.path().into())
            {
                continue;
            }
            let title = url
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .filter(|value| !value.is_empty())
                .unwrap_or("Page")
                .replace(['-', '_'], " ");
            pages.push(json!({"path": url.path(), "title": title}));
            if pages.len() >= max_pages as usize {
                return pages;
            }
        }
    }
    pages
}

#[cfg(test)]
mod css_slice_tests {
    use super::{extract_css_values, extract_css_variables};

    #[test]
    fn variavel_com_caractere_multibyte_no_corte_nao_estoura() {
        // O HTML vem de uma página que o membro aponta: bastava um emoji
        // cruzando o byte 97 para o handler entrar em panic (sem
        // CatchPanicLayer no caminho) e derrubar a requisição.
        let fonte = format!(":root {{ --marca: {}🙂; }}", "a".repeat(95));
        let valores = extract_css_variables(&fonte);
        assert_eq!(valores.len(), 1);
    }

    #[test]
    fn valor_com_caractere_multibyte_no_corte_nao_estoura() {
        let fonte = format!("body {{ font-family: {}é; }}", "b".repeat(159));
        let valores = extract_css_values(&fonte, "font-family:", 4);
        assert_eq!(valores.len(), 1);
    }

    #[test]
    fn continua_extraindo_o_caso_comum() {
        let valores = extract_css_variables(":root { --cor-primaria: #112233; }");
        assert_eq!(valores[0]["name"], "--cor-primaria");
        assert_eq!(valores[0]["value"], "#112233");
    }
}

#[cfg(test)]
mod ssrf_tests {
    use super::is_public_ip;
    use std::net::IpAddr;

    #[test]
    fn ipv4_embutido_em_ipv6_volta_para_a_regra_v4() {
        for hostil in [
            "::ffff:169.254.169.254",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "::ffff:192.168.0.7",
            "::169.254.169.254",
        ] {
            let ip: IpAddr = hostil.parse().unwrap();
            assert!(!is_public_ip(ip), "classificou {hostil} como público");
        }
    }

    #[test]
    fn interno_v6_continua_bloqueado() {
        for hostil in ["::1", "fc00::1", "fd12::9", "fe80::1"] {
            assert!(!is_public_ip(hostil.parse::<IpAddr>().unwrap()), "{hostil}");
        }
    }

    #[test]
    fn publico_continua_passando() {
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2001:4860:4860::8888".parse().unwrap()));
        assert!(is_public_ip("::ffff:8.8.8.8".parse().unwrap()));
    }
}

#[cfg(test)]
mod design_capture_tests {
    use super::*;

    fn node(
        id: &str,
        kind: OrchestrationNodeKind,
        dependencies: &[&str],
    ) -> crate::models::OrchestrationNode {
        crate::models::OrchestrationNode {
            id: id.into(),
            name: id.into(),
            kind,
            mode: None,
            depends_on: dependencies.iter().map(|value| (*value).into()).collect(),
            config: json!({}),
        }
    }

    #[test]
    fn plans_parallel_orchestration_waves_and_critical_path() {
        let graph = OrchestrationGraph {
            schema_version: 1,
            name: "release".into(),
            max_concurrency: 4,
            nodes: vec![
                node("idea", OrchestrationNodeKind::Input, &[]),
                node("agent-a", OrchestrationNodeKind::Agent, &["idea"]),
                node("agent-b", OrchestrationNodeKind::Agent, &["idea"]),
                node("ci", OrchestrationNodeKind::Gate, &["agent-a", "agent-b"]),
                node("merge", OrchestrationNodeKind::Human, &["ci"]),
            ],
        };
        let plan = plan_orchestration(&graph).unwrap();
        assert_eq!(
            plan.waves,
            vec![
                vec!["idea"],
                vec!["agent-a", "agent-b"],
                vec!["ci"],
                vec!["merge"]
            ]
        );
        assert_eq!(plan.max_parallelism, 2);
        assert_eq!(plan.critical_path.first().unwrap(), "idea");
        assert_eq!(plan.critical_path.last().unwrap(), "merge");
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn rejects_cycles_and_missing_dependencies() {
        let cyclic = OrchestrationGraph {
            schema_version: 1,
            name: "cycle".into(),
            max_concurrency: 2,
            nodes: vec![
                node("a", OrchestrationNodeKind::Agent, &["b"]),
                node("b", OrchestrationNodeKind::Agent, &["a"]),
            ],
        };
        assert!(plan_orchestration(&cyclic).unwrap_err().contains("cycle"));

        let missing = OrchestrationGraph {
            schema_version: 1,
            name: "missing".into(),
            max_concurrency: 2,
            nodes: vec![node("a", OrchestrationNodeKind::Agent, &["unknown"])],
        };
        assert!(plan_orchestration(&missing)
            .unwrap_err()
            .contains("missing node"));
    }

    #[test]
    fn blocks_private_and_special_networks() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("10.20.30.40".parse().unwrap()));
        assert!(!is_public_ip("169.254.10.2".parse().unwrap()));
        assert!(!is_public_ip("100.64.0.1".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(!is_public_ip("fd00::1".parse().unwrap()));
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn extracts_static_design_language() {
        let source = r#"
          <title>Glass Studio</title>
          <style>
            :root { --brand: #68d7e7; --surface: #ffffffcc; }
            main { display: grid; font-family: Inter, sans-serif; }
            @keyframes flow { to { transform: translateX(2px); } }
          </style>
        "#;
        assert_eq!(extract_tag_text(source, "title").unwrap(), "Glass Studio");
        assert!(extract_colors(source).contains(&"#68D7E7".to_string()));
        assert_eq!(extract_css_variables(source).len(), 2);
        assert!(extract_css_values(source, "font-family:", 10)[0].contains("Inter"));
        assert_eq!(extract_identifiers(source, "@keyframes", 10), vec!["flow"]);
        assert!(normalized_contains(source, "display:grid"));
    }

    #[test]
    fn discovers_only_same_origin_pages_within_limit() {
        let base = reqwest::Url::parse("https://example.com/").unwrap();
        let html = r#"<a href="/pricing">Pricing</a><a href="https://other.test/x">Other</a><a href="/docs">Docs</a>"#;
        let pages = discover_pages(&base, html, 2);
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[1]["path"], "/pricing");
    }
}
