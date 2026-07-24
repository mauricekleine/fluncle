//! Runtime configuration, read from the environment. Fails fast with a clear
//! message when a required variable is missing or a value cannot be parsed.

use anyhow::{bail, Context, Result};

/// Fully-resolved runtime config.
#[derive(Debug, Clone)]
pub struct Config {
    /// Remote (read-only) Turso database URL, e.g. `libsql://<db>.turso.io`.
    pub turso_url: String,
    /// Read-only Turso auth token.
    pub turso_token: String,
    /// Shared secret required in the `x-sonar-secret` header on `/search`.
    pub secret: String,
    pub port: u16,
    pub bind: String,
    /// Seconds between background index refreshes.
    pub refresh_secs: u64,
    /// Optional PEM cert path — HTTPS is served only when both cert and key are set.
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
}

fn required(key: &str) -> Result<String> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => bail!("missing required env var {key}"),
    }
}

fn optional(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

impl Config {
    /// Build config from the process environment.
    pub fn from_env() -> Result<Self> {
        let turso_url = required("TURSO_DATABASE_URL")?;
        let turso_token = required("TURSO_AUTH_TOKEN")?;
        let secret = required("SONAR_SECRET")?;

        let port = match optional("SONAR_PORT") {
            Some(v) => v
                .parse::<u16>()
                .with_context(|| format!("SONAR_PORT is not a valid port: {v:?}"))?,
            None => 8080,
        };
        let bind = optional("SONAR_BIND").unwrap_or_else(|| "0.0.0.0".to_string());
        let refresh_secs = match optional("SONAR_REFRESH_SECS") {
            Some(v) => v
                .parse::<u64>()
                .with_context(|| format!("SONAR_REFRESH_SECS is not a valid integer: {v:?}"))?,
            None => 3600,
        };

        let tls_cert = optional("SONAR_TLS_CERT");
        let tls_key = optional("SONAR_TLS_KEY");
        if tls_cert.is_some() != tls_key.is_some() {
            bail!("SONAR_TLS_CERT and SONAR_TLS_KEY must be set together (or both unset for plain HTTP)");
        }

        Ok(Self {
            turso_url,
            turso_token,
            secret,
            port,
            bind,
            refresh_secs,
            tls_cert,
            tls_key,
        })
    }

    /// True when both TLS paths are configured.
    pub fn tls_enabled(&self) -> bool {
        self.tls_cert.is_some() && self.tls_key.is_some()
    }
}
