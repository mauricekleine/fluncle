//! Crash-recoverable artifact consumer and periodic full-local reconciliation.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tracing::{info, warn};

use crate::artifact::{
    parse_cursor, validate_change_page, validate_contract, ArtifactClient, ConsumerStatus,
    RebuildCheckpoint, STREAM,
};
use crate::replica::{Replica, SyncStats};
use crate::server::{now_unix, AppState, PublishedSnapshot, RebuildCause};
use crate::state::{Manifest, StateStore, StoredSnapshot};

pub struct Consumer {
    api: ArtifactClient,
    batch_limit: usize,
    replica: Replica,
    snapshot_limit: usize,
    state: StateStore,
}

impl Consumer {
    pub fn new(
        api: ArtifactClient,
        replica: Replica,
        state: StateStore,
        batch_limit: usize,
        snapshot_limit: usize,
    ) -> Result<Self> {
        if batch_limit == 0 || batch_limit > 500 {
            bail!("SONAR_BATCH_LIMIT must be 1..=500");
        }
        if snapshot_limit == 0 || snapshot_limit > 200 {
            bail!("SONAR_SNAPSHOT_LIMIT must be 1..=200");
        }
        Ok(Self {
            api,
            batch_limit,
            replica,
            snapshot_limit,
            state,
        })
    }

    pub async fn initial_snapshot(
        &self,
    ) -> Result<(StoredSnapshot, Option<u64>, bool, Option<SyncStats>)> {
        let corrupt = match self.state.has_manifest().await {
            Ok(true) => match self.state.load().await {
                Ok(stored) => {
                    if let Some(stored) = self.reconcile_startup_state(stored).await? {
                        return Ok((stored, None, false, None));
                    }
                    warn!(
                        cause = "checkpoint_divergence",
                        "durable sonar state is not confirmed active remotely; rebuilding before serving"
                    );
                    let (stored, activation_seq, sync) = self.prepare_bootstrap().await?;
                    return Ok((stored, Some(activation_seq), false, Some(sync)));
                }
                Err(error) => {
                    warn!(cause = "state_corrupt", error = %format!("{error:#}"), "durable sonar state is corrupt; quarantining it before a full local rebuild");
                    true
                }
            },
            Ok(false) => false,
            Err(error) => {
                warn!(cause = "state_corrupt", error = %format!("{error:#}"), "durable sonar state could not be inspected; quarantining it before a full local rebuild");
                true
            }
        };
        if corrupt {
            self.state
                .reset_corrupt()
                .await
                .context("resetting corrupt sonar consumer state")?;
        }
        let (stored, activation_seq, sync) = self.prepare_bootstrap().await?;
        Ok((stored, Some(activation_seq), corrupt, Some(sync)))
    }

    /// Confirm a durable local generation against the authoritative remote
    /// consumer checkpoint before the HTTP server can expose it as healthy.
    /// A local manifest can be complete even when a prior process died before
    /// activation, so file validity alone is not a startup-ready signal.
    async fn reconcile_startup_state(
        &self,
        stored: StoredSnapshot,
    ) -> Result<Option<StoredSnapshot>> {
        let status = match self.api.status().await {
            Ok(status) => status,
            Err(error)
                if ArtifactClient::is_transport_failure(&error)
                    && self.state.activation_proves(&stored.manifest).await? =>
            {
                warn!(
                    cause = "artifact_api_unavailable",
                    error = %format!("{error:#}"),
                    checkpoint = stored.manifest.checkpoint,
                    "serving a durably activated local sonar generation"
                );
                return Ok(Some(stored));
            }
            Err(error) => {
                self.state.clear_activation_proof().await?;
                return Err(error).context("confirming startup artifact activation");
            }
        };
        if let Err(error) = validate_contract(&status) {
            self.state.clear_activation_proof().await?;
            return Err(error).context("validating startup artifact consumer contract");
        }
        if let Some(pending) = stored.manifest.pending.as_ref() {
            match pending_action(&status, pending) {
                PendingAction::Finalize => {
                    self.state.clear_pending(pending.through_seq).await?;
                    let stored = self.state.load().await?;
                    self.state.mark_activated(&stored.manifest).await?;
                    return Ok(Some(stored));
                }
                PendingAction::Retry => {
                    self.confirm_active_checkpoint(
                        self.api
                            .acknowledge_exact(
                                &pending.batch_digest,
                                pending.event_count,
                                pending.from_seq,
                                pending.through_seq,
                            )
                            .await,
                        pending.through_seq,
                        "acknowledgement",
                    )
                    .await?;
                    self.state.clear_pending(pending.through_seq).await?;
                    let stored = self.state.load().await?;
                    self.state.mark_activated(&stored.manifest).await?;
                    return Ok(Some(stored));
                }
                PendingAction::Rebuild => {
                    self.state.clear_activation_proof().await?;
                    return Ok(None);
                }
            }
        }
        if status.state == "active"
            && status.applied_through_seq == Some(stored.manifest.checkpoint)
        {
            self.state.mark_activated(&stored.manifest).await?;
            return Ok(Some(stored));
        }
        self.state.clear_activation_proof().await?;
        Ok(None)
    }

