//! Relatoria de uso e custo para o console do admin.
//!
//! Responde às quatro perguntas que o admin faz: quanto gastou cada
//! **usuário**, cada **grupo**, cada **modelo**, e como isso evoluiu no
//! **tempo**. A autorização é destes endpoints (role >= admin no workspace),
//! nunca da UI.
//!
//! Três decisões que valem mais que o SQL:
//!
//! 1. **Preço é dado do admin, não do código.** Tabela de preço de provedor
//!    muda sem aviso; se o valor estivesse embutido no binário, o relatório
//!    ficaria errado em silêncio. Modelo sem preço cadastrado aparece como
//!    "sem preço", nunca como custo zero — zero seria lido como "não custou".
//!
//! 2. **Grupo vem do snapshot no evento**, não de um JOIN com a associação
//!    atual. Quem muda de área não pode levar consigo o gasto histórico: o
//!    fechamento do mês passado tem de dar o mesmo número no mês que vem.
//!
//! 3. **Token ausente é NULL, não 0.** Chamada em que o provedor não devolveu
//!    contagem entra no relatório como sem-medição, e o total de eventos
//!    medidos é exposto junto — para o admin saber de quanto do consumo o
//!    número realmente fala.

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
/// Teto de linhas por quebra — relatório é para ler, não para exportar tudo.
const MAX_ROWS: i64 = 200;
/// Janela padrão e máxima, em dias.
const DEFAULT_DAYS: i64 = 30;
const MAX_DAYS: i64 = 365;

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

#[derive(Deserialize, Default)]
pub struct Window {
    days: Option<i64>,
}

impl Window {
    fn days(&self) -> i64 {
        self.days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS)
    }
}

/// Expressão de custo em SQL.
///
/// O cálculo fica no banco, junto do somatório, para não trazer milhões de
/// linhas para a memória do gateway. `numeric` (não float) porque dinheiro
/// somado em ponto flutuante acumula erro visível em volume.
const COST_SQL: &str = "
  (COALESCE(e.input_tokens,0)::numeric      * COALESCE(p.input_per_mtok,0)
 + COALESCE(e.output_tokens,0)::numeric     * COALESCE(p.output_per_mtok,0)
 + COALESCE(e.cache_read_tokens,0)::numeric * COALESCE(p.cache_read_per_mtok,0)
 + COALESCE(e.cache_write_tokens,0)::numeric* COALESCE(p.cache_write_per_mtok,0)
  ) / 1000000";

/// Ordenação das quebras: do maior gasto para o menor.
///
/// Pela EXPRESSÃO, nunca pelo alias `cost_usd`. Ele sai como TEXTO de
/// propósito (dinheiro não vira float no caminho), e em Postgres o nome no
/// `ORDER BY` casa com o alias de saída — a comparação virava de string:
/// "9.000000" acima de "80.000000". Com o LIMIT, os maiores gastadores
/// sumiam do relatório que existe justamente para encontrá-los.
fn cost_order() -> String {
    format!("ORDER BY COALESCE(SUM({COST_SQL}),0) DESC, calls DESC")
}

/// Colunas de soma comuns a todas as quebras.
fn totals_select() -> String {
    format!(
        "COUNT(*) AS calls, \
         COUNT(e.input_tokens) AS measured_calls, \
         COALESCE(SUM(e.input_tokens),0) AS input_tokens, \
         COALESCE(SUM(e.output_tokens),0) AS output_tokens, \
         COALESCE(SUM(e.cache_read_tokens),0) AS cache_read_tokens, \
         COALESCE(SUM(e.cache_write_tokens),0) AS cache_write_tokens, \
         ROUND(COALESCE(SUM({COST_SQL}),0), 6)::text AS cost_usd, \
         COUNT(*) FILTER (WHERE p.model IS NULL) AS calls_without_price"
    )
}

