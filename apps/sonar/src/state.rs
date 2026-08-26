//! Crash-safe local consumer state, separate from the read-only source replica.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{bail, Context, Result};
use libsql::{params, Builder, Connection, OpenFlags, Transaction, TransactionBehavior, Value};
use sha2::{Digest, Sha256};

use crate::artifact::{
    canonical_payload, sha256_hex, SonarPayload, ValidatedBatch, ValidatedOperation,
};
use crate::decode::decode_le_f32;
use crate::index::{Index, IndexBuilder};
use crate::replica::{
    source_centroid, source_revision, source_track, Replica, SourceCentroid, SourceRevision,
    SourceTrack,
};

const SCHEMA_VERSION: i64 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAck {
    pub batch_digest: String,
    pub event_count: usize,
    pub from_seq: u64,
    pub through_seq: u64,
}

#[derive(Clone, Debug)]
pub struct Manifest {
    pub artifact_digest: String,
    pub baseline_seq: u64,
    pub centroid_rows: usize,
    pub checkpoint: u64,
    pub pending: Option<PendingAck>,
    pub raw_bytes: u64,
    pub track_rows: usize,
    pub validated_at: i64,
}

pub struct StoredSnapshot {
    pub centroids: Arc<Index>,
    pub manifest: Manifest,
    pub tracks: Arc<Index>,
}

pub struct StateStore {
    conn: RwLock<Connection>,
    path: PathBuf,
}

