//! Política por grupo — a fonte da verdade do que cada usuário pode.
//!
//! Regras de resolução (ver docs/adr-edicao-gerenciada.md):
//! - módulos: UNIÃO dos grupos do usuário;
//! - booleanos de segurança (agentTools, byok, runtime local): o mais
//!   restritivo vence;
//! - approvalPolicy: a mais exigente vence (ask > edits > all);
//! - prompt master: o do grupo sobrepõe o do workspace;
//! - workspace SEM grupos cadastrados = gating não configurado → tudo
//!   liberado (senão a migração bloquearia todo mundo no dia seguinte).

use crate::{error::ApiError, models::Mode, state::AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

/// Documento de política de UM grupo (linhas de group_policies.document).
/// Campos ausentes não opinam — só o que o admin definiu entra no merge.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupPolicyDoc {
    pub agent_tools: Option<bool>,
    /// "ask" | "edits" | "all" — o tipo REAL do cliente (lib/approval.ts).
    pub approval_policy: Option<String>,
    pub byok_allowed: Option<bool>,
    pub local_runtime_allowed: Option<bool>,
    pub effort_max: Option<u8>,
}

/// Política efetiva do usuário depois do merge — o que o bootstrap devolve.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    pub allowed_modes: Vec<String>,
    pub agent_tools: bool,
    pub approval_policy: String,
    pub byok_allowed: bool,
    pub local_runtime_allowed: bool,
    pub effort_max: u8,
    pub prompt_master: Option<PromptMaster>,
    pub offline_grace_hours: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptMaster {
    pub content: String,
    pub allow_local_append: bool,
    pub local_max_chars: i32,
    pub version: i32,
}

/// Sem gating configurado: comporta-se como hoje — tudo liberado, política
/// padrão conservadora só na aprovação.
fn open_policy() -> EffectivePolicy {
    EffectivePolicy {
        allowed_modes: Mode::ALL.iter().map(|mode| mode.as_str().to_string()).collect(),
        agent_tools: true,
        approval_policy: "ask".into(),
        byok_allowed: true,
        local_runtime_allowed: true,
        effort_max: 4,
        prompt_master: None,
        offline_grace_hours: 72,
    }
}

/// Ordena a mais exigente primeiro: ask pergunta sempre, all não pergunta.
fn approval_rank(policy: &str) -> u8 {
    match policy {
        "ask" => 0,
        "edits" => 1,
        "all" => 2,
        _ => 0, // desconhecido é tratado como o mais restritivo
    }
}

/// Merge dos documentos dos grupos do usuário. Puro e testável: nos booleanos
/// de segurança `false` vence; na aprovação a mais exigente vence; no esforço
/// o teto mais baixo vence. Campo que nenhum grupo definiu usa o padrão.
pub fn merge_policies(docs: &[GroupPolicyDoc]) -> GroupPolicyDoc {
    let mut merged = GroupPolicyDoc::default();
    for doc in docs {
        if let Some(value) = doc.agent_tools {
            merged.agent_tools = Some(merged.agent_tools.unwrap_or(true) && value);
        }
        if let Some(value) = &doc.approval_policy {
            merged.approval_policy = Some(match &merged.approval_policy {
                Some(current) if approval_rank(current) <= approval_rank(value) => current.clone(),
                _ => value.clone(),
            });
        }
        if let Some(value) = doc.byok_allowed {
            merged.byok_allowed = Some(merged.byok_allowed.unwrap_or(true) && value);
        }
        if let Some(value) = doc.local_runtime_allowed {
            merged.local_runtime_allowed =
                Some(merged.local_runtime_allowed.unwrap_or(true) && value);
        }
        if let Some(value) = doc.effort_max {
            merged.effort_max = Some(merged.effort_max.map_or(value, |current| current.min(value)));
        }
    }
    merged
}

