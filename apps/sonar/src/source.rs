use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use tracing::warn;

use crate::artifact::{
    canonical_sonar_payload, extend_digest, snapshot_item_digest, ArtifactClient, SonarPayload,
    EMPTY_DIGEST, FORMAT_VERSION, STREAM, STREAM_VERSION,
};
use crate::decode::{decode_le_f32, BLOB_LEN};
use crate::replica::{LocalSnapshotPage, Replica, SourceCentroid, SourceTrack, SyncStats};
use crate::state::centroid_digest;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SourceMode {
    #[default]
    Replica,
    Worker,
    Shadow,
}

impl SourceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Replica => "replica",
            Self::Worker => "worker",
            Self::Shadow => "shadow",
        }
    }
}

pub enum Source {
    Replica(Replica),
    Worker(WorkerSource),
    Shadow(Replica, WorkerSource),
}

impl Source {
    pub async fn open(
        mode: SourceMode,
        api: ArtifactClient,
        replica_path: Option<&str>,
        turso_url: Option<String>,
        turso_token: Option<String>,
    ) -> Result<Self> {
        if mode == SourceMode::Worker {
            return Ok(Self::Worker(WorkerSource::new(api)));
        }
        let replica = Replica::open(
            replica_path.context("missing local replica path")?,
            turso_url.context("missing replica URL")?,
            turso_token.context("missing replica token")?,
        )
        .await
        .context("opening local source replica")?;
        Ok(if mode == SourceMode::Shadow {
            Self::Shadow(replica, WorkerSource::new(api))
        } else {
            Self::Replica(replica)
        })
    }

    pub fn replica(&self) -> Option<&Replica> {
        match self {
            Self::Replica(replica) | Self::Shadow(replica, _) => Some(replica),
            Self::Worker(_) => None,
        }
    }

    pub fn worker(&self) -> Option<&WorkerSource> {
        match self {
            Self::Worker(worker) | Self::Shadow(_, worker) => Some(worker),
            Self::Replica(_) => None,
        }
    }

    pub async fn sync(&self) -> Result<SyncStats> {
        match self.replica() {
            Some(replica) => replica.sync().await,
            None => Ok(SyncStats::default()),
        }
    }

    pub async fn head(&self, api: &ArtifactClient) -> Result<u64> {
        match self.replica() {
            Some(replica) => replica.artifact_head().await,
            None => Ok(api.status().await?.head_seq),
        }
    }

    pub async fn snapshot_page(
        &self,
        after: Option<&str>,
        limit: usize,
        previous_digest: &str,
        previous_count: u64,
        generation: &str,
        snapshot_seq: u64,
    ) -> Result<LocalSnapshotPage> {
        match self {
            Self::Replica(replica) | Self::Shadow(replica, _) => {
                replica
                    .snapshot_page(after, limit, previous_digest, previous_count)
                    .await
            }
            Self::Worker(worker) => {
                worker
                    .snapshot_page(
                        limit,
                        previous_digest,
                        previous_count,
                        generation,
                        snapshot_seq,
                    )
                    .await
            }
        }
    }
}

