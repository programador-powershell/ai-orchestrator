//! Sessões e runs duráveis — a cópia do servidor.
//!
//! O cliente é a FONTE do run (local-first: ele gera o id, numera os eventos e
//! executa). Este módulo é a cópia durável: o que chega aqui sobrevive ao app
//! fechar, aparece em outra máquina e entra na trilha de auditoria.
//!
//! ## Idempotência é requisito, não zelo
//!
//! O cliente sincroniza reenviando de `last_seq` em diante. Sem transação
//! distribuída, a única forma de isso ser seguro é o ingest ser idempotente:
//! `(run_id, seq)` é a chave primária e o INSERT usa `ON CONFLICT DO NOTHING`.
//! Reenviar um lote inteiro custa I/O e não corrompe nada — é o que permite o
//! cliente ser burro na hora da falha (reenvia tudo) em vez de esperto (tenta
//! adivinhar o que chegou).
//!
//! ## Por que o servidor não confia no `seq` do cliente para ordenar tudo
//!
//! Confia dentro de um run — ali o produtor é único. Não confia para nada
//! global: `seq` não é relógio, é contador por run.

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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

const MEMBER: i16 = 1;
/// Teto de eventos por lote de ingest. Protege o gateway de um cliente que
/// tente enviar um run inteiro de uma vez.
pub const MAX_EVENT_BATCH: usize = 500;
/// Teto do payload de um evento. Saída de ferramenta grande deve ir truncada
/// pelo cliente — o log é trilha, não armazenamento de artefato.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_ROWS: i64 = 1_000;

/* ------------------------------- Tipos -------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreate {
    /// Gerado pelo cliente — ver o cabeçalho do módulo.
    pub id: Uuid,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub parent_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCreate {
    pub id: Uuid,
    pub session_id: Uuid,
    /// `OrchestrationGraph` do contracts. Validado pelo mesmo planejador da
    /// rota `/orchestrations/validate` — um run inválido não nasce.
    pub graph: Value,
    /// `local` (padrão) ou `gateway`.
    #[serde(default)]
    pub origin: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunEventInput {
    pub seq: i64,
    pub kind: String,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBatch {
    pub events: Vec<RunEventInput>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplayQuery {
    /// Exclusivo: devolve eventos com `seq > from_seq`.
    #[serde(default)]
    pub from_seq: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAsk {
    pub id: Uuid,
    pub run_id: Uuid,
    #[serde(default)]
    pub node_id: Option<String>,
    pub tool: String,
    #[serde(default)]
    pub args: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecision {
    /// `true` aprova, `false` recusa. Recusar é informação de auditoria tanto
    /// quanto aprovar — as duas gravam.
    pub approved: bool,
}

/* ----------------------------- Utilidades ----------------------------- */

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}

/// Canal Redis de um run. O fanout do WebSocket passa por aqui para que duas
/// instâncias do gateway atendam clientes do MESMO run — sem isto, quem
/// estivesse conectado na instância B não veria o evento ingerido na A.
pub fn run_channel(run: Uuid) -> String {
    format!("run:{run}")
}

/// Publica um lote já persistido. Falha de publicação NÃO derruba o ingest: o
/// dado está no Postgres e o cliente que reconectar recupera por `from_seq`.
/// Perder o tempo real é degradação; perder o evento seria perda de dado.
pub async fn publish(state: &AppState, run: Uuid, events: &[RunEventInput]) {
    if events.is_empty() {
        return;
    }
    /*
     * O `type` PRECISA ir no payload.
     *
     * Este JSON e repassado VERBATIM ao cliente pelo hub (ws.rs, no braco do
     * fanout) — nao ha reembrulho no caminho. E o `parseFrame` do cliente
     * descarta, devolvendo `null`, todo frame sem `type`.
     *
     * Sem isto o tempo real ficava morto de um jeito que nao aparece em lugar
     * nenhum: o cliente recebia o lote de `replay` do subscribe e mais nada
     * depois, sem erro, sem log, sem socket fechado. Parecia "nao ha eventos
     * novos".
     */
    let payload = match serde_json::to_string(
        &json!({ "type": "events", "runId": run, "events": events }),
    ) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error, "falha ao serializar lote para publicação");
            return;
        }
    };
    let mut connection = match state.redis.get_multiplexed_tokio_connection().await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(error = %error, "redis indisponível para fanout do run");
            return;
        }
    };
    let result: Result<i64, _> = redis::cmd("PUBLISH")
        .arg(run_channel(run))
        .arg(payload)
        .query_async(&mut connection)
        .await;
    if let Err(error) = result {
        tracing::warn!(error = %error, "falha ao publicar eventos do run");
    }
}

