//! `sonar` server entrypoint: validate the durable last-good index, start the
//! local-replica/artifact consumer, and serve HTTP or HTTPS.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use tracing::info;

use sonar::artifact::ArtifactClient;
use sonar::config::Config;
use sonar::consumer::{published, Consumer};
use sonar::replica::Replica;
use sonar::server::{router, AppState};
use sonar::state::StateStore;

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
        delta_secs = cfg.delta_secs,
        reconcile_secs = cfg.reconcile_secs,
        validate_only = cfg.validate_only,
        tls = cfg.tls_enabled(),
        "starting sonar"
    );

    let (store, recovered_corruption) = if cfg.validate_only {
        (StateStore::open_readonly(&cfg.state_path).await?, false)
    } else {
        StateStore::open_recovering(&cfg.state_path).await?
    };

    let (stored, activation, consumer, state_corrupt, bootstrap_duration_ms, replica_sync) =
        if cfg.validate_only {
            let stored = store
                .load()
                .await
                .context("validating existing durable state")?;
            (stored, None, None, false, None, None)
        } else {
            let replica = Replica::open(
                cfg.replica_path
                    .as_deref()
                    .context("missing local replica path")?,
                cfg.turso_url.clone().context("missing replica URL")?,
                cfg.turso_token.clone().context("missing replica token")?,
            )
            .await
            .context("opening local source replica")?;
            let api = ArtifactClient::new(
                cfg.api_base_url
                    .clone()
                    .context("missing artifact API base")?,
                cfg.api_token
                    .as_deref()
                    .context("missing artifact API token")?,
                cfg.consumer_id.clone(),
            )?;
            let consumer = Arc::new(Consumer::new(
                api,
                replica,
                store,
                cfg.batch_limit,
                cfg.snapshot_limit,
            )?);
            let started = Instant::now();
            let (stored, activation, logical_corruption, replica_sync) =
                consumer.initial_snapshot().await?;
            (
                stored,
                activation,
                Some(consumer),
                recovered_corruption || logical_corruption,
                Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
                replica_sync,
            )
        };
    info!(
        tracks = stored.tracks.len(),
        centroids = stored.centroids.len(),
        checkpoint = stored.manifest.checkpoint,
        "loaded validated local indexes"
    );

    let state = Arc::new(AppState::from_snapshot(
        published(&stored),
        cfg.secret.clone(),
    ));
    if let Some(sync) = replica_sync {
        state.record_replica_sync(sync.frame_no, sync.frames_synced);
    }
    if let Some(consumer) = consumer {
        if let Some(snapshot_seq) = activation {
            consumer.activate_prepared(snapshot_seq).await?;
            state.record_rebuild(
                if state_corrupt {
                    sonar::server::RebuildCause::StateCorrupt
                } else {
                    sonar::server::RebuildCause::Startup
                },
                bootstrap_duration_ms.unwrap_or_default(),
            );
        }
        tokio::spawn(consumer.run(
            state.clone(),
            Duration::from_secs(cfg.delta_secs),
            Duration::from_secs(cfg.reconcile_secs),
        ));
    }

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
