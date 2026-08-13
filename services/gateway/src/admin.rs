//! Console de administração — grupos, módulos, política e prompt master.
//!
//! A autorização é DESTES endpoints (role >= admin no workspace), nunca da
//! UI: a seção "Administração" do desktop é só um cliente disto. Módulo
//! separado de routes.rs para a superfície de admin ficar auditável num
//! lugar só.

use crate::{
    error::ApiError,
    models::Mode,
    policy::GroupPolicyDoc,
    routes::{identity, require_role, user_id},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

/// Papel mínimo para administrar: admin (2). Owner (3) também passa.
const ADMIN: i16 = 2;

async fn authorize_admin(
    state: &AppState,
    headers: &HeaderMap,
    workspace: Uuid,
) -> Result<Uuid, ApiError> {
    let caller = identity(state, headers).await?;
    let user = user_id(state, &caller).await?;
    require_role(state, user, workspace, ADMIN).await?;
    Ok(user)
}

fn validate_modes(modes: &[String]) -> Result<(), ApiError> {
    for mode in modes {
        if Mode::parse(mode).is_none() {
            return Err(ApiError::BadRequest(format!("módulo desconhecido: {mode}")));
        }
    }
    Ok(())
}

/* -------------------------------- grupos -------------------------------- */

pub async fn groups_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let rows = sqlx::query(
        "SELECT g.id, g.ad_object_id, g.name, g.created_at, g.priority, \
                COALESCE(array_agg(m.mode) FILTER (WHERE m.mode IS NOT NULL), '{}') AS modes, \
                p.document AS policy, \
                COALESCE((SELECT jsonb_object_agg(r.mode, r.config) FROM group_route_configs r \
                          WHERE r.group_id = g.id AND r.capability = 'chat'), '{}'::jsonb) AS routes, \
                (SELECT count(*) FROM user_group_memberships u WHERE u.group_id = g.id) AS members \
         FROM ad_groups g \
         LEFT JOIN group_modules m ON m.group_id = g.id \
         LEFT JOIN group_policies p ON p.group_id = g.id \
         WHERE g.workspace_id = $1 \
         GROUP BY g.id, p.document ORDER BY g.priority DESC, g.name",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.into_iter()
            .map(|row| {
                json!({
                    "id": row.get::<Uuid, _>("id"),
                    "adObjectId": row.get::<String, _>("ad_object_id"),
                    "name": row.get::<String, _>("name"),
                    "modes": row.get::<Vec<String>, _>("modes"),
                    "policy": row.get::<Option<Value>, _>("policy").unwrap_or(json!({})),
                    "priority": row.get::<i32, _>("priority"),
                    // Rota por modo (capacidade chat): o modelo que este grupo usa.
                    "routes": row.get::<Value, _>("routes"),
                    "members": row.get::<i64, _>("members"),
                })
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUpsert {
    /// ObjectId do grupo no AD/Entra OU o nome da app role.
    pub ad_object_id: String,
    pub name: String,
    #[serde(default)]
    pub modes: Vec<String>,
    #[serde(default)]
    pub policy: Option<GroupPolicyDoc>,
}

pub async fn groups_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(request): Json<GroupUpsert>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    if request.ad_object_id.trim().is_empty() || request.name.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "adObjectId e name são obrigatórios".into(),
        ));
    }
    validate_modes(&request.modes)?;
    let group: Uuid = sqlx::query_scalar(
        "INSERT INTO ad_groups(workspace_id, ad_object_id, name) VALUES ($1,$2,$3) \
         ON CONFLICT (workspace_id, ad_object_id) DO UPDATE SET name = EXCLUDED.name \
         RETURNING id",
    )
    .bind(workspace)
    .bind(request.ad_object_id.trim())
    .bind(request.name.trim())
    .fetch_one(&state.pool)
    .await?;
    replace_modules(&state, group, &request.modes).await?;
    if let Some(policy) = &request.policy {
        upsert_policy(&state, group, policy).await?;
    }
    Ok(Json(json!({"id": group})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPatch {
    pub name: Option<String>,
    pub modes: Option<Vec<String>>,
    pub policy: Option<GroupPolicyDoc>,
    /// Desempate quando dois grupos definem rota para o mesmo modo.
    /// Maior vence; empate resolve por nome.
    pub priority: Option<i32>,
    /// Rota por modo: `{"code": {...RouteConfig}}`. Modo com valor `null`
    /// REMOVE o override e faz o grupo voltar ao padrão do workspace.
    pub routes: Option<serde_json::Map<String, Value>>,
}

pub async fn groups_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, group)): Path<(Uuid, Uuid)>,
    Json(request): Json<GroupPatch>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let owned: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM ad_groups WHERE id=$1 AND workspace_id=$2")
            .bind(group)
            .bind(workspace)
            .fetch_optional(&state.pool)
            .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound);
    }
    if let Some(name) = &request.name {
        sqlx::query("UPDATE ad_groups SET name=$1 WHERE id=$2")
            .bind(name.trim())
            .bind(group)
            .execute(&state.pool)
            .await?;
    }
    if let Some(modes) = &request.modes {
        validate_modes(modes)?;
        replace_modules(&state, group, modes).await?;
    }
    if let Some(priority) = request.priority {
        sqlx::query("UPDATE ad_groups SET priority=$1 WHERE id=$2")
            .bind(priority)
            .bind(group)
            .execute(&state.pool)
            .await?;
    }
    if let Some(routes) = &request.routes {
        upsert_group_routes(&state, group, routes).await?;
    }
    if let Some(policy) = &request.policy {
        upsert_policy(&state, group, policy).await?;
    }
    Ok(Json(json!({"ok": true})))
}