    async fn prepare_bootstrap(&self) -> Result<(StoredSnapshot, u64, SyncStats)> {
        // Registration moves the remote consumer out of its prior active
        // checkpoint. Revoke any proof for that generation before the first
        // remote mutation so a crash cannot later authorize stale fallback.
        self.state.clear_activation_proof().await?;
        let registered = self
            .api
            .register()
            .await
            .context("registering artifact consumer")?;
        validate_contract(&registered)?;
        let snapshot_seq = registered
            .snapshot_seq
            .context("registered consumer has no snapshot fence")?;
        self.sync_through(snapshot_seq).await?;
        self.attest_local_snapshot().await?;

        // A final sync may include writes newer than the fence. Seed durable
        // state at local head H before activation, then validate/ack <=H as
        // baseline-covered only after this candidate has been published.
        let sync = self.replica.sync().await?;
        let baseline = self.replica.artifact_head().await?;
        if baseline < snapshot_seq {
            bail!("local replica head is behind the activation fence");
        }
        let stored = self
            .state
            .replace_from_local_replica(&self.replica, snapshot_seq, baseline, now_unix())
            .await?;
        Ok((stored, snapshot_seq, sync))
    }

    pub async fn activate_prepared(&self, snapshot_seq: u64) -> Result<()> {
        self.confirm_active_checkpoint(self.api.activate().await, snapshot_seq, "activation")
            .await?;
        let manifest = self.state.manifest().await?;
        if manifest.checkpoint != snapshot_seq {
            bail!("local generation changed before activation completed");
        }
        self.state.mark_activated(&manifest).await?;
        Ok(())
    }

    async fn confirm_active_checkpoint(
        &self,
        attempted: Result<ConsumerStatus>,
        expected: u64,
        operation: &str,
    ) -> Result<()> {
        let (status, ambiguous_error) = match attempted {
            Ok(status) => (status, None),
            Err(error) => match self.api.status().await {
                Ok(status) => (status, Some(error)),
                Err(status_error) => {
                    return Err(error).context(format!(
                        "artifact {operation} was ambiguous and status reconciliation failed: {status_error:#}"
                    ));
                }
            },
        };
        validate_contract(&status)?;
        if status.state == "active" && status.applied_through_seq == Some(expected) {
            return Ok(());
        }
        if let Some(error) = ambiguous_error {
            return Err(error).context(format!(
                "ambiguous artifact {operation} did not commit at checkpoint {expected}"
            ));
        }
        bail!("artifact {operation} returned the wrong active checkpoint");
    }

    async fn sync_through(&self, fence: u64) -> Result<()> {
        self.replica.sync().await?;
        let head = self.replica.artifact_head().await?;
        if head < fence {
            bail!("successful replica sync stopped before artifact snapshot fence");
        }
        Ok(())
    }

    async fn attest_local_snapshot(&self) -> Result<()> {
        loop {
            let status = self.api.status().await?;
            validate_contract(&status)?;
            if status.state != "rebuilding" {
                bail!("artifact consumer left rebuilding before attestation");
            }
            let rebuild = sonar_rebuild(&status)?;
            if rebuild.state == "complete" {
                return Ok(());
            }
            let after = parse_cursor(rebuild.cursor.as_deref())?;
            let page = self
                .replica
                .snapshot_page(
                    after.as_deref(),
                    self.snapshot_limit,
                    &rebuild.source_digest,
                    rebuild.source_item_count,
                )
                .await?;
            match self
                .api
                .checkpoint_rebuild(
                    &rebuild.generation,
                    self.snapshot_limit,
                    &page.page_digest,
                    &page.consumer_digest,
                    page.consumer_item_count,
                )
                .await
            {
                Ok(checkpoint) => {
                    if checkpoint.consumer_digest != page.consumer_digest
                        || checkpoint.consumer_item_count != page.consumer_item_count
                    {
                        bail!("remote rebuild checkpoint disagrees with local attestation");
                    }
                }
                Err(error) => {
                    // A timed-out POST may have committed. Status is the receipt.
                    let after_error = self.api.status().await?;
                    validate_contract(&after_error)?;
                    let checkpoint = sonar_rebuild(&after_error)?;
                    if checkpoint.consumer_digest == page.consumer_digest
                        && checkpoint.consumer_item_count == page.consumer_item_count
                    {
                        continue;
                    }
                    if checkpoint.generation == rebuild.generation
                        && checkpoint.state == "running"
                        && checkpoint.consumer_digest == rebuild.consumer_digest
                        && checkpoint.consumer_item_count == rebuild.consumer_item_count
                        && checkpoint.cursor == rebuild.cursor
                    {
                        self.replica.sync().await.context(
                            "resynchronising a snapshot page rejected after source churn",
                        )?;
                        continue;
                    }
                    return Err(error)
                        .context("artifact rebuild checkpoint was not durably accepted");
                }
            }
        }
    }