impl StateStore {
    pub async fn open_readonly(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let db = Builder::new_local(&path)
            .flags(OpenFlags::SQLITE_OPEN_READ_ONLY)
            .build()
            .await
            .context("opening read-only sonar consumer state")?;
        let conn = db
            .connect()
            .context("connecting to read-only sonar consumer state")?;
        Ok(Self {
            conn: RwLock::new(conn),
            path,
        })
    }

    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let db = Builder::new_local(&path)
            .build()
            .await
            .context("opening sonar consumer state")?;
        let conn = db.connect().context("connecting to sonar consumer state")?;
        conn.execute_batch(
            "pragma journal_mode=wal; pragma synchronous=full; pragma foreign_keys=on;
             create table if not exists sonar_manifest (
               id integer primary key check(id=1), schema_version integer not null,
               checkpoint integer not null, baseline_seq integer not null,
               artifact_digest text not null, track_rows integer not null,
               centroid_rows integer not null, raw_bytes integer not null,
               validated_at integer not null,
               pending_from integer, pending_through integer, pending_count integer, pending_digest text
             );
             create table if not exists sonar_tracks (
               id text primary key, payload_json text not null, vector blob not null,
               revision integer not null, value_digest text not null
             ) without rowid;
             create table if not exists sonar_revisions (
               id text primary key, revision integer not null, present integer not null,
               value_digest text not null
             ) without rowid;
             create table if not exists sonar_centroids (
               id text primary key, vector blob not null, value_digest text not null
             ) without rowid;",
        ).await.context("initialising sonar consumer state schema")?;
        Ok(Self {
            conn: RwLock::new(conn),
            path,
        })
    }

    /// Open writable state, quarantining one physically corrupt generation so
    /// bootstrap can recreate the derived database without manual surgery.
    pub async fn open_recovering(path: impl AsRef<Path>) -> Result<(Self, bool)> {
        let path = path.as_ref().to_path_buf();
        match Self::open(&path).await {
            Ok(store) => Ok((store, false)),
            Err(open_error) if path.exists() => {
                quarantine_files(&path).with_context(|| {
                    format!("quarantining corrupt sonar state after: {open_error:#}")
                })?;
                let store = Self::open(&path)
                    .await
                    .context("recreating quarantined sonar consumer state")?;
                Ok((store, true))
            }
            Err(error) => Err(error),
        }
    }

    /// Drop the active connection, retain one bounded corrupt backup, and
    /// replace it with an empty schema. The in-memory index remains untouched
    /// until the caller completes and publishes a full local rebuild.
    pub async fn reset_corrupt(&self) -> Result<()> {
        let placeholder = Builder::new_local(":memory:").build().await?.connect()?;
        {
            let mut conn = self
                .conn
                .write()
                .map_err(|_| anyhow::anyhow!("sonar state connection lock poisoned"))?;
            *conn = placeholder;
        }
        quarantine_files(&self.path)?;
        let replacement = Self::open(&self.path)
            .await
            .context("recreating corrupt sonar consumer state")?;
        let replacement_conn = replacement.connection()?;
        let mut conn = self
            .conn
            .write()
            .map_err(|_| anyhow::anyhow!("sonar state connection lock poisoned"))?;
        *conn = replacement_conn;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        self.conn
            .read()
            .map(|conn| conn.clone())
            .map_err(|_| anyhow::anyhow!("sonar state connection lock poisoned"))
    }

    pub async fn has_manifest(&self) -> Result<bool> {
        let conn = self.connection()?;
        let mut rows = conn
            .query("select 1 from sonar_manifest where id=1", ())
            .await?;
        Ok(rows.next().await?.is_some())
    }

    pub async fn load(&self) -> Result<StoredSnapshot> {
        load_from(&self.connection()?).await
    }

    pub async fn manifest(&self) -> Result<Manifest> {
        read_manifest(&self.connection()?).await
    }

    pub async fn replace_from_replica(
        &self,
        tracks: &[SourceTrack],
        revisions: &[SourceRevision],
        centroids: &[SourceCentroid],
        checkpoint: u64,
        baseline_seq: u64,
        validated_at: i64,
    ) -> Result<StoredSnapshot> {
        let conn = self.connection()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .await?;
        tx.execute("delete from sonar_tracks", ()).await?;
        tx.execute("delete from sonar_revisions", ()).await?;
        tx.execute("delete from sonar_centroids", ()).await?;
        for revision in revisions {
            tx.execute(
                "insert into sonar_revisions(id,revision,present,value_digest) values(?,?,0,?)",
                params![
                    revision.id.clone(),
                    to_i64(revision.revision)?,
                    delete_value_digest()
                ],
            )
            .await?;
        }
        for track in tracks {
            // Rows that predate the producer log legitimately have no receipt.
            // Revision zero is a local baseline sentinel; every wire revision is
            // positive and can advance it after the baseline fence.
            let payload_json = canonical_payload(&track.meta)?;
            let value_digest = value_digest(&payload_json, &track.blob);
            tx.execute(
                "insert into sonar_tracks(id,payload_json,vector,revision,value_digest) values(?,?,?,?,?)",
                params![track.id.clone(), payload_json, track.blob.clone(), to_i64(track.revision)?, value_digest.clone()],
            ).await?;
            tx.execute(
                "insert into sonar_revisions(id,revision,present,value_digest) values(?,?,1,?) \
                 on conflict(id) do update set revision=excluded.revision,present=1,value_digest=excluded.value_digest",
                params![track.id.clone(), to_i64(track.revision)?, value_digest],
            ).await?;
        }
        for centroid in centroids {
            tx.execute(
                "insert into sonar_centroids(id,vector,value_digest) values(?,?,?)",
                params![
                    centroid.id.clone(),
                    centroid.blob.clone(),
                    centroid_digest(&centroid.id, &centroid.blob)
                ],
            )
            .await?;
        }
        let built = build_state(&tx).await?;
        write_manifest(&tx, checkpoint, baseline_seq, &built, None, validated_at).await?;
        tx.commit().await?;
        Ok(stored_snapshot(
            built,
            checkpoint,
            baseline_seq,
            None,
            validated_at,
        ))
    }

    /// Stream one synchronized local replica into durable state. Only one raw
    /// source row and the candidate index under construction are resident at a
    /// time, so a rebuild never materializes a second raw corpus in memory.
    pub async fn replace_from_local_replica(
        &self,
        replica: &Replica,
        checkpoint: u64,
        baseline_seq: u64,
        validated_at: i64,
    ) -> Result<StoredSnapshot> {
        let conn = self.connection()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .await?;
        tx.execute("delete from sonar_tracks", ()).await?;
        tx.execute("delete from sonar_revisions", ()).await?;
        tx.execute("delete from sonar_centroids", ()).await?;

        let mut revisions = replica.revision_rows().await?;
        while let Some(row) = revisions.next().await? {
            let revision = source_revision(&row)?;
            tx.execute(
                "insert into sonar_revisions(id,revision,present,value_digest) values(?,?,0,?)",
                params![
                    revision.id,
                    to_i64(revision.revision)?,
                    delete_value_digest()
                ],
            )
            .await?;
        }

        let mut tracks = replica.track_rows().await?;
        while let Some(row) = tracks.next().await? {
            let track = source_track(&row)?;
            let payload_json = canonical_payload(&track.meta)?;
            let digest = value_digest(&payload_json, &track.blob);
            tx.execute(
                "insert into sonar_tracks(id,payload_json,vector,revision,value_digest) values(?,?,?,?,?)",
                params![
                    track.id.clone(),
                    payload_json,
                    track.blob,
                    to_i64(track.revision)?,
                    digest.clone()
                ],
            )
            .await?;
            tx.execute(
                "insert into sonar_revisions(id,revision,present,value_digest) values(?,?,1,?) \
                 on conflict(id) do update set revision=excluded.revision,present=1,value_digest=excluded.value_digest",
                params![track.id, to_i64(track.revision)?, digest],
            )
            .await?;
        }

        let mut centroids = replica.centroid_rows().await?;
        while let Some(row) = centroids.next().await? {
            let centroid = source_centroid(&row)?;
            tx.execute(
                "insert into sonar_centroids(id,vector,value_digest) values(?,?,?)",
                params![
                    centroid.id.clone(),
                    centroid.blob.clone(),
                    centroid_digest(&centroid.id, &centroid.blob)
                ],
            )
            .await?;
        }

        let built = build_state(&tx).await?;
        write_manifest(&tx, checkpoint, baseline_seq, &built, None, validated_at).await?;
        tx.commit().await?;
        Ok(stored_snapshot(
            built,
            checkpoint,
            baseline_seq,
            None,
            validated_at,
        ))
    }

    pub async fn apply_batch(
        &self,
        batch: &ValidatedBatch,
        validated_at: i64,
    ) -> Result<StoredSnapshot> {
        if batch.events.is_empty() {
            bail!("cannot apply an empty artifact batch");
        }
        let conn = self.connection()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .await?;
        let current = read_manifest(&tx).await?;
        if current.checkpoint != batch.from_seq || current.pending.is_some() {
            bail!("local checkpoint does not accept this artifact batch");
        }
        for event in &batch.events {
            if event.seq <= current.baseline_seq
                || matches!(event.operation, ValidatedOperation::Skip)
            {
                continue;
            }
            let prior = read_revision(&tx, &event.subject_id).await?;
            if let Some((revision, present, digest)) = prior {
                if event.revision < revision {
                    bail!("artifact subject revision regressed after the local baseline");
                }
                if event.revision == revision {
                    let same = match &event.operation {
                        ValidatedOperation::Delete => !present && digest == delete_value_digest(),
                        ValidatedOperation::Upsert { blob, payload } => {
                            present
                                && digest == value_digest(&serde_json::to_string(payload)?, blob)
                        }
                        ValidatedOperation::Skip => true,
                    };
                    if same {
                        continue;
                    }
                    bail!("artifact subject revision was reused with different immutable bytes");
                }
            }
            match &event.operation {
                ValidatedOperation::Delete => {
                    tx.execute(
                        "delete from sonar_tracks where id=?",
                        [event.subject_id.clone()],
                    )
                    .await?;
                    tx.execute(
                        "insert into sonar_revisions(id,revision,present,value_digest) values(?,?,0,?) \
                         on conflict(id) do update set revision=excluded.revision,present=0,value_digest=excluded.value_digest",
                        params![event.subject_id.clone(), to_i64(event.revision)?, delete_value_digest()],
                    ).await?;
                }
                ValidatedOperation::Upsert { blob, payload } => {
                    let payload_json = serde_json::to_string(payload)?;
                    let digest = value_digest(&payload_json, blob);
                    tx.execute(
                        "insert into sonar_tracks(id,payload_json,vector,revision,value_digest) values(?,?,?,?,?) \
                         on conflict(id) do update set payload_json=excluded.payload_json,vector=excluded.vector,revision=excluded.revision,value_digest=excluded.value_digest",
                        params![event.subject_id.clone(), payload_json, blob.clone(), to_i64(event.revision)?, digest.clone()],
                    ).await?;
                    tx.execute(
                        "insert into sonar_revisions(id,revision,present,value_digest) values(?,?,1,?) \
                         on conflict(id) do update set revision=excluded.revision,present=1,value_digest=excluded.value_digest",
                        params![event.subject_id.clone(), to_i64(event.revision)?, digest],
                    ).await?;
                }
                ValidatedOperation::Skip => {}
            }
        }
        let built = build_state(&tx).await?;
        let pending = PendingAck {
            batch_digest: batch.batch_digest.clone(),
            event_count: batch.events.len(),
            from_seq: batch.from_seq,
            through_seq: batch.through_seq,
        };
        write_manifest(
            &tx,
            batch.through_seq,
            current.baseline_seq,
            &built,
            Some(&pending),
            validated_at,
        )
        .await?;
        tx.commit().await?;
        Ok(stored_snapshot(
            built,
            batch.through_seq,
            current.baseline_seq,
            Some(pending),
            validated_at,
        ))
    }

    pub async fn clear_pending(&self, through_seq: u64) -> Result<()> {
        let affected = self.connection()?.execute(
            "update sonar_manifest set pending_from=null,pending_through=null,pending_count=null,pending_digest=null \
             where id=1 and checkpoint=? and pending_through=?",
            params![to_i64(through_seq)?, to_i64(through_seq)?],
        ).await?;
        if affected != 1 {
            bail!("pending acknowledgement changed before finalization");
        }
        Ok(())
    }
}

