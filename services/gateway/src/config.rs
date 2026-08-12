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
    /// Seed Ed25519 (base64, 32 bytes) que assina a politica do bootstrap.
    /// Ausente = bootstrap sem assinatura (dev); a edicao managed do cliente
    /// RECUSA politica sem assinatura.
    pub policy_signing_seed: Option<[u8; 32]>,
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
            policy_signing_seed: match env::var("POLICY_SIGNING_KEY") {
                Ok(value) if !value.is_empty() => {
                    let bytes = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        value,
                    )
                    .context("POLICY_SIGNING_KEY must be base64")?;
                    if bytes.len() != 32 {
                        bail!("POLICY_SIGNING_KEY must decode to exactly 32 bytes");
                    }
                    let mut seed = [0u8; 32];
                    seed.copy_from_slice(&bytes);
                    Some(seed)
                }
                _ => None,
            },
        })
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    env::var(name).with_context(|| format!("missing required environment variable {name}"))
}
