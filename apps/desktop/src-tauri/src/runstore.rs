//! Log local do run — a FONTE de verdade (local-first).
//!
//! O gateway é a cópia durável e compartilhável; quem manda é este arquivo. A
//! consequência prática: o run começa e anda **sem rede**, com BYOK ou runtime
//! local, e a sincronização é um detalhe de transporte que pode falhar sem
//! matar a execução. O contrário (servidor como fonte) tornaria o gateway
//! requisito para digitar qualquer coisa.
//!
//! ## `seq` é atribuído aqui, não no servidor
//!
//! É o que permite numerar offline. Uma ida ao gateway por evento seria
//! latência por token e um ponto de falha por linha de log. O servidor ACEITA
//! o número e usa `(run_id, seq)` como chave — reenviar é inofensivo.
//!
//! ## A atribuição do `seq` é atômica de verdade
//!
//! `SELECT MAX(seq)+1` seguido de `INSERT` em duas instruções abre corrida:
//! dois nós de uma mesma onda gravando ao mesmo tempo escolheriam o MESMO
//! número, e o segundo INSERT morreria na chave primária — evento perdido no
//! meio de um run paralelo, que é justamente o caso que o log existe para
//! contar. Aqui o número sai de uma subconsulta DENTRO do INSERT, sob
//! `BEGIN IMMEDIATE`: o write lock do SQLite serializa os dois.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Teto de eventos devolvidos por leitura. Alinhado ao teto de lote do
/// gateway (`runs::MAX_EVENT_BATCH`) para o sync nunca montar lote recusado.
const MAX_ROWS: i64 = 500;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub seq: i64,
    pub kind: String,
    pub node_id: String,
    pub payload: Value,
    pub ts: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub mode: String,
    pub title: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub runs: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub last_seq: i64,
    /// Até onde o gateway confirmou. `last_seq - synced_seq` é o que falta subir.
    pub synced_seq: i64,
    pub graph: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRow {
    pub id: String,
    pub run_id: String,
    pub node_id: String,
    pub tool: String,
    pub args: Value,
    pub status: String,
    pub created_at: String,
}

fn database_path() -> Result<PathBuf, String> {
    let directory = dirs::data_dir()
        .ok_or_else(|| "pasta de dados do usuário indisponível".to_string())?
        .join(crate::rebrand::SERVICO);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("runs.db"))
}