pub async fn groups_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, group)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let removed = sqlx::query("DELETE FROM ad_groups WHERE id=$1 AND workspace_id=$2")
        .bind(group)
        .bind(workspace)
        .execute(&state.pool)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({"ok": true})))
}

async fn replace_modules(state: &AppState, group: Uuid, modes: &[String]) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM group_modules WHERE group_id=$1")
        .bind(group)
        .execute(&state.pool)
        .await?;
    for mode in modes {
        sqlx::query(
            "INSERT INTO group_modules(group_id, mode) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(group)
        .bind(mode)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/// Grava as rotas do grupo (capacidade `chat`).
///
/// `null` no modo REMOVE o override — é como o admin devolve o grupo ao
/// padrão do workspace. Sem esse caminho, tirar uma escolha exigiria mexer no
/// banco à mão.
///
/// A configuração é validada como `RouteConfig` antes de entrar: um JSON
/// solto viraria erro só na hora da chamada do usuário, longe de quem errou.
async fn upsert_group_routes(
    state: &AppState,
    group: Uuid,
    routes: &serde_json::Map<String, Value>,
) -> Result<(), ApiError> {
    for (mode, config) in routes {
        if crate::models::Mode::parse(mode).is_none() {
            return Err(ApiError::BadRequest(format!("módulo desconhecido: {mode}")));
        }
        if config.is_null() {
            sqlx::query(
                "DELETE FROM group_route_configs WHERE group_id=$1 AND mode=$2 AND capability='chat'",
            )
            .bind(group)
            .bind(mode)
            .execute(&state.pool)
            .await?;
            continue;
        }
        serde_json::from_value::<crate::models::RouteConfig>(config.clone())
            .map_err(|error| ApiError::BadRequest(format!("rota inválida para {mode}: {error}")))?;
        sqlx::query(
            "INSERT INTO group_route_configs(group_id, mode, capability, config) \
             VALUES ($1,$2,'chat',$3) \
             ON CONFLICT (group_id, mode, capability) DO UPDATE SET \
             config = EXCLUDED.config, updated_at = now()",
        )
        .bind(group)
        .bind(mode)
        .bind(config)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

async fn upsert_policy(
    state: &AppState,
    group: Uuid,
    policy: &GroupPolicyDoc,
) -> Result<(), ApiError> {
    let document =
        serde_json::to_value(policy).map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query(
        "INSERT INTO group_policies(group_id, document) VALUES ($1,$2) \
         ON CONFLICT (group_id) DO UPDATE SET document = EXCLUDED.document, \
         version = group_policies.version + 1, updated_at = now()",
    )
    .bind(group)
    .bind(document)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/* ----------------------------- prompt master ----------------------------- */

pub async fn prompt_master_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let row = sqlx::query(
        "SELECT content, allow_local_append, local_max_chars, version FROM prompt_masters \
         WHERE workspace_id=$1 AND group_id IS NULL",
    )
    .bind(workspace)
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(match row {
        Some(row) => json!({
            "content": row.get::<String, _>("content"),
            "allowLocalAppend": row.get::<bool, _>("allow_local_append"),
            "localMaxChars": row.get::<i32, _>("local_max_chars"),
            "version": row.get::<i32, _>("version"),
        }),
        None => Value::Null,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMasterUpsert {
    pub content: String,
    #[serde(default = "default_true")]
    pub allow_local_append: bool,
    #[serde(default = "default_local_max")]
    pub local_max_chars: i32,
}

fn default_true() -> bool {
    true
}
fn default_local_max() -> i32 {
    2000
}

pub async fn prompt_master_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(request): Json<PromptMasterUpsert>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    if request.local_max_chars < 0 {
        return Err(ApiError::BadRequest(
            "localMaxChars não pode ser negativo".into(),
        ));
    }
    // O índice parcial garante uma linha por workspace; o upsert manual cobre
    // o ON CONFLICT, que não funciona com índice parcial em todo Postgres.
    let updated = sqlx::query(
        "UPDATE prompt_masters SET content=$2, allow_local_append=$3, local_max_chars=$4, \
         version = version + 1, updated_at = now() WHERE workspace_id=$1 AND group_id IS NULL",
    )
    .bind(workspace)
    .bind(&request.content)
    .bind(request.allow_local_append)
    .bind(request.local_max_chars)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        sqlx::query(
            "INSERT INTO prompt_masters(workspace_id, group_id, content, allow_local_append, local_max_chars) \
             VALUES ($1, NULL, $2, $3, $4)",
        )
        .bind(workspace)
        .bind(&request.content)
        .bind(request.allow_local_append)
        .bind(request.local_max_chars)
        .execute(&state.pool)
        .await?;
    }
    Ok(Json(json!({"ok": true})))
}