    pub async fn run(
        self: Arc<Self>,
        app: Arc<AppState>,
        delta_interval: Duration,
        reconcile_interval: Duration,
    ) {
        let mut delta = tokio::time::interval(delta_interval.max(Duration::from_secs(1)));
        let mut last_reconcile = Instant::now();
        loop {
            delta.tick().await;
            let result = if last_reconcile.elapsed() >= reconcile_interval {
                last_reconcile = Instant::now();
                self.reconcile_local(&app).await
            } else {
                self.consume_once(&app).await
            };
            if let Err(error) = result {
                app.validation_failed.store(true, Ordering::Relaxed);
                warn!(stage = "consumer", error = %format!("{error:#}"), "sonar refresh failed; serving last good index");
            }
        }
    }

    pub async fn reconcile_local(&self, app: &AppState) -> Result<()> {
        app.ensure_publish_capacity()?;
        let started = Instant::now();
        let sync = self.replica.sync().await?;
        app.record_replica_sync(sync.frame_no, sync.frames_synced);
        let baseline = self.replica.artifact_head().await?;
        let current = match self.state.manifest().await {
            Ok(current) => current,
            Err(error) => {
                warn!(cause = "state_corrupt", error = %format!("{error:#}"), "rebuilding corrupt sonar state from the local replica");
                return self
                    .full_local_rebuild(app, RebuildCause::StateCorrupt)
                    .await;
            }
        };
        if current.pending.is_some() {
            return self.recover_pending(app, self.state.load().await?).await;
        }
        if baseline < current.checkpoint {
            bail!("local replica head regressed behind the durable consumer checkpoint");
        }
        let stored = self
            .state
            .replace_from_local_replica(&self.replica, current.checkpoint, baseline, now_unix())
            .await?;
        let rows = stored.manifest.track_rows;
        publish(app, stored)?;
        app.record_rebuild(
            RebuildCause::ScheduledLocal,
            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        );
        info!(
            cause = "scheduled_local",
            rows,
            baseline_seq = baseline,
            "published full local sonar reconciliation"
        );
        Ok(())
    }

    pub async fn consume_once(&self, app: &AppState) -> Result<()> {
        app.ensure_publish_capacity()?;
        let manifest = match self.state.manifest().await {
            Ok(manifest) => manifest,
            Err(error) => {
                warn!(cause = "state_corrupt", error = %format!("{error:#}"), "rebuilding corrupt sonar state from the local replica");
                return self
                    .full_local_rebuild(app, RebuildCause::StateCorrupt)
                    .await;
            }
        };
        if manifest.pending.is_some() {
            return self.recover_pending(app, self.state.load().await?).await;
        }
        let status = self.api.status().await?;
        validate_contract(&status)?;
        if status.state != "active" {
            return self
                .full_local_rebuild(app, RebuildCause::CheckpointDivergence)
                .await;
        }
        let remote = status
            .applied_through_seq
            .context("active consumer has no checkpoint")?;
        app.head_seq.store(status.head_seq, Ordering::Relaxed);
        if remote != manifest.checkpoint {
            return self
                .full_local_rebuild(app, RebuildCause::CheckpointDivergence)
                .await;
        }
        if has_compaction_gap(&status, remote) {
            return self
                .full_local_rebuild(app, RebuildCause::CompactionGap)
                .await;
        }
        let page = self.api.changes(self.batch_limit).await?;
        let batch = validate_change_page(page, &status.consumer_id, remote)?;
        app.head_seq.store(batch.head_seq, Ordering::Relaxed);
        if batch.events.is_empty() {
            if !app.serves(&manifest.artifact_digest, manifest.checkpoint) {
                publish(app, self.state.load().await?)?;
            }
            return Ok(());
        }
        let candidate = self.state.apply_batch(&batch, now_unix()).await?;
        publish(app, candidate)?;
        self.ack_pending(
            app,
            &batch.batch_digest,
            batch.events.len(),
            batch.from_seq,
            batch.through_seq,
        )
        .await?;
        Ok(())
    }

    async fn recover_pending(&self, app: &AppState, stored: StoredSnapshot) -> Result<()> {
        let pending = stored
            .manifest
            .pending
            .clone()
            .context("recover_pending without a pending receipt")?;
        publish(app, stored)?;
        let status = self.api.status().await?;
        validate_contract(&status)?;
        match pending_action(&status, &pending) {
            PendingAction::Finalize => {
                self.state.clear_pending(pending.through_seq).await?;
                let manifest = self.state.manifest().await?;
                self.state.mark_activated(&manifest).await?;
                app.record_pending_ack(false);
                Ok(())
            }
            PendingAction::Retry => {
                self.ack_pending(
                    app,
                    &pending.batch_digest,
                    pending.event_count,
                    pending.from_seq,
                    pending.through_seq,
                )
                .await
            }
            PendingAction::Rebuild => {
                self.full_local_rebuild(app, RebuildCause::PendingDivergence)
                    .await
            }
        }
    }

    async fn ack_pending(
        &self,
        app: &AppState,
        digest: &str,
        count: usize,
        from: u64,
        through: u64,
    ) -> Result<()> {
        self.confirm_active_checkpoint(
            self.api
                .acknowledge_exact(digest, count, from, through)
                .await,
            through,
            "acknowledgement",
        )
        .await?;
        self.state.clear_pending(through).await?;
        let manifest = self.state.manifest().await?;
        self.state.mark_activated(&manifest).await?;
        app.record_pending_ack(false);
        Ok(())
    }