fn totals_json(row: &sqlx::postgres::PgRow) -> Value {
    // numeric → text no SQL: evita habilitar a feature bigdecimal do sqlx e,
    // principalmente, evita converter dinheiro para float no caminho.
    let cost: String = row.try_get("cost_usd").unwrap_or_else(|_| "0".into());
    json!({
        "calls": row.try_get::<i64, _>("calls").unwrap_or(0),
        // Quantas dessas chamadas realmente têm medição de token.
        "measuredCalls": row.try_get::<i64, _>("measured_calls").unwrap_or(0),
        "inputTokens": row.try_get::<i64, _>("input_tokens").unwrap_or(0),
        "outputTokens": row.try_get::<i64, _>("output_tokens").unwrap_or(0),
        "cacheReadTokens": row.try_get::<i64, _>("cache_read_tokens").unwrap_or(0),
        "cacheWriteTokens": row.try_get::<i64, _>("cache_write_tokens").unwrap_or(0),
        "costUsd": cost,
        // > 0 significa que o custo mostrado está INCOMPLETO.
        "callsWithoutPrice": row.try_get::<i64, _>("calls_without_price").unwrap_or(0),
    })
}

/// `FROM` comum: eventos da janela, com o preço do modelo quando existir.
fn from_clause() -> &'static str {
    "FROM usage_events e \
     LEFT JOIN model_prices p ON p.workspace_id = e.workspace_id AND p.model = e.model \
     WHERE e.workspace_id = $1 AND e.created_at >= now() - make_interval(days => $2::int)"
}

/* ------------------------------ por usuário ----------------------------- */

pub async fn usage_by_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(window): Query<Window>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let sql = format!(
        "SELECT e.user_id, u.email, u.display_name, {} {} \
         GROUP BY e.user_id, u.email, u.display_name \
         {} LIMIT {MAX_ROWS}",
        totals_select(),
        cost_order(),
        from_clause().replace(
            "FROM usage_events e ",
            "FROM usage_events e JOIN users u ON u.id = e.user_id "
        )
    );
    let rows = sqlx::query(&sql)
        .bind(workspace)
        .bind(window.days() as i32)
        .fetch_all(&state.pool)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut item = totals_json(row);
            item["userId"] = json!(row.try_get::<Uuid, _>("user_id").ok());
            item["email"] = json!(row.try_get::<Option<String>, _>("email").ok().flatten());
            item["name"] = json!(row
                .try_get::<Option<String>, _>("display_name")
                .ok()
                .flatten());
            item
        })
        .collect();
    Ok(Json(json!({ "days": window.days(), "items": items })))
}

/* ------------------------------- por grupo ------------------------------ */

pub async fn usage_by_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(window): Query<Window>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    // `unnest` do snapshot: quem está em dois grupos conta nos dois, e a soma
    // das áreas passa do total do workspace — dito na UI para não parecer erro.
    let sql = format!(
        "SELECT g.id AS group_id, g.name, {} \
         FROM usage_events e \
         CROSS JOIN LATERAL unnest(e.group_ids) AS gid \
         JOIN ad_groups g ON g.id = gid \
         LEFT JOIN model_prices p ON p.workspace_id = e.workspace_id AND p.model = e.model \
         WHERE e.workspace_id = $1 AND e.created_at >= now() - make_interval(days => $2::int) \
         GROUP BY g.id, g.name {} LIMIT {MAX_ROWS}",
        totals_select(),
        cost_order()
    );
    let rows = sqlx::query(&sql)
        .bind(workspace)
        .bind(window.days() as i32)
        .fetch_all(&state.pool)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut item = totals_json(row);
            item["groupId"] = json!(row.try_get::<Uuid, _>("group_id").ok());
            item["name"] = json!(row.try_get::<String, _>("name").unwrap_or_default());
            item
        })
        .collect();

    // Eventos SEM grupo algum: usuário fora de qualquer grupo cadastrado.
    // Sem esta linha o relatório por área simplesmente perderia esse consumo.
    let orphan_sql = format!(
        "SELECT {} {} AND cardinality(e.group_ids) = 0",
        totals_select(),
        from_clause()
    );
    let orphan = sqlx::query(&orphan_sql)
        .bind(workspace)
        .bind(window.days() as i32)
        .fetch_one(&state.pool)
        .await?;

    Ok(Json(json!({
        "days": window.days(),
        "items": items,
        "ungrouped": totals_json(&orphan),
    })))
}

/* ------------------------------ por modelo ------------------------------ */

