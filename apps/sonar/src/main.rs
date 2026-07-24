//! `sonar` server entrypoint: read config, load both indexes from Turso (fail
//! fast if the first load fails — there is nothing to serve), spawn the periodic
//! refresh loop, and serve HTTP (or HTTPS when TLS is configured).

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use tracing::{info, warn};

use sonar::config::Config;
use sonar::server::{now_unix, router, AppState};
use sonar::turso;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    // Install the pure-Rust `ring` crypto provider as the process default so
    // rustls (server-side TLS) does not require aws-lc-rs. Idempotent: ignore the
    // Err if something already installed one.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = Config::from_env().context("reading configuration")?;

    info!(
        bind = %cfg.bind,
        port = cfg.port,
        refresh_secs = cfg.refresh_secs,
        tls = cfg.tls_enabled(),
        "starting sonar"
    );

    // Initial load — fail fast if Turso is unreachable at startup.
    let (tracks, centroids) = turso::load_indexes(&cfg.turso_url, &cfg.turso_token)
        .await
        .context("initial index load from Turso failed")?;
    info!(
        tracks = tracks.len(),
        centroids = centroids.len(),
        "loaded initial indexes"
    );

    let state = Arc::new(AppState::new(tracks, centroids, cfg.secret.clone()));

    spawn_refresh(
        state.clone(),
        cfg.turso_url.clone(),
        cfg.turso_token.clone(),
        cfg.refresh_secs,
    );

    let app = router(state);
    let addr: SocketAddr = format!("{}:{}", cfg.bind, cfg.port)
        .parse()
        .with_context(|| format!("invalid bind address {}:{}", cfg.bind, cfg.port))?;

    match (cfg.tls_cert.as_ref(), cfg.tls_key.as_ref()) {
        (Some(cert), Some(key)) => {
            let tls = RustlsConfig::from_pem_file(cert, key)
                .await
                .context("loading TLS cert/key PEM files")?;
            info!(%addr, "serving HTTPS");
            axum_server::bind_rustls(addr, tls)
                .serve(app.into_make_service())
                .await
                .context("HTTPS server error")?;
        }
        _ => {
            info!(%addr, "serving HTTP");
            axum_server::bind(addr)
                .serve(app.into_make_service())
                .await
                .context("HTTP server error")?;
        }
    }

    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).init();
}

/// Background task: every `refresh_secs`, re-read Turso and atomically hot-swap
/// both indexes. A failed refresh logs and keeps the current snapshot — a
/// transient Turso blip never empties the served index.
fn spawn_refresh(state: Arc<AppState>, url: String, token: String, refresh_secs: u64) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(refresh_secs.max(1)));
        // The first tick fires immediately; consume it so we don't re-load right
        // after the startup load.
        interval.tick().await;
        loop {
            interval.tick().await;
            match turso::load_indexes(&url, &token).await {
                Ok((tracks, centroids)) => {
                    let (nt, nc) = (tracks.len(), centroids.len());
                    state.tracks.store(Arc::new(tracks));
                    state.centroids.store(Arc::new(centroids));
                    state.last_refresh.store(now_unix(), Ordering::Relaxed);
                    info!(tracks = nt, centroids = nc, "refreshed indexes");
                }
                Err(e) => {
                    warn!(
                        error = format!("{e:#}"),
                        "index refresh failed; keeping current snapshot"
                    );
                }
            }
        }
    });
}
