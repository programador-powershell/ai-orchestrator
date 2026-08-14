use crate::{auth::AuthService, config::Config, crypto::SecretBox, providers::ProviderClient};
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Default)]
pub struct Metrics {
    requests: AtomicU64,
    provider_failures: AtomicU64,
    fallbacks: AtomicU64,
}
impl Metrics {
    pub fn request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
    }
    pub fn provider_failure(&self) {
        self.provider_failures.fetch_add(1, Ordering::Relaxed);
    }
    pub fn fallback(&self) {
        self.fallbacks.fetch_add(1, Ordering::Relaxed);
    }
    pub fn render(&self) -> String {
        format!("# TYPE multiplike_ai_requests_total counter\nmultiplike_ai_requests_total {}\n# TYPE multiplike_ai_provider_failures_total counter\nmultiplike_ai_provider_failures_total {}\n# TYPE multiplike_ai_fallbacks_total counter\nmultiplike_ai_fallbacks_total {}\n",self.requests.load(Ordering::Relaxed),self.provider_failures.load(Ordering::Relaxed),self.fallbacks.load(Ordering::Relaxed))
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub redis: redis::Client,
    pub auth: AuthService,
    pub providers: ProviderClient,
    pub metrics: Arc<Metrics>,
    /// Distribuidor de eventos de run para os WebSockets desta instância.
    /// Alimentado pela ponte do Redis (`ws::hub_task`) — ver ws.rs.
    pub hub: Arc<crate::ws::Hub>,
}

impl AppState {
    pub fn new(config: Config, pool: PgPool, redis: redis::Client) -> Self {
        let secrets = SecretBox::new(&config.provider_master_key);
        Self {
            auth: AuthService::new(config.clone()),
            config,
            providers: ProviderClient {
                http: reqwest::Client::new(),
                pool: pool.clone(),
                secrets,
            },
            pool,
            redis,
            metrics: Arc::new(Metrics::default()),
            hub: Arc::new(crate::ws::Hub::default()),
        }
    }
}