#[derive(Clone)]
pub struct WorkerSource {
    api: ArtifactClient,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPage {
    complete: bool,
    consumer_id: String,
    generation: String,
    head_seq: u64,
    item_count: usize,
    items: Vec<WireTrack>,
    ok: bool,
    page_digest: String,
    snapshot_seq: u64,
    source_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTrack {
    pub format_version: u32,
    pub operation: String,
    pub payload_blob_base64: Option<String>,
    pub payload_digest: String,
    pub payload_json: String,
    pub revision: Option<u64>,
    pub stream: String,
    pub stream_version: u32,
    pub subject_id: String,
    pub subject_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDigest {
    pub subject_id: String,
    pub payload_digest: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CentroidDigest {
    pub artist_id: String,
    pub digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listing<T> {
    items: Vec<T>,
    next_after: Option<String>,
    ok: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Items<T> {
    items: Vec<T>,
    absent_ids: Vec<String>,
    ok: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCentroid {
    artist_id: String,
    blob_base64: String,
    digest: String,
}

impl WorkerSource {
    pub fn new(api: ArtifactClient) -> Self {
        Self { api }
    }

    pub async fn snapshot_page(
        &self,
        limit: usize,
        previous: &str,
        count: u64,
        generation: &str,
        snapshot_seq: u64,
    ) -> Result<LocalSnapshotPage> {
        let response = self
            .api
            .get(
                "/admin/artifacts/snapshots",
                &[
                    ("consumerId", self.api.consumer_id()),
                    ("stream", STREAM),
                    ("streamVersion", "1"),
                    ("limit", &limit.to_string()),
                ],
            )
            .await?;
        let page: SnapshotPage = response.json().await?;
        if !page.ok
            || page.consumer_id != self.api.consumer_id()
            || page.generation != generation
            || page.snapshot_seq != snapshot_seq
            || page.head_seq < snapshot_seq
            || page.item_count != page.items.len()
            || page.items.len() > limit
            || (!page.complete && page.items.is_empty())
        {
            bail!("Worker snapshot page boundary mismatch");
        }
        let mut digests = Vec::with_capacity(page.items.len());
        let mut rows = Vec::with_capacity(page.items.len());
        for item in page.items {
            let digest = item.digest()?;
            digests.push(digest);
            let mut track = item.track_with_snapshot_revision()?;
            track.revision = 0;
            rows.push(track);
        }
        let page_digest = extend_digest(EMPTY_DIGEST, &digests)?;
        if page_digest != page.page_digest
            || extend_digest(previous, &digests)? != page.source_digest
        {
            bail!("Worker snapshot page digest mismatch");
        }
        let consumer_item_count = count
            .checked_add(u64::try_from(digests.len())?)
            .context("snapshot count overflow")?;
        Ok(LocalSnapshotPage {
            consumer_digest: page.source_digest,
            consumer_item_count,
            page_digest,
            rows,
        })
    }

    pub async fn track_digests(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<TrackDigest>, Option<String>)> {
        self.track_digests_limit(after, 1000).await
    }

    async fn track_digests_limit(
        &self,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<TrackDigest>, Option<String>)> {
        let limit_text = limit.to_string();
        let mut query = vec![("limit", limit_text.as_str())];
        if let Some(after) = after {
            query.push(("after", after));
        }
        let response = self.api.get("/admin/sonar/source/tracks", &query).await?;
        let page: Listing<TrackDigest> = response.json().await?;
        if !page.ok || page.items.len() > limit {
            bail!("invalid Worker track digest page");
        }
        validate_page(
            &page.items,
            page.next_after.as_deref(),
            after,
            limit,
            |item| &item.subject_id,
        )?;
        Ok((page.items, page.next_after))
    }

    pub async fn centroid_digests(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<CentroidDigest>, Option<String>)> {
        self.centroid_digests_limit(after, 1000).await
    }

    async fn centroid_digests_limit(
        &self,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<CentroidDigest>, Option<String>)> {
        let limit_text = limit.to_string();
        let mut query = vec![("limit", limit_text.as_str())];
        if let Some(after) = after {
            query.push(("after", after));
        }
        let response = self
            .api
            .get("/admin/sonar/source/centroids", &query)
            .await?;
        let page: Listing<CentroidDigest> = response.json().await?;
        if !page.ok || page.items.len() > limit {
            bail!("invalid Worker centroid digest page");
        }
        validate_page(
            &page.items,
            page.next_after.as_deref(),
            after,
            limit,
            |item| &item.artist_id,
        )?;
        Ok((page.items, page.next_after))
    }

    pub async fn tracks(
        &self,
        expected: &[TrackDigest],
        preceding: &[Option<String>],
    ) -> Result<Vec<SourceTrack>> {
        if expected.len() != preceding.len() {
            bail!("Worker track cursor count mismatch");
        }
        let ids: Vec<&str> = expected
            .iter()
            .map(|item| item.subject_id.as_str())
            .collect();
        let response = self
            .api
            .post(
                "/admin/sonar/source/tracks/items",
                json!({"subjectIds": ids}),
            )
            .await?;
        let body: Items<WireTrack> = response.json().await?;
        if !body.ok || body.items.len() + body.absent_ids.len() != expected.len() {
            bail!("Worker track items response is incomplete");
        }
        let mut by_id = BTreeMap::new();
        for item in body.items {
            if by_id.insert(item.subject_id.clone(), item).is_some() {
                bail!("duplicate Worker track item");
            }
        }
        let mut tracks = Vec::with_capacity(expected.len());
        for (wanted, before) in expected.iter().zip(preceding) {
            if let Some(item) = by_id.remove(&wanted.subject_id) {
                let item_digest = item.digest()?;
                if item.revision.unwrap_or_default() >= wanted.revision
                    && (item.revision != Some(wanted.revision)
                        || item_digest == wanted.payload_digest)
                {
                    tracks.push(item.track()?);
                    continue;
                }
            }
            if let Some(relisted) = self
                .track_digest_for(&wanted.subject_id, before.as_deref())
                .await?
            {
                let retry = self
                    .api
                    .post(
                        "/admin/sonar/source/tracks/items",
                        json!({"subjectIds": [wanted.subject_id]}),
                    )
                    .await?;
                let retry: Items<WireTrack> = retry.json().await?;
                if retry.ok && retry.absent_ids.is_empty() && retry.items.len() == 1 {
                    let item = retry
                        .items
                        .into_iter()
                        .next()
                        .context("missing retry item")?;
                    let digest = item.digest()?;
                    if item.subject_id == wanted.subject_id
                        && item.revision.unwrap_or_default() >= relisted.revision
                        && (item.revision != Some(relisted.revision)
                            || digest == relisted.payload_digest)
                    {
                        tracks.push(item.track()?);
                        continue;
                    }
                }
            }
            warn!(subject_id = %wanted.subject_id, "Worker track item raced its listing; retaining local subject");
        }
        if !by_id.is_empty() {
            bail!("Worker track items include unexpected subjects");
        }
        Ok(tracks)
    }

    pub async fn recheck_tracks(&self, ids: &[String]) -> Result<(Vec<SourceTrack>, Vec<String>)> {
        if ids.is_empty() || ids.len() > 200 {
            bail!("Worker recheck must contain 1..=200 tracks");
        }
        let response = self
            .api
            .post(
                "/admin/sonar/source/tracks/items",
                json!({"subjectIds": ids}),
            )
            .await?;
        let body: Items<WireTrack> = response.json().await?;
        if !body.ok || body.items.len() + body.absent_ids.len() != ids.len() {
            bail!("Worker recheck response is incomplete");
        }
        let requested: std::collections::BTreeSet<&str> = ids.iter().map(String::as_str).collect();
        let mut returned = std::collections::BTreeSet::new();
        let mut tracks = Vec::new();
        for item in body.items {
            if !requested.contains(item.subject_id.as_str())
                || !returned.insert(item.subject_id.clone())
            {
                bail!("Worker recheck returned an unexpected track");
            }
            item.digest()?;
            tracks.push(item.track()?);
        }
        for id in &body.absent_ids {
            if !requested.contains(id.as_str()) || !returned.insert(id.clone()) {
                bail!("Worker recheck returned an unexpected absent id");
            }
        }
        if returned.len() != ids.len() {
            bail!("Worker recheck omitted a subject");
        }
        Ok((tracks, body.absent_ids))
    }

    async fn track_digest_for(
        &self,
        id: &str,
        before: Option<&str>,
    ) -> Result<Option<TrackDigest>> {
        let (page, _) = self.track_digests_limit(before, 1).await?;
        Ok(page.into_iter().next().filter(|item| item.subject_id == id))
    }

    pub async fn centroids(
        &self,
        expected: &[CentroidDigest],
        preceding: &[Option<String>],
    ) -> Result<Vec<SourceCentroid>> {
        if expected.len() != preceding.len() {
            bail!("Worker centroid cursor count mismatch");
        }
        let ids: Vec<&str> = expected
            .iter()
            .map(|item| item.artist_id.as_str())
            .collect();
        let response = self
            .api
            .post(
                "/admin/sonar/source/centroids/items",
                json!({"artistIds": ids}),
            )
            .await?;
        let body: Items<WireCentroid> = response.json().await?;
        if !body.ok || body.items.len() + body.absent_ids.len() != expected.len() {
            bail!("Worker centroid items response is incomplete");
        }
        let mut by_id = BTreeMap::new();
        for item in body.items {
            if by_id.insert(item.artist_id.clone(), item).is_some() {
                bail!("duplicate Worker centroid item");
            }
        }
        let mut result = Vec::with_capacity(expected.len());
        for (wanted, before) in expected.iter().zip(preceding) {
            if let Some(item) = by_id.remove(&wanted.artist_id) {
                if let Some(centroid) = item.centroid(&wanted.digest)? {
                    result.push(centroid);
                    continue;
                }
            }
            if let Some(relisted) = self
                .centroid_digest_for(&wanted.artist_id, before.as_deref())
                .await?
            {
                let retry = self
                    .api
                    .post(
                        "/admin/sonar/source/centroids/items",
                        json!({"artistIds": [wanted.artist_id]}),
                    )
                    .await?;
                let retry: Items<WireCentroid> = retry.json().await?;
                if retry.ok && retry.absent_ids.is_empty() && retry.items.len() == 1 {
                    if let Some(centroid) = retry
                        .items
                        .into_iter()
                        .next()
                        .context("missing retry centroid")?
                        .centroid(&relisted.digest)?
                    {
                        result.push(centroid);
                        continue;
                    }
                }
            }
            warn!(artist_id = %wanted.artist_id, "Worker centroid item raced its listing; retaining local subject");
        }
        if !by_id.is_empty() {
            bail!("Worker centroid items include unexpected subjects");
        }
        Ok(result)
    }

    async fn centroid_digest_for(
        &self,
        id: &str,
        before: Option<&str>,
    ) -> Result<Option<CentroidDigest>> {
        let (page, _) = self.centroid_digests_limit(before, 1).await?;
        Ok(page.into_iter().next().filter(|item| item.artist_id == id))
    }
}

impl WireCentroid {
    fn centroid(self, expected_digest: &str) -> Result<Option<SourceCentroid>> {
        let blob = STANDARD
            .decode(&self.blob_base64)
            .context("decoding Worker centroid")?;
        if centroid_digest(&self.artist_id, &blob) != self.digest {
            bail!("Worker centroid digest is invalid");
        }
        if self.digest != expected_digest {
            return Ok(None);
        }
        let vector = decode_le_f32(&blob).context("Worker vector has invalid length")?;
        if vector.iter().any(|value| !value.is_finite()) {
            bail!("Worker centroid is nonfinite");
        }
        Ok(Some(SourceCentroid {
            id: self.artist_id,
            blob,
        }))
    }
}

impl WireTrack {
    fn track_with_snapshot_revision(self) -> Result<SourceTrack> {
        let (payload, blob) = self.decoded()?;
        Ok(SourceTrack {
            id: self.subject_id,
            blob,
            meta: payload.meta(),
            revision: 0,
        })
    }
    fn decoded(&self) -> Result<(SonarPayload, Vec<u8>)> {
        if self.stream != STREAM
            || self.stream_version != STREAM_VERSION
            || self.format_version != FORMAT_VERSION
            || self.operation != "upsert"
            || self.subject_type != "track"
            || self.subject_id.is_empty()
        {
            bail!("Worker track item has invalid contract");
        }
        let blob = STANDARD.decode(
            self.payload_blob_base64
                .as_deref()
                .context("Worker track has no blob")?,
        )?;
        if blob.len() != BLOB_LEN {
            bail!("Worker track blob length mismatch");
        }
        let vector = decode_le_f32(&blob).context("Worker vector has invalid length")?;
        if vector.iter().any(|value| !value.is_finite()) {
            bail!("Worker track has nonfinite vector");
        }
        let payload: SonarPayload = serde_json::from_str(&self.payload_json)?;
        if canonical_sonar_payload(&payload)? != self.payload_json {
            bail!("Worker track payload is not canonical");
        }
        Ok((payload, blob))
    }

    fn digest(&self) -> Result<String> {
        let (_, blob) = self.decoded()?;
        let digest = snapshot_item_digest(&self.subject_id, &self.payload_json, &blob)?;
        if digest != self.payload_digest {
            bail!("Worker track payload digest mismatch");
        }
        Ok(digest)
    }

    fn track(self) -> Result<SourceTrack> {
        let (payload, blob) = self.decoded()?;
        Ok(SourceTrack {
            id: self.subject_id,
            blob,
            meta: payload.meta(),
            revision: self.revision.context("Worker track has no revision")?,
        })
    }
}

fn validate_page<T>(
    items: &[T],
    next: Option<&str>,
    after: Option<&str>,
    limit: usize,
    id: impl Fn(&T) -> &str,
) -> Result<()> {
    if (items.len() == limit) != next.is_some() {
        bail!("Worker source page truncation contract mismatch");
    }
    let mut prior = after.unwrap_or("");
    for item in items {
        let current = id(item);
        if current <= prior {
            bail!("Worker source page is not ordered by id");
        }
        prior = current;
    }
    if let Some(next) = next {
        if items.is_empty() || next != prior {
            bail!("Worker source cursor does not match the page tail");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Query, State};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use libsql::{params, Builder};
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    use crate::artifact::{canonical_payload, ValidatedBatch, ValidatedEvent, ValidatedOperation};
    use crate::consumer::{published, Consumer};
    use crate::decode::BLOB_LEN;
    use crate::index::TrackMeta;
    use crate::replica::{Replica, SourceCentroid, SourceRevision, SourceTrack};
    use crate::server::AppState;
    use crate::state::{StateStore, WorkerReconcile};

    #[tokio::test]
    async fn worker_mode_opens_without_replica_configuration_or_file() {
        let api =
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap();
        let source = Source::open(
            SourceMode::Worker,
            api,
            Some("/this/path/must/not/be/opened"),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(matches!(&source, Source::Worker(_)));
        assert!(source.replica().is_none());
    }

    #[derive(Default)]
    struct Fake {
        bump_once: AtomicBool,
        bump_each_listing: AtomicBool,
        bump_each_status: AtomicBool,
        reregister_on_listing: AtomicBool,
        reregister_on_second_status: AtomicBool,
        status_calls: AtomicUsize,
        stale_once: AtomicBool,
        absent_once: AtomicBool,
        absent_always: AtomicBool,
        race_revision_once: AtomicBool,
        fail_centroid_listing: AtomicBool,
        bad_centroid_schema: AtomicBool,
        accepted_count: AtomicUsize,
        accepted_digest: Mutex<String>,
        checkpoint_calls: AtomicUsize,
        head_increment: AtomicU64,
        applied_increment: AtomicU64,
        phase: AtomicUsize,
        tracks: Mutex<BTreeMap<String, SourceTrack>>,
        centroids: Mutex<BTreeMap<String, Vec<u8>>>,
        fetched_tracks: Mutex<Vec<String>>,
        fetched_centroids: Mutex<Vec<String>>,
        track_listing_requests: AtomicUsize,
        centroid_listing_requests: AtomicUsize,
        feed_subject: Mutex<Option<String>>,
    }

    fn rebuild(fake: &Fake) -> Value {
        let complete = fake.phase.load(Ordering::SeqCst) >= 1;
        let accepted = fake.accepted_count.load(Ordering::SeqCst);
        let digests: Vec<String> = fake
            .tracks
            .lock()
            .unwrap()
            .values()
            .take(accepted)
            .map(|track| {
                snapshot_item_digest(
                    &track.id,
                    &canonical_payload(&track.meta).unwrap(),
                    &track.blob,
                )
                .unwrap()
            })
            .collect();
        let digest = fake.accepted_digest.lock().unwrap().clone();
        json!({
            "completedAt": if complete { Some("2030-01-01T00:00:00.000Z") } else { None },
            "consumerDigest": digest.clone(),
            "consumerItemCount": digests.len(),
            "cursor": fake.tracks.lock().unwrap().keys().nth(accepted.saturating_sub(1)).filter(|_| accepted > 0).map(|id| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!([id])).unwrap())),
            "formatVersion": 1, "generation": "worker-test", "snapshotSeq": 3,
            "sourceDigest": digest,
            "sourceItemCount": digests.len(),
            "startedAt": "2030-01-01T00:00:00.000Z", "state": if complete { "complete" } else { "running" },
            "stream": STREAM, "streamVersion": 1, "updatedAt": "2030-01-01T00:00:00.000Z"
        })
    }

    fn status(fake: &Fake) -> Value {
        let active = fake.phase.load(Ordering::SeqCst) >= 2;
        json!({"ok": true, "consumer": {
            "appliedThroughSeq": if active { Some(3 + fake.applied_increment.load(Ordering::SeqCst)) } else { None },
            "checkpointedAt": null, "compactionBarrier": 3, "consumerId": "sonar-test",
            "contracts": [{"formatVersion": 1, "stream": STREAM, "streamVersion": 1}],
            "earliestSeq": null, "headSeq": 3 + fake.head_increment.load(Ordering::SeqCst),
            "rebuilds": if active { Vec::<Value>::new() } else { vec![rebuild(fake)] },
            "registeredAt": "2030-01-01T00:00:00.000Z", "snapshotSeq": if active { None } else { Some(3) },
            "state": if active { "active" } else { "rebuilding" },
            "stateChangedAt": "2030-01-01T00:00:00.000Z", "updatedAt": "2030-01-01T00:00:00.000Z"
        }})
    }

    async fn status_route(State(fake): State<Arc<Fake>>) -> Json<Value> {
        if fake.status_calls.fetch_add(1, Ordering::SeqCst) == 1
            && fake
                .reregister_on_second_status
                .swap(false, Ordering::SeqCst)
        {
            fake.phase.store(0, Ordering::SeqCst);
        }
        if fake.bump_each_status.load(Ordering::SeqCst) {
            fake.head_increment.fetch_add(1, Ordering::SeqCst);
        }
        Json(status(&fake))
    }

    async fn changes_route(
        State(fake): State<Arc<Fake>>,
        Query(query): Query<BTreeMap<String, String>>,
    ) -> Json<Value> {
        let from = query.get("fromSeq").unwrap().parse::<u64>().unwrap();
        let subject = fake.feed_subject.lock().unwrap().clone();
        let mut events = Vec::new();
        let mut digests = Vec::new();
        if from < 4 && fake.head_increment.load(Ordering::SeqCst) > 0 {
            if let Some(subject) = subject {
                let mut event = crate::artifact::ChangeEvent {
                    created_at: "2030-01-01T00:00:00.000Z".into(),
                    format_registered: true,
                    format_version: 1,
                    operation: "delete".into(),
                    payload_blob_base64: None,
                    payload_digest: String::new(),
                    payload_json: "{}".into(),
                    producer: "test".into(),
                    revision: 2,
                    seq: 4,
                    stream: STREAM.into(),
                    stream_version: 1,
                    subject_id: subject,
                    subject_type: "track".into(),
                    supported_by_consumer: true,
                };
                event.payload_digest = crate::artifact::event_digest(&event, &[]).unwrap();
                digests.push(event.payload_digest.clone());
                events.push(event);
            }
        }
        let through = events.last().map_or(from, |event| event.seq);
        Json(
            json!({"ok":true,"consumerId":"sonar-test","fromSeq":from,"throughSeq":through,"headSeq":3 + fake.head_increment.load(Ordering::SeqCst),"hasMore":false,"events":events,"batchDigest":extend_digest(EMPTY_DIGEST,&digests).unwrap()}),
        )
    }
    async fn register_route(State(fake): State<Arc<Fake>>) -> Json<Value> {
        fake.phase.store(0, Ordering::SeqCst);
        fake.accepted_count.store(0, Ordering::SeqCst);
        *fake.accepted_digest.lock().unwrap() = EMPTY_DIGEST.into();
        Json(status(&fake))
    }
    async fn checkpoint_route(
        State(fake): State<Arc<Fake>>,
        Json(input): Json<Value>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        fake.checkpoint_calls.fetch_add(1, Ordering::SeqCst);
        if fake.stale_once.swap(false, Ordering::SeqCst) {
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"code": "stale_artifact_snapshot_page"})),
            );
        }
        let start = fake.accepted_count.load(Ordering::SeqCst);
        let limit = input["pageLimit"].as_u64().unwrap_or_default() as usize;
        let tracks = fake.tracks.lock().unwrap();
        let all: Vec<_> = tracks.values().collect();
        let page: Vec<_> = all.iter().skip(start).take(limit).collect();
        let page_digests: Vec<String> = page
            .iter()
            .map(|track| {
                snapshot_item_digest(
                    &track.id,
                    &canonical_payload(&track.meta).unwrap(),
                    &track.blob,
                )
                .unwrap()
            })
            .collect();
        let expected_page = extend_digest(EMPTY_DIGEST, &page_digests).unwrap();
        let expected_running =
            extend_digest(&fake.accepted_digest.lock().unwrap(), &page_digests).unwrap();
        if input["pageDigest"] != expected_page
            || input["consumerDigest"] != expected_running
            || input["consumerItemCount"] != start + page.len()
        {
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"code": "digest_mismatch"})),
            );
        }
        let complete = page.len() < limit;
        let next = start + page.len();
        drop(tracks);
        fake.accepted_count.store(next, Ordering::SeqCst);
        *fake.accepted_digest.lock().unwrap() = expected_running;
        if complete {
            fake.phase.store(1, Ordering::SeqCst);
        }
        (
            axum::http::StatusCode::OK,
            Json(json!({"ok": true, "checkpoint": rebuild(&fake)})),
        )
    }
    async fn activate_route(State(fake): State<Arc<Fake>>) -> Json<Value> {
        fake.phase.store(2, Ordering::SeqCst);
        Json(status(&fake))
    }

    async fn snapshot_route(
        State(fake): State<Arc<Fake>>,
        Query(query): Query<BTreeMap<String, String>>,
    ) -> Json<Value> {
        let start = fake.accepted_count.load(Ordering::SeqCst);
        let limit = query
            .get("limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(200);
        let tracks = fake.tracks.lock().unwrap();
        let items: Vec<Value> = tracks
            .values()
            .skip(start)
            .take(limit)
            .map(|track| wire(track, false))
            .collect();
        let digests: Vec<String> = tracks
            .values()
            .skip(start)
            .take(limit)
            .map(|track| {
                snapshot_item_digest(
                    &track.id,
                    &canonical_payload(&track.meta).unwrap(),
                    &track.blob,
                )
                .unwrap()
            })
            .collect();
        let digest = extend_digest(EMPTY_DIGEST, &digests).unwrap();
        let running = extend_digest(&fake.accepted_digest.lock().unwrap(), &digests).unwrap();
        Json(
            json!({"ok": true, "complete": items.len() < limit, "consumerId": "sonar-test", "cursor": null,
            "formatVersion": 1, "generation": "worker-test", "headSeq": 3 + fake.head_increment.load(Ordering::SeqCst),
            "itemCount": items.len(), "items": items, "pageDigest": digest, "snapshotSeq": 3,
            "sourceDigest": running, "stream": STREAM, "streamVersion": 1}),
        )
    }

    fn track(id: &str, revision: u64, dismissed: bool, seed: f32) -> SourceTrack {
        let mut blob = vec![0; BLOB_LEN];
        blob[..4].copy_from_slice(&seed.to_le_bytes());
        SourceTrack {
            id: id.into(),
            blob,
            revision,
            meta: TrackMeta {
                anchored: true,
                dismissed,
                ..TrackMeta::default()
            },
        }
    }

    fn wire(track: &SourceTrack, revision: bool) -> Value {
        let payload = canonical_payload(&track.meta).unwrap();
        let mut item = json!({
            "formatVersion": 1, "operation": "upsert",
            "payloadBlobBase64": STANDARD.encode(&track.blob),
            "payloadDigest": snapshot_item_digest(&track.id, &payload, &track.blob).unwrap(),
            "payloadJson": payload, "stream": STREAM, "streamVersion": 1,
            "subjectId": track.id, "subjectType": "track"
        });
        if revision {
            item["revision"] = json!(track.revision);
        }
        item
    }

    async fn track_listing(
        State(fake): State<Arc<Fake>>,
        Query(query): Query<BTreeMap<String, String>>,
    ) -> Json<Value> {
        fake.track_listing_requests.fetch_add(1, Ordering::SeqCst);
        if fake.reregister_on_listing.swap(false, Ordering::SeqCst) {
            fake.phase.store(0, Ordering::SeqCst);
        }
        if fake.bump_once.swap(false, Ordering::SeqCst) {
            if let Some(track) = fake.tracks.lock().unwrap().get_mut("a") {
                track.revision += 1;
            }
            fake.head_increment.fetch_add(1, Ordering::SeqCst);
        }
        if fake.bump_each_listing.load(Ordering::SeqCst) {
            fake.head_increment.fetch_add(1, Ordering::SeqCst);
        }
        let after = query.get("after").map(String::as_str).unwrap_or("");
        let limit = query.get("limit").unwrap().parse::<usize>().unwrap();
        let tracks = fake.tracks.lock().unwrap();
        let selected: Vec<&SourceTrack> = tracks
            .values()
            .filter(|item| item.id.as_str() > after)
            .take(limit)
            .collect();
        let next = (selected.len() == limit)
            .then(|| selected.last().map(|item| item.id.clone()))
            .flatten();
        let items: Vec<Value> = selected.into_iter().map(|item| json!({
            "subjectId": item.id,
            "payloadDigest": snapshot_item_digest(&item.id, &canonical_payload(&item.meta).unwrap(), &item.blob).unwrap(),
            "revision": item.revision
        })).collect();
        Json(json!({"ok": true, "items": items, "nextAfter": next}))
    }

    async fn track_items(State(fake): State<Arc<Fake>>, Json(input): Json<Value>) -> Json<Value> {
        let absent = fake.absent_always.load(Ordering::SeqCst)
            || fake.absent_once.swap(false, Ordering::SeqCst);
        let mut tracks = fake.tracks.lock().unwrap();
        let mut items = Vec::new();
        let mut absent_ids = Vec::new();
        for id in input["subjectIds"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            fake.fetched_tracks.lock().unwrap().push(id.into());
            if absent {
                absent_ids.push(id.to_string());
                continue;
            }
            if fake.race_revision_once.swap(false, Ordering::SeqCst) {
                if let Some(track) = tracks.get_mut(id) {
                    track.revision += 1;
                }
                fake.head_increment.fetch_add(1, Ordering::SeqCst);
            }
            if let Some(track) = tracks.get(id) {
                items.push(wire(track, true));
            } else {
                absent_ids.push(id.to_string());
            }
        }
        Json(json!({"ok": true, "items": items, "absentIds": absent_ids}))
    }

    async fn centroid_listing(
        State(fake): State<Arc<Fake>>,
        Query(query): Query<BTreeMap<String, String>>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        fake.centroid_listing_requests
            .fetch_add(1, Ordering::SeqCst);
        if fake.fail_centroid_listing.load(Ordering::SeqCst) {
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code": "unavailable"})),
            );
        }
        if fake.bad_centroid_schema.load(Ordering::SeqCst) {
            return (
                axum::http::StatusCode::OK,
                Json(json!({"ok": true, "items": "invalid", "nextAfter": null})),
            );
        }
        let after = query.get("after").map(String::as_str).unwrap_or("");
        let limit = query.get("limit").unwrap().parse::<usize>().unwrap();
        let centroids = fake.centroids.lock().unwrap();
        let selected: Vec<_> = centroids
            .iter()
            .filter(|(id, _)| id.as_str() > after)
            .take(limit)
            .collect();
        let next = (selected.len() == limit)
            .then(|| selected.last().map(|(id, _)| (*id).clone()))
            .flatten();
        let items: Vec<Value> = selected
            .into_iter()
            .map(|(id, blob)| json!({"artistId": id, "digest": centroid_digest(id, blob)}))
            .collect();
        (
            axum::http::StatusCode::OK,
            Json(json!({"ok": true, "items": items, "nextAfter": next})),
        )
    }

    async fn centroid_items(
        State(fake): State<Arc<Fake>>,
        Json(input): Json<Value>,
    ) -> Json<Value> {
        let centroids = fake.centroids.lock().unwrap();
        let mut items = Vec::new();
        for id in input["artistIds"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            fake.fetched_centroids.lock().unwrap().push(id.into());
            if let Some(blob) = centroids.get(id) {
                items.push(json!({"artistId": id, "blobBase64": STANDARD.encode(blob), "digest": centroid_digest(id, blob)}));
            }
        }
        Json(json!({"ok": true, "items": items, "absentIds": []}))
    }

    async fn start(fake: Arc<Fake>) -> (WorkerSource, tokio::task::JoinHandle<()>) {
        let router = Router::new()
            .route("/api/v1/admin/artifacts/consumers", post(register_route))
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test",
                get(status_route),
            )
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test/rebuilds/sonar.track/checkpoint",
                post(checkpoint_route),
            )
            .route(
                "/api/v1/admin/artifacts/consumers/sonar-test/activate",
                post(activate_route),
            )
            .route("/api/v1/admin/artifacts/snapshots", get(snapshot_route))
            .route("/api/v1/admin/artifacts/changes", get(changes_route))
            .route("/api/v1/admin/sonar/source/tracks", get(track_listing))
            .route("/api/v1/admin/sonar/source/tracks/items", post(track_items))
            .route(
                "/api/v1/admin/sonar/source/centroids",
                get(centroid_listing),
            )
            .route(
                "/api/v1/admin/sonar/source/centroids/items",
                post(centroid_items),
            )
            .with_state(fake);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (
            WorkerSource::new(
                ArtifactClient::new(format!("http://{address}"), "test", "sonar-test".into())
                    .unwrap(),
            ),
            task,
        )
    }

    async fn local_replica(path: &std::path::Path, source: &SourceTrack) -> Replica {
        let db = Builder::new_local(path).build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch("create table tracks(track_id text primary key,key text,bpm real,spotify_uri text,dismissed_at text,duplicate_of_track_id text,nearest_finding_score real,duration_ms integer); create table track_embeddings(track_id text primary key,embedding_blob blob); create table findings(track_id text primary key,log_id text); create table artifact_change_revisions(stream text,stream_version integer,subject_type text,subject_id text,revision integer); create table artist_centroids(artist_id text primary key,centroid_blob blob); create table artifact_changes(seq integer primary key autoincrement,body text);").await.unwrap();
        conn.execute(
            "insert into tracks(track_id,spotify_uri) values(?,'spotify:track:test')",
            [source.id.clone()],
        )
        .await
        .unwrap();
        conn.execute(
            "insert into track_embeddings(track_id,embedding_blob) values(?,?)",
            params![source.id.clone(), source.blob.clone()],
        )
        .await
        .unwrap();
        conn.execute("insert into artifact_change_revisions(stream,stream_version,subject_type,subject_id,revision) values('sonar.track',1,'track',?,?)", params![source.id.clone(), i64::try_from(source.revision).unwrap()]).await.unwrap();
        for number in 0..3 {
            conn.execute(
                "insert into artifact_changes(body) values(?)",
                [format!("event-{number}")],
            )
            .await
            .unwrap();
        }
        drop(conn);
        drop(db);
        Replica::open_local_test_source(path).await.unwrap()
    }

    #[tokio::test]
    async fn worker_reconcile_repairs_metadata_delete_insert_and_centroid_with_selective_fetch() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let old = track("old", 1, false, 1.0);
        let drift = track("drift", 1, false, 2.0);
        let stable = track("stable", 1, false, 3.0);
        let mut old_centroid = vec![0; BLOB_LEN];
        old_centroid[..4].copy_from_slice(&1.0_f32.to_le_bytes());
        store
            .replace_from_replica(
                &[old.clone(), drift.clone(), stable.clone()],
                &[
                    SourceRevision {
                        id: old.id.clone(),
                        revision: 1,
                    },
                    SourceRevision {
                        id: drift.id.clone(),
                        revision: 1,
                    },
                    SourceRevision {
                        id: stable.id.clone(),
                        revision: 1,
                    },
                ],
                &[SourceCentroid {
                    id: "artist".into(),
                    blob: old_centroid.clone(),
                }],
                2,
                2,
                1,
            )
            .await
            .unwrap();
        let fake = Arc::new(Fake::default());
        fake.tracks
            .lock()
            .unwrap()
            .insert("drift".into(), track("drift", 1, true, 2.0));
        fake.tracks
            .lock()
            .unwrap()
            .insert("new".into(), track("new", 0, false, 4.0));
        fake.tracks.lock().unwrap().insert("stable".into(), stable);
        let mut new_centroid = old_centroid;
        new_centroid[..4].copy_from_slice(&2.0_f32.to_le_bytes());
        fake.centroids
            .lock()
            .unwrap()
            .insert("artist".into(), new_centroid);
        let (worker, task) = start(fake.clone()).await;
        let (stored, differences) = store
            .reconcile_worker(&worker, 2, 3, 2, false, false)
            .await
            .unwrap();
        assert_eq!(stored.manifest.track_rows, 3);
        assert_eq!(stored.manifest.reconciled_at, 2);
        assert_eq!(store.manifest().await.unwrap().reconciled_at, 2);
        assert_eq!(stored.manifest.centroid_rows, 1);
        assert!(differences.contains(&"drift".into()));
        assert!(differences.contains(&"new".into()));
        assert!(differences.contains(&"old".into()));
        assert!(differences.contains(&"artist".into()));
        assert_eq!(*fake.fetched_tracks.lock().unwrap(), vec!["drift", "new"]);
        assert_eq!(*fake.fetched_centroids.lock().unwrap(), vec!["artist"]);
        assert_eq!(store.manifest().await.unwrap().baseline_seq, 3);
        task.abort();
    }

    #[tokio::test]
    async fn worker_candidate_matches_replica_state_and_shadow_rollback_preserves_it() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let track = track("a", 1, false, 1.0);
        let original = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                1,
                1,
                1,
            )
            .await
            .unwrap();
        let fake = Arc::new(Fake::default());
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), track.clone());
        let (worker, task) = start(fake.clone()).await;
        let (matched, differences) = store
            .reconcile_worker(&worker, 1, 1, 2, false, true)
            .await
            .unwrap();
        assert_eq!(
            matched.manifest.artifact_digest,
            original.manifest.artifact_digest
        );
        assert!(differences.is_empty());
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), self::track("a", 1, true, 1.0));
        let (mismatched, differences) = store
            .reconcile_worker(&worker, 1, 1, 2, false, true)
            .await
            .unwrap();
        assert_ne!(
            mismatched.manifest.artifact_digest,
            original.manifest.artifact_digest
        );
        assert_eq!(differences, vec!["a"]);
        assert_eq!(
            store.manifest().await.unwrap().artifact_digest,
            original.manifest.artifact_digest
        );
        task.abort();
    }

    #[tokio::test]
    async fn worker_rebuild_revision_accepts_the_same_following_delta_as_replica() {
        let dir = tempdir().unwrap();
        let source_track = track("a", 4, false, 1.0);
        let fake = Arc::new(Fake::default());
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), source_track.clone());
        let (worker, task) = start(fake.clone()).await;
        let worker_store = StateStore::open(dir.path().join("worker.db"))
            .await
            .unwrap();
        let replica_store = StateStore::open(dir.path().join("replica.db"))
            .await
            .unwrap();
        worker_store
            .reconcile_worker(&worker, 3, 4, 1, true, false)
            .await
            .unwrap();
        replica_store
            .replace_from_replica(
                &[source_track],
                &[SourceRevision {
                    id: "a".into(),
                    revision: 4,
                }],
                &[],
                3,
                4,
                1,
            )
            .await
            .unwrap();
        let changed = track("a", 5, true, 2.0);
        let batch = ValidatedBatch {
            batch_digest: EMPTY_DIGEST.into(),
            from_seq: 3,
            through_seq: 5,
            head_seq: 5,
            events: vec![ValidatedEvent {
                operation: ValidatedOperation::Upsert {
                    blob: changed.blob,
                    payload: serde_json::from_str(&canonical_payload(&changed.meta).unwrap())
                        .unwrap(),
                },
                payload_digest: String::new(),
                revision: 5,
                seq: 5,
                subject_id: "a".into(),
            }],
        };
        let from_worker = worker_store.apply_batch(&batch, 2).await.unwrap();
        let from_replica = replica_store.apply_batch(&batch, 2).await.unwrap();
        assert_eq!(
            from_worker.manifest.artifact_digest,
            from_replica.manifest.artifact_digest
        );
        task.abort();
    }

    #[tokio::test]
    async fn worker_bootstrap_attests_snapshot_and_activates_without_replica() {
        let dir = tempdir().unwrap();
        let fake = Arc::new(Fake::default());
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), track("a", 2, false, 1.0));
        let (worker, task) = start(fake.clone()).await;
        let consumer = Consumer::with_source(
            worker.api.clone(),
            Source::Worker(worker),
            StateStore::open(dir.path().join("state.db")).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (stored, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert_eq!(activation, Some(3));
        assert_eq!(stored.manifest.track_rows, 1);
        assert_eq!(stored.manifest.baseline_seq, 3);
        consumer.activate_prepared(3).await.unwrap();
        assert_eq!(fake.phase.load(Ordering::SeqCst), 2);
        task.abort();
    }

    #[tokio::test]
    async fn worker_bootstrap_converges_with_a_moving_head_in_one_pass() {
        let dir = tempdir().unwrap();
        let fake = Arc::new(Fake::default());
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), track("a", 2, false, 1.0));
        fake.bump_each_listing.store(true, Ordering::SeqCst);
        fake.bump_each_status.store(true, Ordering::SeqCst);
        let (worker, task) = start(fake.clone()).await;
        let consumer = Consumer::with_source(
            worker.api.clone(),
            Source::Worker(worker),
            StateStore::open(dir.path().join("state.db")).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (stored, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert_eq!(activation, Some(3));
        assert!(stored.manifest.baseline_seq >= 3);
        assert!(stored.manifest.overlap_through > stored.manifest.baseline_seq);
        assert_eq!(stored.manifest.track_rows, 1);
        assert!(fake.fetched_tracks.lock().unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn worker_reconcile_converges_with_a_moving_head_in_one_pass() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let track = track("a", 2, false, 1.0);
        let original = store
            .replace_from_replica(
                std::slice::from_ref(&track),
                &[SourceRevision {
                    id: "a".into(),
                    revision: 2,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.bump_each_listing.store(true, Ordering::SeqCst);
        fake.bump_each_status.store(true, Ordering::SeqCst);
        fake.tracks.lock().unwrap().insert("a".into(), track);
        let (worker, task) = start(fake).await;
        let app = AppState::from_snapshot(published(&original), "secret".into());
        let consumer =
            Consumer::with_source(worker.api.clone(), Source::Worker(worker), store, 10, 10)
                .unwrap();
        consumer.reconcile_local(&app).await.unwrap();
        let served = app.snapshot.load();
        assert!(served.baseline_seq > 3);
        assert_eq!(served.tracks.len(), 1);
        assert!(
            StateStore::open(dir.path().join("state.db"))
                .await
                .unwrap()
                .manifest()
                .await
                .unwrap()
                .overlap_through
                > served.baseline_seq
        );
        task.abort();
    }

    #[tokio::test]
    async fn worker_listing_paginates_and_rejects_truncation_shapes() {
        let fake = Arc::new(Fake::default());
        for number in 0..1001 {
            let id = format!("track-{number:04}");
            fake.tracks
                .lock()
                .unwrap()
                .insert(id.clone(), track(&id, 1, false, 1.0));
        }
        let (worker, task) = start(fake).await;
        let (first, next) = worker.track_digests(None).await.unwrap();
        assert_eq!(first.len(), 1000);
        let (second, last) = worker.track_digests(next.as_deref()).await.unwrap();
        assert_eq!(second.len(), 1);
        assert!(last.is_none());
        assert!(validate_page(&["a"], Some("a"), None, 1000, |id| id).is_err());
        assert!(validate_page(&["a"], None, None, 1, |id| id).is_err());
        task.abort();
    }

    #[tokio::test]
    async fn worker_reconcile_rejects_empty_and_mass_deletion_without_publishing() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let old: Vec<_> = (0..102)
            .map(|number| track(&format!("track-{number:03}"), 1, false, 1.0))
            .collect();
        let revisions: Vec<_> = old
            .iter()
            .map(|track| SourceRevision {
                id: track.id.clone(),
                revision: 1,
            })
            .collect();
        let original = store
            .replace_from_replica(&old, &revisions, &[], 3, 3, 1)
            .await
            .unwrap();
        let fake = Arc::new(Fake::default());
        let (worker, task) = start(fake.clone()).await;
        assert!(store
            .reconcile_worker(&worker, 3, 3, 2, false, false)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("would delete"));
        assert_eq!(
            store.load().await.unwrap().manifest.artifact_digest,
            original.manifest.artifact_digest
        );
        fake.tracks
            .lock()
            .unwrap()
            .insert(old[0].id.clone(), old[0].clone());
        assert!(store
            .reconcile_worker(&worker, 3, 3, 2, false, false)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("would delete"));
        assert_eq!(
            store.load().await.unwrap().manifest.artifact_digest,
            original.manifest.artifact_digest
        );
        task.abort();
    }

    #[tokio::test]
    async fn worker_guard_rebuilds_after_a_legitimate_large_prune() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let old: Vec<_> = (0..102)
            .map(|number| track(&format!("track-{number:03}"), 1, false, 1.0))
            .collect();
        let revisions: Vec<_> = old
            .iter()
            .map(|item| SourceRevision {
                id: item.id.clone(),
                revision: 1,
            })
            .collect();
        let original = store
            .replace_from_replica(&old, &revisions, &[], 3, 3, 1)
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.tracks
            .lock()
            .unwrap()
            .insert(old[0].id.clone(), old[0].clone());
        let (worker, task) = start(fake.clone()).await;
        let app = AppState::from_snapshot(published(&original), "secret".into())
            .with_source(SourceMode::Worker);
        let consumer =
            Consumer::with_source(worker.api.clone(), Source::Worker(worker), store, 10, 10)
                .unwrap();
        consumer.reconcile_local(&app).await.unwrap();
        assert_eq!(app.snapshot.load().tracks.len(), 1);
        assert!(fake.checkpoint_calls.load(Ordering::SeqCst) > 0);
        assert_eq!(
            app.rebuild_cause.load(Ordering::SeqCst),
            crate::server::RebuildCause::ReconcileGuard as u64
        );
        task.abort();
    }

    #[tokio::test]
    async fn worker_deletion_guard_counts_gross_track_and_centroid_removals() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let tracks: Vec<_> = (0..60)
            .map(|number| track(&format!("track-{number:03}"), 1, false, 1.0))
            .collect();
        let centroids: Vec<_> = (0..60)
            .map(|number| SourceCentroid {
                id: format!("artist-{number:03}"),
                blob: vec![0; BLOB_LEN],
            })
            .collect();
        store
            .replace_from_replica(&tracks, &[], &centroids, 3, 3, 1)
            .await
            .unwrap();
        let fake = Arc::new(Fake::default());
        for item in tracks.iter().take(5) {
            fake.tracks
                .lock()
                .unwrap()
                .insert(item.id.clone(), item.clone());
        }
        for item in centroids.iter().take(5) {
            fake.centroids
                .lock()
                .unwrap()
                .insert(item.id.clone(), item.blob.clone());
        }
        let (worker, task) = start(fake).await;
        let error = store
            .reconcile_worker(&worker, 3, 3, 2, false, false)
            .await
            .err()
            .unwrap();
        assert_eq!(
            error
                .downcast_ref::<crate::state::ReconcileGuard>()
                .unwrap()
                .deletions,
            110
        );
        task.abort();
    }

    #[tokio::test]
    async fn consumer_reregistration_during_worker_reconcile_revokes_activation_proof() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = StateStore::open(&path).await.unwrap();
        let old = track("a", 1, false, 1.0);
        let original = store
            .replace_from_replica(
                std::slice::from_ref(&old),
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.reregister_on_listing.store(true, Ordering::SeqCst);
        fake.tracks.lock().unwrap().insert("a".into(), old);
        let (worker, task) = start(fake).await;
        let app = AppState::from_snapshot(published(&original), "secret".into())
            .with_source(SourceMode::Worker);
        let consumer =
            Consumer::with_source(worker.api.clone(), Source::Worker(worker), store, 10, 10)
                .unwrap();
        assert!(consumer
            .reconcile_local(&app)
            .await
            .unwrap_err()
            .to_string()
            .contains("consumer changed"));
        let reopened = StateStore::open(&path).await.unwrap();
        assert!(!reopened
            .activation_proves(&reopened.manifest().await.unwrap())
            .await
            .unwrap());
        drop(reopened);
        let outage =
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap();
        let restart = Consumer::with_source(
            outage.clone(),
            Source::Worker(WorkerSource::new(outage)),
            StateStore::open(&path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        assert!(restart.initial_snapshot().await.is_err());
        task.abort();
    }

    #[tokio::test]
    async fn consumer_reregistration_during_default_replica_reconcile_revokes_activation_proof() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let replica_path = dir.path().join("replica.db");
        let source = track("a", 1, false, 1.0);
        let replica = local_replica(&replica_path, &source).await;
        let store = StateStore::open(&path).await.unwrap();
        let original = store
            .replace_from_replica(
                std::slice::from_ref(&source),
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.reregister_on_second_status
            .store(true, Ordering::SeqCst);
        let (worker, task) = start(fake).await;
        let app = AppState::from_snapshot(published(&original), "secret".into());
        let consumer = Consumer::new(worker.api.clone(), replica, store, 10, 10).unwrap();
        assert!(consumer
            .reconcile_local(&app)
            .await
            .unwrap_err()
            .to_string()
            .contains("consumer changed"));
        let reopened = StateStore::open(&path).await.unwrap();
        assert!(!reopened
            .activation_proves(&reopened.manifest().await.unwrap())
            .await
            .unwrap());
        drop(reopened);
        let outage =
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap();
        let restart = Consumer::new(
            outage,
            Replica::open_local_test_source(&replica_path)
                .await
                .unwrap(),
            StateStore::open(&path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        assert!(restart.initial_snapshot().await.is_err());
        task.abort();
    }

    #[tokio::test]
    async fn worker_bootstrap_attests_multiple_pages_after_one_stale_checkpoint() {
        let dir = tempdir().unwrap();
        let fake = Arc::new(Fake::default());
        fake.stale_once.store(true, Ordering::SeqCst);
        for number in 0..3 {
            let id = format!("track-{number}");
            fake.tracks
                .lock()
                .unwrap()
                .insert(id.clone(), track(&id, 2, false, 1.0));
        }
        let (worker, task) = start(fake.clone()).await;
        let consumer = Consumer::with_source(
            worker.api.clone(),
            Source::Worker(worker),
            StateStore::open(dir.path().join("state.db")).await.unwrap(),
            10,
            2,
        )
        .unwrap();
        let (stored, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert_eq!(activation, Some(3));
        assert_eq!(stored.manifest.track_rows, 3);
        assert_eq!(fake.accepted_count.load(Ordering::SeqCst), 3);
        assert_eq!(fake.checkpoint_calls.load(Ordering::SeqCst), 3);
        assert!(fake.fetched_tracks.lock().unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn worker_item_races_retry_one_subject_and_allow_a_higher_revision() {
        let fake = Arc::new(Fake::default());
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), track("a", 1, false, 1.0));
        let (worker, task) = start(fake.clone()).await;
        let (listed, _) = worker.track_digests(None).await.unwrap();
        fake.absent_once.store(true, Ordering::SeqCst);
        let retried = worker.tracks(&listed, &[None]).await.unwrap();
        assert_eq!(retried.len(), 1);
        assert_eq!(*fake.fetched_tracks.lock().unwrap(), vec!["a", "a"]);
        fake.race_revision_once.store(true, Ordering::SeqCst);
        let newer = worker.tracks(&listed, &[None]).await.unwrap();
        assert_eq!(newer[0].revision, 2);
        fake.absent_always.store(true, Ordering::SeqCst);
        assert!(worker.tracks(&listed, &[None]).await.unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn raced_subject_relisting_uses_one_keyset_request() {
        let fake = Arc::new(Fake::default());
        for number in 0..1_100 {
            let id = format!("track-{number:04}");
            fake.tracks
                .lock()
                .unwrap()
                .insert(id.clone(), track(&id, 1, false, 1.0));
            fake.centroids
                .lock()
                .unwrap()
                .insert(format!("artist-{number:04}"), vec![0; BLOB_LEN]);
        }
        let (worker, task) = start(fake.clone()).await;
        let id = "track-1099";
        let source = fake.tracks.lock().unwrap().get(id).unwrap().clone();
        let digest = TrackDigest {
            subject_id: id.into(),
            payload_digest: snapshot_item_digest(
                id,
                &canonical_payload(&source.meta).unwrap(),
                &source.blob,
            )
            .unwrap(),
            revision: 1,
        };
        fake.absent_once.store(true, Ordering::SeqCst);
        assert_eq!(
            worker
                .tracks(&[digest], &[Some("track-1098".into())])
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fake.track_listing_requests.load(Ordering::SeqCst), 1);
        assert!(worker
            .centroid_digest_for("artist-1099", Some("artist-1098"))
            .await
            .unwrap()
            .is_some());
        assert_eq!(fake.centroid_listing_requests.load(Ordering::SeqCst), 1);
        task.abort();
    }

    #[tokio::test]
    async fn worker_reconcile_errors_leave_durable_and_served_state_untouched() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let old = track("a", 1, false, 1.0);
        let original = store
            .replace_from_replica(
                &[old],
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), track("a", 1, true, 1.0));
        let (worker, task) = start(fake.clone()).await;
        let app = AppState::from_snapshot(published(&original), "secret".into());
        let consumer =
            Consumer::with_source(worker.api.clone(), Source::Worker(worker), store, 10, 10)
                .unwrap();
        fake.fail_centroid_listing.store(true, Ordering::SeqCst);
        assert!(consumer.reconcile_local(&app).await.is_err());
        assert_eq!(
            app.snapshot.load().artifact_digest,
            original.manifest.artifact_digest
        );
        assert_eq!(
            StateStore::open(dir.path().join("state.db"))
                .await
                .unwrap()
                .manifest()
                .await
                .unwrap()
                .artifact_digest,
            original.manifest.artifact_digest
        );
        fake.fail_centroid_listing.store(false, Ordering::SeqCst);
        fake.bad_centroid_schema.store(true, Ordering::SeqCst);
        assert!(consumer.reconcile_local(&app).await.is_err());
        assert_eq!(
            app.snapshot.load().artifact_digest,
            original.manifest.artifact_digest
        );
        task.abort();
    }

    #[tokio::test]
    async fn shadow_reconcile_reports_match_mismatch_inconclusive_and_error_after_publish() {
        let dir = tempdir().unwrap();
        let replica =
            local_replica(&dir.path().join("replica.db"), &track("a", 1, false, 1.0)).await;
        let replica_track = replica.tracks().await.unwrap().remove(0);
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let original = store
            .replace_from_replica(
                std::slice::from_ref(&replica_track),
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), replica_track.clone());
        let (worker, task) = start(fake.clone()).await;
        let app = AppState::from_snapshot(published(&original), "secret".into())
            .with_source(SourceMode::Shadow);
        let consumer = Consumer::with_source(
            worker.api.clone(),
            Source::Shadow(replica, worker),
            store,
            10,
            10,
        )
        .unwrap();
        consumer.reconcile_local(&app).await.unwrap();
        assert_eq!(app.shadow_comparison().unwrap().result, "match");
        let mut drift = replica_track.clone();
        drift.meta.dismissed = true;
        fake.tracks.lock().unwrap().insert("a".into(), drift);
        consumer.reconcile_local(&app).await.unwrap();
        assert_eq!(app.shadow_comparison().unwrap().result, "mismatch");
        fake.head_increment.store(1, Ordering::SeqCst);
        fake.feed_subject.lock().unwrap().replace("a".into());
        consumer.reconcile_local(&app).await.unwrap();
        let inconclusive = app.shadow_comparison().unwrap();
        assert_eq!(inconclusive.result, "inconclusive");
        assert_eq!(inconclusive.replica_head, 3);
        assert_eq!(inconclusive.worker_h0, Some(4));
        fake.feed_subject.lock().unwrap().replace("other".into());
        consumer.reconcile_local(&app).await.unwrap();
        let unexplained = app.shadow_comparison().unwrap();
        assert_eq!(unexplained.result, "mismatch");
        assert_eq!(unexplained.differing_ids, vec!["a"]);
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), replica_track.clone());
        consumer.reconcile_local(&app).await.unwrap();
        assert_eq!(app.shadow_comparison().unwrap().result, "match");
        fake.fail_centroid_listing.store(true, Ordering::SeqCst);
        consumer.reconcile_local(&app).await.unwrap();
        let error = app.shadow_comparison().unwrap();
        assert_eq!(error.result, "error");
        assert!(error.error.is_some());
        task.abort();
    }

    #[tokio::test]
    async fn worker_candidate_committed_before_publish_resumes_after_restart() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = StateStore::open(&path).await.unwrap();
        let original = store
            .replace_from_replica(
                &[track("a", 1, false, 1.0)],
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                3,
                3,
                1,
            )
            .await
            .unwrap();
        store.mark_activated(&original.manifest).await.unwrap();
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.head_increment.store(1, Ordering::SeqCst);
        fake.tracks
            .lock()
            .unwrap()
            .insert("a".into(), track("a", 2, true, 1.0));
        let (worker, task) = start(fake).await;
        let (committed, _, h1) = store
            .reconcile_worker_window(
                &worker,
                &worker.api,
                WorkerReconcile {
                    checkpoint: 3,
                    baseline_seq: 3,
                    validated_at: 2,
                    replace: false,
                    shadow: false,
                },
                "active",
            )
            .await
            .unwrap();
        assert_eq!(h1, 4);
        drop(store);
        let consumer = Consumer::with_source(
            worker.api.clone(),
            Source::Worker(worker),
            StateStore::open(&path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (recovered, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert!(activation.is_none());
        assert_eq!(
            recovered.manifest.artifact_digest,
            committed.manifest.artifact_digest
        );
        assert_eq!(recovered.manifest.overlap_through, 4);
        let applied = StateStore::open(&path).await.unwrap();
        let newer = track("a", 3, false, 3.0);
        let replayed = applied
            .apply_batch(
                &ValidatedBatch {
                    batch_digest: "b".repeat(64),
                    events: vec![
                        ValidatedEvent {
                            operation: ValidatedOperation::Upsert {
                                blob: track("a", 1, false, 4.0).blob,
                                payload: serde_json::from_str(
                                    &canonical_payload(&track("a", 1, false, 4.0).meta).unwrap(),
                                )
                                .unwrap(),
                            },
                            payload_digest: String::new(),
                            revision: 1,
                            seq: 4,
                            subject_id: "a".into(),
                        },
                        ValidatedEvent {
                            operation: ValidatedOperation::Upsert {
                                blob: newer.blob.clone(),
                                payload: serde_json::from_str(
                                    &canonical_payload(&newer.meta).unwrap(),
                                )
                                .unwrap(),
                            },
                            payload_digest: String::new(),
                            revision: 3,
                            seq: 5,
                            subject_id: "a".into(),
                        },
                    ],
                    from_seq: 3,
                    head_seq: 5,
                    through_seq: 5,
                },
                3,
            )
            .await
            .unwrap();
        assert_ne!(
            replayed.manifest.served_digest,
            recovered.manifest.served_digest
        );
        assert!(applied.pending_overlap_recheck().await.unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn overlap_upsert_followed_by_nonstream_quarantine_is_rechecked_after_restart() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = StateStore::open(&path).await.unwrap();
        let stable = track("stable", 1, false, 1.0);
        let quarantined = track("quarantined", 1, false, 2.0);
        store
            .replace_from_replica(&[stable], &[], &[], 3, 3, 1)
            .await
            .unwrap();
        drop(store);
        let db = Builder::new_local(&path).build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute("update sonar_manifest set overlap_through=4 where id=1", ())
            .await
            .unwrap();
        drop(conn);
        drop(db);
        let store = StateStore::open(&path).await.unwrap();
        let upsert = ValidatedEvent {
            operation: ValidatedOperation::Upsert {
                blob: quarantined.blob.clone(),
                payload: serde_json::from_str(&canonical_payload(&quarantined.meta).unwrap())
                    .unwrap(),
            },
            payload_digest: String::new(),
            revision: 1,
            seq: 4,
            subject_id: quarantined.id.clone(),
        };
        let replayed = store
            .apply_batch(
                &ValidatedBatch {
                    batch_digest: "a".repeat(64),
                    events: vec![upsert],
                    from_seq: 3,
                    head_seq: 4,
                    through_seq: 4,
                },
                2,
            )
            .await
            .unwrap();
        assert_eq!(replayed.manifest.track_rows, 2);
        store.finalize_pending_activated(4).await.unwrap();
        drop(store);
        let reopened = StateStore::open(&path).await.unwrap();
        assert_eq!(
            reopened.pending_overlap_recheck().await.unwrap(),
            vec!["quarantined"]
        );
        assert!(!reopened
            .activation_proves(&reopened.manifest().await.unwrap())
            .await
            .unwrap());
        drop(reopened);
        let outage =
            ArtifactClient::new("http://127.0.0.1:1".into(), "test", "sonar-test".into()).unwrap();
        let blocked = Consumer::with_source(
            outage.clone(),
            Source::Worker(WorkerSource::new(outage)),
            StateStore::open(&path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        assert!(blocked.initial_snapshot().await.is_err());
        let fake = Arc::new(Fake::default());
        fake.phase.store(2, Ordering::SeqCst);
        fake.applied_increment.store(1, Ordering::SeqCst);
        fake.head_increment.store(1, Ordering::SeqCst);
        let (worker, task) = start(fake).await;
        let consumer = Consumer::with_source(
            worker.api.clone(),
            Source::Worker(worker),
            StateStore::open(&path).await.unwrap(),
            10,
            10,
        )
        .unwrap();
        let (corrected, activation, _, _) = consumer.initial_snapshot().await.unwrap();
        assert!(activation.is_none());
        assert_eq!(corrected.manifest.track_rows, 1);
        let reopened = StateStore::open(&path).await.unwrap();
        assert!(reopened.pending_overlap_recheck().await.unwrap().is_empty());
        assert!(reopened
            .activation_proves(&corrected.manifest)
            .await
            .unwrap());
        task.abort();
    }
}