/// Confere que o run existe e pertence ao workspace, devolvendo `last_seq`.
///
/// Sem o `workspace_id` na cláusula, um id de run vazado daria leitura
/// cruzada entre workspaces — o id é um uuid do cliente, não um segredo.
pub async fn run_guard(state: &AppState, workspace: Uuid, run: Uuid) -> Result<i64, ApiError> {
    let row = sqlx::query("SELECT last_seq FROM runs WHERE id=$1 AND workspace_id=$2")
        .bind(run)
        .bind(workspace)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(row.try_get("last_seq")?)
}

/// Grava um lote e devolve (aceitos, novo last_seq).
///
/// `aceitos` conta o que era NOVO: o cliente usa isso para saber que o reenvio
/// foi redundante sem precisar comparar listas.
pub async fn ingest(
    state: &AppState,
    run: Uuid,
    events: &[RunEventInput],
) -> Result<(usize, i64), ApiError> {
    if events.len() > MAX_EVENT_BATCH {
        return Err(ApiError::BadRequest(format!(
            "lote de {} eventos acima do teto de {MAX_EVENT_BATCH}",
            events.len()
        )));
    }
    let mut aceitos = 0usize;
    let mut maior = 0i64;
    let mut transaction = state.pool.begin().await?;
    for event in events {
        if event.seq <= 0 {
            return Err(ApiError::BadRequest(
                "seq do evento deve ser positivo — é contador por run".into(),
            ));
        }
        let payload = event.payload.clone().unwrap_or_else(|| json!({}));
        // O teto vale sobre o JSON serializado, que é o que ocupa disco.
        if serde_json::to_string(&payload).map(|s| s.len()).unwrap_or(0) > MAX_PAYLOAD_BYTES {
            return Err(ApiError::BadRequest(format!(
                "payload do evento seq={} acima de {MAX_PAYLOAD_BYTES} bytes — trunque no cliente",
                event.seq
            )));
        }
        let done = sqlx::query(
            "INSERT INTO run_events(run_id,seq,kind,node_id,payload) VALUES($1,$2,$3,$4,$5) \
             ON CONFLICT (run_id, seq) DO NOTHING",
        )
        .bind(run)
        .bind(event.seq)
        .bind(clip(&event.kind, 80))
        .bind(clip(event.node_id.as_deref().unwrap_or(""), 120))
        .bind(&payload)
        .execute(&mut *transaction)
        .await?;
        if done.rows_affected() > 0 {
            aceitos += 1;
        }
        maior = maior.max(event.seq);
    }
    // `GREATEST` e não atribuição direta: um lote atrasado chegando depois de
    // um mais novo não pode ANDAR PARA TRÁS com o cursor, senão o cliente
    // seguinte pediria replay de algo que já viu e o run pareceria repetir.
    let row = sqlx::query(
        "UPDATE runs SET last_seq=GREATEST(last_seq,$2), updated_at=now() WHERE id=$1 \
         RETURNING last_seq",
    )
    .bind(run)
    .bind(maior)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok((aceitos, row.try_get("last_seq")?))
}

/* ------------------------------- Sessões ------------------------------ */

pub async fn session_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(body): Json<SessionCreate>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;

    // Upsert: o cliente local-first pode criar a sessão offline e sincronizar
    // depois; reenviar não pode ser erro.
    sqlx::query(
        "INSERT INTO sessions(id,workspace_id,user_id,mode,title,cwd,parent_id) \
         VALUES($1,$2,$3,$4,$5,$6,$7) \
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, updated_at=now()",
    )
    .bind(body.id)
    .bind(workspace)
    .bind(user)
    .bind(clip(body.mode.as_deref().unwrap_or("agent"), 40))
    .bind(clip(body.title.as_deref().unwrap_or(""), 200))
    .bind(clip(body.cwd.as_deref().unwrap_or(""), 500))
    .bind(body.parent_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "id": body.id })))
}

pub async fn sessions_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;

    // Só as próprias sessões: sessão de colega não é informação de membro.
    let rows = sqlx::query(
        "SELECT s.id, s.mode, s.title, s.cwd, s.created_at, s.updated_at, \
                COUNT(r.id) AS runs \
         FROM sessions s LEFT JOIN runs r ON r.session_id = s.id \
         WHERE s.workspace_id=$1 AND s.user_id=$2 \
         GROUP BY s.id ORDER BY s.updated_at DESC LIMIT $3",
    )
    .bind(workspace)
    .bind(user)
    .bind(MAX_ROWS)
    .fetch_all(&state.pool)
    .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "mode": row.get::<String, _>("mode"),
                "title": row.get::<String, _>("title"),
                "cwd": row.get::<String, _>("cwd"),
                "runs": row.get::<i64, _>("runs"),
                "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/* --------------------------------- Runs ------------------------------- */

