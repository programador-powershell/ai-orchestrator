//! Canal bidirecional do harness.
//!
//! Antes existia só SSE, de mão única: o servidor empurrava tokens e o cliente
//! não tinha por onde responder. Aprovar uma ferramenta, empurrar o log local,
//! cancelar um run — tudo isso precisava de uma requisição HTTP separada, e
//! nada disso sobrevivia a uma reconexão sem buraco no meio.
//!
//! ## Autenticação NÃO vai na URL
//!
//! O `WebSocket` do navegador não deixa definir cabeçalho, e a saída comum é
//! `?token=…`. Aqui não: query string entra em log de acesso, em proxy e no
//! histórico — é o lugar errado para um bearer. A conexão abre anônima e a
//! PRIMEIRA mensagem tem de ser `auth`; sem ela, o servidor fecha em
//! [`AUTH_TIMEOUT`]. O token trafega no corpo do frame, dentro do TLS.
//!
//! ## Retomada por cursor
//!
//! `subscribe { runId, fromSeq }` faz replay do Postgres a partir do cursor e
//! só então entra no vivo. É o que transforma "caiu a rede" em "perdi 3
//! segundos" em vez de "perdi o meio do run".
//!
//! A inscrição no vivo acontece ANTES do replay, de propósito: na ordem
//! inversa, um evento publicado entre o fim do replay e a inscrição sumiria.
//! O preço é evento repetido na virada, que é inofensivo — o cliente já
//! precisa deduplicar por `seq` para o replay funcionar.
//!
//! ## Fanout
//!
//! O caminho é único: `publish` grava no Redis, uma ÚNICA tarefa por instância
//! (`hub_task`) escuta `run:*` e reparte para as conexões locais. Publicar
//! também direto no hub economizaria um salto e entregaria cada evento duas
//! vezes para quem estivesse na mesma instância.

use crate::{
    error::ApiError,
    routes::{require_role, user_id},
    runs::{self, RunEventInput},
    state::AppState,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::Duration,
};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Prazo para o frame `auth`. Conexão que não se identifica é fechada.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Runs simultâneos por conexão. Teto para não virar assinatura do workspace
/// inteiro a partir de um socket.
const MAX_SUBSCRIPTIONS: usize = 16;
/// Capacidade do canal por run. Cliente lento perde a janela e recebe
/// `lagged` — o tratamento é reconectar com o cursor, não crescer o buffer.
const CHANNEL_CAPACITY: usize = 256;
const MEMBER: i16 = 1;

/* --------------------------------- Hub -------------------------------- */

/// Distribuidor em processo: um canal por run, criado sob demanda.
#[derive(Default)]
pub struct Hub {
    channels: Mutex<HashMap<Uuid, broadcast::Sender<String>>>,
}

impl Hub {
    pub fn subscribe(&self, run: Uuid) -> broadcast::Receiver<String> {
        let mut channels = match self.channels.lock() {
            Ok(guard) => guard,
            // Lock envenenado não pode derrubar o socket: entrega um canal
            // órfão (só replay funciona) em vez de encerrar a conexão.
            Err(poisoned) => poisoned.into_inner(),
        };
        channels
            .entry(run)
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .subscribe()
    }

    /// Entrega a quem estiver ouvindo. Zero ouvintes não é erro.
    pub fn broadcast(&self, run: Uuid, payload: String) {
        let mut channels = match self.channels.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(sender) = channels.get(&run) {
            if sender.send(payload).is_err() {
                // Último ouvinte saiu: o canal não serve mais para nada e ficar
                // no mapa seria vazamento por run visitado.
                channels.remove(&run);
            }
        }
    }
}