    async fn full_local_rebuild(&self, app: &AppState, cause: RebuildCause) -> Result<()> {
        app.ensure_publish_capacity()?;
        let started = Instant::now();
        if matches!(cause, RebuildCause::StateCorrupt) {
            self.state
                .reset_corrupt()
                .await
                .context("resetting corrupt sonar consumer state")?;
        }
        let (stored, snapshot_seq, sync) = self.prepare_bootstrap().await?;
        publish(app, stored)?;
        self.activate_prepared(snapshot_seq).await?;
        app.record_replica_sync(sync.frame_no, sync.frames_synced);
        app.record_rebuild(
            cause,
            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        );
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PendingAction {
    Finalize,
    Retry,
    Rebuild,
}

fn pending_action(status: &ConsumerStatus, pending: &crate::state::PendingAck) -> PendingAction {
    if status.state != "active" {
        return PendingAction::Rebuild;
    }
    match status.applied_through_seq {
        Some(checkpoint) if checkpoint == pending.through_seq => PendingAction::Finalize,
        Some(checkpoint) if checkpoint == pending.from_seq => PendingAction::Retry,
        _ => PendingAction::Rebuild,
    }
}

fn has_compaction_gap(status: &ConsumerStatus, checkpoint: u64) -> bool {
    match status.earliest_seq {
        Some(earliest) => earliest > checkpoint.saturating_add(1),
        None => status.head_seq > checkpoint,
    }
}

fn sonar_rebuild(status: &ConsumerStatus) -> Result<&RebuildCheckpoint> {
    status
        .rebuilds
        .iter()
        .find(|rebuild| rebuild.stream == STREAM)
        .context("consumer status has no sonar.track rebuild")
}

fn publish(app: &AppState, stored: StoredSnapshot) -> Result<()> {
    app.publish(PublishedSnapshot {
        tracks: stored.tracks,
        centroids: stored.centroids,
        artifact_digest: stored.manifest.artifact_digest,
        checkpoint: stored.manifest.checkpoint,
        baseline_seq: stored.manifest.baseline_seq,
        raw_vector_bytes: stored.manifest.raw_bytes,
        validated_at: stored.manifest.validated_at,
        pending_ack: stored.manifest.pending.is_some(),
    })
}

pub fn published(stored: &StoredSnapshot) -> PublishedSnapshot {
    PublishedSnapshot {
        tracks: stored.tracks.clone(),
        centroids: stored.centroids.clone(),
        artifact_digest: stored.manifest.artifact_digest.clone(),
        checkpoint: stored.manifest.checkpoint,
        baseline_seq: stored.manifest.baseline_seq,
        raw_vector_bytes: stored.manifest.raw_bytes,
        validated_at: stored.manifest.validated_at,
        pending_ack: stored.manifest.pending.is_some(),
    }
}

pub fn manifest_is_pending(manifest: &Manifest) -> bool {
    manifest.pending.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::{Contract, ValidatedBatch, ValidatedEvent, ValidatedOperation};
    use crate::decode::BLOB_LEN;
    use crate::index::TrackMeta;
    use crate::replica::{SourceRevision, SourceTrack};
    use crate::state::PendingAck;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use libsql::{params, Builder};
    use serde_json::{json, Value};
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;
    use tempfile::tempdir;

    fn test_blob(seed: f32) -> Vec<u8> {
        let mut bytes = vec![0_u8; BLOB_LEN];
        bytes[..4].copy_from_slice(&seed.to_le_bytes());
        bytes
    }

    fn test_track(id: &str, revision: u64, seed: f32) -> SourceTrack {
        SourceTrack {
            blob: test_blob(seed),
            id: id.into(),
            meta: TrackMeta {
                anchored: true,
                bpm: Some(174.0),
                ..TrackMeta::default()
            },
            revision,
        }
    }

    async fn local_replica(
        path: &Path,
        tracks: &[SourceTrack],
        artifact_head: u64,
        compact_event_bodies: bool,
    ) -> Replica {
        let db = Builder::new_local(path).build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch(
            "create table tracks (
               track_id text primary key, key text, bpm real, spotify_uri text,
               dismissed_at text, duplicate_of_track_id text,
               nearest_finding_score real, duration_ms integer
             );
             create table track_embeddings (track_id text primary key, embedding_blob blob);
             create table findings (track_id text primary key, log_id text);
             create table artifact_change_revisions (
               stream text, stream_version integer, subject_type text,
               subject_id text, revision integer
             );
             create table artist_centroids (artist_id text primary key, centroid_blob blob);
             create table artifact_changes (seq integer primary key autoincrement, body text);",
        )
        .await
        .unwrap();
        for track in tracks {
            conn.execute(
                "insert into tracks(track_id,bpm,spotify_uri) values(?,174.0,'spotify:track:test')",
                [track.id.clone()],
            )
            .await
            .unwrap();
            conn.execute(
                "insert into track_embeddings(track_id,embedding_blob) values(?,?)",
                params![track.id.clone(), track.blob.clone()],
            )
            .await
            .unwrap();
            conn.execute(
                "insert into artifact_change_revisions(stream,stream_version,subject_type,subject_id,revision) values('sonar.track',1,'track',?,?)",
                params![track.id.clone(), i64::try_from(track.revision).unwrap()],
            )
            .await
            .unwrap();
        }
        for seq in 1..=artifact_head {
            conn.execute(
                "insert into artifact_changes(body) values(?)",
                [format!("event-{seq}")],
            )
            .await
            .unwrap();
        }
        if compact_event_bodies {
            conn.execute("delete from artifact_changes", ())
                .await
                .unwrap();
        }
        drop(conn);
        drop(db);
        Replica::open_local_test_source(path).await.unwrap()
    }

    async fn compacted_change_rows(path: &Path) -> i64 {
        let db = Builder::new_local(path).build().await.unwrap();
        let conn = db.connect().unwrap();
        let mut rows = conn
            .query("select count(*) from artifact_changes", ())
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    fn response_status(
        state: &str,
        applied: Option<u64>,
        earliest: Option<u64>,
        head: u64,
        rebuilds: Vec<Value>,
    ) -> Value {
        json!({
            "appliedThroughSeq": applied,
            "checkpointedAt": null,
            "compactionBarrier": 2,
            "consumerId": "sonar-test",
            "contracts": [{"formatVersion": 1, "stream": STREAM, "streamVersion": 1}],
            "earliestSeq": earliest,
            "headSeq": head,
            "rebuilds": rebuilds,
            "registeredAt": "2030-01-01T00:00:00.000Z",
            "snapshotSeq": 3,
            "state": state,
            "stateChangedAt": "2030-01-01T00:00:00.000Z",
            "updatedAt": "2030-01-01T00:00:00.000Z"
        })
    }

    fn complete_rebuild() -> Value {
        json!({
            "completedAt": "2030-01-01T00:00:00.000Z",
            "consumerDigest": crate::artifact::EMPTY_DIGEST,
            "consumerItemCount": 1,
            "cursor": null,
            "formatVersion": 1,
            "generation": "compaction-rebuild",
            "snapshotSeq": 3,
            "sourceDigest": crate::artifact::EMPTY_DIGEST,
            "sourceItemCount": 1,
            "startedAt": "2030-01-01T00:00:00.000Z",
            "state": "complete",
            "stream": STREAM,
            "streamVersion": 1,
            "updatedAt": "2030-01-01T00:00:00.000Z"
        })
    }

    async fn compaction_api() -> (String, tokio::task::JoinHandle<()>) {
        let status_calls = Arc::new(AtomicUsize::new(0));
        let get_calls = Arc::clone(&status_calls);
        let app = Router::new()
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test",
                get(move || {
                    let calls = Arc::clone(&get_calls);
                    async move {
                        let response = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            response_status("active", Some(1), None, 3, Vec::new())
                        } else {
                            response_status("rebuilding", None, None, 3, vec![complete_rebuild()])
                        };
                        Json(json!({"consumer": response, "ok": true}))
                    }
                }),
            )
            .route(
                "/api/v1/admin/artifacts/consumers",
                post(|| async {
                    Json(json!({
                        "consumer": response_status(
                            "rebuilding",
                            None,
                            None,
                            3,
                            vec![complete_rebuild()]
                        ),
                        "ok": true
                    }))
                }),
            )
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test/activate",
                post(|| async {
                    Json(json!({
                        "consumer": response_status("active", Some(3), None, 3, Vec::new()),
                        "ok": true
                    }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    async fn pre_activation_api() -> (
        String,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let registrations = Arc::new(AtomicUsize::new(0));
        let activations = Arc::new(AtomicUsize::new(0));
        let register_calls = Arc::clone(&registrations);
        let activation_calls = Arc::clone(&activations);
        let app = Router::new()
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test",
                get(|| async {
                    Json(json!({
                        "consumer": response_status(
                            "rebuilding",
                            None,
                            None,
                            3,
                            vec![complete_rebuild()]
                        ),
                        "ok": true
                    }))
                }),
            )
            .route(
                "/api/v1/admin/artifacts/consumers",
                post(move || {
                    let calls = Arc::clone(&register_calls);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Json(json!({
                            "consumer": response_status(
                                "rebuilding",
                                None,
                                None,
                                3,
                                vec![complete_rebuild()]
                            ),
                            "ok": true
                        }))
                    }
                }),
            )
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test/activate",
                post(move || {
                    let calls = Arc::clone(&activation_calls);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Json(json!({
                            "consumer": response_status("active", Some(3), None, 3, Vec::new()),
                            "ok": true
                        }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            format!("http://{address}"),
            registrations,
            activations,
            task,
        )
    }

    async fn fixed_status_api(status: Value) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/v1/admin/artifacts/consumers/sonar-test",
            get(move || {
                let status = status.clone();
                async move { Json(json!({"consumer": status, "ok": true})) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    async fn ambiguous_activation_api() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test",
                get(|| async {
                    Json(json!({
                        "consumer": response_status("active", Some(3), None, 3, Vec::new()),
                        "ok": true
                    }))
                }),
            )
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test/activate",
                post(|| async { "{" }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    async fn ambiguous_startup_ack_api() -> (String, tokio::task::JoinHandle<()>) {
        let status_calls = Arc::new(AtomicUsize::new(0));
        let get_calls = Arc::clone(&status_calls);
        let app = Router::new()
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test",
                get(move || {
                    let calls = Arc::clone(&get_calls);
                    async move {
                        let checkpoint = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            2
                        } else {
                            3
                        };
                        Json(json!({
                            "consumer": response_status(
                                "active",
                                Some(checkpoint),
                                None,
                                3,
                                Vec::new()
                            ),
                            "ok": true
                        }))
                    }
                }),
            )
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test/checkpoint",
                post(|| async { "{" }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    fn status(checkpoint: Option<u64>, earliest: Option<u64>, head: u64) -> ConsumerStatus {
        ConsumerStatus {
            applied_through_seq: checkpoint,
            checkpointed_at: None,
            compaction_barrier: None,
            consumer_id: "sonar-test".into(),
            contracts: vec![Contract {
                format_version: 1,
                stream: STREAM.into(),
                stream_version: 1,
            }],
            earliest_seq: earliest,
            head_seq: head,
            rebuilds: Vec::new(),
            registered_at: "2030-01-01T00:00:00.000Z".into(),
            snapshot_seq: Some(10),
            state: "active".into(),
            state_changed_at: "2030-01-01T00:00:00.000Z".into(),
            updated_at: "2030-01-01T00:00:00.000Z".into(),
        }
    }

    #[tokio::test]
    async fn interrupted_sync_before_rebuild_commit_leaves_exact_last_good_bytes() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let original = store
            .replace_from_replica(
                &[test_track("last-good", 1, 3.5)],
                &[SourceRevision {
                    id: "last-good".into(),
                    revision: 1,
                }],
                &[],
                1,
                1,
                1,
            )
            .await
            .unwrap();
        let original_digest = original.manifest.artifact_digest.clone();
        let app = AppState::from_snapshot(published(&original), "secret".into());
        let replica = local_replica(
            &dir.path().join("replica.db"),
            &[test_track("replacement", 2, 9.5)],
            2,
            false,
        )
        .await;
        replica.interrupt_next_sync();
        let consumer = Consumer::new(
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap(),
            replica,
            store,
            10,
            10,
        )
        .unwrap();

        let error = consumer.reconcile_local(&app).await.unwrap_err();
        assert!(format!("{error:#}").contains("embedded replica sync interruption"));
        let durable = consumer.state.load().await.unwrap();
        let served = app.snapshot.load_full();
        assert_eq!(durable.manifest.artifact_digest, original_digest);
        assert_eq!(durable.tracks.id_at(0), "last-good");
        assert_eq!(served.artifact_digest, original_digest);
        assert_eq!(served.tracks.id_at(0), "last-good");

        consumer.reconcile_local(&app).await.unwrap();
        let recovered = consumer.state.load().await.unwrap();
        let published = app.snapshot.load_full();
        assert_eq!(
            recovered.manifest.artifact_digest,
            published.artifact_digest
        );
        assert_ne!(published.artifact_digest, original_digest);
        assert_eq!(recovered.tracks.id_at(0), "replacement");
        assert_eq!(published.tracks.id_at(0), "replacement");
    }

    #[tokio::test]
    async fn compaction_gap_rebuilds_and_atomically_publishes_the_converged_replica() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let original = store
            .replace_from_replica(
                &[test_track("last-good", 1, 2.5)],
                &[SourceRevision {
                    id: "last-good".into(),
                    revision: 1,
                }],
                &[],
                1,
                1,
                1,
            )
            .await
            .unwrap();
        let original_digest = original.manifest.artifact_digest.clone();
        let app = AppState::from_snapshot(published(&original), "secret".into());
        let held_last_good = app.snapshot.load_full();
        let desired = test_track("after-compaction", 3, 8.5);
        let replica_path = dir.path().join("replica.db");
        let replica = local_replica(&replica_path, std::slice::from_ref(&desired), 3, true).await;
        assert_eq!(compacted_change_rows(&replica_path).await, 0);
        assert_eq!(replica.artifact_head().await.unwrap(), 3);

        let expected_store = StateStore::open(dir.path().join("expected.db"))
            .await
            .unwrap();
        let expected = expected_store
            .replace_from_replica(
                std::slice::from_ref(&desired),
                &[SourceRevision {
                    id: desired.id.clone(),
                    revision: desired.revision,
                }],
                &[],
                3,
                3,
                2,
            )
            .await
            .unwrap();
        let (base_url, server) = compaction_api().await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            replica,
            store,
            10,
            10,
        )
        .unwrap();

        consumer.consume_once(&app).await.unwrap();
        server.abort();
        let durable = consumer.state.load().await.unwrap();
        let current = app.snapshot.load_full();
        assert_eq!(held_last_good.artifact_digest, original_digest);
        assert_eq!(held_last_good.tracks.id_at(0), "last-good");
        assert_eq!(
            durable.manifest.artifact_digest,
            expected.manifest.artifact_digest
        );
        assert_eq!(current.artifact_digest, expected.manifest.artifact_digest);
        assert_eq!(current.checkpoint, 3);
        assert_eq!(current.baseline_seq, 3);
        assert_eq!(current.tracks.id_at(0), "after-compaction");
        assert_eq!(app.rebuild_cause.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn valid_manifest_before_activation_retries_bootstrap_before_serving() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("bootstrap", 3, 8.5);
        let seed = StateStore::open(&state_path).await.unwrap();
        seed.replace_from_replica(
            std::slice::from_ref(&track),
            &[SourceRevision {
                id: track.id.clone(),
                revision: track.revision,
            }],
            &[],
            3,
            3,
            1,
        )
        .await
        .unwrap();
        drop(seed);
        let (base_url, registrations, activations, server) = pre_activation_api().await;

        let first = Consumer::new(
            ArtifactClient::new(base_url.clone(), "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            StateStore::open(&state_path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (_, first_activation, _, _) = first.initial_snapshot().await.unwrap();
        assert_eq!(first_activation, Some(3));
        assert_eq!(activations.load(Ordering::SeqCst), 0);
        drop(first);

        let retry = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            Replica::open_local_test_source(&replica_path)
                .await
                .unwrap(),
            StateStore::open(&state_path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (_, retry_activation, _, _) = retry.initial_snapshot().await.unwrap();
        assert_eq!(retry_activation, Some(3));
        retry
            .activate_prepared(retry_activation.unwrap())
            .await
            .unwrap();

        assert_eq!(registrations.load(Ordering::SeqCst), 2);
        assert_eq!(activations.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn proved_generation_serves_when_startup_status_is_unavailable() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("proved", 3, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        let stored = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&stored.manifest).await.unwrap();
        let consumer = Consumer::new(
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        let (loaded, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert_eq!(
            loaded.manifest.artifact_digest,
            stored.manifest.artifact_digest
        );
        assert_eq!(activation, None);
    }

    #[tokio::test]
    async fn unproved_generation_fails_closed_when_startup_status_is_unavailable() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("unproved", 3, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        let consumer = Consumer::new(
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        let error = consumer.initial_snapshot().await.err().unwrap();
        assert!(format!("{error:#}").contains("confirming startup artifact activation"));
    }

    #[tokio::test]
    async fn divergent_remote_checkpoint_revokes_a_matching_local_proof() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("diverged", 3, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        let stored = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&stored.manifest).await.unwrap();
        let (base_url, server) =
            fixed_status_api(response_status("active", Some(2), None, 3, Vec::new())).await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        assert!(consumer
            .reconcile_startup_state(stored)
            .await
            .unwrap()
            .is_none());
        let manifest = consumer.state.manifest().await.unwrap();
        assert!(!consumer.state.activation_proves(&manifest).await.unwrap());
        server.abort();
    }

    #[tokio::test]
    async fn finalized_pending_recovery_remains_available_during_the_next_status_outage() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("pending", 1, 8.5);
        let replica = local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await;
        let store = StateStore::open(&state_path).await.unwrap();
        store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                2,
                2,
                1,
            )
            .await
            .unwrap();
        let candidate = store
            .apply_batch(
                &ValidatedBatch {
                    batch_digest: "a".repeat(64),
                    events: vec![ValidatedEvent {
                        operation: ValidatedOperation::Delete,
                        payload_digest: "b".repeat(64),
                        revision: 2,
                        seq: 3,
                        subject_id: track.id.clone(),
                    }],
                    from_seq: 2,
                    head_seq: 3,
                    through_seq: 3,
                },
                2,
            )
            .await
            .unwrap();
        let app = AppState::from_snapshot(published(&candidate), "secret".into());
        let (base_url, server) =
            fixed_status_api(response_status("active", Some(3), None, 3, Vec::new())).await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            replica,
            store,
            10,
            10,
        )
        .unwrap();
        consumer.recover_pending(&app, candidate).await.unwrap();
        let finalized = consumer.state.manifest().await.unwrap();
        assert!(finalized.pending.is_none());
        assert!(consumer.state.activation_proves(&finalized).await.unwrap());
        server.abort();
        drop(consumer);

        let restart = Consumer::new(
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap(),
            Replica::open_local_test_source(&replica_path)
                .await
                .unwrap(),
            StateStore::open(&state_path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (loaded, activation, _, _) = restart.initial_snapshot().await.unwrap();
        assert_eq!(loaded.manifest.checkpoint, 3);
        assert_eq!(activation, None);
    }

    #[tokio::test]
    async fn failed_bootstrap_after_registration_revokes_the_old_generation_proof() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("old-generation", 1, 8.5);
        let replica = local_replica(&replica_path, std::slice::from_ref(&track), 2, false).await;
        let store = StateStore::open(&state_path).await.unwrap();
        let stored = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                2,
                2,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&stored.manifest).await.unwrap();
        let app = AppState::from_snapshot(published(&stored), "secret".into());
        let (base_url, registrations, _activations, server) = pre_activation_api().await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            replica,
            store,
            10,
            10,
        )
        .unwrap();

        let error = consumer
            .full_local_rebuild(&app, RebuildCause::CheckpointDivergence)
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("stopped before artifact snapshot fence"),
            "{error:#}"
        );
        assert_eq!(registrations.load(Ordering::SeqCst), 1);
        let unchanged = consumer.state.manifest().await.unwrap();
        assert_eq!(unchanged.checkpoint, 2);
        assert!(!consumer.state.activation_proves(&unchanged).await.unwrap());
        server.abort();
        drop(consumer);

        let restart = Consumer::new(
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap(),
            Replica::open_local_test_source(&replica_path)
                .await
                .unwrap(),
            StateStore::open(&state_path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let restart_error = restart.initial_snapshot().await.err().unwrap();
        assert!(format!("{restart_error:#}").contains("confirming startup artifact activation"));
    }

    #[tokio::test]
    async fn ambiguous_activation_uses_exact_status_as_its_receipt() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("activated", 3, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        let (base_url, server) = ambiguous_activation_api().await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        consumer.activate_prepared(3).await.unwrap();
        let manifest = consumer.state.manifest().await.unwrap();
        assert!(consumer.state.activation_proves(&manifest).await.unwrap());
        server.abort();
    }

    #[tokio::test]
    async fn ambiguous_startup_ack_uses_exact_status_as_its_receipt() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("acknowledged", 1, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                2,
                2,
                1,
            )
            .await
            .unwrap();
        store
            .apply_batch(
                &ValidatedBatch {
                    batch_digest: "a".repeat(64),
                    events: vec![ValidatedEvent {
                        operation: ValidatedOperation::Delete,
                        payload_digest: "b".repeat(64),
                        revision: 2,
                        seq: 3,
                        subject_id: track.id.clone(),
                    }],
                    from_seq: 2,
                    head_seq: 3,
                    through_seq: 3,
                },
                2,
            )
            .await
            .unwrap();
        let (base_url, server) = ambiguous_startup_ack_api().await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        let (loaded, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert!(loaded.manifest.pending.is_none());
        assert_eq!(activation, None);
        assert!(consumer
            .state
            .activation_proves(&loaded.manifest)
            .await
            .unwrap());
        server.abort();
    }

    #[tokio::test]
    async fn wrong_consumer_identity_revokes_proof_instead_of_becoming_outage_fallback() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("identity", 3, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        let stored = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&stored.manifest).await.unwrap();
        let mut wrong = response_status("active", Some(3), None, 3, Vec::new());
        wrong["consumerId"] = json!("another-consumer");
        let (base_url, server) = fixed_status_api(wrong).await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        let error = consumer.initial_snapshot().await.err().unwrap();
        assert!(format!("{error:#}").contains("wrong consumer"));
        let manifest = consumer.state.manifest().await.unwrap();
        assert!(!consumer.state.activation_proves(&manifest).await.unwrap());
        server.abort();
    }

    #[tokio::test]
    async fn authoritative_contract_mismatch_revokes_proof_before_a_later_outage() {
        let dir = tempdir().unwrap();
        let state_path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let track = test_track("contract", 3, 8.5);
        let store = StateStore::open(&state_path).await.unwrap();
        let stored = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: track.id.clone(),
                    revision: track.revision,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&stored.manifest).await.unwrap();
        let mut incompatible = response_status("active", Some(3), None, 3, Vec::new());
        incompatible["contracts"][0]["formatVersion"] = json!(2);
        let (base_url, server) = fixed_status_api(incompatible).await;
        let consumer = Consumer::new(
            ArtifactClient::new(base_url, "test", "sonar-test".into()).unwrap(),
            local_replica(&replica_path, std::slice::from_ref(&track), 3, false).await,
            store,
            10,
            10,
        )
        .unwrap();

        let error = consumer.initial_snapshot().await.err().unwrap();
        assert!(format!("{error:#}").contains("validating startup artifact consumer contract"));
        let manifest = consumer.state.manifest().await.unwrap();
        assert!(!consumer.state.activation_proves(&manifest).await.unwrap());
        server.abort();
        drop(consumer);

        let restart = Consumer::new(
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap(),
            Replica::open_local_test_source(&replica_path)
                .await
                .unwrap(),
            StateStore::open(&state_path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        assert!(restart.initial_snapshot().await.is_err());
    }

    #[test]
    fn compaction_gap_detection_covers_empty_and_nonempty_logs() {
        assert!(!has_compaction_gap(&status(Some(10), Some(11), 12), 10));
        assert!(has_compaction_gap(&status(Some(10), Some(12), 12), 10));
        assert!(!has_compaction_gap(&status(Some(10), None, 10), 10));
        assert!(has_compaction_gap(&status(Some(10), None, 11), 10));
    }

    #[test]
    fn pending_receipt_recovers_every_remote_ack_boundary() {
        let pending = PendingAck {
            batch_digest: "a".repeat(64),
            event_count: 2,
            from_seq: 10,
            through_seq: 12,
        };
        assert_eq!(
            pending_action(&status(Some(10), Some(11), 12), &pending),
            PendingAction::Retry
        );
        assert_eq!(
            pending_action(&status(Some(12), None, 12), &pending),
            PendingAction::Finalize
        );
        assert_eq!(
            pending_action(&status(Some(11), Some(12), 12), &pending),
            PendingAction::Rebuild
        );
        let mut inactive = status(Some(10), Some(11), 12);
        inactive.state = "inactive".into();
        assert_eq!(pending_action(&inactive, &pending), PendingAction::Rebuild);
    }
}