pub async fn usage_by_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(window): Query<Window>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let sql = format!(
        "SELECT e.model, e.mode, (p.model IS NOT NULL) AS has_price, {} {} \
         GROUP BY e.model, e.mode, has_price {} LIMIT {MAX_ROWS}",
        totals_select(),
        from_clause(),
        cost_order()
    );
    let rows = sqlx::query(&sql)
        .bind(workspace)
        .bind(window.days() as i32)
        .fetch_all(&state.pool)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut item = totals_json(row);
            item["model"] = json!(row.try_get::<String, _>("model").unwrap_or_default());
            item["mode"] = json!(row.try_get::<String, _>("mode").unwrap_or_default());
            item["hasPrice"] = json!(row.try_get::<bool, _>("has_price").unwrap_or(false));
            item
        })
        .collect();
    Ok(Json(json!({ "days": window.days(), "items": items })))
}

/* -------------------------------- por dia ------------------------------- */

pub async fn usage_daily(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Query(window): Query<Window>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let sql = format!(
        "SELECT date_trunc('day', e.created_at) AS day, \
         COUNT(DISTINCT e.user_id) AS active_users, {} {} \
         GROUP BY day ORDER BY day",
        totals_select(),
        from_clause()
    );
    let rows = sqlx::query(&sql)
        .bind(workspace)
        .bind(window.days() as i32)
        .fetch_all(&state.pool)
        .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut item = totals_json(row);
            item["day"] = json!(row
                .try_get::<chrono::DateTime<chrono::Utc>, _>("day")
                .map(|value| value.date_naive().to_string())
                .unwrap_or_default());
            item["activeUsers"] = json!(row.try_get::<i64, _>("active_users").unwrap_or(0));
            item
        })
        .collect();
    Ok(Json(json!({ "days": window.days(), "items": items })))
}

/* ------------------------- preços por modelo ---------------------------- */

pub async fn prices_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    // `::text` no SQL: o valor é `numeric` e chega ao JSON como string, sem
    // passar por float em ponto nenhum do caminho — é preço, não estimativa.
    let rows = sqlx::query(
        "SELECT model, input_per_mtok::text AS input_per_mtok, \
         output_per_mtok::text AS output_per_mtok, \
         cache_read_per_mtok::text AS cache_read_per_mtok, \
         cache_write_per_mtok::text AS cache_write_per_mtok, currency \
         FROM model_prices WHERE workspace_id=$1 ORDER BY model",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let texto = |coluna: &str| row.try_get::<String, _>(coluna).unwrap_or_default();
            json!({
                "model": texto("model"),
                "inputPerMTok": texto("input_per_mtok"),
                "outputPerMTok": texto("output_per_mtok"),
                "cacheReadPerMTok": texto("cache_read_per_mtok"),
                "cacheWritePerMTok": texto("cache_write_per_mtok"),
                "currency": texto("currency"),
            })
        })
        .collect();

    // Modelos que APARECEM no uso mas não têm preço: é a lista de trabalho do
    // admin. Sem ela, descobrir o furo exigiria comparar dois relatórios.
    let missing = sqlx::query(
        "SELECT DISTINCT e.model FROM usage_events e \
         LEFT JOIN model_prices p ON p.workspace_id=e.workspace_id AND p.model=e.model \
         WHERE e.workspace_id=$1 AND p.model IS NULL ORDER BY e.model",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await?;
    let missing: Vec<String> = missing
        .iter()
        .filter_map(|row| row.try_get::<String, _>("model").ok())
        .collect();

    Ok(Json(json!({ "items": items, "missingPrices": missing })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceUpsert {
    model: String,
    input_per_mtok: f64,
    output_per_mtok: f64,
    #[serde(default)]
    cache_read_per_mtok: f64,
    #[serde(default)]
    cache_write_per_mtok: f64,
    #[serde(default = "usd")]
    currency: String,
}

fn usd() -> String {
    "USD".into()
}

pub async fn price_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(body): Json<PriceUpsert>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    let model = body.model.trim();
    if model.is_empty() {
        return Err(ApiError::BadRequest("modelo obrigatório".into()));
    }
    // Preço negativo geraria crédito no relatório — recusa explícita.
    for (nome, valor) in [
        ("inputPerMTok", body.input_per_mtok),
        ("outputPerMTok", body.output_per_mtok),
        ("cacheReadPerMTok", body.cache_read_per_mtok),
        ("cacheWritePerMTok", body.cache_write_per_mtok),
    ] {
        if !valor.is_finite() || valor < 0.0 {
            return Err(ApiError::BadRequest(format!(
                "{nome} precisa ser um número não negativo"
            )));
        }
    }
    sqlx::query(
        "INSERT INTO model_prices(workspace_id,model,input_per_mtok,output_per_mtok,\
         cache_read_per_mtok,cache_write_per_mtok,currency) \
         VALUES($1,$2,$3::numeric,$4::numeric,$5::numeric,$6::numeric,$7) \
         ON CONFLICT (workspace_id, model) DO UPDATE SET \
         input_per_mtok=EXCLUDED.input_per_mtok, output_per_mtok=EXCLUDED.output_per_mtok, \
         cache_read_per_mtok=EXCLUDED.cache_read_per_mtok, \
         cache_write_per_mtok=EXCLUDED.cache_write_per_mtok, \
         currency=EXCLUDED.currency, updated_at=now()",
    )
    .bind(workspace)
    .bind(model)
    .bind(body.input_per_mtok)
    .bind(body.output_per_mtok)
    .bind(body.cache_read_per_mtok)
    .bind(body.cache_write_per_mtok)
    .bind(body.currency.trim())
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true, "model": model })))
}

