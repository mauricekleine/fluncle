//! The axum HTTP surface: shared state, routing, handlers, and auth.
//!
//! `/search` requires a constant-time-checked `x-sonar-secret` header. `/health`
//! and `/` are open (Cloudflare health checks hit `/health` unauthenticated).

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
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
use crate::search::{cap_violation, search, IndexName, SearchRequest, SearchResponse};

/// Shared, atomically-swappable server state.
pub struct AppState {
    pub snapshot: ArcSwap<PublishedSnapshot>,
    pub last_refresh: AtomicI64,
    pub head_seq: AtomicU64,
    pub replica_synced_at: AtomicI64,
    pub replica_frame: AtomicU64,
    pub replica_frames_synced: AtomicU64,
    pub rebuild_duration_ms: AtomicU64,
    pub rebuild_cause: AtomicU64,
    pub validation_failed: AtomicBool,
    pending_ack: AtomicBool,
    retired: Mutex<Option<Weak<PublishedSnapshot>>>,
    /// Shared secret for `/search` (compared in constant time).
    pub secret: String,
}

/// One complete generation. Tracks, centroids, durable checkpoint, and
/// validation counters become visible in one ArcSwap store.
pub struct PublishedSnapshot {
    pub artifact_digest: String,
    pub tracks: Arc<Index>,
    pub centroids: Arc<Index>,
    pub checkpoint: u64,
    pub baseline_seq: u64,
    pub raw_vector_bytes: u64,
    pub validated_at: i64,
    pub pending_ack: bool,
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
        let now = now_unix();
        Self {
            snapshot: ArcSwap::from_pointee(PublishedSnapshot {
                artifact_digest: String::new(),
                raw_vector_bytes: (tracks.vector_bytes() + centroids.vector_bytes()) as u64,
                tracks: Arc::new(tracks),
                centroids: Arc::new(centroids),
                checkpoint: 0,
                baseline_seq: 0,
                validated_at: now,
                pending_ack: false,
            }),
            last_refresh: AtomicI64::new(now),
            head_seq: AtomicU64::new(0),
            replica_synced_at: AtomicI64::new(0),
            replica_frame: AtomicU64::new(0),
            replica_frames_synced: AtomicU64::new(0),
            rebuild_duration_ms: AtomicU64::new(0),
            rebuild_cause: AtomicU64::new(0),
            validation_failed: AtomicBool::new(false),
            pending_ack: AtomicBool::new(false),
            retired: Mutex::new(None),
            secret,
        }
    }

    pub fn from_snapshot(snapshot: PublishedSnapshot, secret: String) -> Self {
        let pending_ack = snapshot.pending_ack;
        Self {
            last_refresh: AtomicI64::new(snapshot.validated_at),
            head_seq: AtomicU64::new(snapshot.checkpoint),
            replica_synced_at: AtomicI64::new(0),
            replica_frame: AtomicU64::new(0),
            replica_frames_synced: AtomicU64::new(0),
            rebuild_duration_ms: AtomicU64::new(0),
            rebuild_cause: AtomicU64::new(0),
            validation_failed: AtomicBool::new(false),
            pending_ack: AtomicBool::new(pending_ack),
            snapshot: ArcSwap::from_pointee(snapshot),
            retired: Mutex::new(None),
            secret,
        }
    }

    /// Publish only when the prior retired generation is no longer held by a
    /// request. Freshness may wait; resident generations never grow unbounded.
    pub fn publish(&self, snapshot: PublishedSnapshot) -> anyhow::Result<()> {
        let mut retired = self.publish_guard()?;
        let pending_ack = snapshot.pending_ack;
        let previous = self.snapshot.swap(Arc::new(snapshot));
        *retired = Some(Arc::downgrade(&previous));
        drop(previous);
        self.last_refresh.store(now_unix(), Ordering::Relaxed);
        self.validation_failed.store(false, Ordering::Relaxed);
        self.pending_ack.store(pending_ack, Ordering::Relaxed);
        Ok(())
    }

    pub fn ensure_publish_capacity(&self) -> anyhow::Result<()> {
        drop(self.publish_guard()?);
        Ok(())
    }

    fn publish_guard(
        &self,
    ) -> anyhow::Result<std::sync::MutexGuard<'_, Option<Weak<PublishedSnapshot>>>> {
        let retired = self
            .retired
            .lock()
            .map_err(|_| anyhow::anyhow!("retired snapshot lock poisoned"))?;
        if retired.as_ref().and_then(Weak::upgrade).is_some() {
            anyhow::bail!("previous index generation is still in flight");
        }
        Ok(retired)
    }

    pub fn serves(&self, artifact_digest: &str, checkpoint: u64) -> bool {
        let snapshot = self.snapshot.load();
        snapshot.artifact_digest == artifact_digest && snapshot.checkpoint == checkpoint
    }

    pub fn record_pending_ack(&self, pending: bool) {
        self.pending_ack.store(pending, Ordering::Relaxed);
    }

    pub fn record_replica_sync(&self, frame_no: Option<u64>, frames_synced: u64) {
        self.replica_frame
            .store(frame_no.unwrap_or_default(), Ordering::Relaxed);
        self.replica_frames_synced
            .store(frames_synced, Ordering::Relaxed);
        self.replica_synced_at.store(now_unix(), Ordering::Relaxed);
    }

    pub fn record_rebuild(&self, cause: RebuildCause, duration_ms: u64) {
        self.rebuild_cause.store(cause as u64, Ordering::Relaxed);
        self.rebuild_duration_ms
            .store(duration_ms, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy)]
