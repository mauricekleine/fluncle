//! Explicitly-synchronised embedded libSQL source replica.
//!
//! The remote is contacted only by [`libsql::Database::sync`]. Every corpus and
//! centroid SELECT runs against the local replica file.

use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{bail, Context, Result};
use libsql::{Builder, Connection, Database, Value};

use crate::artifact::{canonical_payload, extend_digest, snapshot_item_digest, EMPTY_DIGEST};
use crate::decode::decode_le_f32;
use crate::index::TrackMeta;

#[derive(Clone, Debug)]
pub struct SourceTrack {
    pub blob: Vec<u8>,
    pub id: String,
    pub meta: TrackMeta,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub struct SourceRevision {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub struct SourceCentroid {
    pub blob: Vec<u8>,
    pub id: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SyncStats {
    pub frame_no: Option<u64>,
    pub frames_synced: u64,
}

#[derive(Clone, Debug)]
pub struct LocalSnapshotPage {
    pub consumer_digest: String,
    pub consumer_item_count: u64,
    pub page_digest: String,
    pub rows: Vec<SourceTrack>,
}

pub struct Replica {
    db: Database,
    conn: Connection,
    #[cfg(test)]
    interrupt_next_sync: AtomicBool,
    #[cfg(test)]
    local_test_source: bool,
}

impl Replica {
    pub async fn open(path: impl AsRef<Path>, url: String, token: String) -> Result<Self> {
        let db = Builder::new_remote_replica(path, url, token)
            .build()
            .await
            .context("opening embedded libSQL replica")?;
        let conn = db
            .connect()
            .context("connecting to embedded libSQL replica")?;
        Ok(Self {
            db,
            conn,
            #[cfg(test)]
            interrupt_next_sync: AtomicBool::new(false),
            #[cfg(test)]
            local_test_source: false,
        })
    }

    #[cfg(test)]
    pub(crate) async fn open_local_test_source(path: impl AsRef<Path>) -> Result<Self> {
        let db = Builder::new_local(path)
            .build()
            .await
            .context("opening test local replica source")?;
        let conn = db
            .connect()
            .context("connecting to test local replica source")?;
        Ok(Self {
            db,
            conn,
            interrupt_next_sync: AtomicBool::new(false),
            local_test_source: true,
        })
    }

    #[cfg(test)]
    pub(crate) fn interrupt_next_sync(&self) {
        self.interrupt_next_sync.store(true, Ordering::SeqCst);
    }

    /// Pull committed frames explicitly. No `sync_interval` is configured.
    pub async fn sync(&self) -> Result<SyncStats> {
        #[cfg(test)]
        if self.interrupt_next_sync.swap(false, Ordering::SeqCst) {
            bail!("injected embedded replica sync interruption");
        }
        #[cfg(test)]
        if self.local_test_source {
            return Ok(SyncStats::default());
        }
        let result = self
            .db
            .sync()
            .await
            .context("synchronising embedded libSQL replica")?;
        Ok(SyncStats {
            frame_no: result.frame_no(),
            frames_synced: u64::try_from(result.frames_synced())
                .context("replica frame count overflow")?,
        })
    }

    pub async fn tracks(&self) -> Result<Vec<SourceTrack>> {
        read_tracks(&self.conn, None, None).await
    }

    pub(crate) async fn track_rows(&self) -> Result<libsql::Rows> {
        self.conn
            .query(TRACKS_SQL, ())
            .await
            .context("streaming tracks from local replica")
    }

    pub async fn snapshot_page(
        &self,
        after_id: Option<&str>,
        limit: usize,
        previous_digest: &str,
        previous_count: u64,
    ) -> Result<LocalSnapshotPage> {
        if limit == 0 || limit > 200 {
            bail!("artifact snapshot page limit must be 1..=200");
        }
        let rows = read_tracks(&self.conn, after_id, Some(limit)).await?;
        let mut item_digests = Vec::with_capacity(rows.len());
        for row in &rows {
            let payload = canonical_payload(&row.meta)?;
            item_digests.push(snapshot_item_digest(&row.id, &payload, &row.blob)?);
        }
        let page_digest = extend_digest(EMPTY_DIGEST, &item_digests)?;
        let consumer_digest = extend_digest(previous_digest, &item_digests)?;
        Ok(LocalSnapshotPage {
            consumer_digest,
            consumer_item_count: previous_count
                .checked_add(u64::try_from(rows.len())?)
                .context("snapshot item count overflow")?,
            page_digest,
            rows,
        })
    }

    pub async fn revisions(&self) -> Result<Vec<SourceRevision>> {
        let mut rows = self.revision_rows().await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(source_revision(&row)?);
        }
        Ok(out)
    }

    pub(crate) async fn revision_rows(&self) -> Result<libsql::Rows> {
        self.conn
            .query(
                "select subject_id, max(revision) from artifact_change_revisions \
                 where stream = 'sonar.track' and stream_version = 1 and subject_type = 'track' \
                 group by subject_id order by subject_id",
                (),
            )
            .await
            .context("streaming sonar revision receipts from local replica")
    }

    pub async fn artifact_head(&self) -> Result<u64> {
        let mut rows = self
            .conn
            .query(
                "select coalesce((select seq from sqlite_sequence where name='artifact_changes'), 0)",
                (),
            )
            .await
            .context("reading artifact head from local replica")?;
        let row = rows
            .next()
            .await?
            .context("artifact head returned no row")?;
        nonnegative_u64(&row.get_value(0)?).context("artifact head is invalid")
    }

    pub async fn centroids(&self) -> Result<Vec<SourceCentroid>> {
        let count = scalar_count(&self.conn, "select count(*) from artist_centroids").await?;
        let mut rows = self.centroid_rows().await?;
        let mut seen = 0usize;
        let mut out = Vec::with_capacity(count);
        while let Some(row) = rows.next().await? {
            out.push(source_centroid(&row)?);
            seen += 1;
        }
        if seen != count {
            bail!("centroid row count changed during local read");
        }
        Ok(out)
    }

    pub(crate) async fn centroid_rows(&self) -> Result<libsql::Rows> {
        self.conn
            .query(
                "select artist_id, centroid_blob from artist_centroids order by artist_id",
                (),
            )
            .await
            .context("streaming centroids from local replica")
    }
}

const TRACKS_SQL: &str =
    "select t.track_id, e.embedding_blob, t.key, t.bpm, t.spotify_uri, \
     f.track_id, f.log_id, t.dismissed_at, t.duplicate_of_track_id, \
     t.nearest_finding_score, t.duration_ms, coalesce(r.revision, 0) \
     from tracks t join track_embeddings e on e.track_id = t.track_id \
     left join findings f on f.track_id = t.track_id \
     left join (select subject_id, max(revision) revision from artifact_change_revisions \
       where stream='sonar.track' and stream_version=1 and subject_type='track' group by subject_id) r \
       on r.subject_id=t.track_id where length(e.embedding_blob)=4096 order by t.track_id";

async fn read_tracks(
    conn: &Connection,
    after_id: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<SourceTrack>> {
    let sql = if after_id.is_some() {
        "select t.track_id, e.embedding_blob, t.key, t.bpm, t.spotify_uri, \
         f.track_id, f.log_id, t.dismissed_at, t.duplicate_of_track_id, \
         t.nearest_finding_score, t.duration_ms, coalesce(r.revision, 0) \
         from tracks t join track_embeddings e on e.track_id = t.track_id \
         left join findings f on f.track_id = t.track_id \
         left join (select subject_id, max(revision) revision from artifact_change_revisions \
           where stream='sonar.track' and stream_version=1 and subject_type='track' group by subject_id) r \
           on r.subject_id=t.track_id where length(e.embedding_blob)=4096 and t.track_id > ? order by t.track_id limit ?"
    } else if limit.is_some() {
        "select t.track_id, e.embedding_blob, t.key, t.bpm, t.spotify_uri, \
         f.track_id, f.log_id, t.dismissed_at, t.duplicate_of_track_id, \
         t.nearest_finding_score, t.duration_ms, coalesce(r.revision, 0) \
         from tracks t join track_embeddings e on e.track_id = t.track_id \
         left join findings f on f.track_id = t.track_id \
         left join (select subject_id, max(revision) revision from artifact_change_revisions \
           where stream='sonar.track' and stream_version=1 and subject_type='track' group by subject_id) r \
           on r.subject_id=t.track_id where length(e.embedding_blob)=4096 order by t.track_id limit ?"
    } else {
        TRACKS_SQL
    };
    let mut rows = match (after_id, limit) {
        (Some(after), Some(limit)) => conn.query(sql, (after, i64::try_from(limit)?)).await?,
        (None, Some(limit)) => conn.query(sql, [i64::try_from(limit)?]).await?,
        (None, None) => conn.query(sql, ()).await?,
        (Some(_), None) => bail!("after_id requires a bounded limit"),
    };
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(source_track(&row)?);
    }
    Ok(out)
}

pub(crate) fn source_track(row: &libsql::Row) -> Result<SourceTrack> {
    let id = text(&row.get_value(0)?).context("track has invalid id")?;
    let blob = match row.get_value(1)? {
        Value::Blob(blob) if blob.len() == crate::decode::BLOB_LEN => blob,
        Value::Blob(blob) => bail!("track {id} blob is {} bytes", blob.len()),
        _ => bail!("track {id} does not contain a blob"),
    };
    let vector = decode_le_f32(&blob).context("validated blob failed to decode")?;
    if vector.iter().any(|value| !value.is_finite()) {
        bail!("track {id} vector contains non-finite floats");
    }
    let meta = TrackMeta {
        key: optional_text(&row.get_value(2)?, "track key")?,
        bpm: optional_f32(&row.get_value(3)?, "track bpm")?,
        anchored: !matches!(row.get_value(4)?, Value::Null),
        has_finding: !matches!(row.get_value(5)?, Value::Null),
        certified: !matches!(row.get_value(6)?, Value::Null),
        dismissed: !matches!(row.get_value(7)?, Value::Null),
        is_duplicate: !matches!(row.get_value(8)?, Value::Null),
        nearest_finding_score: optional_f32(&row.get_value(9)?, "nearest finding score")?,
        duration_ms: optional_u32(&row.get_value(10)?, "track duration")?,
    };
    let revision = nonnegative_u64(&row.get_value(11)?).context("track revision is invalid")?;
    Ok(SourceTrack {
        blob,
        id,
        meta,
        revision,
    })
}

pub(crate) fn source_revision(row: &libsql::Row) -> Result<SourceRevision> {
    let id = text(&row.get_value(0)?).context("revision receipt has invalid subject id")?;
    let revision =
        positive_u64(&row.get_value(1)?).context("revision receipt has invalid revision")?;
    Ok(SourceRevision { id, revision })
}

pub(crate) fn source_centroid(row: &libsql::Row) -> Result<SourceCentroid> {
    let id = text(&row.get_value(0)?).context("centroid has invalid artist id")?;
    let blob = match row.get_value(1)? {
        Value::Blob(blob) => blob,
        _ => bail!("centroid {id} does not contain a blob"),
    };
    let vector =
        decode_le_f32(&blob).with_context(|| format!("centroid {id} has invalid blob length"))?;
    if vector.iter().any(|value| !value.is_finite()) {
        bail!("centroid {id} vector contains non-finite floats");
    }
    Ok(SourceCentroid { blob, id })
}

async fn scalar_count(conn: &Connection, sql: &str) -> Result<usize> {
    let mut rows = conn.query(sql, ()).await?;
    let row = rows.next().await?.context("count query returned no row")?;
    match row.get_value(0)? {
        Value::Integer(value) => usize::try_from(value).context("count is out of range"),
        _ => bail!("count query returned non-integer"),
    }
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::Text(value) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}
fn optional_text(value: &Value, field: &str) -> Result<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::Text(value) => Ok(Some(value.clone())),
        _ => bail!("{field} has an invalid type"),
    }
}
fn optional_f32(value: &Value, field: &str) -> Result<Option<f32>> {
    let value = match value {
        Value::Null => return Ok(None),
        Value::Real(value) => *value,
        Value::Integer(value) => *value as f64,
        _ => bail!("{field} has an invalid type"),
    };
    let rounded = value as f32;
    if !value.is_finite() || !rounded.is_finite() {
        bail!("{field} is not a finite f32");
    }
    Ok(Some(rounded))
}
fn optional_u32(value: &Value, field: &str) -> Result<Option<u32>> {
    match value {
        Value::Null => Ok(None),
        Value::Integer(value) => Ok(Some(
            u32::try_from(*value).with_context(|| format!("{field} is out of range"))?,
        )),
        _ => bail!("{field} has an invalid type"),
    }
}
fn positive_u64(value: &Value) -> Option<u64> {
    nonnegative_u64(value).filter(|value| *value > 0)
}
fn nonnegative_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Integer(value) => u64::try_from(*value).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn artifact_head_survives_full_event_body_compaction() {
        let dir = tempfile::tempdir().unwrap();
        let db = Builder::new_local(dir.path().join("replica.db"))
            .build()
            .await
            .unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch(
            "create table artifact_changes(seq integer primary key autoincrement, body text);\
             insert into artifact_changes(body) values('one'),('two'),('three');\
             delete from artifact_changes;",
        )
        .await
        .unwrap();
        let replica = Replica {
            db,
            conn,
            interrupt_next_sync: AtomicBool::new(false),
            local_test_source: true,
        };

        assert_eq!(replica.artifact_head().await.unwrap(), 3);
    }
}
