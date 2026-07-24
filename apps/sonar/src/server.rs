//! The axum HTTP surface: shared state, routing, handlers, and auth.
//!
//! `/search` requires a constant-time-checked `x-sonar-secret` header. `/health`
//! and `/` are open (Cloudflare health checks hit `/health` unauthenticated).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwap;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use subtle::ConstantTimeEq;

use crate::index::Index;
use crate::search::{search, IndexName, SearchRequest, SearchResponse};

/// Shared, atomically-swappable server state.
pub struct AppState {
    pub tracks: ArcSwap<Index>,
    pub centroids: ArcSwap<Index>,
    pub last_refresh: AtomicI64,
    /// Shared secret for `/search` (compared in constant time).
    pub secret: String,
}

/// Current unix time in seconds (saturating; never panics).
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

impl AppState {
    /// Build state from two ready indexes, stamping the refresh time as now.
    pub fn new(tracks: Index, centroids: Index, secret: String) -> Self {
        Self {
            tracks: ArcSwap::from_pointee(tracks),
            centroids: ArcSwap::from_pointee(centroids),
            last_refresh: AtomicI64::new(now_unix()),
            secret,
        }
    }
}

/// Build the router over shared state.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/search", post(search_handler))
        .with_state(state)
}

async fn root() -> &'static str {
    "sonar — Fluncle's in-memory exact vector-similarity engine. POST /search (auth), GET /health.\n"
}

#[derive(Serialize)]
struct Health {
    tracks: usize,
    centroids: usize,
    last_refresh_unix: i64,
    ok: bool,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        tracks: state.tracks.load().len(),
        centroids: state.centroids.load().len(),
        last_refresh_unix: state.last_refresh.load(Ordering::Relaxed),
        ok: true,
    })
}

/// Constant-time check of the `x-sonar-secret` header against the configured
/// secret. A length mismatch short-circuits to `false` (length is not secret);
/// equal-length values are compared in constant time.
fn authorized(headers: &HeaderMap, secret: &str) -> bool {
    let Some(provided) = headers.get("x-sonar-secret").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let a = provided.as_bytes();
    let b = secret.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// `POST /search`. Auth is checked before the body is parsed, so a bad secret is
/// always 401. A malformed/invalid body (bad JSON, empty or wrong-dim probes)
/// returns `{ "matches": [] }` — never a panic.
async fn search_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&headers, &state.secret) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    let req: SearchRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return Json(SearchResponse::empty()).into_response(),
    };

    let guard = match req.index {
        IndexName::Tracks => state.tracks.load(),
        IndexName::Centroids => state.centroids.load(),
    };

    let resp = search(&guard, &req);
    Json(resp).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{Entry, TrackMeta};

    fn state_with(secret: &str) -> Arc<AppState> {
        let mut v = vec![1.0_f32, 0.0];
        v.resize(crate::decode::DIM, 0.0);
        let tracks = Index::from_entries(vec![Entry {
            id: "t1".into(),
            vector: v,
            meta: Some(TrackMeta::default()),
        }]);
        Arc::new(AppState::new(tracks, Index::empty(), secret.into()))
    }

    #[test]
    fn authorized_requires_exact_secret() {
        let state = state_with("sekret");
        let mut ok = HeaderMap::new();
        ok.insert("x-sonar-secret", "sekret".parse().unwrap());
        assert!(authorized(&ok, &state.secret));

        let mut wrong = HeaderMap::new();
        wrong.insert("x-sonar-secret", "nope".parse().unwrap());
        assert!(!authorized(&wrong, &state.secret));

        // missing header
        assert!(!authorized(&HeaderMap::new(), &state.secret));
    }
}