#[repr(u64)]
pub enum RebuildCause {
    Startup = 0,
    ScheduledLocal = 1,
    StateCorrupt = 2,
    CompactionGap = 3,
    CheckpointDivergence = 4,
    PendingDivergence = 5,
}

fn rebuild_cause(value: u64) -> &'static str {
    match value {
        1 => "scheduled_local",
        2 => "state_corrupt",
        3 => "compaction_gap",
        4 => "checkpoint_divergence",
        5 => "pending_divergence",
        _ => "startup",
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

/// The commit this binary was built from, baked at COMPILE TIME by the release
/// workflow (`GIT_SHA`); `"unknown"` when unset, so a plain local `cargo run` still
/// builds and still answers `/health`.
///
/// WHY IT IS ON THE HEALTH RESPONSE. The box self-deploys on an hourly timer, so
/// "merged" and "running on the box" are different moments. A dark flag must only be
/// flipped once the engine actually carries the code the flag depends on, and this is
/// how an operator checks that in one unauthenticated GET rather than by inference.
/// Public-safe: a commit SHA of a public repo identifies a commit anyone can already
/// read, and nothing else is added here.
pub const BUILD_COMMIT: &str = match option_env!("GIT_SHA") {
    Some(sha) => sha,
    None => "unknown",
};

#[derive(Serialize)]
struct Health {
    tracks: usize,
    centroids: usize,
    last_refresh_unix: i64,
    replica_synced_unix: i64,
    replica_lag_seconds: i64,
    replica_frame: u64,
    replica_frames_synced: u64,
    checkpoint: u64,
    head_seq: u64,
    delta_backlog: u64,
    delta_age_seconds: i64,
    baseline_seq: u64,
    raw_vector_bytes: u64,
    artifact_version: &'static str,
    validation: &'static str,
    pending_ack: bool,
    rebuild_cause: &'static str,
    rebuild_duration_ms: u64,
    commit: &'static str,
    ok: bool,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    let snapshot = state.snapshot.load_full();
    let now = now_unix();
    let head = state.head_seq.load(Ordering::Relaxed);
    let replica_synced = state.replica_synced_at.load(Ordering::Relaxed);
    Json(Health {
        tracks: snapshot.tracks.len(),
        centroids: snapshot.centroids.len(),
        last_refresh_unix: state.last_refresh.load(Ordering::Relaxed),
        replica_synced_unix: replica_synced,
        replica_lag_seconds: if replica_synced > 0 {
            now.saturating_sub(replica_synced)
        } else {
            -1
        },
        replica_frame: state.replica_frame.load(Ordering::Relaxed),
        replica_frames_synced: state.replica_frames_synced.load(Ordering::Relaxed),
        checkpoint: snapshot.checkpoint,
        head_seq: head,
        delta_backlog: head.saturating_sub(snapshot.checkpoint),
        delta_age_seconds: now.saturating_sub(snapshot.validated_at),
        baseline_seq: snapshot.baseline_seq,
        raw_vector_bytes: snapshot.raw_vector_bytes,
        artifact_version: crate::artifact::CONTRACT,
        validation: if state.validation_failed.load(Ordering::Relaxed) {
            "last_attempt_failed"
        } else {
            "valid"
        },
        pending_ack: state.pending_ack.load(Ordering::Relaxed),
        rebuild_cause: rebuild_cause(state.rebuild_cause.load(Ordering::Relaxed)),
        rebuild_duration_ms: state.rebuild_duration_ms.load(Ordering::Relaxed),
        commit: BUILD_COMMIT,
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
///
/// AN OVER-CAP BODY IS A 400, not an empty result (`search::cap_violation`:
/// `top_k` > `MAX_TOP_K`, or more than `MAX_PROBES` probes). The two failure modes are
/// deliberately different: an empty result is the quiet "I could not understand this,
/// degrade to Turso" signal for a Worker/box version skew, whereas an over-cap request
/// is a caller bug or an abuse attempt and should be visible as a 4xx. It costs nothing
/// on the client side — `searchSonar` maps every non-2xx to `null`, which is the same
/// documented fallback, so the surface still answers off the Turso scan. The refusal
/// happens BEFORE the scan, so no heap is allocated for the over-cap `top_k`.
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

    if let Some(reason) = cap_violation(&req) {
        return (StatusCode::BAD_REQUEST, reason).into_response();
    }

    let snapshot = state.snapshot.load_full();
    let index = match req.index {
        IndexName::Tracks => &snapshot.tracks,
        IndexName::Centroids => &snapshot.centroids,
    };

    let resp = search(index, &req);
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

    #[test]
    fn publication_is_atomic_and_refuses_unbounded_retired_generations() {
        let state = state_with("sekret");
        let held = state.snapshot.load_full();
        let replacement = PublishedSnapshot {
            artifact_digest: "one".into(),
            tracks: Arc::new(Index::empty()),
            centroids: Arc::new(Index::empty()),
            checkpoint: 1,
            baseline_seq: 1,
            raw_vector_bytes: 0,
            validated_at: now_unix(),
            pending_ack: false,
        };
        state.publish(replacement).unwrap();
        assert_eq!(state.snapshot.load_full().checkpoint, 1);
        let another = PublishedSnapshot {
            artifact_digest: "two".into(),
            tracks: Arc::new(Index::empty()),
            centroids: Arc::new(Index::empty()),
            checkpoint: 2,
            baseline_seq: 2,
            raw_vector_bytes: 0,
            validated_at: now_unix(),
            pending_ack: false,
        };
        assert!(state.publish(another).is_err());
        assert_eq!(state.snapshot.load_full().checkpoint, 1);
        drop(held);
    }
}