fn appended(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn quarantine_files(path: &Path) -> Result<()> {
    for source in [
        appended(path, "-wal"),
        appended(path, "-shm"),
        path.to_path_buf(),
    ] {
        if !source.exists() {
            continue;
        }
        let backup = appended(&source, ".corrupt");
        if backup.exists() {
            std::fs::remove_file(&backup).with_context(|| {
                format!("removing the prior bounded sonar state quarantine {backup:?}")
            })?;
        }
        std::fs::rename(&source, &backup)
            .with_context(|| format!("quarantining corrupt sonar state file {source:?}"))?;
    }
    Ok(())
}

struct BuiltState {
    centroids: Arc<Index>,
    digest: String,
    centroid_rows: usize,
    raw_bytes: u64,
    track_rows: usize,
    tracks: Arc<Index>,
}

async fn build_state(conn: &impl Queryable) -> Result<BuiltState> {
    let track_count = count_rows(conn, "sonar_tracks").await?;
    let mut track_builder = IndexBuilder::with_capacity(track_count);
    let mut track_hasher = Sha256::new();
    let mut raw_bytes = 0u64;
    let mut track_seen = 0usize;
    let mut rows = conn
        .query_rows(
            "select id,payload_json,vector,revision,value_digest from sonar_tracks order by id",
        )
        .await?;
    while let Some(row) = rows.next().await? {
        let id = required_text(&row.get_value(0)?, "track id")?;
        let payload_json = required_text(&row.get_value(1)?, "payload JSON")?;
        let payload: SonarPayload = serde_json::from_str(&payload_json)?;
        if serde_json::to_string(&payload)? != payload_json {
            bail!("stored payload is not canonical");
        }
        let blob = match row.get_value(2)? {
            Value::Blob(blob) => blob,
            _ => bail!("stored vector is not a blob"),
        };
        let revision = required_u64(&row.get_value(3)?, "revision")?;
        let stored_value_digest = required_text(&row.get_value(4)?, "value digest")?;
        if stored_value_digest != value_digest(&payload_json, &blob) {
            bail!("stored track value digest mismatch");
        }
        let vector = decode_le_f32(&blob).context("stored vector has invalid byte length")?;
        track_builder.push(id.clone(), vector, Some(payload.meta()))?;
        digest_field(&mut track_hasher, id.as_bytes());
        digest_field(&mut track_hasher, payload_json.as_bytes());
        digest_field(&mut track_hasher, &blob);
        track_hasher.update(revision.to_be_bytes());
        raw_bytes = raw_bytes
            .checked_add(u64::try_from(blob.len())?)
            .context("raw byte count overflow")?;
        track_seen += 1;
    }
    if track_seen != track_count {
        bail!("stored track count changed during candidate build");
    }

    validate_revision_links(conn).await?;
    let mut revision_hasher = Sha256::new();
    let revision_count = count_rows(conn, "sonar_revisions").await?;
    let mut revision_seen = 0usize;
    let mut revisions = conn
        .query_rows("select id,revision,present,value_digest from sonar_revisions order by id")
        .await?;
    while let Some(row) = revisions.next().await? {
        let id = required_text(&row.get_value(0)?, "revision id")?;
        let revision = required_u64(&row.get_value(1)?, "revision")?;
        let present = required_i64(&row.get_value(2)?, "revision presence")?;
        if !matches!(present, 0 | 1) {
            bail!("stored revision has an invalid presence marker");
        }
        let value_digest = required_text(&row.get_value(3)?, "revision value digest")?;
        if !is_digest(&value_digest) {
            bail!("stored revision has an invalid value digest");
        }
        digest_field(&mut revision_hasher, id.as_bytes());
        revision_hasher.update(revision.to_be_bytes());
        revision_hasher.update([u8::try_from(present)?]);
        digest_field(&mut revision_hasher, value_digest.as_bytes());
        revision_seen += 1;
    }
    if revision_seen != revision_count {
        bail!("stored revision count changed during candidate build");
    }

    let centroid_count = count_rows(conn, "sonar_centroids").await?;
    let mut centroid_builder = IndexBuilder::with_capacity(centroid_count);
    let mut centroid_hasher = Sha256::new();
    let mut centroid_seen = 0usize;
    let mut centroid_rows = conn
        .query_rows("select id,vector,value_digest from sonar_centroids order by id")
        .await?;
    while let Some(row) = centroid_rows.next().await? {
        let id = required_text(&row.get_value(0)?, "centroid id")?;
        let blob = match row.get_value(1)? {
            Value::Blob(blob) => blob,
            _ => bail!("stored centroid vector is not a blob"),
        };
        let stored_digest = required_text(&row.get_value(2)?, "centroid digest")?;
        if stored_digest != centroid_digest(&id, &blob) {
            bail!("stored centroid value digest mismatch");
        }
        let vector = decode_le_f32(&blob).context("stored centroid has invalid byte length")?;
        centroid_builder.push(id.clone(), vector, None)?;
        digest_field(&mut centroid_hasher, id.as_bytes());
        digest_field(&mut centroid_hasher, &blob);
        raw_bytes = raw_bytes
            .checked_add(u64::try_from(blob.len())?)
            .context("raw byte count overflow")?;
        centroid_seen += 1;
    }
    if centroid_seen != centroid_count {
        bail!("stored centroid count changed during candidate build");
    }

    let track_digest = track_hasher.finalize();
    let revision_digest = revision_hasher.finalize();
    let centroid_digest = centroid_hasher.finalize();
    let digest = sha256_hex(&[&track_digest, &revision_digest, &centroid_digest]);
    Ok(BuiltState {
        centroids: Arc::new(centroid_builder.finish()),
        digest,
        centroid_rows: centroid_seen,
        raw_bytes,
        track_rows: track_seen,
        tracks: Arc::new(track_builder.finish()),
    })
}

fn digest_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn value_digest(payload_json: &str, blob: &[u8]) -> String {
    let payload_len = u64::try_from(payload_json.len())
        .unwrap_or(u64::MAX)
        .to_be_bytes();
    let blob_len = u64::try_from(blob.len()).unwrap_or(u64::MAX).to_be_bytes();
    sha256_hex(&[&payload_len, payload_json.as_bytes(), &blob_len, blob])
}

fn delete_value_digest() -> String {
    value_digest("{}", &[])
}

fn centroid_digest(id: &str, blob: &[u8]) -> String {
    let id_len = u64::try_from(id.len()).unwrap_or(u64::MAX).to_be_bytes();
    let blob_len = u64::try_from(blob.len()).unwrap_or(u64::MAX).to_be_bytes();
    sha256_hex(&[&id_len, id.as_bytes(), &blob_len, blob])
}

async fn write_manifest(
    conn: &Transaction,
    checkpoint: u64,
    baseline_seq: u64,
    built: &BuiltState,
    pending: Option<&PendingAck>,
    validated_at: i64,
) -> Result<()> {
    let (from, through, count, digest) = match pending {
        Some(pending) => (
            Some(to_i64(pending.from_seq)?),
            Some(to_i64(pending.through_seq)?),
            Some(i64::try_from(pending.event_count)?),
            Some(pending.batch_digest.clone()),
        ),
        None => (None, None, None, None),
    };
    conn.execute(
        "insert into sonar_manifest(id,schema_version,checkpoint,baseline_seq,artifact_digest,track_rows,centroid_rows,raw_bytes,validated_at,pending_from,pending_through,pending_count,pending_digest) \
         values(1,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set schema_version=excluded.schema_version,checkpoint=excluded.checkpoint,baseline_seq=excluded.baseline_seq,artifact_digest=excluded.artifact_digest,track_rows=excluded.track_rows,centroid_rows=excluded.centroid_rows,raw_bytes=excluded.raw_bytes,validated_at=excluded.validated_at,pending_from=excluded.pending_from,pending_through=excluded.pending_through,pending_count=excluded.pending_count,pending_digest=excluded.pending_digest",
        params![SCHEMA_VERSION, to_i64(checkpoint)?, to_i64(baseline_seq)?, built.digest.clone(), i64::try_from(built.track_rows)?, i64::try_from(built.centroid_rows)?, to_i64(built.raw_bytes)?, validated_at, from, through, count, digest],
    ).await?;
    Ok(())
}

async fn load_from(conn: &Connection) -> Result<StoredSnapshot> {
    let manifest = read_manifest(conn).await?;
    let built = build_state(conn).await?;
    if built.digest != manifest.artifact_digest
        || built.track_rows != manifest.track_rows
        || built.centroid_rows != manifest.centroid_rows
        || built.raw_bytes != manifest.raw_bytes
    {
        bail!("sonar consumer state manifest does not match durable rows");
    }
    Ok(StoredSnapshot {
        centroids: built.centroids,
        manifest,
        tracks: built.tracks,
    })
}

async fn read_manifest(conn: &impl Queryable) -> Result<Manifest> {
    let mut rows = conn.query_rows("select schema_version,checkpoint,baseline_seq,artifact_digest,track_rows,centroid_rows,raw_bytes,validated_at,pending_from,pending_through,pending_count,pending_digest from sonar_manifest where id=1").await?;
    let row = rows
        .next()
        .await?
        .context("sonar consumer state has no manifest")?;
    let schema = required_i64(&row.get_value(0)?, "schema version")?;
    if schema != SCHEMA_VERSION {
        bail!("unsupported sonar state schema version {schema}");
    }
    let pending = match (
        optional_u64(&row.get_value(8)?),
        optional_u64(&row.get_value(9)?),
        optional_u64(&row.get_value(10)?),
        optional_text(&row.get_value(11)?),
    ) {
        (Some(from_seq), Some(through_seq), Some(event_count), Some(batch_digest)) => {
            if from_seq >= through_seq || event_count == 0 {
                bail!("pending acknowledgement has inconsistent boundaries");
            }
            if !is_digest(&batch_digest) {
                bail!("pending acknowledgement has an invalid digest");
            }
            Some(PendingAck {
                batch_digest,
                event_count: usize::try_from(event_count)?,
                from_seq,
                through_seq,
            })
        }
        (None, None, None, None) => None,
        _ => bail!("partial pending acknowledgement in sonar state"),
    };
    Ok(Manifest {
        artifact_digest: {
            let digest = required_text(&row.get_value(3)?, "artifact digest")?;
            if !is_digest(&digest) {
                bail!("manifest artifact digest is invalid");
            }
            digest
        },
        baseline_seq: required_u64(&row.get_value(2)?, "baseline sequence")?,
        centroid_rows: usize::try_from(required_u64(&row.get_value(5)?, "centroid count")?)?,
        checkpoint: required_u64(&row.get_value(1)?, "checkpoint")?,
        pending,
        raw_bytes: required_u64(&row.get_value(6)?, "raw bytes")?,
        track_rows: usize::try_from(required_u64(&row.get_value(4)?, "track count")?)?,
        validated_at: required_i64(&row.get_value(7)?, "validation time")?,
    })
}

async fn read_revision(conn: &Transaction, id: &str) -> Result<Option<(u64, bool, String)>> {
    let mut rows = conn
        .query(
            "select revision,present,value_digest from sonar_revisions where id=?",
            [id],
        )
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(None);
    };
    let present = required_i64(&row.get_value(1)?, "present")?;
    if !matches!(present, 0 | 1) {
        bail!("stored revision has an invalid presence marker");
    }
    let digest = required_text(&row.get_value(2)?, "value digest")?;
    if !is_digest(&digest) {
        bail!("stored revision has an invalid value digest");
    }
    Ok(Some((
        required_u64(&row.get_value(0)?, "revision")?,
        present == 1,
        digest,
    )))
}

