//! Runtime configuration, read from the environment. Fails fast with a clear
//! message when a required variable is missing or a value cannot be parsed.

use crate::source::SourceMode;
use anyhow::{bail, Context, Result};
use std::path::Path;

/// Fully-resolved runtime config.
#[derive(Debug, Clone)]
pub struct Config {
    pub source: SourceMode,
    /// Remote Turso database URL used only by explicit replica sync.
    pub turso_url: Option<String>,
    /// Read-only Turso auth token used only by explicit replica sync.
    pub turso_token: Option<String>,
    pub replica_path: Option<String>,
    pub state_path: String,
    pub api_base_url: Option<String>,
    pub api_token: Option<String>,
    pub consumer_id: String,
    /// Shared secret required in the `x-sonar-secret` header on `/search`.
    pub secret: String,
    pub port: u16,
    pub bind: String,
    pub delta_secs: u64,
    pub reconcile_secs: u64,
    pub batch_limit: usize,
    pub snapshot_limit: usize,
    pub validate_only: bool,
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
        let state_path = required("SONAR_STATE_PATH")?;
        let secret = required("SONAR_SECRET")?;
        let validate_only = optional("SONAR_VALIDATE_ONLY").as_deref() == Some("true");
        let source = match optional("SONAR_SOURCE").as_deref().unwrap_or("replica") {
            "replica" => SourceMode::Replica,
            "worker" => SourceMode::Worker,
            "shadow" => SourceMode::Shadow,
            _ => bail!("SONAR_SOURCE must be replica, worker, or shadow"),
        };
        let turso_url = optional("TURSO_DATABASE_URL");
        let turso_token = optional("TURSO_AUTH_TOKEN");
        let replica_path = optional("SONAR_REPLICA_PATH");
        let api_base_url = optional("FLUNCLE_API_BASE_URL");
        let api_token = optional("FLUNCLE_API_TOKEN");
        let consumer_id = optional("SONAR_CONSUMER_ID").unwrap_or_default();
        if !validate_only
            && (api_base_url.is_none()
                || api_token.is_none()
                || (source != SourceMode::Worker
                    && (turso_url.is_none() || turso_token.is_none() || replica_path.is_none()))
                || consumer_id.is_empty())
        {
            bail!("selected source and artifact API configuration is required outside SONAR_VALIDATE_ONLY=true");
        }
        if !consumer_id.is_empty()
            && (consumer_id.len() > 128
                || !consumer_id.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
                }))
        {
            bail!("SONAR_CONSUMER_ID violates the artifact consumer identifier contract");
        }

        let port = match optional("SONAR_PORT") {
            Some(v) => v
                .parse::<u16>()
                .with_context(|| format!("SONAR_PORT is not a valid port: {v:?}"))?,
            None => 8080,
        };
        let bind = optional("SONAR_BIND").unwrap_or_else(|| "0.0.0.0".to_string());
        let delta_secs = match optional("SONAR_DELTA_SECS") {
            Some(v) => v
                .parse::<u64>()
                .with_context(|| format!("SONAR_DELTA_SECS is not a valid integer: {v:?}"))?,
            None => 30,
        };
        let reconcile_secs = parsed("SONAR_RECONCILE_SECS", 21600)?;
        if delta_secs == 0 {
            bail!("SONAR_DELTA_SECS must be greater than zero");
        }
        if reconcile_secs == 0 {
            bail!("SONAR_RECONCILE_SECS must be greater than zero");
        }
        let batch_limit = usize::try_from(parsed("SONAR_BATCH_LIMIT", 100)?)?;
        let snapshot_limit = usize::try_from(parsed("SONAR_SNAPSHOT_LIMIT", 200)?)?;
        if let Some(replica_path) = replica_path
            .as_deref()
            .filter(|_| source != SourceMode::Worker)
        {
            if same_path(Path::new(&state_path), Path::new(replica_path))? {
                bail!("SONAR_STATE_PATH and SONAR_REPLICA_PATH must be different files");
            }
        }

        let tls_cert = optional("SONAR_TLS_CERT");
        let tls_key = optional("SONAR_TLS_KEY");
        if tls_cert.is_some() != tls_key.is_some() {
            bail!("SONAR_TLS_CERT and SONAR_TLS_KEY must be set together (or both unset for plain HTTP)");
        }

        Ok(Self {
            source,
            turso_url,
            turso_token,
            replica_path,
            state_path,
            api_base_url,
            api_token,
            consumer_id,
            secret,
            port,
            bind,
            delta_secs,
            reconcile_secs,
            batch_limit,
            snapshot_limit,
            validate_only,
            tls_cert,
            tls_key,
        })
    }

    /// True when both TLS paths are configured.
    pub fn tls_enabled(&self) -> bool {
        self.tls_cert.is_some() && self.tls_key.is_some()
    }
}