/// União dos módulos, devolvida na ordem canônica de Mode::ALL — a mesma
/// ordem das abas, para o cliente não reordenar nada.
pub fn union_modes(sets: &[Vec<String>]) -> Vec<String> {
    Mode::ALL
        .iter()
        .map(|mode| mode.as_str())
        .filter(|mode| sets.iter().any(|set| set.iter().any(|item| item == mode)))
        .map(str::to_string)
        .collect()
}

/// Grupos do token (ObjectIds do claim groups + nomes de app roles) casados
/// contra ad_groups do workspace. Devolve os ids internos.
async fn match_groups(
    state: &AppState,
    workspace: Uuid,
    token_groups: &[String],
) -> Result<Vec<Uuid>, ApiError> {
    if token_groups.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id FROM ad_groups WHERE workspace_id=$1 AND (ad_object_id = ANY($2) OR name = ANY($2))",
    )
    .bind(workspace)
    .bind(token_groups)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| row.get::<Uuid, _>("id"))
        .collect())
}

/// Quantos grupos o workspace tem cadastrados — zero significa que o admin
/// ainda não configurou gating e o comportamento é o legado (tudo liberado).
async fn gating_configured(state: &AppState, workspace: Uuid) -> Result<bool, ApiError> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM ad_groups WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(&state.pool)
        .await?;
    Ok(count > 0)
}