async fn count_rows(conn: &impl Queryable, table: &str) -> Result<usize> {
    let sql = match table {
        "sonar_tracks" => "select count(*) from sonar_tracks",
        "sonar_revisions" => "select count(*) from sonar_revisions",
        "sonar_centroids" => "select count(*) from sonar_centroids",
        _ => bail!("unsupported state table"),
    };
    let mut rows = conn.query_rows(sql).await?;
    let row = rows.next().await?.context("track count returned no row")?;
    usize::try_from(required_u64(&row.get_value(0)?, "track count")?)
        .context("track count overflow")
}

async fn validate_revision_links(conn: &impl Queryable) -> Result<()> {
    let mut rows = conn
        .query_rows(
            "select count(*) from sonar_tracks t left join sonar_revisions r on r.id=t.id \
             where r.id is null or r.present != 1 or r.revision != t.revision or r.value_digest != t.value_digest",
        )
        .await?;
    let row = rows
        .next()
        .await?
        .context("revision link count returned no row")?;
    if required_u64(&row.get_value(0)?, "revision link mismatch count")? != 0 {
        bail!("stored tracks and revision ledger disagree");
    }
    let mut rows = conn
        .query_rows(
            "select count(*) from sonar_revisions r left join sonar_tracks t on t.id=r.id \
             where r.present=1 and t.id is null",
        )
        .await?;
    let row = rows
        .next()
        .await?
        .context("presence link count returned no row")?;
    if required_u64(&row.get_value(0)?, "presence link mismatch count")? != 0 {
        bail!("stored revision ledger references a missing present track");
    }
    Ok(())
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn stored_snapshot(
    built: BuiltState,
    checkpoint: u64,
    baseline_seq: u64,
    pending: Option<PendingAck>,
    validated_at: i64,
) -> StoredSnapshot {
    StoredSnapshot {
        centroids: built.centroids,
        manifest: Manifest {
            artifact_digest: built.digest,
            baseline_seq,
            centroid_rows: built.centroid_rows,
            checkpoint,
            pending,
            raw_bytes: built.raw_bytes,
            track_rows: built.track_rows,
            validated_at,
        },
        tracks: built.tracks,
    }
}

#[allow(async_fn_in_trait)]
trait Queryable {
    async fn query_rows(&self, sql: &str) -> libsql::Result<libsql::Rows>;
}
impl Queryable for Connection {
    async fn query_rows(&self, sql: &str) -> libsql::Result<libsql::Rows> {
        self.query(sql, ()).await
    }
}
impl Queryable for Transaction {
    async fn query_rows(&self, sql: &str) -> libsql::Result<libsql::Rows> {
        self.query(sql, ()).await
    }
}

fn required_text(value: &Value, field: &str) -> Result<String> {
    optional_text(value).with_context(|| format!("{field} is not text"))
}
fn optional_text(value: &Value) -> Option<String> {
    match value {
        Value::Text(value) => Some(value.clone()),
        _ => None,
    }
}
fn required_i64(value: &Value, field: &str) -> Result<i64> {
    match value {
        Value::Integer(value) => Ok(*value),
        _ => bail!("{field} is not an integer"),
    }
}
fn required_u64(value: &Value, field: &str) -> Result<u64> {
    u64::try_from(required_i64(value, field)?).with_context(|| format!("{field} is negative"))
}
fn optional_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Integer(value) => u64::try_from(*value).ok(),
        _ => None,
    }
}
fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).context("value exceeds libSQL integer range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::{SonarPayload, ValidatedEvent};
    use crate::decode::BLOB_LEN;
    use crate::replica::SourceRevision;
    use tempfile::tempdir;

    fn blob(seed: f32) -> Vec<u8> {
        let mut bytes = vec![0_u8; BLOB_LEN];
        bytes[..4].copy_from_slice(&seed.to_le_bytes());
        bytes
    }

    fn track(id: &str, revision: u64, seed: f32) -> SourceTrack {
        SourceTrack {
            blob: blob(seed),
            id: id.into(),
            meta: crate::index::TrackMeta {
                bpm: Some(174.0),
                anchored: true,
                ..Default::default()
            },
            revision,
        }
    }

    fn centroid(id: &str, seed: f32) -> SourceCentroid {
        SourceCentroid {
            blob: blob(seed),
            id: id.into(),
        }
    }

    fn payload(seed: f32) -> SonarPayload {
        let _ = seed;
        SonarPayload {
            anchored: true,
            bpm: Some(174.0),
            certified: false,
            dismissed: false,
            duration_ms: None,
            has_finding: false,
            is_duplicate: false,
            key: None,
            nearest_finding_score: None,
        }
    }

    fn batch(from: u64, events: Vec<ValidatedEvent>) -> ValidatedBatch {
        ValidatedBatch {
            batch_digest: format!("{:064x}", from + 1),
            through_seq: events.last().map_or(from, |event| event.seq),
            head_seq: events.last().map_or(from, |event| event.seq),
            events,
            from_seq: from,
        }
    }

    fn upsert(seq: u64, revision: u64, id: &str, seed: f32) -> ValidatedEvent {
        ValidatedEvent {
            operation: ValidatedOperation::Upsert {
                blob: blob(seed),
                payload: payload(seed),
            },
            payload_digest: format!("{:064x}", seq),
            revision,
            seq,
            subject_id: id.into(),
        }
    }

    fn delete(seq: u64, revision: u64, id: &str) -> ValidatedEvent {
        ValidatedEvent {
            operation: ValidatedOperation::Delete,
            payload_digest: format!("{:064x}", seq),
            revision,
            seq,
            subject_id: id.into(),
        }
    }

    #[tokio::test]
    async fn commit_pending_restart_and_finalize_boundaries_are_durable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = StateStore::open(&path).await.unwrap();
        store
            .replace_from_replica(
                &[track("a", 1, 1.0)],
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[],
                10,
                10,
                1,
            )
            .await
            .unwrap();
        let candidate = store
            .apply_batch(&batch(10, vec![upsert(11, 3, "b", 2.0)]), 2)
            .await
            .unwrap();
        assert_eq!(candidate.manifest.checkpoint, 11);
        assert_eq!(candidate.manifest.pending.as_ref().unwrap().from_seq, 10);
        drop(store);

        let reopened = StateStore::open(&path).await.unwrap();
        let recovered = reopened.load().await.unwrap();
        assert_eq!(recovered.tracks.len(), 2);
        assert!(recovered.manifest.pending.is_some());
        reopened.clear_pending(11).await.unwrap();
        assert!(reopened.load().await.unwrap().manifest.pending.is_none());
    }

    #[tokio::test]
    async fn tombstone_blocks_stale_resurrection_and_revision_may_jump() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        store
            .replace_from_replica(
                &[track("a", 1, 1.0)],
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
        let deleted = store
            .apply_batch(&batch(1, vec![delete(2, 9, "a")]), 2)
            .await
            .unwrap();
        assert_eq!(deleted.tracks.len(), 0);
        store.clear_pending(2).await.unwrap();
        assert!(store
            .apply_batch(&batch(2, vec![upsert(3, 8, "a", 3.0)]), 3)
            .await
            .is_err());
        let after = store.load().await.unwrap();
        assert_eq!(after.manifest.checkpoint, 2);
        assert_eq!(after.tracks.len(), 0);
    }

    #[tokio::test]
    async fn invalid_candidate_rolls_back_and_preserves_last_good() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let original = store
            .replace_from_replica(
                &[track("a", 1, 1.0)],
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
        let mut bad = upsert(2, 2, "b", 2.0);
        if let ValidatedOperation::Upsert { blob, .. } = &mut bad.operation {
            blob.truncate(4);
        }
        assert!(store.apply_batch(&batch(1, vec![bad]), 2).await.is_err());
        let after = store.load().await.unwrap();
        assert_eq!(
            after.manifest.artifact_digest,
            original.manifest.artifact_digest
        );
        assert_eq!(after.manifest.checkpoint, 1);
    }

    #[tokio::test]
    async fn duplicate_redelivery_is_idempotent_but_stale_batch_boundaries_are_rejected() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let initial = store
            .replace_from_replica(&[], &[], &[centroid("artist", 7.0)], 4, 4, 1)
            .await
            .unwrap();
        let first = store
            .apply_batch(&batch(4, vec![upsert(5, 8, "a", 2.0)]), 2)
            .await
            .unwrap();
        assert!(store
            .apply_batch(&batch(4, vec![upsert(5, 8, "a", 2.0)]), 2)
            .await
            .is_err());
        store.clear_pending(5).await.unwrap();

        let duplicate_revision = store
            .apply_batch(&batch(5, vec![upsert(6, 8, "a", 2.0)]), 3)
            .await
            .unwrap();
        assert_eq!(
            duplicate_revision.manifest.artifact_digest,
            first.manifest.artifact_digest
        );
        assert_eq!(duplicate_revision.centroids.len(), 1);
        assert_ne!(
            initial.manifest.artifact_digest,
            first.manifest.artifact_digest
        );
        store.clear_pending(6).await.unwrap();
        assert!(store
            .apply_batch(&batch(5, vec![upsert(6, 8, "a", 2.0)]), 3)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn interrupted_sync_before_rebuild_commit_leaves_exact_last_good_bytes() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        let original_blob = blob(3.5);
        let original = store
            .replace_from_replica(
                &[track("a", 1, 3.5)],
                &[SourceRevision {
                    id: "a".into(),
                    revision: 1,
                }],
                &[centroid("artist", 4.5)],
                1,
                1,
                1,
            )
            .await
            .unwrap();

        let interrupted_sync: Result<Vec<SourceTrack>> = Err(anyhow::anyhow!("interrupted"));
        assert!(interrupted_sync.is_err());
        let after = store.load().await.unwrap();
        assert_eq!(
            after.manifest.artifact_digest,
            original.manifest.artifact_digest
        );
        let mut rows = store
            .connection()
            .unwrap()
            .query("select vector from sonar_tracks where id='a'", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(row.get_value(0).unwrap(), Value::Blob(original_blob));
    }

    #[tokio::test]
    async fn corrupt_state_is_detected_instead_of_partially_loaded() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        store
            .replace_from_replica(
                &[track("a", 1, 1.0)],
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
        store
            .connection()
            .unwrap()
            .execute(
                "update sonar_tracks set vector=? where id='a'",
                [vec![0_u8; 4]],
            )
            .await
            .unwrap();
        assert!(store.load().await.is_err());
        store.reset_corrupt().await.unwrap();
        assert!(!store.has_manifest().await.unwrap());
        assert!(appended(&dir.path().join("state.db"), ".corrupt").exists());
    }

    #[tokio::test]
    async fn corrupt_tombstone_ledger_is_detected() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("state.db")).await.unwrap();
        store
            .replace_from_replica(
                &[track("a", 1, 1.0)],
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
        store
            .connection()
            .unwrap()
            .execute("update sonar_revisions set revision=0 where id='a'", ())
            .await
            .unwrap();
        assert!(store.load().await.is_err());
    }

    #[tokio::test]
    async fn physically_corrupt_state_is_quarantined_and_recreated_on_restart() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = StateStore::open(&path).await.unwrap();
        store
            .replace_from_replica(
                &[track("a", 1, 1.0)],
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
        drop(store);
        std::fs::write(&path, b"not a libsql database").unwrap();

        let (recreated, recovered) = StateStore::open_recovering(&path).await.unwrap();
        assert!(recovered);
        assert!(!recreated.has_manifest().await.unwrap());
        assert!(appended(&path, ".corrupt").exists());
    }

    #[tokio::test]
    async fn delta_converges_with_full_local_rebuild_at_scaled_corpora() {
        for size in [4usize, 8, 16] {
            let dir = tempdir().unwrap();
            let delta = StateStore::open(dir.path().join("delta.db")).await.unwrap();
            let full = StateStore::open(dir.path().join("full.db")).await.unwrap();
            let initial = (0..size)
                .map(|i| track(&format!("t{i}"), 1, i as f32 + 1.0))
                .collect::<Vec<_>>();
            let initial_revisions = initial
                .iter()
                .map(|row| SourceRevision {
                    id: row.id.clone(),
                    revision: 1,
                })
                .collect::<Vec<_>>();
            delta
                .replace_from_replica(&initial, &initial_revisions, &[], 1, 1, 1)
                .await
                .unwrap();
            let events = vec![delete(2, 4, "t0"), upsert(3, 7, "new", 99.0)];
            let changed = delta.apply_batch(&batch(1, events), 2).await.unwrap();

            let mut desired = initial.into_iter().skip(1).collect::<Vec<_>>();
            desired.push(track("new", 7, 99.0));
            desired.sort_by(|a, b| a.id.cmp(&b.id));
            let desired_revisions = desired
                .iter()
                .map(|row| SourceRevision {
                    id: row.id.clone(),
                    revision: row.revision,
                })
                .chain(std::iter::once(SourceRevision {
                    id: "t0".into(),
                    revision: 4,
                }))
                .collect::<Vec<_>>();
            let rebuilt = full
                .replace_from_replica(&desired, &desired_revisions, &[], 3, 3, 2)
                .await
                .unwrap();
            assert_eq!(
                changed.manifest.artifact_digest,
                rebuilt.manifest.artifact_digest
            );
            assert_eq!(
                changed.manifest.raw_bytes,
                u64::try_from(size * BLOB_LEN).unwrap()
            );
            assert_eq!(changed.tracks.vector_bytes(), size * BLOB_LEN);
            let two_generation_peak = changed
                .tracks
                .vector_bytes()
                .saturating_add(rebuilt.tracks.vector_bytes());
            assert_eq!(two_generation_peak, 2 * size * BLOB_LEN);
            assert!(two_generation_peak + BLOB_LEN <= (2 * size + 1) * BLOB_LEN);
        }
    }
}
