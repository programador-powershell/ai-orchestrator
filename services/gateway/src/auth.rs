use crate::{
    config::Config,
    error::ApiError,
    models::{Identity, OidcClaims},
};
use axum::http::HeaderMap;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

#[derive(Clone, Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

#[derive(Clone)]
pub struct AuthService {
    config: Config,
    http: reqwest::Client,
    discovery: Arc<RwLock<Option<Discovery>>>,
    jwks: Arc<RwLock<Option<(Value, Instant)>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicOidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub authorization_endpoint: String,
    /// O desktop (public client) troca o code DIRETO com o IdP — o gateway
    /// nao intermedia com client_secret (no Entra, loopback e segredo sao
    /// plataformas mutuamente exclusivas).
    pub token_endpoint: String,
    pub scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenExchange {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshExchange {
    pub refresh_token: String,
}

impl AuthService {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
            discovery: Default::default(),
            jwks: Default::default(),
        }
    }

    async fn discovery(&self) -> Result<Discovery, ApiError> {
        if let Some(value) = self.discovery.read().await.clone() {
            return Ok(value);
        }
        let value: Discovery = self
            .http
            .get(format!(
                "{}/.well-known/openid-configuration",
                self.config.oidc_issuer
            ))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        *self.discovery.write().await = Some(value.clone());
        Ok(value)
    }

    async fn jwks(&self) -> Result<Value, ApiError> {
        if let Some((value, fetched)) = self.jwks.read().await.as_ref() {
            if fetched.elapsed() < Duration::from_secs(900) {
                return Ok(value.clone());
            }
        }
        let discovery = self.discovery().await?;
        let value: Value = self
            .http
            .get(discovery.jwks_uri)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        *self.jwks.write().await = Some((value.clone(), Instant::now()));
        Ok(value)
    }

    pub async fn public_config(&self) -> Result<PublicOidcConfig, ApiError> {
        let discovery = self.discovery().await?;
        Ok(PublicOidcConfig {
            issuer: self.config.oidc_issuer.clone(),
            client_id: self.config.oidc_client_id.clone(),
            authorization_endpoint: discovery.authorization_endpoint,
            token_endpoint: discovery.token_endpoint,
            scope: self.config.oidc_scope.clone(),
        })
    }

    pub async fn exchange(&self, request: TokenExchange) -> Result<Value, ApiError> {
        let discovery = self.discovery().await?;
        let mut form = vec![
            ("grant_type", "authorization_code".to_string()),
            ("client_id", self.config.oidc_client_id.clone()),
            ("code", request.code),
            ("code_verifier", request.code_verifier),
            ("redirect_uri", request.redirect_uri),
            ("scope", self.config.oidc_scope.clone()),
        ];
        if let Some(secret) = &self.config.oidc_client_secret {
            form.push(("client_secret", secret.clone()));
        }
        Ok(self
            .http
            .post(discovery.token_endpoint)
            .form(&form)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    pub async fn refresh(&self, request: RefreshExchange) -> Result<Value, ApiError> {
        let discovery = self.discovery().await?;
        let mut form = vec![
            ("grant_type", "refresh_token".to_string()),
            ("client_id", self.config.oidc_client_id.clone()),
            ("refresh_token", request.refresh_token),
            // Sem scope o refresh multi-recurso do Entra devolve token com aud
            // imprevisivel — quebrava na primeira renovacao.
            ("scope", self.config.oidc_scope.clone()),
        ];
        if let Some(secret) = &self.config.oidc_client_secret {
            form.push(("client_secret", secret.clone()));
        }
        Ok(self
            .http
            .post(discovery.token_endpoint)
            .form(&form)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    pub async fn identity(&self, headers: &HeaderMap) -> Result<Identity, ApiError> {
        let token = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        if self.config.allow_dev_auth && token.starts_with("dev:") {
            // Grupos sintéticos para testar o gating sem AD:
            // "dev:daniel@grupo-ti,grupo-dev". Sem "@", segue sem grupos.
            let raw = token.trim_start_matches("dev:");
            let (subject, groups) = match raw.split_once('@') {
                Some((subject, list)) => (
                    subject.to_string(),
                    list.split(',')
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(str::to_string)
                        .collect(),
                ),
                None => (raw.to_string(), Vec::new()),
            };
            return Ok(Identity {
                subject: subject.clone(),
                email: Some(format!("{subject}@localhost")),
                name: Some(subject),
                groups,
            });
        }
        let header = decode_header(token).map_err(|_| ApiError::Unauthorized)?;
        if !matches!(
            header.alg,
            Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512
        ) {
            return Err(ApiError::Unauthorized);
        }
        let kid = header.kid.ok_or(ApiError::Unauthorized)?;
        let jwks = self.jwks().await?;
        let key = jwks
            .get("keys")
            .and_then(Value::as_array)
            .and_then(|keys| {
                keys.iter()
                    .find(|key| key.get("kid").and_then(Value::as_str) == Some(&kid))
            })
            .ok_or(ApiError::Unauthorized)?;
        let n = key
            .get("n")
            .and_then(Value::as_str)
            .ok_or(ApiError::Unauthorized)?;
        let e = key
            .get("e")
            .and_then(Value::as_str)
            .ok_or(ApiError::Unauthorized)?;
        let decoding =
            DecodingKey::from_rsa_components(n, e).map_err(|_| ApiError::Unauthorized)?;
        let mut validation = Validation::new(header.alg);
        validation.set_issuer(&[self.config.oidc_issuer.as_str()]);
        validation.set_audience(&[self.config.oidc_audience.as_str()]);
        let claims = decode::<OidcClaims>(token, &decoding, &validation)
            .map_err(|_| ApiError::Unauthorized)?
            .claims;
        // groups ∪ roles: a política casa por ObjectId ou por nome, então
        // tanto o claim de grupos quanto app roles alimentam o gating.
        let mut groups = claims.groups;
        groups.extend(claims.roles);
        groups.sort();
        groups.dedup();
        Ok(Identity {
            subject: claims.sub,
            email: claims.email,
            name: claims.name,
            groups,
        })
    }
}
