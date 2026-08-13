//! Trilha de auditoria das execuções do agente na estação (`computer_exec`).
//!
//! Tabela própria, não `usage_events` — ver o comentário da migration 0007.
//!
//! Duas assimetrias de autorização, propositais:
//!
//! - **Gravar** é do próprio usuário (membro do workspace). Quem executa é
//!   quem registra; exigir admin significaria não ter trilha nenhuma.
//! - **Ler** é só do admin. A trilha responde "o que a IA rodou na máquina de
//!   quem", e isso não é informação para colega ver.
//!
//! O comando chega **já redigido** pelo cliente (`lib/agentAudit.ts`): os
//! padrões de segredo conhecidos saem antes de trafegar. O servidor não
//! desfaz nem confia — só guarda e limita o tamanho.

use crate::{
    error::ApiError,
    routes::{identity, require_role, user_id},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

const ADMIN: i16 = 2;
const MEMBER: i16 = 1;
/// Teto do comando persistido. O cliente já trunca; aqui é a rede de proteção
/// contra um chamador que não seja o nosso.
const MAX_COMMAND: usize = 4_000;
const MAX_ROWS: i64 = 200;
const DEFAULT_DAYS: i64 = 30;
const MAX_DAYS: i64 = 365;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRecord {
    agent: String,
    #[serde(default)]
    goal: String,
    command: String,
    approved: bool,
    exit_code: Option<i32>,
    #[serde(default)]
    duration_ms: i32,
    #[serde(default = "yes")]
    jailed: bool,
}

fn yes() -> bool {
    true
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}

/// Registra uma execução. Autorização de MEMBRO: quem executa é quem registra.
pub async fn record_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(body): Json<ActionRecord>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;

    let command = clip(&body.command, MAX_COMMAND);
    if command.is_empty() {
        return Err(ApiError::BadRequest("comando vazio não é auditável".into()));
    }
    let groups = crate::policy::match_groups(&state, workspace, &caller.groups)
        .await
        .unwrap_or_default();

    sqlx::query(
        "INSERT INTO agent_actions(workspace_id,user_id,group_ids,agent,goal,command,\
         approved,exit_code,duration_ms,jailed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(workspace)
    .bind(user)
    .bind(&groups[..])
    .bind(clip(&body.agent, 120))
    .bind(clip(&body.goal, 500))
    .bind(&command)
    .bind(body.approved)
    .bind(body.exit_code)
    .bind(body.duration_ms.max(0))
    .bind(body.jailed)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
pub struct Window {
    days: Option<i64>,
    /// Só as recusadas ou as que rodaram fora do job — o filtro que interessa
    /// numa revisão de segurança.
    #[serde(default)]
    flagged: bool,
}

/// Lista a trilha. Autorização de ADMIN: não é informação para colega ver.
pub async fn list_actions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(window): Query<Window>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, ADMIN).await?;

    let days = window.days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS);
    let filtro = if window.flagged {
        " AND (a.approved = false OR a.jailed = false OR a.exit_code <> 0)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT a.created_at, a.agent, a.goal, a.command, a.approved, a.exit_code, \
         a.duration_ms, a.jailed, u.email, u.display_name \
         FROM agent_actions a JOIN users u ON u.id = a.user_id \
         WHERE a.workspace_id = $1 AND a.created_at >= now() - make_interval(days => $2::int){filtro} \
         ORDER BY a.created_at DESC LIMIT {MAX_ROWS}"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace)
        .bind(days as i32)
        .fetch_all(&state.pool)
        .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "at": row.try_get::<chrono::DateTime<chrono::Utc>,_>("created_at").map(|v| v.to_rfc3339()).unwrap_or_default(),
                "agent": row.try_get::<String,_>("agent").unwrap_or_default(),
                "goal": row.try_get::<String,_>("goal").unwrap_or_default(),
                "command": row.try_get::<String,_>("command").unwrap_or_default(),
                "approved": row.try_get::<bool,_>("approved").unwrap_or(false),
                "exitCode": row.try_get::<Option<i32>,_>("exit_code").ok().flatten(),
                "durationMs": row.try_get::<i32,_>("duration_ms").unwrap_or(0),
                "jailed": row.try_get::<bool,_>("jailed").unwrap_or(true),
                "email": row.try_get::<Option<String>,_>("email").ok().flatten(),
                "name": row.try_get::<Option<String>,_>("display_name").ok().flatten(),
            })
        })
        .collect();

    Ok(Json(json!({ "days": days, "items": items })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_corta_por_caractere_e_nao_por_byte() {
        // Cortar por byte partiria um caractere acentuado no meio.
        let texto = "áéíóú".repeat(10);
        let cortado = clip(&texto, 5);
        assert_eq!(cortado, "áéíóú");
        assert_eq!(cortado.chars().count(), 5);
    }

    #[test]
    fn clip_preserva_texto_curto_e_tira_espaco_das_bordas() {
        assert_eq!(clip("  python x.py  ", 100), "python x.py");
    }

    /// `jailed` ausente vira `true` — um cliente antigo não deve marcar toda a
    /// trilha como "rodou fora do job" e disparar alarme falso.
    #[test]
    fn jailed_ausente_assume_verdadeiro() {
        let record: ActionRecord = serde_json::from_value(json!({
            "agent": "A", "command": "dir", "approved": true
        }))
        .expect("desserializa");
        assert!(record.jailed);
        assert_eq!(record.duration_ms, 0);
        assert_eq!(record.exit_code, None);
    }

    #[test]
    fn recusa_tambem_e_desserializada() {
        let record: ActionRecord = serde_json::from_value(json!({
            "agent": "A", "command": "rm -rf /", "approved": false, "exitCode": null
        }))
        .expect("desserializa");
        assert!(!record.approved);
    }
}