pub async fn price_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((workspace, model)): Path<(Uuid, String)>,
) -> Result<Json<Value>, ApiError> {
    authorize_admin(&state, &headers, workspace).await?;
    sqlx::query("DELETE FROM model_prices WHERE workspace_id=$1 AND model=$2")
        .bind(workspace)
        .bind(&model)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn janela_e_limitada_para_nao_varrer_o_historico_inteiro() {
        assert_eq!(Window { days: None }.days(), DEFAULT_DAYS);
        assert_eq!(Window { days: Some(0) }.days(), 1);
        assert_eq!(Window { days: Some(-30) }.days(), 1);
        assert_eq!(Window { days: Some(99_999) }.days(), MAX_DAYS);
        assert_eq!(Window { days: Some(7) }.days(), 7);
    }

    /// O custo tem de somar as QUATRO categorias — somar cache como entrada
    /// normal daria um número errado com cara de certo.
    #[test]
    fn expressao_de_custo_cobre_as_quatro_categorias() {
        for coluna in [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ] {
            assert!(COST_SQL.contains(coluna), "custo ignora {coluna}");
        }
        assert!(COST_SQL.contains("1000000"), "preço é por milhão de tokens");
    }

    /// `COUNT(e.input_tokens)` ignora NULL — é o que separa "chamada medida"
    /// de "chamada sem contagem". Se virasse COUNT(*), o relatório afirmaria
    /// medir tudo.
    #[test]
    fn totais_distinguem_chamada_medida_de_nao_medida() {
        let select = totals_select();
        assert!(select.contains("COUNT(*) AS calls"));
        assert!(select.contains("COUNT(e.input_tokens) AS measured_calls"));
        assert!(select.contains("calls_without_price"));
    }

    /// `cost_usd` é TEXTO (dinheiro não vira float no caminho). Ordenar pelo
    /// alias faria o Postgres comparar string: "9.000000" acima de
    /// "80.000000", e com LIMIT o maior gastador sumia do relatório.
    #[test]
    fn ordenacao_de_custo_e_numerica_e_nao_pelo_alias_de_texto() {
        let ordem = cost_order();
        assert!(
            ordem.contains("SUM(") && ordem.contains("input_per_mtok"),
            "a ordenação precisa ser pela expressão de custo: {ordem}"
        );
        assert!(
            !ordem.contains("cost_usd"),
            "ordenar pelo alias volta a comparar dinheiro como string"
        );
        assert!(totals_select().contains("::text AS cost_usd"));
    }

    #[test]
    fn from_filtra_por_workspace_e_janela() {
        let from = from_clause();
        assert!(from.contains("e.workspace_id = $1"));
        assert!(from.contains("make_interval(days => $2::int)"));
        // LEFT JOIN: modelo sem preço não pode sumir do relatório.
        assert!(from.contains("LEFT JOIN model_prices"));
    }
}