fn same_path(left: &Path, right: &Path) -> Result<bool> {
    if left == right {
        return Ok(true);
    }
    if let (Ok(left), Ok(right)) = (left.canonicalize(), right.canonicalize()) {
        return Ok(left == right);
    }
    let left_parent = left.parent().unwrap_or_else(|| Path::new("."));
    let right_parent = right.parent().unwrap_or_else(|| Path::new("."));
    let left_name = left.file_name();
    let right_name = right.file_name();
    if left_name != right_name {
        return Ok(false);
    }
    match (left_parent.canonicalize(), right_parent.canonicalize()) {
        (Ok(left_parent), Ok(right_parent)) => Ok(left_parent == right_parent),
        _ => Ok(false),
    }
}

fn parsed(key: &str, default: u64) -> Result<u64> {
    match optional(key) {
        Some(value) => value
            .parse::<u64>()
            .with_context(|| format!("{key} is not a valid integer: {value:?}")),
        None => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_config_needs_no_turso_credentials_or_replica_path() {
        const KEYS: &[&str] = &[
            "SONAR_STATE_PATH",
            "SONAR_SECRET",
            "SONAR_VALIDATE_ONLY",
            "SONAR_SOURCE",
            "TURSO_DATABASE_URL",
            "TURSO_AUTH_TOKEN",
            "SONAR_REPLICA_PATH",
            "FLUNCLE_API_BASE_URL",
            "FLUNCLE_API_TOKEN",
            "SONAR_CONSUMER_ID",
            "SONAR_PORT",
            "SONAR_BIND",
            "SONAR_DELTA_SECS",
            "SONAR_RECONCILE_SECS",
            "SONAR_BATCH_LIMIT",
            "SONAR_SNAPSHOT_LIMIT",
            "SONAR_TLS_CERT",
            "SONAR_TLS_KEY",
        ];
        struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl Drop for Restore {
            fn drop(&mut self) {
                for (key, value) in &self.0 {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }
        let restore = Restore(
            KEYS.iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        );
        for key in KEYS {
            std::env::remove_var(key);
        }
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("SONAR_STATE_PATH", dir.path().join("state.db"));
        std::env::set_var("SONAR_SECRET", "test");
        std::env::set_var("SONAR_SOURCE", "worker");
        std::env::set_var("FLUNCLE_API_BASE_URL", "http://127.0.0.1:1");
        std::env::set_var("FLUNCLE_API_TOKEN", "test");
        std::env::set_var("SONAR_CONSUMER_ID", "sonar-test");
        let config = Config::from_env().unwrap();
        assert_eq!(config.source, SourceMode::Worker);
        assert!(config.turso_url.is_none());
        assert!(config.replica_path.is_none());
        drop(restore);
    }

    #[test]
    fn replica_and_state_paths_must_resolve_to_different_files() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state.db");
        std::fs::write(&state, []).unwrap();
        let alias = dir.path().join("alias.db");
        std::os::unix::fs::symlink(&state, &alias).unwrap();

        assert!(same_path(&state, &state).unwrap());
        assert!(same_path(&state, &alias).unwrap());
        assert!(!same_path(&state, &dir.path().join("replica.db")).unwrap());
    }
}
