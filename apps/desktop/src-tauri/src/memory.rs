use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub importance: i64,
    pub uses: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    kind: String,
    title: String,
    content: String,
    tags: Option<Vec<String>>,
    importance: Option<i64>,
    source: Option<String>,
}

fn database_path() -> Result<PathBuf, String> {
    let directory = dirs::data_dir()
        .ok_or_else(|| "pasta de dados do usuário indisponível".to_string())?
        .join("AI-Orchestrator");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("memory.db"))
}

fn open() -> Result<Connection, String> {
    let connection = Connection::open(database_path()?).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                tags TEXT NOT NULL,
                importance INTEGER NOT NULL,
                uses INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_used_at TEXT,
                source TEXT NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn tags_json(tags: &[String]) -> Result<String, String> {
    serde_json::to_string(tags).map_err(|error| error.to_string())
}

fn row_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    let tags_text: String = row.get(4)?;
    Ok(MemoryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        tags: serde_json::from_str(&tags_text).unwrap_or_default(),
        importance: row.get(5)?,
        uses: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        last_used_at: row.get(9)?,
        source: row.get(10)?,
    })
}

#[tauri::command]
pub fn memory_add(input: MemoryInput) -> Result<MemoryItem, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let item = MemoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        kind: input.kind,
        title: input.title,
        content: input.content,
        tags: input.tags.unwrap_or_default(),
        importance: input.importance.unwrap_or(3),
        uses: 0,
        created_at: now.clone(),
        updated_at: now,
        last_used_at: None,
        source: input.source.unwrap_or_else(|| "manual".into()),
    };
    open()?
        .execute(
            "INSERT INTO memories (id, kind, title, content, tags, importance, uses, created_at, updated_at, last_used_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                item.id,
                item.kind,
                item.title,
                item.content,
                tags_json(&item.tags)?,
                item.importance,
                item.uses,
                item.created_at,
                item.updated_at,
                item.last_used_at,
                item.source
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(item)
}

#[tauri::command]
pub fn memory_update(item: MemoryItem) -> Result<(), String> {
    let changed = open()?
        .execute(
            "UPDATE memories SET kind = ?2, title = ?3, content = ?4, tags = ?5, importance = ?6, updated_at = ?7, source = ?8 WHERE id = ?1",
            params![
                item.id,
                item.kind,
                item.title,
                item.content,
                tags_json(&item.tags)?,
                item.importance,
                chrono::Utc::now().to_rfc3339(),
                item.source
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("memória não encontrada".into());
    }
    Ok(())
}

#[tauri::command]
pub fn memory_delete(id: String) -> Result<(), String> {
    open()?
        .execute("DELETE FROM memories WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn memory_list() -> Result<Vec<MemoryItem>, String> {
    let connection = open()?;
    let mut statement = connection
        .prepare(
            "SELECT id, kind, title, content, tags, importance, uses, created_at, updated_at, last_used_at, source
             FROM memories ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_item)
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    Ok(items)
}

#[tauri::command]
pub fn memory_touch(ids: Vec<String>) -> Result<(), String> {
    let connection = open()?;
    let now = chrono::Utc::now().to_rfc3339();
    for id in ids {
        connection
            .execute(
                "UPDATE memories SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1",
                params![id, now],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