/// Materializa a associação usuário↔grupo vista neste login. O console admin
/// lista quem está em qual grupo sem consultar o AD.
async fn sync_memberships(
    state: &AppState,
    user: Uuid,
    group_ids: &[Uuid],
) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM user_group_memberships WHERE user_id=$1")
        .bind(user)
        .execute(&state.pool)
        .await?;
    for group in group_ids {
        sqlx::query(
            "INSERT INTO user_group_memberships(user_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(user)
        .bind(group)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/// Resolve a política efetiva do usuário no workspace.
pub async fn resolve(
    state: &AppState,
    workspace: Uuid,
    user: Uuid,
    token_groups: &[String],
) -> Result<EffectivePolicy, ApiError> {
    if !gating_configured(state, workspace).await? {
        return Ok(open_policy());
    }

    let group_ids = match_groups(state, workspace, token_groups).await?;
    sync_memberships(state, user, &group_ids).await?;

    // Usuário sem grupo casado: não vê nada. É o comportamento pedido —
    // módulo não liberado nem existe para ele.
    if group_ids.is_empty() {
        return Ok(EffectivePolicy {
            allowed_modes: Vec::new(),
            agent_tools: false,
            approval_policy: "ask".into(),
            byok_allowed: false,
            local_runtime_allowed: false,
            effort_max: 4,
            prompt_master: prompt_master_for(state, workspace, &[]).await?,
            offline_grace_hours: 72,
        });
    }

    let module_rows = sqlx::query("SELECT group_id, mode FROM group_modules WHERE group_id = ANY($1)")
        .bind(&group_ids)
        .fetch_all(&state.pool)
        .await?;
    let sets: Vec<Vec<String>> = group_ids
        .iter()
        .map(|group| {
            module_rows
                .iter()
                .filter(|row| row.get::<Uuid, _>("group_id") == *group)
                .map(|row| row.get::<String, _>("mode"))
                .collect()
        })
        .collect();

    let policy_rows = sqlx::query("SELECT document FROM group_policies WHERE group_id = ANY($1)")
        .bind(&group_ids)
        .fetch_all(&state.pool)
        .await?;
    let docs: Vec<GroupPolicyDoc> = policy_rows
        .iter()
        .map(|row| {
            serde_json::from_value(row.get::<Value, _>("document")).unwrap_or_default()
        })
        .collect();
    let merged = merge_policies(&docs);

    Ok(EffectivePolicy {
        allowed_modes: union_modes(&sets),
        agent_tools: merged.agent_tools.unwrap_or(true),
        approval_policy: merged.approval_policy.unwrap_or_else(|| "ask".into()),
        byok_allowed: merged.byok_allowed.unwrap_or(true),
        local_runtime_allowed: merged.local_runtime_allowed.unwrap_or(true),
        effort_max: merged.effort_max.unwrap_or(4),
        prompt_master: prompt_master_for(state, workspace, &group_ids).await?,
        offline_grace_hours: 72,
    })
}

/// Prompt master: o override do grupo vence o do workspace. Com vários grupos
/// com override, vence o de versão mais alta (determinístico e auditável).
async fn prompt_master_for(
    state: &AppState,
    workspace: Uuid,
    group_ids: &[Uuid],
) -> Result<Option<PromptMaster>, ApiError> {
    let row = sqlx::query(
        "SELECT content, allow_local_append, local_max_chars, version FROM prompt_masters \
         WHERE workspace_id=$1 AND (group_id = ANY($2)) ORDER BY version DESC LIMIT 1",
    )
    .bind(workspace)
    .bind(group_ids)
    .fetch_optional(&state.pool)
    .await?;
    let row = match row {
        Some(row) => Some(row),
        None => {
            sqlx::query(
                "SELECT content, allow_local_append, local_max_chars, version FROM prompt_masters \
                 WHERE workspace_id=$1 AND group_id IS NULL",
            )
            .bind(workspace)
            .fetch_optional(&state.pool)
            .await?
        }
    };
    Ok(row.map(|row| PromptMaster {
        content: row.get("content"),
        allow_local_append: row.get("allow_local_append"),
        local_max_chars: row.get("local_max_chars"),
        version: row.get("version"),
    }))
}

/// O portão dos endpoints de execução: módulo fora da política responde 404 —
/// não 403 — porque o requisito é que o módulo nem exista para o usuário.
pub async fn ensure_mode_allowed(
    state: &AppState,
    workspace: Uuid,
    user: Uuid,
    token_groups: &[String],
    mode: &Mode,
) -> Result<(), ApiError> {
    if !gating_configured(state, workspace).await? {
        return Ok(());
    }
    let policy = resolve(state, workspace, user, token_groups).await?;
    if policy.allowed_modes.iter().any(|allowed| allowed == mode.as_str()) {
        Ok(())
    } else {
        Err(ApiError::NotFound)
    }
}

/// Etag barato e determinístico do documento de política (FNV-1a 64).
pub fn policy_etag(policy: &EffectivePolicy) -> String {
    let serialized = serde_json::to_string(policy).unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in serialized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(patch: impl FnOnce(&mut GroupPolicyDoc)) -> GroupPolicyDoc {
        let mut doc = GroupPolicyDoc::default();
        patch(&mut doc);
        doc
    }

    #[test]
    fn uniao_de_modulos_na_ordem_canonica() {
        let sets = vec![
            vec!["code".to_string(), "chat".to_string()],
            vec!["office".to_string(), "chat".to_string()],
        ];
        assert_eq!(union_modes(&sets), vec!["chat", "code", "office"]);
    }

    #[test]
    fn uniao_vazia_para_usuario_sem_grupos() {
        assert!(union_modes(&[]).is_empty());
        assert!(union_modes(&[vec![]]).is_empty());
    }

    #[test]
    fn booleanos_de_seguranca_o_mais_restritivo_vence() {
        let merged = merge_policies(&[
            doc(|d| d.agent_tools = Some(true)),
            doc(|d| d.agent_tools = Some(false)),
            doc(|d| d.byok_allowed = Some(true)),
        ]);
        assert_eq!(merged.agent_tools, Some(false));
        assert_eq!(merged.byok_allowed, Some(true));
    }

    #[test]
    fn aprovacao_a_mais_exigente_vence() {
        let merged = merge_policies(&[
            doc(|d| d.approval_policy = Some("all".into())),
            doc(|d| d.approval_policy = Some("edits".into())),
        ]);
        assert_eq!(merged.approval_policy, Some("edits".into()));

        let com_ask = merge_policies(&[
            doc(|d| d.approval_policy = Some("edits".into())),
            doc(|d| d.approval_policy = Some("ask".into())),
        ]);
        assert_eq!(com_ask.approval_policy, Some("ask".into()));
    }

    #[test]
    fn politica_desconhecida_e_tratada_como_a_mais_restritiva() {
        let merged = merge_policies(&[
            doc(|d| d.approval_policy = Some("all".into())),
            doc(|d| d.approval_policy = Some("qualquer-coisa".into())),
        ]);
        assert_eq!(merged.approval_policy, Some("qualquer-coisa".into()));
        assert_eq!(approval_rank("qualquer-coisa"), 0);
    }

    #[test]
    fn teto_de_esforco_mais_baixo_vence() {
        let merged = merge_policies(&[doc(|d| d.effort_max = Some(4)), doc(|d| d.effort_max = Some(2))]);
        assert_eq!(merged.effort_max, Some(2));
    }

    #[test]
    fn campo_que_nenhum_grupo_definiu_nao_opina() {
        let merged = merge_policies(&[GroupPolicyDoc::default()]);
        assert_eq!(merged, GroupPolicyDoc::default());
    }

    #[test]
    fn etag_e_estavel_e_muda_com_a_politica() {
        let a = open_policy();
        let mut b = open_policy();
        assert_eq!(policy_etag(&a), policy_etag(&a));
        b.allowed_modes.pop();
        assert_ne!(policy_etag(&a), policy_etag(&b));
    }
}

/* ------------------------------ assinatura ------------------------------ */

/// PKCS#8 v1 para Ed25519: prefixo DER fixo + seed de 32 bytes. Permite usar
/// o jsonwebtoken (que já está no projeto) sem dependência nova de assinatura.
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
    0x20,
];

/// Mensagem canônica assinada: JSON com chaves ordenadas (serde_json usa
/// BTreeMap por padrão) contendo APENAS issuedAt/expiresAt/profile/policy.
/// O cliente reconstrói os mesmos bytes a partir do corpo recebido.
pub fn signing_message(issued_at: &str, expires_at: &str, profile: &Value, policy: &Value) -> String {
    serde_json::json!({
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "profile": profile,
        "policy": policy,
    })
    .to_string()
}

/// Assina a mensagem canônica com a seed Ed25519 da configuração.
/// Devolve base64url (sem padding), o formato nativo do jsonwebtoken.
pub fn sign_bootstrap(seed: &[u8; 32], message: &str) -> Result<String, ApiError> {
    let mut pkcs8 = Vec::with_capacity(48);
    pkcs8.extend_from_slice(&ED25519_PKCS8_PREFIX);
    pkcs8.extend_from_slice(seed);
    let key = jsonwebtoken::EncodingKey::from_ed_der(&pkcs8);
    jsonwebtoken::crypto::sign(message.as_bytes(), &key, jsonwebtoken::Algorithm::EdDSA)
        .map_err(|error| ApiError::Internal(error.into()))
}

#[cfg(test)]
mod signing_tests {
    use super::*;

    #[test]
    fn assinatura_e_deterministica_e_muda_com_a_mensagem() {
        let seed = [7u8; 32];
        let message = signing_message("2026-01-01T00:00:00Z", "2026-01-01T06:00:00Z", &serde_json::json!({"a":1}), &serde_json::json!({"b":2}));
        let first = sign_bootstrap(&seed, &message).unwrap();
        let second = sign_bootstrap(&seed, &message).unwrap();
        assert_eq!(first, second);
        let other = sign_bootstrap(&seed, &format!("{message}x")).unwrap();
        assert_ne!(first, other);
    }

    #[test]
    fn mensagem_canonica_ordena_chaves() {
        // BTreeMap do serde_json: a ordem de inserção não importa — o cliente
        // reconstrói os mesmos bytes independente da ordem do wire.
        let a = signing_message("i", "e", &serde_json::json!({"z":1,"a":2}), &serde_json::json!({}));
        assert!(a.find("\"a\":2").unwrap() < a.find("\"z\":1").unwrap());
    }
}