pub async fn run_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(body): Json<RunCreate>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;

    // Mesmo planejador da rota de validação: um run só nasce de grafo válido,
    // e o plano fica CONGELADO junto (ver comentário da migration).
    let graph: crate::models::OrchestrationGraph =
        serde_json::from_value(body.graph.clone()).map_err(|error| {
            ApiError::BadRequest(format!("grafo de orquestração inválido: {error}"))
        })?;
    let plan = crate::routes::plan_orchestration(&graph).map_err(ApiError::BadRequest)?;
    let origin = match body.origin.as_deref() {
        None | Some("local") => "local",
        Some("gateway") => "gateway",
        Some(outro) => {
            return Err(ApiError::BadRequest(format!(
                "origin desconhecida: {outro} — use local ou gateway"
            )))
        }
    };

    let session_ok: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM sessions WHERE id=$1 AND workspace_id=$2 AND user_id=$3")
            .bind(body.session_id)
            .bind(workspace)
            .bind(user)
            .fetch_optional(&state.pool)
            .await?;
    if session_ok.is_none() {
        return Err(ApiError::BadRequest(
            "sessão inexistente neste workspace — crie a sessão antes do run".into(),
        ));
    }

    let groups = crate::policy::match_groups(&state, workspace, &caller.groups)
        .await
        .unwrap_or_default();

    sqlx::query(
        "INSERT INTO runs(id,session_id,workspace_id,user_id,group_ids,graph,plan,origin) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
    )
    .bind(body.id)
    .bind(body.session_id)
    .bind(workspace)
    .bind(user)
    .bind(&groups[..])
    .bind(&body.graph)
    .bind(serde_json::to_value(&plan).unwrap_or_else(|_| json!({})))
    .bind(origin)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "id": body.id, "plan": plan })))
}

pub async fn run_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, run)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;

    let row = sqlx::query(
        "SELECT id, session_id, status, origin, last_seq, graph, plan, error, \
                created_at, updated_at, started_at, finished_at \
         FROM runs WHERE id=$1 AND workspace_id=$2",
    )
    .bind(run)
    .bind(workspace)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;

    let pendentes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM run_approvals WHERE run_id=$1 AND status='pending'",
    )
    .bind(run)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": row.get::<Uuid, _>("id"),
        "sessionId": row.get::<Uuid, _>("session_id"),
        "status": row.get::<String, _>("status"),
        "origin": row.get::<String, _>("origin"),
        "lastSeq": row.get::<i64, _>("last_seq"),
        "graph": row.get::<Value, _>("graph"),
        "plan": row.get::<Value, _>("plan"),
        "error": row.get::<Option<String>, _>("error"),
        "pendingApprovals": pendentes,
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        "startedAt": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("started_at"),
        "finishedAt": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("finished_at"),
    })))
}

/// Ingest de eventos. É a rota mais chamada do módulo — o cliente empurra o
/// log dele aqui conforme executa.
pub async fn run_events_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, run)): Path<(Uuid, Uuid)>,
    Json(body): Json<EventBatch>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;
    run_guard(&state, workspace, run).await?;

    let (aceitos, last_seq) = ingest(&state, run, &body.events).await?;
    crate::executor::advance(&state, run).await?;
    publish(&state, run, &body.events).await;

    Ok(Json(json!({ "accepted": aceitos, "lastSeq": last_seq })))
}

/// Replay a partir de um cursor. É o que fecha o buraco da reconexão.
pub async fn run_events_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, run)): Path<(Uuid, Uuid)>,
    Query(query): Query<ReplayQuery>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;
    let last_seq = run_guard(&state, workspace, run).await?;

    let from = query.from_seq.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(MAX_ROWS).clamp(1, MAX_ROWS);
    let rows = sqlx::query(
        "SELECT seq, ts, kind, node_id, payload FROM run_events \
         WHERE run_id=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
    )
    .bind(run)
    .bind(from)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "seq": row.get::<i64, _>("seq"),
                "ts": row.get::<chrono::DateTime<chrono::Utc>, _>("ts"),
                "kind": row.get::<String, _>("kind"),
                "nodeId": row.get::<String, _>("node_id"),
                "payload": row.get::<Value, _>("payload"),
            })
        })
        .collect();

    // `hasMore` explícito: sem ele o cliente não distingue "acabou" de "bateu
    // no limite da página" e pararia de paginar no meio do run.
    let maior = items.last().and_then(|item| item["seq"].as_i64()).unwrap_or(from);
    Ok(Json(json!({
        "items": items,
        "lastSeq": last_seq,
        "hasMore": maior < last_seq,
    })))
}

