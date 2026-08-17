mod admin;
mod agent_audit;
mod analytics;
mod auth;
mod config;
mod crypto;
mod error;
mod executor;
mod finetune;
mod models;
mod policy;
mod providers;
mod routes;
mod runs;
mod state;
mod usage;
mod ws;

use axum::{
    extract::DefaultBodyLimit,
    routing::{get, patch, post},
    Router,
};
use config::Config;
use sqlx::postgres::PgPoolOptions;
use state::AppState;
use std::time::Duration;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let redis = redis::Client::open(config.redis_url.clone())?;
    let state = AppState::new(config.clone(), pool, redis);
    // Reconciliador de fine-tuning: sincroniza jobs não-terminais em background.
    tokio::spawn(finetune::reconciler(state.clone()));
    // Ponte Redis → hub: uma por instância, alimenta todos os WebSockets desta
    // instância com os eventos publicados por qualquer uma (ver ws.rs).
    tokio::spawn(ws::hub_task(state.clone()));

    let api = Router::new()
        .route("/auth/config", get(routes::oidc_config))
        .route("/auth/token", post(routes::oidc_token))
        .route("/auth/refresh", post(routes::oidc_refresh))
        .route("/me", get(routes::me))
        .route("/bootstrap", get(routes::bootstrap))
        .route(
            "/workspaces/{workspace}/admin/groups",
            get(admin::groups_list).post(admin::groups_create),
        )
        .route(
            "/workspaces/{workspace}/admin/groups/{group}",
            patch(admin::groups_update).delete(admin::groups_delete),
        )
        .route(
            "/workspaces/{workspace}/admin/prompt-master",
            get(admin::prompt_master_get).put(admin::prompt_master_put),
        )
        // Relatoria: uso e custo por usuário, grupo, modelo e dia.
        .route(
            "/workspaces/{workspace}/admin/usage/users",
            get(analytics::usage_by_user),
        )
        .route(
            "/workspaces/{workspace}/admin/usage/groups",
            get(analytics::usage_by_group),
        )
        .route(
            "/workspaces/{workspace}/admin/usage/models",
            get(analytics::usage_by_model),
        )
        .route(
            "/workspaces/{workspace}/admin/usage/daily",
            get(analytics::usage_daily),
        )
        .route(
            "/workspaces/{workspace}/admin/prices",
            get(analytics::prices_list).put(analytics::price_put),
        )
        .route(
            "/workspaces/{workspace}/admin/prices/{model}",
            axum::routing::delete(analytics::price_delete),
        )
        // Trilha de auditoria: gravar é do membro (quem executa registra),
        // ler é do admin (não é informação para colega ver).
        .route(
            "/workspaces/{workspace}/agent-actions",
            post(agent_audit::record_action),
        )
        .route(
            "/workspaces/{workspace}/admin/agent-actions",
            get(agent_audit::list_actions),
        )
        .route("/workspaces", get(routes::workspaces))
        .route(
            "/workspaces/{workspace}/routing",
            get(routes::routing_get).patch(routes::routing_patch),
        )
        .route(
            "/workspaces/{workspace}/providers",
            get(routes::providers_list).post(routes::providers_create),
        )
        .route(
            "/workspaces/{workspace}/providers/{provider}",
            patch(routes::providers_update).delete(routes::providers_delete),
        )
        .route(
            "/workspaces/{workspace}/chat/completions",
            post(routes::chat),
        )
        .route(
            "/workspaces/{workspace}/images/generations",
            post(routes::images),
        )
        .route(
            "/workspaces/{workspace}/embeddings",
            post(routes::embeddings),
        )
        .route(
            "/workspaces/{workspace}/design/replications",
            post(routes::design_replication),
        )
        .route(
            "/workspaces/{workspace}/orchestrations/validate",
            post(routes::orchestration_validate),
        )
        .route(
            "/workspaces/{workspace}/finetune/datasets",
            post(finetune::dataset_upload).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route(
            "/workspaces/{workspace}/finetune/jobs",
            get(finetune::jobs_list).post(finetune::job_create),
        )
        .route(
            "/workspaces/{workspace}/finetune/jobs/{job}",
            get(finetune::job_get),
        )
        .route(
            "/workspaces/{workspace}/finetune/jobs/{job}/events",
            get(finetune::job_events),
        )
        .route(
            "/workspaces/{workspace}/finetune/jobs/{job}/events/stream",
            get(finetune::job_events_stream),
        )
        .route(
            "/workspaces/{workspace}/finetune/jobs/{job}/cancel",
            post(finetune::job_cancel),
        )
        .route(
            "/workspaces/{workspace}/finetune/models",
            get(finetune::models_list),
        )
        // ---- Sessões e runs duráveis (espinha do harness) ----
        .route(
            "/workspaces/{workspace}/sessions",
            get(runs::sessions_list).post(runs::session_create),
        )
        .route("/workspaces/{workspace}/runs", post(runs::run_create))
        .route("/workspaces/{workspace}/runs/{run}", get(runs::run_get))
        .route(
            "/workspaces/{workspace}/runs/{run}/events",
            get(runs::run_events_get).post(runs::run_events_post),
        )
        .route(
            "/workspaces/{workspace}/runs/{run}/approvals",
            get(runs::approvals_pending),
        )
        .route(
            "/workspaces/{workspace}/approvals",
            post(runs::approval_ask),
        )
        .route(
            "/workspaces/{workspace}/approvals/{approval}",
            post(runs::approval_decide),
        )
        // Canal bidirecional. Autentica pelo PRIMEIRO frame, não por query
        // string — bearer em URL entra em log de acesso e proxy (ver ws.rs).
        .route("/workspaces/{workspace}/ws", get(ws::handler));

    let request_id = axum::http::HeaderName::from_static("x-request-id");
    let app = Router::new()
        .route("/health", get(routes::health))
        .route("/metrics", get(routes::metrics))
        .nest("/v1", api)
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list([
                    "tauri://localhost".parse()?,
                    "http://tauri.localhost".parse()?,
                ]))
                .allow_headers([
                    axum::http::header::AUTHORIZATION,
                    axum::http::header::CONTENT_TYPE,
                    axum::http::header::ACCEPT,
                ])
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::PATCH,
                    axum::http::Method::DELETE,
                ]),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!(address=%config.bind,"AI-BOT gateway listening");
    axum::serve(listener, app).await?;
    Ok(())
}
