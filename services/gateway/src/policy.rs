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
use std::collections::BTreeMap;
#[cfg(test)]
use serde_json::json;
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
    /* ----------------------- modelo de agente ----------------------- */
    //
    // Um agente que aciona agentes é recursão dirigida por modelo: os tetos
    // decidem quanto uma execução pode custar. Deixá-los no cliente era o
    // mesmo furo do gating cosmético — quem paga a conta é a empresa, então
    // quem define é o admin.
    /// Níveis de delegação abaixo da raiz. 0 proíbe delegar.
    pub agent_max_depth: Option<u8>,
    /// Subordinados diretos por agente.
    pub agent_max_children: Option<u8>,
    /// Teto absoluto de agentes por execução.
    pub agent_max_total: Option<u8>,
    /// Modelo por PAPEL da equipe (`idea`, `scope`, `plan`, `code`, `review`).
    ///
    /// A escalação da aba Agent é pré-determinada pela complexidade, e cada
    /// papel tem custo e exigência diferentes: raciocinar sobre princípios não
    /// é a mesma coisa que aplicar uma fatia de tarefa. Deixar isso no cliente
    /// devolveria ao usuário a escolha de gastar — que é justamente o que a
    /// política do grupo existe para decidir.
    pub agent_role_models: Option<BTreeMap<String, String>>,
    /// Plugins GLOBAIS do grupo, como manifesto declarativo (ver lib/plugins.ts).
    ///
    /// Eles valem para todo mundo do grupo. Ficam aqui, e não no cliente,
    /// porque uma ferramenta que aponta para um endpoint interno é decisão de
    /// arquitetura da empresa, não preferência de estação.
    pub agent_plugins: Option<Vec<Value>>,
    /// Deixa a pessoa criar plugin próprio para o agente DELA.
    ///
    /// Fechado por padrão, como todo o resto que amplia o que a IA alcança: o
    /// admin abre quando decidir que abre.
    pub user_plugins_allowed: Option<bool>,
    /// Code mode: o modelo escreve UM programa que combina várias ferramentas,
    /// interpretado por um subconjunto fechado no cliente (lib/codeMode.ts).
    ///
    /// Não é `eval`: o interpretador não tem caminho até nada do app. Ainda
    /// assim é o modelo dirigindo uma sequência de ações com uma aprovação por
    /// chamada, então quem abre é o admin.
    pub code_mode_allowed: Option<bool>,
    /// Área de trabalho isolada (escrever e EXECUTAR código na estação).
    /// Ver docs/adr-computer-use.md — não reduz privilégio.
    pub computer_use_allowed: Option<bool>,
    /// Domínios que o app não pode alcançar — nem para pesquisar, nem para
    /// chamar webhook ou servidor MCP. `exemplo.com` pega os subdomínios;
    /// `*.exemplo.com` pega só os subdomínios.
    pub blocked_domains: Option<Vec<String>>,
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
    pub agent_max_depth: u8,
    pub agent_max_children: u8,
    pub agent_max_total: u8,
    pub agent_role_models: BTreeMap<String, String>,
    pub agent_plugins: Vec<Value>,
    pub user_plugins_allowed: bool,
    pub code_mode_allowed: bool,
    pub computer_use_allowed: bool,
    pub blocked_domains: Vec<String>,
    pub prompt_master: Option<PromptMaster>,
    pub offline_grace_hours: u32,
}

