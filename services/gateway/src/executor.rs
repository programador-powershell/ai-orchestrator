//! Máquina de estados do run — o que faltava para `/orchestrations/validate`
//! deixar de ser um cálculo e virar execução.
//!
//! ## Por que o estado é DERIVADO do log, e não guardado por nó
//!
//! Uma tabela `run_nodes` com o status de cada nó pareceria mais direta e seria
//! a fonte de uma classe de bug conhecida: dois escritores (o cliente que
//! executa e o servidor que reage) atualizando a mesma linha, com o último a
//! gravar ganhando. O log de eventos já é append-only e idempotente; reduzir o
//! log ao estado é uma função pura, sempre chega no mesmo resultado, e vale
//! para replay tanto quanto para tempo real. Não há linha para dois donos
//! disputarem.
//!
//! ## O que o gateway NÃO consegue executar
//!
//! Nó que toca o repositório (ler, gravar, rodar comando) roda na ESTAÇÃO —
//! o disco é de lá. O servidor não tem como executá-lo, e finge nada: ele
//! agenda, cobra retry, decide o status do run e marca quando o run está
//! parado esperando alguém. Um executor de servidor que tentasse gravar
//! arquivo do usuário seria uma promessa que o modelo de segurança não
//! sustenta.

use crate::{
    error::ApiError,
    models::OrchestrationGraph,
    state::AppState,
};
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Tentativas por nó antes de o run ser considerado perdido.
///
/// Três é o que o cliente já anunciava em `config.retries` do grafo; aqui é o
/// teto que o servidor cobra, para um cliente que não respeite o próprio.
pub const MAX_ATTEMPTS: u32 = 3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NodeStatus {
    #[default]
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NodeState {
    pub status: NodeStatus,
    /// Quantas vezes o nó COMEÇOU. É o contador de retry.
    pub attempts: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStatus {
    Pending,
    Running,
    /// Nada rodando, nada pronto, e não terminou — espera humano ou aprovação.
    Paused,
    Succeeded,
    Failed,
    Canceled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

/// Um evento reduzido ao que a máquina de estados precisa.
#[derive(Clone, Debug)]
pub struct Marker {
    pub kind: String,
    pub node_id: String,
}

/// Reduz o log ao estado dos nós. Função pura — é o coração testável.
///
/// Nós citados no log mas ausentes do grafo são ignorados: o grafo é o
/// contrato, e um evento órfão (de um grafo editado entre runs) não deve
/// inventar nó.
pub fn reduce(graph: &OrchestrationGraph, markers: &[Marker]) -> BTreeMap<String, NodeState> {
    let mut states: BTreeMap<String, NodeState> = graph
        .nodes
        .iter()
        .map(|node| (node.id.clone(), NodeState::default()))
        .collect();
    for marker in markers {
        let Some(state) = states.get_mut(&marker.node_id) else {
            continue;
        };
        match marker.kind.as_str() {
            "node:start" => {
                state.status = NodeStatus::Running;
                state.attempts += 1;
            }
            "node:done" => state.status = NodeStatus::Done,
            "node:fail" => state.status = NodeStatus::Failed,
            _ => {}
        }
    }
    states
}

/// `true` se o log contém um cancelamento — decisão humana, vence tudo.
pub fn canceled(markers: &[Marker]) -> bool {
    markers.iter().any(|marker| marker.kind == "run:cancel")
}

/// Nós que podem começar agora, respeitando `maxConcurrency`.
///
/// Inclui nó que FALHOU e ainda tem tentativa — retry é "voltar para a fila",
/// não um caminho separado.
pub fn ready(graph: &OrchestrationGraph, states: &BTreeMap<String, NodeState>) -> Vec<String> {
    let rodando = states
        .values()
        .filter(|state| state.status == NodeStatus::Running)
        .count();
    let teto = graph.max_concurrency.max(1);
    let vagas = teto.saturating_sub(rodando);
    if vagas == 0 {
        return Vec::new();
    }
    let mut prontos = Vec::new();
    for node in &graph.nodes {
        let Some(state) = states.get(&node.id) else {
            continue;
        };
        let elegivel = match state.status {
            NodeStatus::Pending => true,
            NodeStatus::Failed => state.attempts < MAX_ATTEMPTS,
            _ => false,
        };
        if !elegivel {
            continue;
        }
        // Dependência tem de estar CONCLUÍDA. `Failed` retryable não libera o
        // dependente: liberar seria deixar o nó de baixo rodar sobre a saída
        // que nunca existiu.
        let liberado = node
            .depends_on
            .iter()
            .all(|dep| states.get(dep).map(|d| d.status == NodeStatus::Done).unwrap_or(false));
        if liberado {
            prontos.push(node.id.clone());
            if prontos.len() >= vagas {
                break;
            }
        }
    }
    prontos
}

/// Status do run derivado do estado dos nós.
pub fn derive_status(graph: &OrchestrationGraph, markers: &[Marker]) -> RunStatus {
    if canceled(markers) {
        return RunStatus::Canceled;
    }
    let states = reduce(graph, markers);
    if states.is_empty() {
        return RunStatus::Pending;
    }
    // Falha esgotada é terminal: sem tentativa restante, nada abaixo do nó
    // roda, e deixar o run em "running" seria pendurá-lo para sempre.
    if states
        .values()
        .any(|state| state.status == NodeStatus::Failed && state.attempts >= MAX_ATTEMPTS)
    {
        return RunStatus::Failed;
    }
    if states.values().all(|state| state.status == NodeStatus::Done) {
        return RunStatus::Succeeded;
    }
    if states.values().any(|state| state.status == NodeStatus::Running) {
        return RunStatus::Running;
    }
    let comecou = states.values().any(|state| state.attempts > 0);
    if !ready(graph, &states).is_empty() {
        return if comecou { RunStatus::Running } else { RunStatus::Pending };
    }
    // Nada rodando, nada pronto, e não acabou: alguém precisa agir. É o caso
    // da aprovação pendente e do nó `human`.
    RunStatus::Paused
}

/* --------------------------- Lado do banco ---------------------------- */

async fn markers_of(state: &AppState, run: Uuid) -> Result<Vec<Marker>, ApiError> {
    let rows = sqlx::query(
        "SELECT kind, node_id FROM run_events WHERE run_id=$1 \
           AND kind IN ('node:start','node:done','node:fail','run:cancel') ORDER BY seq ASC",
    )
    .bind(run)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| Marker {
            kind: row.get::<String, _>("kind"),
            node_id: row.get::<String, _>("node_id"),
        })
        .collect())
}

/// Recalcula o status do run a partir do log e grava se mudou.
///
/// Chamada após cada ingest. Idempotente: rodar duas vezes com o mesmo log não
/// produz evento novo, porque só grava na TRANSIÇÃO.
pub async fn advance(state: &AppState, run: Uuid) -> Result<RunStatus, ApiError> {
    let row = sqlx::query("SELECT graph, status FROM runs WHERE id=$1")
        .bind(run)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::NotFound)?;
    let graph: OrchestrationGraph = serde_json::from_value(row.get::<Value, _>("graph"))
        .map_err(|error| ApiError::Internal(anyhow::anyhow!("grafo persistido ilegível: {error}")))?;
    let anterior: String = row.get("status");

    // Run já terminal não volta a andar. Sem esta guarda, um evento atrasado
    // chegando depois do fim reabriria um run concluído.
    if matches!(anterior.as_str(), "succeeded" | "failed" | "canceled") {
        return Ok(match anterior.as_str() {
            "succeeded" => RunStatus::Succeeded,
            "failed" => RunStatus::Failed,
            _ => RunStatus::Canceled,
        });
    }

    let markers = markers_of(state, run).await?;
    let novo = derive_status(&graph, &markers);
    if novo.as_str() == anterior {
        return Ok(novo);
    }

    sqlx::query(
        "UPDATE runs SET status=$2, updated_at=now(), \
           started_at = CASE WHEN started_at IS NULL AND $2 <> 'pending' THEN now() ELSE started_at END, \
           finished_at = CASE WHEN $3 THEN now() ELSE finished_at END \
         WHERE id=$1",
    )
    .bind(run)
    .bind(novo.as_str())
    .bind(novo.terminal())
    .execute(&state.pool)
    .await?;

    // A transição entra no log: quem faz replay vê a mudança de status na
    // posição em que ela aconteceu, não só o valor final na tabela.
    let seq = crate::runs::next_seq(state, run).await?;
    let evento = crate::runs::RunEventInput {
        seq,
        kind: "run:status".into(),
        node_id: None,
        payload: Some(json!({ "from": anterior, "to": novo.as_str() })),
    };
    crate::runs::ingest(state, run, std::slice::from_ref(&evento)).await?;
    crate::runs::publish(state, run, std::slice::from_ref(&evento)).await;
    Ok(novo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{OrchestrationNode, OrchestrationNodeKind};

    fn node(id: &str, deps: &[&str]) -> OrchestrationNode {
        OrchestrationNode {
            id: id.into(),
            name: id.into(),
            kind: OrchestrationNodeKind::Agent,
            mode: None,
            depends_on: deps.iter().map(|d| (*d).to_string()).collect(),
            config: Value::Null,
        }
    }

    fn graph(nodes: Vec<OrchestrationNode>, max_concurrency: usize) -> OrchestrationGraph {
        OrchestrationGraph {
            schema_version: 1,
            name: "teste".into(),
            max_concurrency,
            nodes,
        }
    }

    fn mark(kind: &str, node: &str) -> Marker {
        Marker {
            kind: kind.into(),
            node_id: node.into(),
        }
    }

    fn cadeia() -> OrchestrationGraph {
        graph(vec![node("a", &[]), node("b", &["a"]), node("c", &["b"])], 4)
    }

    #[test]
    fn log_vazio_deixa_todos_pendentes_e_libera_so_a_raiz() {
        let g = cadeia();
        let states = reduce(&g, &[]);
        assert!(states.values().all(|s| s.status == NodeStatus::Pending));
        assert_eq!(ready(&g, &states), vec!["a".to_string()]);
        assert_eq!(derive_status(&g, &[]), RunStatus::Pending);
    }

    #[test]
    fn dependente_nao_libera_enquanto_a_dependencia_nao_conclui() {
        let g = cadeia();
        let markers = vec![mark("node:start", "a")];
        let states = reduce(&g, &markers);
        // `a` está rodando: `b` continua preso, e o run está running.
        assert!(ready(&g, &states).is_empty());
        assert_eq!(derive_status(&g, &markers), RunStatus::Running);
    }

    #[test]
    fn conclusao_libera_o_proximo() {
        let g = cadeia();
        let markers = vec![mark("node:start", "a"), mark("node:done", "a")];
        let states = reduce(&g, &markers);
        assert_eq!(ready(&g, &states), vec!["b".to_string()]);
        assert_eq!(derive_status(&g, &markers), RunStatus::Running);
    }

    #[test]
    fn todos_concluidos_e_sucesso() {
        let g = cadeia();
        let markers = vec![
            mark("node:start", "a"),
            mark("node:done", "a"),
            mark("node:start", "b"),
            mark("node:done", "b"),
            mark("node:start", "c"),
            mark("node:done", "c"),
        ];
        assert_eq!(derive_status(&g, &markers), RunStatus::Succeeded);
    }

    #[test]
    fn falha_com_tentativa_restante_volta_para_a_fila() {
        let g = cadeia();
        let markers = vec![mark("node:start", "a"), mark("node:fail", "a")];
        let states = reduce(&g, &markers);
        assert_eq!(states["a"].attempts, 1);
        // Retry é voltar para a fila, não caminho separado.
        assert_eq!(ready(&g, &states), vec!["a".to_string()]);
        assert_eq!(derive_status(&g, &markers), RunStatus::Running);
    }

    #[test]
    fn falha_com_tentativas_esgotadas_derruba_o_run() {
        let g = cadeia();
        let mut markers = Vec::new();
        for _ in 0..MAX_ATTEMPTS {
            markers.push(mark("node:start", "a"));
            markers.push(mark("node:fail", "a"));
        }
        let states = reduce(&g, &markers);
        assert_eq!(states["a"].attempts, MAX_ATTEMPTS);
        assert!(ready(&g, &states).is_empty());
        // Pendurar em "running" para sempre seria o pior desfecho: ninguém
        // sabe que acabou e nada abaixo do nó vai rodar.
        assert_eq!(derive_status(&g, &markers), RunStatus::Failed);
    }

    #[test]
    fn max_concurrency_limita_quantos_liberam_de_uma_vez() {
        let g = graph(
            vec![node("a", &[]), node("b", &[]), node("c", &[]), node("d", &[])],
            2,
        );
        let states = reduce(&g, &[]);
        assert_eq!(ready(&g, &states), vec!["a".to_string(), "b".to_string()]);

        // Com um já rodando sobra uma vaga só.
        let markers = vec![mark("node:start", "a")];
        let states = reduce(&g, &markers);
        assert_eq!(ready(&g, &states), vec!["b".to_string()]);
    }

    #[test]
    fn max_concurrency_zero_nao_trava_o_run() {
        // Grafo com `maxConcurrency: 0` liberaria zero vagas para sempre.
        // Tratar como 1 mantém o run andando em vez de morrer em silêncio.
        let g = graph(vec![node("a", &[])], 0);
        let states = reduce(&g, &[]);
        assert_eq!(ready(&g, &states), vec!["a".to_string()]);
    }

    #[test]
    fn cancelamento_vence_qualquer_estado() {
        let g = cadeia();
        let markers = vec![
            mark("node:start", "a"),
            mark("node:done", "a"),
            mark("run:cancel", ""),
        ];
        assert_eq!(derive_status(&g, &markers), RunStatus::Canceled);
        assert!(RunStatus::Canceled.terminal());
    }

    #[test]
    fn nada_rodando_e_nada_pronto_e_pausa_nao_sucesso() {
        // Nó humano que ninguém iniciou: `b` depende de `a`, `a` está pendente
        // e a concorrência já foi consumida por um nó rodando fora do grafo?
        // O caso real é aprovação pendente — o nó começou, não terminou nem
        // falhou, e o log não tem mais nada. Aqui: `a` concluído, `b` falhou
        // sem tentativa restante seria Failed; então montamos o caso de
        // dependência insatisfeita permanente sem falha registrada.
        let g = graph(vec![node("a", &["ausente"]), node("b", &["a"])], 4);
        // `ausente` não existe no grafo, então `a` nunca libera.
        assert_eq!(derive_status(&g, &[]), RunStatus::Paused);
    }

    #[test]
    fn evento_de_no_fora_do_grafo_e_ignorado() {
        let g = cadeia();
        let markers = vec![mark("node:done", "fantasma"), mark("node:start", "a")];
        let states = reduce(&g, &markers);
        assert_eq!(states.len(), 3);
        assert!(!states.contains_key("fantasma"));
        assert_eq!(states["a"].status, NodeStatus::Running);
    }

    #[test]
    fn grafo_sem_no_fica_pendente_em_vez_de_sucesso_vazio() {
        // `all()` sobre coleção vazia é `true`: sem esta guarda um grafo sem nó
        // seria reportado como "succeeded" sem ter executado nada.
        let g = graph(vec![], 4);
        assert_eq!(derive_status(&g, &[]), RunStatus::Pending);
    }
}
