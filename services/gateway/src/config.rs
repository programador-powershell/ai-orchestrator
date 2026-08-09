use anyhow::{bail, Context};
use std::{env, net::SocketAddr};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub redis_url: String,
    pub oidc_issuer: String,
    pub oidc_client_id: String,
    pub oidc_client_secret: Option<String>,
    pub oidc_audience: String,
    pub provider_master_key: [u8; 32],
    pub allow_dev_auth: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let key = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            required("PROVIDER_MASTER_KEY")?,
        )
        .context("PROVIDER_MASTER_KEY must be base64")?;
        if key.len() != 32 {
            bail!("PROVIDER_MASTER_KEY must decode to exactly 32 bytes");
        }
        let mut provider_master_key = [0u8; 32];
        provider_master_key.copy_from_slice(&key);
        Ok(Self {
            bind: env::var("GATEWAY_BIND")
                .unwrap_or_else(|_| "0.0.0.0:8787".into())
                .parse()?,
            database_url: required("DATABASE_URL")?,
            redis_url: required("REDIS_URL")?,
            oidc_issuer: required("OIDC_ISSUER")?.trim_end_matches('/').into(),
            oidc_client_id: required("OIDC_CLIENT_ID")?,
            oidc_client_secret: env::var("OIDC_CLIENT_SECRET")
                .ok()
                .filter(|v| !v.is_empty()),
            oidc_audience: required("OIDC_AUDIENCE")?,
            provider_master_key,
            allow_dev_auth: env::var("ALLOW_DEV_AUTH")
                .is_ok_and(|v| v.eq_ignore_ascii_case("true")),
        })
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    env::var(name).with_context(|| format!("missing required environment variable {name}"))
}