/* ------------------------------ Aprovações ---------------------------- */

/// Registra um pedido de aprovação. Idempotente pelo id do cliente.
pub async fn approval_ask(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(body): Json<ApprovalAsk>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;
    run_guard(&state, workspace, body.run_id).await?;

    sqlx::query(
        "INSERT INTO run_approvals(id,run_id,node_id,tool,args) VALUES($1,$2,$3,$4,$5) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(body.id)
    .bind(body.run_id)
    .bind(clip(body.node_id.as_deref().unwrap_or(""), 120))
    .bind(clip(&body.tool, 120))
    .bind(body.args.clone().unwrap_or_else(|| json!({})))
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "id": body.id, "status": "pending" })))
}

pub async fn approvals_pending(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, run)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;
    run_guard(&state, workspace, run).await?;

    let rows = sqlx::query(
        "SELECT id, node_id, tool, args, created_at FROM run_approvals \
         WHERE run_id=$1 AND status='pending' ORDER BY created_at ASC",
    )
    .bind(run)
    .fetch_all(&state.pool)
    .await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "nodeId": row.get::<String, _>("node_id"),
                "tool": row.get::<String, _>("tool"),
                "args": row.get::<Value, _>("args"),
                "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// Decide uma aprovação. Primeira decisão vence; a segunda não sobrescreve.
pub async fn approval_decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, approval)): Path<(Uuid, Uuid)>,
    Json(body): Json<ApprovalDecision>,
) -> Result<Json<Value>, ApiError> {
    let caller = identity(&state, &headers).await?;
    let user = user_id(&state, &caller).await?;
    require_role(&state, user, workspace, MEMBER).await?;

    let alvo = if body.approved { "approved" } else { "denied" };
    // O `AND status='pending'` é o que faz a primeira decisão vencer. Sem ele,
    // um clique duplicado (ou dois operadores) reescreveria a decisão já
    // tomada e o log de auditoria contaria a última, não a que valeu.
    let row = sqlx::query(
        "UPDATE run_approvals a SET status=$3, decided_by=$4, decided_at=now() \
         WHERE a.id=$1 AND a.status='pending' \
           AND EXISTS (SELECT 1 FROM runs r WHERE r.id=a.run_id AND r.workspace_id=$2) \
         RETURNING a.run_id, a.status",
    )
    .bind(approval)
    .bind(workspace)
    .bind(alvo)
    .bind(user)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        // Já decidida, inexistente, ou de outro workspace. Devolver o estado
        // atual em vez de erro deixa o cliente convergir sem tratar corrida.
        let atual: Option<String> = sqlx::query_scalar(
            "SELECT a.status FROM run_approvals a JOIN runs r ON r.id=a.run_id \
             WHERE a.id=$1 AND r.workspace_id=$2",
        )
        .bind(approval)
        .bind(workspace)
        .fetch_optional(&state.pool)
        .await?;
        let status = atual.ok_or(ApiError::NotFound)?;
        return Ok(Json(json!({ "id": approval, "status": status, "changed": false })));
    };

    let run: Uuid = row.try_get("run_id")?;
    let status: String = row.try_get("status")?;
    // A decisão entra no log do run como qualquer outro evento: quem faz
    // replay precisa ver a aprovação no lugar em que ela aconteceu.
    let seq = next_seq(&state, run).await?;
    let evento = RunEventInput {
        seq,
        kind: "approval:decided".into(),
        node_id: None,
        payload: Some(json!({ "approvalId": approval, "status": status, "decidedBy": user })),
    };
    ingest(&state, run, std::slice::from_ref(&evento)).await?;
    publish(&state, run, std::slice::from_ref(&evento)).await;

    Ok(Json(json!({ "id": approval, "status": status, "changed": true })))
}

/// Próximo `seq` para um evento gerado PELO SERVIDOR.
///
/// O cliente numera os dele; quando o servidor precisa inserir (decisão de
/// aprovação, status do executor) ele pega o topo. Corrida com o cliente é
/// possível e o `ON CONFLICT DO NOTHING` a torna inofensiva — perder um
/// número não perde o evento, porque quem chama tenta o seguinte.
pub async fn next_seq(state: &AppState, run: Uuid) -> Result<i64, ApiError> {
    let atual: i64 = sqlx::query_scalar(
        "SELECT GREATEST(r.last_seq, COALESCE((SELECT MAX(seq) FROM run_events WHERE run_id=r.id),0)) \
         FROM runs r WHERE r.id=$1",
    )
    .bind(run)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    Ok(atual + 1)
}
