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
                Ok(stored) => return Ok((stored, None, false, None)),
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

    async fn prepare_bootstrap(&self) -> Result<(StoredSnapshot, u64, SyncStats)> {
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
        let active = self
            .api
            .activate()
            .await
            .context("activating artifact consumer")?;
        validate_contract(&active)?;
        if active.state != "active" || active.applied_through_seq != Some(snapshot_seq) {
            bail!("artifact consumer activation checkpoint mismatch");
        }
        Ok(())
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
        match self
            .api
            .acknowledge_exact(digest, count, from, through)
            .await
        {
            Ok(status) => {
                validate_contract(&status)?;
                if status.state != "active" || status.applied_through_seq != Some(through) {
                    bail!("artifact acknowledgement returned the wrong checkpoint");
                }
            }
            Err(error) => {
                let status = self.api.status().await?;
                validate_contract(&status)?;
                if status.state != "active" || status.applied_through_seq != Some(through) {
                    return Err(error).context("ambiguous artifact acknowledgement did not commit");
                }
            }
        }
        self.state.clear_pending(through).await?;
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
    use crate::artifact::Contract;
    use crate::state::PendingAck;

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