fn open() -> Result<Connection, String> {
    let connection = Connection::open(database_path()?).map_err(|error| error.to_string())?;
    // WAL: o leitor (a tela lendo o log) não bloqueia o escritor (o run
    // gravando eventos). Sem isto, abrir o painel de log durante uma onda
    // paralela travaria a gravação.
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                mode TEXT NOT NULL DEFAULT 'agent',
                title TEXT NOT NULL DEFAULT '',
                cwd TEXT NOT NULL DEFAULT '',
                parent_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                graph TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                last_seq INTEGER NOT NULL DEFAULT 0,
                synced_seq INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS run_events (
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                kind TEXT NOT NULL,
                node_id TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL DEFAULT '{}',
                ts TEXT NOT NULL,
                PRIMARY KEY (run_id, seq)
            );
            CREATE TABLE IF NOT EXISTS run_approvals (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL DEFAULT '',
                tool TEXT NOT NULL,
                args TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                decided_at TEXT
            );
            CREATE INDEX IF NOT EXISTS run_approvals_pending_idx
                ON run_approvals(run_id, status, created_at);",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}

/* ------------------------------- Sessões ------------------------------ */

#[tauri::command]
pub fn run_session_create(
    id: String,
    mode: Option<String>,
    title: Option<String>,
    cwd: Option<String>,
    parent_id: Option<String>,
) -> Result<String, String> {
    let connection = open()?;
    let agora = now();
    connection
        .execute(
            "INSERT INTO sessions(id,mode,title,cwd,parent_id,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?6) \
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at",
            params![
                id,
                clip(mode.as_deref().unwrap_or("agent"), 40),
                clip(title.as_deref().unwrap_or(""), 200),
                clip(cwd.as_deref().unwrap_or(""), 500),
                parent_id,
                agora
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn run_sessions_list() -> Result<Vec<SessionRow>, String> {
    let connection = open()?;
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.mode, s.title, s.cwd, s.created_at, s.updated_at, \
                    (SELECT COUNT(*) FROM runs r WHERE r.session_id = s.id) \
             FROM sessions s ORDER BY s.updated_at DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![MAX_ROWS], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                mode: row.get(1)?,
                title: row.get(2)?,
                cwd: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                runs: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

/* --------------------------------- Runs ------------------------------- */

#[tauri::command]
pub fn run_create(id: String, session_id: String, graph: Value) -> Result<String, String> {
    let connection = open()?;
    let agora = now();
    let graph_text = serde_json::to_string(&graph).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO runs(id,session_id,graph,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?4) ON CONFLICT(id) DO NOTHING",
            params![id, session_id, graph_text, agora],
        )
        .map_err(|error| error.to_string())?;
    Ok(id)
}

/// Grava um evento e devolve o `seq` atribuído.
///
/// A subconsulta dentro do INSERT é o que torna a atribuição atômica — ver o
/// cabeçalho do módulo.
#[tauri::command]
pub fn run_append(
    run_id: String,
    kind: String,
    node_id: Option<String>,
    payload: Option<Value>,
) -> Result<i64, String> {
    let mut connection = open()?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let payload_text = serde_json::to_string(&payload.unwrap_or(Value::Object(Default::default())))
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO run_events(run_id,seq,kind,node_id,payload,ts) VALUES( \
                ?1, \
                (SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id=?1), \
                ?2,?3,?4,?5)",
            params![
                run_id,
                clip(&kind, 80),
                clip(node_id.as_deref().unwrap_or(""), 120),
                payload_text,
                now()
            ],
        )
        .map_err(|error| error.to_string())?;
    let seq: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(seq),0) FROM run_events WHERE run_id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE runs SET last_seq=MAX(last_seq,?2), updated_at=?3 WHERE id=?1",
            params![run_id, seq, now()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(seq)
}

#[tauri::command]
pub fn run_events_since(
    run_id: String,
    from_seq: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<RunEvent>, String> {
    let connection = open()?;
    let teto = limit.unwrap_or(MAX_ROWS).clamp(1, MAX_ROWS);
    let mut statement = connection
        .prepare(
            "SELECT seq, kind, node_id, payload, ts FROM run_events \
             WHERE run_id=?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id, from_seq.unwrap_or(0).max(0), teto], |row| {
            let payload_text: String = row.get(3)?;
            Ok(RunEvent {
                seq: row.get(0)?,
                kind: row.get(1)?,
                node_id: row.get(2)?,
                payload: serde_json::from_str(&payload_text).unwrap_or(Value::Null),
                ts: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn run_get(run_id: String) -> Result<Option<RunRow>, String> {
    let connection = open()?;
    let row = connection
        .query_row(
            "SELECT id, session_id, status, last_seq, synced_seq, graph, created_at, updated_at \
             FROM runs WHERE id=?1",
            params![run_id],
            |row| {
                let graph_text: String = row.get(5)?;
                Ok(RunRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    status: row.get(2)?,
                    last_seq: row.get(3)?,
                    synced_seq: row.get(4)?,
                    graph: serde_json::from_str(&graph_text).unwrap_or(Value::Null),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .ok();
    Ok(row)
}

#[tauri::command]
pub fn run_list(session_id: Option<String>) -> Result<Vec<RunRow>, String> {
    let connection = open()?;
    // Duas consultas em vez de um filtro opcional em SQL: `?1 IS NULL OR ...`
    // impede o SQLite de usar o índice por sessão.
    let (sql, bind): (&str, Vec<String>) = match &session_id {
        Some(id) => (
            "SELECT id, session_id, status, last_seq, synced_seq, graph, created_at, updated_at \
             FROM runs WHERE session_id=?1 ORDER BY created_at DESC LIMIT 500",
            vec![id.clone()],
        ),
        None => (
            "SELECT id, session_id, status, last_seq, synced_seq, graph, created_at, updated_at \
             FROM runs ORDER BY created_at DESC LIMIT 500",
            Vec::new(),
        ),
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        let graph_text: String = row.get(5)?;
        Ok(RunRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            status: row.get(2)?,
            last_seq: row.get(3)?,
            synced_seq: row.get(4)?,
            graph: serde_json::from_str(&graph_text).unwrap_or(Value::Null),
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    };
    let rows = if bind.is_empty() {
        statement.query_map([], mapper)
    } else {
        statement.query_map(rusqlite::params_from_iter(bind.iter()), mapper)
    }
    .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn run_set_status(run_id: String, status: String, error: Option<String>) -> Result<(), String> {
    const VALIDOS: [&str; 6] = [
        "pending",
        "running",
        "paused",
        "succeeded",
        "failed",
        "canceled",
    ];
    if !VALIDOS.contains(&status.as_str()) {
        return Err(format!("status desconhecido: {status}"));
    }
    let connection = open()?;
    connection
        .execute(
            "UPDATE runs SET status=?2, error=?3, updated_at=?4 WHERE id=?1",
            params![run_id, status, error, now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Marca até onde o gateway confirmou (`ack`).
///
/// `MAX` e não atribuição: um `ack` atrasado não pode andar para trás com o
/// cursor, senão o sync reenviaria de um ponto já confirmado para sempre.
#[tauri::command]
pub fn run_mark_synced(run_id: String, seq: i64) -> Result<(), String> {
    let connection = open()?;
    connection
        .execute(
            "UPDATE runs SET synced_seq=MAX(synced_seq,?2) WHERE id=?1",
            params![run_id, seq.max(0)],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Runs com evento pendente de subir. É a fila do sincronizador.
#[tauri::command]
pub fn run_pending_sync() -> Result<Vec<String>, String> {
    let connection = open()?;
    let mut statement = connection
        .prepare("SELECT id FROM runs WHERE last_seq > synced_seq ORDER BY updated_at ASC LIMIT 50")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

/* ------------------------------ Aprovações ---------------------------- */

#[tauri::command]
pub fn run_approval_ask(
    id: String,
    run_id: String,
    node_id: Option<String>,
    tool: String,
    args: Option<Value>,
) -> Result<String, String> {
    let connection = open()?;
    let args_text = serde_json::to_string(&args.unwrap_or(Value::Object(Default::default())))
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO run_approvals(id,run_id,node_id,tool,args,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING",
            params![
                id,
                run_id,
                clip(node_id.as_deref().unwrap_or(""), 120),
                clip(&tool, 120),
                args_text,
                now()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(id)
}

/// Decide localmente. Devolve o status que VALEU.
///
/// O `AND status='pending'` é o mesmo do gateway: a primeira decisão vence, e
/// um segundo clique não reescreve o que já foi decidido.
#[tauri::command]
pub fn run_approval_decide(id: String, approved: bool) -> Result<String, String> {
    let connection = open()?;
    let alvo = if approved { "approved" } else { "denied" };
    let mudou = connection
        .execute(
            "UPDATE run_approvals SET status=?2, decided_at=?3 WHERE id=?1 AND status='pending'",
            params![id, alvo, now()],
        )
        .map_err(|error| error.to_string())?;
    if mudou > 0 {
        return Ok(alvo.to_string());
    }
    connection
        .query_row(
            "SELECT status FROM run_approvals WHERE id=?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("aprovação inexistente: {id}"))
}

#[tauri::command]
pub fn run_approvals_pending(run_id: String) -> Result<Vec<ApprovalRow>, String> {
    let connection = open()?;
    let mut statement = connection
        .prepare(
            "SELECT id, run_id, node_id, tool, args, status, created_at FROM run_approvals \
             WHERE run_id=?1 AND status='pending' ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id], |row| {
            let args_text: String = row.get(4)?;
            Ok(ApprovalRow {
                id: row.get(0)?,
                run_id: row.get(1)?,
                node_id: row.get(2)?,
                tool: row.get(3)?,
                args: serde_json::from_str(&args_text).unwrap_or(Value::Null),
                status: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}