/// Ponte Redis → hub. Uma por instância do gateway, iniciada no `main`.
///
/// Reconecta sozinha: sem isto, um restart do Redis mataria o tempo real até o
/// próximo deploy do gateway, e ninguém perceberia — os dados continuariam
/// chegando no Postgres.
pub async fn hub_task(state: AppState) {
    loop {
        match run_bridge(&state).await {
            Ok(()) => tracing::warn!("ponte de eventos do Redis encerrou; reconectando"),
            Err(error) => tracing::warn!(error = %error, "ponte de eventos do Redis falhou"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn run_bridge(state: &AppState) -> anyhow::Result<()> {
    let mut pubsub = state.redis.get_async_pubsub().await?;
    pubsub.psubscribe("run:*").await?;
    let mut stream = pubsub.on_message();
    while let Some(message) = stream.next().await {
        let channel: String = message.get_channel_name().to_string();
        let Some(id) = channel.strip_prefix("run:") else {
            continue;
        };
        let Ok(run) = Uuid::parse_str(id) else {
            continue;
        };
        let Ok(payload) = message.get_payload::<String>() else {
            continue;
        };
        state.hub.broadcast(run, payload);
    }
    Ok(())
}

/* ------------------------------ Protocolo ----------------------------- */

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Incoming {
    Auth {
        token: String,
    },
    Subscribe {
        run_id: Uuid,
        #[serde(default)]
        from_seq: Option<i64>,
    },
    Unsubscribe {
        run_id: Uuid,
    },
    /// Sincronização local-first pelo próprio socket, sem POST separado.
    Events {
        run_id: Uuid,
        events: Vec<RunEventInput>,
    },
    Decide {
        approval_id: Uuid,
        approved: bool,
    },
    Cancel {
        run_id: Uuid,
    },
    Ping,
}

fn frame(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

fn erro(code: &str, message: impl AsRef<str>) -> Message {
    frame(json!({ "type": "error", "code": code, "message": message.as_ref() }))
}

/* ------------------------------- Handler ------------------------------ */

pub async fn handler(
    State(state): State<AppState>,
    Path(workspace): Path<Uuid>,
    _headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| session(state, workspace, socket))
}

async fn session(state: AppState, workspace: Uuid, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // ---- 1) autenticação, com prazo ----
    let identidade = match tokio::time::timeout(AUTH_TIMEOUT, async {
        while let Some(Ok(message)) = stream.next().await {
            let Message::Text(text) = message else { continue };
            let Ok(Incoming::Auth { token }) = serde_json::from_str::<Incoming>(&text) else {
                return None;
            };
            return Some(token);
        }
        None
    })
    .await
    {
        Ok(Some(token)) => token,
        _ => {
            let _ = sink
                .send(erro("AUTH_REQUIRED", "primeira mensagem deve ser auth"))
                .await;
            return;
        }
    };

    let mut headers = HeaderMap::new();
    let valor = if identidade.starts_with("Bearer ") {
        identidade.clone()
    } else {
        format!("Bearer {identidade}")
    };
    if let Ok(header) = valor.parse() {
        headers.insert(axum::http::header::AUTHORIZATION, header);
    }
    let caller = match state.auth.identity(&headers).await {
        Ok(caller) => caller,
        Err(_) => {
            let _ = sink.send(erro("UNAUTHORIZED", "token inválido")).await;
            return;
        }
    };
    let user = match user_id(&state, &caller).await {
        Ok(user) => user,
        Err(_) => {
            let _ = sink.send(erro("UNAUTHORIZED", "usuário não resolvido")).await;
            return;
        }
    };
    if require_role(&state, user, workspace, MEMBER).await.is_err() {
        let _ = sink.send(erro("FORBIDDEN", "sem acesso a este workspace")).await;
        return;
    }
    if sink
        .send(frame(json!({ "type": "hello", "userId": user, "workspace": workspace })))
        .await
        .is_err()
    {
        return;
    }

    // ---- 2) laço principal ----
    //
    // As entregas do hub e as mensagens do cliente chegam por caminhos
    // independentes; um canal interno junta os dois para haver UM escritor no
    // sink (dois escritores intercalariam frames pela metade).
    let (saida, mut saida_rx) = tokio::sync::mpsc::channel::<Message>(64);
    let escritor = tokio::spawn(async move {
        while let Some(message) = saida_rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let mut inscricoes: HashMap<Uuid, tokio::task::JoinHandle<()>> = HashMap::new();

    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let comando = match serde_json::from_str::<Incoming>(&text) {
            Ok(comando) => comando,
            Err(error) => {
                let _ = saida.send(erro("BAD_FRAME", error.to_string())).await;
                continue;
            }
        };

        match comando {
            Incoming::Auth { .. } => {
                let _ = saida.send(erro("ALREADY_AUTHED", "conexão já autenticada")).await;
            }
            Incoming::Ping => {
                let _ = saida.send(frame(json!({ "type": "pong" }))).await;
            }
            Incoming::Subscribe { run_id, from_seq } => {
                if inscricoes.len() >= MAX_SUBSCRIPTIONS && !inscricoes.contains_key(&run_id) {
                    let _ = saida
                        .send(erro(
                            "TOO_MANY_SUBSCRIPTIONS",
                            format!("teto de {MAX_SUBSCRIPTIONS} runs por conexão"),
                        ))
                        .await;
                    continue;
                }
                if runs::run_guard(&state, workspace, run_id).await.is_err() {
                    let _ = saida.send(erro("RUN_NOT_FOUND", "run inexistente neste workspace")).await;
                    continue;
                }

                // Vivo ANTES do replay — ver o cabeçalho do módulo.
                let mut receiver = state.hub.subscribe(run_id);
                let envio = saida.clone();
                if let Some(anterior) = inscricoes.remove(&run_id) {
                    anterior.abort();
                }
                inscricoes.insert(
                    run_id,
                    tokio::spawn(async move {
                        loop {
                            match receiver.recv().await {
                                Ok(payload) => {
                                    if envio.send(Message::Text(payload.into())).await.is_err() {
                                        break;
                                    }
                                }
                                // Cliente lento: avisa e deixa ELE decidir
                                // reconectar com o cursor. Fingir que não
                                // houve perda daria um log com buraco.
                                Err(broadcast::error::RecvError::Lagged(perdidos)) => {
                                    let aviso = json!({
                                        "type": "lagged",
                                        "runId": run_id,
                                        "dropped": perdidos,
                                    });
                                    if envio.send(frame(aviso)).await.is_err() {
                                        break;
                                    }
                                }
                                Err(broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    }),
                );

                match replay(&state, run_id, from_seq.unwrap_or(0)).await {
                    Ok(lote) => {
                        let _ = saida.send(frame(lote)).await;
                    }
                    Err(_) => {
                        let _ = saida.send(erro("REPLAY_FAILED", "falha ao ler o log do run")).await;
                    }
                }
            }
            Incoming::Unsubscribe { run_id } => {
                if let Some(tarefa) = inscricoes.remove(&run_id) {
                    tarefa.abort();
                }
                let _ = saida
                    .send(frame(json!({ "type": "unsubscribed", "runId": run_id })))
                    .await;
            }
            Incoming::Events { run_id, events } => {
                if runs::run_guard(&state, workspace, run_id).await.is_err() {
                    let _ = saida.send(erro("RUN_NOT_FOUND", "run inexistente neste workspace")).await;
                    continue;
                }
                match runs::ingest(&state, run_id, &events).await {
                    Ok((aceitos, last_seq)) => {
                        // O `ack` é o que permite o cliente avançar o cursor
                        // dele com segurança: até receber isto, o evento só
                        // existe na estação.
                        let _ = saida
                            .send(frame(json!({
                                "type": "ack",
                                "runId": run_id,
                                "accepted": aceitos,
                                "lastSeq": last_seq,
                            })))
                            .await;
                        let _ = crate::executor::advance(&state, run_id).await;
                        runs::publish(&state, run_id, &events).await;
                    }
                    Err(error) => {
                        let _ = saida.send(erro("INGEST_FAILED", error.to_string())).await;
                    }
                }
            }
            Incoming::Decide {
                approval_id,
                approved,
            } => match decide(&state, workspace, user, approval_id, approved).await {
                Ok(status) => {
                    let _ = saida
                        .send(frame(json!({
                            "type": "decided",
                            "approvalId": approval_id,
                            "status": status,
                        })))
                        .await;
                }
                Err(error) => {
                    let _ = saida.send(erro("DECIDE_FAILED", error.to_string())).await;
                }
            },
            Incoming::Cancel { run_id } => {
                if runs::run_guard(&state, workspace, run_id).await.is_err() {
                    let _ = saida.send(erro("RUN_NOT_FOUND", "run inexistente neste workspace")).await;
                    continue;
                }
                let seq = runs::next_seq(&state, run_id).await.unwrap_or(1);
                let evento = RunEventInput {
                    seq,
                    kind: "run:cancel".into(),
                    node_id: None,
                    payload: Some(json!({ "by": user })),
                };
                if runs::ingest(&state, run_id, std::slice::from_ref(&evento))
                    .await
                    .is_ok()
                {
                    let _ = crate::executor::advance(&state, run_id).await;
                    runs::publish(&state, run_id, std::slice::from_ref(&evento)).await;
                }
            }
        }
    }

    for (_, tarefa) in inscricoes {
        tarefa.abort();
    }
    drop(saida);
    let _ = escritor.await;
}

async fn replay(state: &AppState, run: Uuid, from_seq: i64) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT seq, ts, kind, node_id, payload FROM run_events \
         WHERE run_id=$1 AND seq > $2 ORDER BY seq ASC LIMIT 1000",
    )
    .bind(run)
    .bind(from_seq.max(0))
    .fetch_all(&state.pool)
    .await?;
    use sqlx::Row;
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
    Ok(json!({ "type": "replay", "runId": run, "events": items }))
}

async fn decide(
    state: &AppState,
    workspace: Uuid,
    user: Uuid,
    approval: Uuid,
    approved: bool,
) -> Result<String, ApiError> {
    let alvo = if approved { "approved" } else { "denied" };
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
    use sqlx::Row;
    let Some(row) = row else {
        let atual: Option<String> = sqlx::query_scalar(
            "SELECT a.status FROM run_approvals a JOIN runs r ON r.id=a.run_id \
             WHERE a.id=$1 AND r.workspace_id=$2",
        )
        .bind(approval)
        .bind(workspace)
        .fetch_optional(&state.pool)
        .await?;
        return atual.ok_or(ApiError::NotFound);
    };
    let run: Uuid = row.try_get("run_id")?;
    let status: String = row.try_get("status")?;
    let seq = runs::next_seq(state, run).await?;
    let evento = RunEventInput {
        seq,
        kind: "approval:decided".into(),
        node_id: None,
        payload: Some(json!({ "approvalId": approval, "status": status, "decidedBy": user })),
    };
    runs::ingest(state, run, std::slice::from_ref(&evento)).await?;
    crate::executor::advance(state, run).await?;
    runs::publish(state, run, std::slice::from_ref(&evento)).await;
    Ok(status)
}
