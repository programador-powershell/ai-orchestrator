mod admin;
mod auth;
mod config;
mod crypto;
mod error;
mod finetune;
mod models;
mod policy;
mod providers;
mod routes;
mod state;

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
        );

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
    tracing::info!(address=%config.bind,"AI Orchestrator gateway listening");
    axum::serve(listener, app).await?;
    Ok(())
}