/// Tetos padrão do acionamento de agentes quando o admin não definiu nada.
/// Conservadores: melhor um fluxo que pede para o admin abrir do que uma
/// execução que gasta antes de alguém perceber.
pub const DEFAULT_AGENT_DEPTH: u8 = 3;
pub const DEFAULT_AGENT_CHILDREN: u8 = 5;
pub const DEFAULT_AGENT_TOTAL: u8 = 20;

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
        allowed_modes: Mode::ALL
            .iter()
            .map(|mode| mode.as_str().to_string())
            .collect(),
        agent_tools: true,
        approval_policy: "ask".into(),
        byok_allowed: true,
        local_runtime_allowed: true,
        effort_max: 4,
        agent_max_depth: DEFAULT_AGENT_DEPTH,
        agent_max_children: DEFAULT_AGENT_CHILDREN,
        agent_max_total: DEFAULT_AGENT_TOTAL,
        // Sem política, todos os papéis usam o modelo do módulo.
        agent_role_models: BTreeMap::new(),
        agent_plugins: Vec::new(),
        // Plugin próprio amplia o alcance da IA: fechado até o admin abrir.
        user_plugins_allowed: false,
        code_mode_allowed: false,
        // Mesmo sem gating configurado, computer use nasce FECHADO: ele executa
        // comando na estação e depende de parecer de TI/SI (ver ADR).
        computer_use_allowed: false,
        blocked_domains: Vec::new(),
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
            merged.effort_max = Some(
                merged
                    .effort_max
                    .map_or(value, |current| current.min(value)),
            );
        }
        // Tetos de agente: o MENOR vence. Quem está em TI (teto alto) e em
        // Comercial (teto baixo) recebe o baixo — a união dos módulos abre
        // acesso, mas nunca abre gasto.
        for (destino, valor) in [
            (&mut merged.agent_max_depth, doc.agent_max_depth),
            (&mut merged.agent_max_children, doc.agent_max_children),
            (&mut merged.agent_max_total, doc.agent_max_total),
        ] {
            if let Some(value) = valor {
                *destino = Some(destino.map_or(value, |current| current.min(value)));
            }
        }
        if let Some(value) = doc.computer_use_allowed {
            merged.computer_use_allowed = Some(merged.computer_use_allowed.unwrap_or(true) && value);
        }
        // Plugin do usuário é ampliação do que a IA alcança: o grupo mais
        // restritivo vence, como nos outros booleanos de segurança.
        if let Some(value) = doc.user_plugins_allowed {
            merged.user_plugins_allowed = Some(merged.user_plugins_allowed.unwrap_or(true) && value);
        }
        if let Some(value) = doc.code_mode_allowed {
            merged.code_mode_allowed = Some(merged.code_mode_allowed.unwrap_or(true) && value);
        }
        // Plugins globais são UNIÃO, com o primeiro `id` vencendo — pertencer a
        // dois grupos soma ferramentas, não as tira. O `id` decide para dois
        // grupos não registrarem a mesma ferramenta duas vezes.
        if let Some(value) = &doc.agent_plugins {
            let lista = merged.agent_plugins.get_or_insert_with(Vec::new);
            for plugin in value {
                let id = plugin.get("id").and_then(Value::as_str).unwrap_or("").trim();
                if id.is_empty() {
                    continue;
                }
                let repetido = lista
                    .iter()
                    .any(|item| item.get("id").and_then(Value::as_str) == Some(id));
                if !repetido {
                    lista.push(plugin.clone());
                }
            }
        }
        // Modelo por papel: o PRIMEIRO grupo que definir o papel manda. Não há
        // ordem "mais restritiva" entre dois nomes de modelo — tentar escolher
        // pelo mais barato exigiria a tabela de preços aqui dentro, e ela vive
        // no relatório. Os grupos vêm ordenados por prioridade, então o
        // primeiro é o de maior precedência.
        if let Some(value) = &doc.agent_role_models {
            let mapa = merged.agent_role_models.get_or_insert_with(BTreeMap::new);
            for (role, model) in value {
                let role = role.trim().to_ascii_lowercase();
                let model = model.trim();
                if !role.is_empty() && !model.is_empty() {
                    mapa.entry(role).or_insert_with(|| model.to_string());
                }
            }
        }
        // Blocklist é UNIÃO: mais domínios bloqueados = mais restritivo, que é
        // a mesma direção dos booleanos. Interseção deixaria alguém escapar de
        // um bloqueio do próprio time só por estar em outro grupo.
        if let Some(value) = &doc.blocked_domains {
            let lista = merged.blocked_domains.get_or_insert_with(Vec::new);
            for domain in value {
                let clean = domain.trim().to_ascii_lowercase();
                if !clean.is_empty() && !lista.contains(&clean) {
                    lista.push(clean);
                }
            }
        }
    }
    if let Some(lista) = merged.blocked_domains.as_mut() {
        // Ordem estável: a política entra no etag e é ASSINADA — ordem
        // variável mudaria a assinatura sem nada ter mudado de fato.
        lista.sort();
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
pub(crate) async fn match_groups(
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
    Ok(rows.iter().map(|row| row.get::<Uuid, _>("id")).collect())
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
            agent_max_depth: 0,
            agent_max_children: 0,
            agent_max_total: 0,
            agent_role_models: BTreeMap::new(),
            agent_plugins: Vec::new(),
            user_plugins_allowed: false,
            code_mode_allowed: false,
            computer_use_allowed: false,
            blocked_domains: Vec::new(),
            prompt_master: prompt_master_for(state, workspace, &[]).await?,
            offline_grace_hours: 72,
        });
    }

    let module_rows =
        sqlx::query("SELECT group_id, mode FROM group_modules WHERE group_id = ANY($1)")
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
        .map(|row| serde_json::from_value(row.get::<Value, _>("document")).unwrap_or_default())
        .collect();
    let merged = merge_policies(&docs);

    Ok(EffectivePolicy {
        allowed_modes: union_modes(&sets),
        agent_tools: merged.agent_tools.unwrap_or(true),
        approval_policy: merged.approval_policy.unwrap_or_else(|| "ask".into()),
        byok_allowed: merged.byok_allowed.unwrap_or(true),
        local_runtime_allowed: merged.local_runtime_allowed.unwrap_or(true),
        effort_max: merged.effort_max.unwrap_or(4),
        agent_max_depth: merged.agent_max_depth.unwrap_or(DEFAULT_AGENT_DEPTH),
        agent_max_children: merged.agent_max_children.unwrap_or(DEFAULT_AGENT_CHILDREN),
        agent_max_total: merged.agent_max_total.unwrap_or(DEFAULT_AGENT_TOTAL),
        agent_role_models: merged.agent_role_models.unwrap_or_default(),
        agent_plugins: merged.agent_plugins.unwrap_or_default(),
        // Sem declaração explícita do admin, plugin de usuário fica FECHADO.
        user_plugins_allowed: merged.user_plugins_allowed.unwrap_or(false),
        // Idem para o code mode: o modelo dirigindo uma sequência de ações.
        code_mode_allowed: merged.code_mode_allowed.unwrap_or(false),
        // Sem declaração explícita do admin, computer use fica FECHADO.
        computer_use_allowed: merged.computer_use_allowed.unwrap_or(false),
        blocked_domains: merged.blocked_domains.unwrap_or_default(),
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
    let row =
        match row {
            Some(row) => Some(row),
            None => sqlx::query(
                "SELECT content, allow_local_append, local_max_chars, version FROM prompt_masters \
                 WHERE workspace_id=$1 AND group_id IS NULL",
            )
            .bind(workspace)
            .fetch_optional(&state.pool)
            .await?,
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
    if policy
        .allowed_modes
        .iter()
        .any(|allowed| allowed == mode.as_str())
    {
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
        let merged = merge_policies(&[
            doc(|d| d.effort_max = Some(4)),
            doc(|d| d.effort_max = Some(2)),
        ]);
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
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// Mensagem canônica assinada: JSON com chaves ordenadas (serde_json usa
/// BTreeMap por padrão) contendo APENAS issuedAt/expiresAt/profile/policy.
/// O cliente reconstrói os mesmos bytes a partir do corpo recebido.
pub fn signing_message(
    issued_at: &str,
    expires_at: &str,
    profile: &Value,
    policy: &Value,
) -> String {
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
        let message = signing_message(
            "2026-01-01T00:00:00Z",
            "2026-01-01T06:00:00Z",
            &serde_json::json!({"a":1}),
            &serde_json::json!({"b":2}),
        );
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
        let a = signing_message(
            "i",
            "e",
            &serde_json::json!({"z":1,"a":2}),
            &serde_json::json!({}),
        );
        assert!(a.find("\"a\":2").unwrap() < a.find("\"z\":1").unwrap());
    }
}

#[cfg(test)]
mod agent_policy_tests {
    use super::*;

    fn doc(json: Value) -> GroupPolicyDoc {
        serde_json::from_value(json).expect("documento de política")
    }

    /// União abre ACESSO; nunca abre GASTO. Quem está em dois grupos recebe o
    /// teto do mais restritivo — senão bastaria entrar num grupo permissivo
    /// para escapar do limite do próprio time.
    #[test]
    fn teto_de_agente_pega_o_menor_entre_os_grupos() {
        let merged = merge_policies(&[
            doc(json!({"agentMaxDepth": 4, "agentMaxChildren": 8, "agentMaxTotal": 40})),
            doc(json!({"agentMaxDepth": 1, "agentMaxChildren": 2, "agentMaxTotal": 6})),
        ]);
        assert_eq!(merged.agent_max_depth, Some(1));
        assert_eq!(merged.agent_max_children, Some(2));
        assert_eq!(merged.agent_max_total, Some(6));
    }

    #[test]
    fn ordem_dos_grupos_nao_muda_o_resultado() {
        let a = doc(json!({"agentMaxTotal": 30}));
        let b = doc(json!({"agentMaxTotal": 5}));
        assert_eq!(
            merge_policies(&[a.clone(), b.clone()]).agent_max_total,
            merge_policies(&[b, a]).agent_max_total
        );
    }

    #[test]
    fn grupo_que_nao_opina_nao_derruba_o_teto_do_outro() {
        let merged = merge_policies(&[doc(json!({"agentMaxDepth": 2})), doc(json!({"byokAllowed": true}))]);
        assert_eq!(merged.agent_max_depth, Some(2));
    }

    /// Zero é um valor VÁLIDO e significa "não delega" — não pode ser tratado
    /// como ausência e substituído pelo padrão.
    #[test]
    fn profundidade_zero_proibe_delegar_e_sobrevive_ao_merge() {
        let merged = merge_policies(&[doc(json!({"agentMaxDepth": 3})), doc(json!({"agentMaxDepth": 0}))]);
        assert_eq!(merged.agent_max_depth, Some(0));
    }

    #[test]
    fn computer_use_so_fica_ligado_se_todos_os_grupos_permitirem() {
        assert_eq!(
            merge_policies(&[
                doc(json!({"computerUseAllowed": true})),
                doc(json!({"computerUseAllowed": true}))
            ])
            .computer_use_allowed,
            Some(true)
        );
        // um único grupo que nega fecha para o usuário inteiro
        assert_eq!(
            merge_policies(&[
                doc(json!({"computerUseAllowed": true})),
                doc(json!({"computerUseAllowed": false}))
            ])
            .computer_use_allowed,
            Some(false)
        );
    }

    /// Executa comando na estação e depende de parecer de TI/SI: silêncio do
    /// admin NÃO pode significar liberado.
    #[test]
    fn computer_use_sem_declaracao_fica_fechado() {
        assert_eq!(merge_policies(&[doc(json!({}))]).computer_use_allowed, None);
        assert!(!open_policy().computer_use_allowed);
    }

    #[test]
    fn workspace_sem_gating_ainda_tem_tetos_de_agente() {
        let aberta = open_policy();
        assert_eq!(aberta.agent_max_depth, DEFAULT_AGENT_DEPTH);
        assert_eq!(aberta.agent_max_children, DEFAULT_AGENT_CHILDREN);
        assert_eq!(aberta.agent_max_total, DEFAULT_AGENT_TOTAL);
    }

    #[test]
    fn documento_antigo_sem_os_campos_novos_continua_valido() {
        // Política gravada antes desta mudança não pode quebrar a resolução.
        let antigo = doc(json!({"agentTools": true, "approvalPolicy": "edits", "effortMax": 2}));
        assert_eq!(antigo.agent_max_depth, None);
        assert_eq!(antigo.computer_use_allowed, None);
        let merged = merge_policies(&[antigo]);
        assert_eq!(merged.effort_max, Some(2));
        assert_eq!(merged.agent_max_total, None);
    }
}

#[cfg(test)]
mod blocklist_tests {
    use super::*;

    fn doc(json: Value) -> GroupPolicyDoc {
        serde_json::from_value(json).expect("documento de política")
    }

    /// União, e não interseção: alguém em dois grupos não pode escapar do
    /// bloqueio do próprio time só por pertencer a outro.
    #[test]
    fn blocklist_e_uniao_dos_grupos() {
        let merged = merge_policies(&[
            doc(json!({"blockedDomains": ["facebook.com"]})),
            doc(json!({"blockedDomains": ["tiktok.com"]})),
        ]);
        assert_eq!(
            merged.blocked_domains,
            Some(vec!["facebook.com".to_string(), "tiktok.com".to_string()])
        );
    }

    #[test]
    fn duplicata_e_caixa_nao_incham_a_lista() {
        let merged = merge_policies(&[
            doc(json!({"blockedDomains": ["Facebook.com", "  facebook.com  "]})),
            doc(json!({"blockedDomains": ["FACEBOOK.COM"]})),
        ]);
        assert_eq!(merged.blocked_domains, Some(vec!["facebook.com".to_string()]));
    }

    #[test]
    fn modelo_por_papel_vem_do_grupo_de_maior_prioridade() {
        // Os grupos chegam ordenados por prioridade: o primeiro que definir o
        // papel manda, e o segundo não sobrescreve.
        let merged = merge_policies(&[
            doc(json!({"agentRoleModels": {"idea": "opus 5", "code": "kimi 3"}})),
            doc(json!({"agentRoleModels": {"idea": "haiku 4.5", "review": "sonnet 5"}})),
        ]);
        let mapa = merged.agent_role_models.expect("mapa");
        assert_eq!(mapa.get("idea").map(String::as_str), Some("opus 5"));
        assert_eq!(mapa.get("code").map(String::as_str), Some("kimi 3"));
        // Papel que só o segundo grupo definiu entra normalmente.
        assert_eq!(mapa.get("review").map(String::as_str), Some("sonnet 5"));
    }

    #[test]
    fn papel_em_branco_ou_modelo_vazio_nao_entra() {
        let merged = merge_policies(&[doc(
            json!({"agentRoleModels": {"  ": "opus 5", "code": "   ", "REVIEW": "sonnet 5"}}),
        )]);
        let mapa = merged.agent_role_models.expect("mapa");
        assert_eq!(mapa.len(), 1);
        // A chave é normalizada em minúsculas — o papel vem do cliente.
        assert_eq!(mapa.get("review").map(String::as_str), Some("sonnet 5"));
    }

    #[test]
    fn plugin_de_usuario_fecha_no_grupo_mais_restritivo() {
        // Pertencer a um grupo que libera não desfaz o grupo que fecha.
        let merged = merge_policies(&[
            doc(json!({"userPluginsAllowed": true})),
            doc(json!({"userPluginsAllowed": false})),
        ]);
        assert_eq!(merged.user_plugins_allowed, Some(false));
    }

    #[test]
    fn code_mode_fecha_no_grupo_mais_restritivo() {
        let merged = merge_policies(&[
            doc(json!({"codeModeAllowed": true})),
            doc(json!({"codeModeAllowed": false})),
        ]);
        assert_eq!(merged.code_mode_allowed, Some(false));
    }

    #[test]
    fn code_mode_nasce_fechado_sem_declaracao() {
        assert_eq!(merge_policies(&[doc(json!({}))]).code_mode_allowed, None);
    }

    #[test]
    fn plugins_globais_sao_uniao_com_id_unico() {
        let merged = merge_policies(&[
            doc(json!({"agentPlugins": [{"id": "cep", "name": "CEP"}]})),
            doc(json!({"agentPlugins": [{"id": "cep", "name": "CEP duplicado"}, {"id": "erp", "name": "ERP"}]})),
        ]);
        let lista = merged.agent_plugins.expect("lista");
        assert_eq!(lista.len(), 2);
        // O primeiro grupo (maior prioridade) manda no id repetido.
        assert_eq!(lista[0]["name"], "CEP");
        assert_eq!(lista[1]["id"], "erp");
    }

    #[test]
    fn plugin_sem_id_nao_entra() {
        let merged = merge_policies(&[doc(json!({"agentPlugins": [{"name": "sem id"}, {"id": "  "}]}))]);
        assert_eq!(merged.agent_plugins, Some(vec![]));
    }

    #[test]
    fn sem_politica_o_mapa_de_papeis_fica_vazio() {
        assert_eq!(merge_policies(&[doc(json!({}))]).agent_role_models, None);
    }

    /// A política é ASSINADA: ordem instável mudaria a assinatura sem nada
    /// ter mudado, e o cliente managed recusaria a política do nada.
    #[test]
    fn ordem_e_estavel_independente_da_ordem_dos_grupos() {
        let a = doc(json!({"blockedDomains": ["zeta.com"]}));
        let b = doc(json!({"blockedDomains": ["alfa.com"]}));
        assert_eq!(
            merge_policies(&[a.clone(), b.clone()]).blocked_domains,
            merge_policies(&[b, a]).blocked_domains
        );
    }

    #[test]
    fn entrada_vazia_e_descartada() {
        let merged = merge_policies(&[doc(json!({"blockedDomains": ["", "   ", "ok.com"]}))]);
        assert_eq!(merged.blocked_domains, Some(vec!["ok.com".to_string()]));
    }

    #[test]
    fn nenhum_grupo_opinando_deixa_a_lista_vazia() {
        assert_eq!(merge_policies(&[doc(json!({}))]).blocked_domains, None);
        assert!(open_policy().blocked_domains.is_empty());
    }
}
