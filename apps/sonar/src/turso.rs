//! Remote (read-only) Turso reads that build the two in-memory indexes.
//!
//! Uses the official `libsql` crate with a REMOTE connection (not an embedded
//! replica): `Builder::new_remote(url, token).build()`. TLS is rustls-backed
//! (`ring`), so the binary stays OpenSSL-free for a musl static build.

use anyhow::{Context, Result};
use libsql::{Builder, Connection, Value};
use tracing::warn;

use crate::decode::decode_le_f32;
use crate::index::{Entry, Index, TrackMeta};

/// One row per embedded track. `anchored = spotify_uri IS NOT NULL`,
/// `certified = a findings row with a Log ID exists`, `has_finding = ANY findings row`.
///
/// TWO NEGATIONS, NOT ONE. `certified` REQUIRES `f.log_id IS NOT NULL`, not merely a
/// findings row. `findings.log_id` is nullable (a straggler awaiting its one-time
/// coordinate backfill), and the app-wide meaning of "certified" — the certification
/// rail, "Fluncle speaks about it" — is the Log ID, not the row. The `/log` neighbours
/// surface filters `findings.log_id IS NOT NULL`, so `certified` here must match that
/// exactly or the flag flip could surface an un-coordinated finding on `/log`.
/// `has_finding` is the WEAKER fact the `/recommendations` catalogue predicate needs
/// (`f.track_id IS NULL` — no findings row at all); that straggler is `has_finding:
/// true, certified: false`, so the two can never be collapsed into one column.
///
/// `findings.track_id` is that table's PRIMARY KEY, so this single LEFT JOIN yields at
/// most one row per track and both facts read off it — no second join, no fan-out.
///
/// THE VECTOR COMES FROM `track_embeddings`, NOT FROM `tracks`. The blob was moved out of
/// the hot table into a satellite keyed 1:1 by `track_id` (apps/web/src/db/schema.ts), and
/// that join is INNER here — membership in the satellite IS "this track has a vector", so
/// it replaces the old `where t.embedding_blob is not null` exactly. The Worker's
/// `/recommendations` predicate reads the same satellite, which is what keeps sonar's index
/// membership clause-for-clause identical to the Turso path it stands in for
/// (docs/vector-serving.md).
///
/// DEPLOY ORDER: this binary must not ship ahead of the Worker migration that creates the
/// table, or every refresh fails and the box keeps serving its last snapshot until it does.
const TRACKS_SQL: &str =
    "select t.track_id, e.embedding_blob, t.key, t.bpm, t.spotify_uri, f.track_id as finding_id, \
     f.log_id as finding_log_id, t.dismissed_at, t.duplicate_of_track_id, \
     t.nearest_finding_score, t.duration_ms \
     from tracks t \
     join track_embeddings e on e.track_id = t.track_id \
     left join findings f on f.track_id = t.track_id";

/// One row per artist centroid (no metadata for the pilot).
const CENTROIDS_SQL: &str = "select ac.artist_id, ac.centroid_blob from artist_centroids ac";

/// Connect remotely and load both indexes. On any error the caller keeps its
/// current snapshot (never swaps in an empty index on a transient blip).
pub async fn load_indexes(url: &str, token: &str) -> Result<(Index, Index)> {
    let db = Builder::new_remote(url.to_string(), token.to_string())
        .build()
        .await
        .context("building remote libsql connection")?;
    let conn = db.connect().context("opening libsql connection")?;

    let tracks = load_tracks(&conn).await.context("loading tracks index")?;
    let centroids = load_centroids(&conn)
        .await
        .context("loading centroids index")?;
    Ok((tracks, centroids))
}

/// Read a column as an optional String (Text → Some, Null → None).
fn text_opt(v: &Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s.clone()),
        _ => None,
    }
}

/// Read a numeric column as an optional f32 (Real/Integer → Some, else None).
fn f32_opt(v: &Value) -> Option<f32> {
    match v {
        Value::Real(r) => Some(*r as f32),
        Value::Integer(i) => Some(*i as f32),
        _ => None,
    }
}

/// Read a numeric column as an optional u32 (Integer in range → Some, else None).
///
/// A NULL, a non-integer, or a value outside `u32` (which no real `duration_ms`
/// carries) all read as `None` — which FAILS a `duration_ms_max` constraint, so a
/// corrupt row is excluded rather than silently admitted. Fail-closed on purpose.
fn u32_opt(v: &Value) -> Option<u32> {
    match v {
        Value::Integer(i) => u32::try_from(*i).ok(),
        _ => None,
    }
}

async fn load_tracks(conn: &Connection) -> Result<Index> {
    let mut rows = conn.query(TRACKS_SQL, ()).await?;
    let mut entries: Vec<Entry> = Vec::new();
    let mut skipped = 0usize;

    while let Some(row) = rows.next().await? {
        let track_id = match text_opt(&row.get_value(0)?) {
            Some(id) => id,
            None => {
                skipped += 1;
                continue;
            }
        };
        let blob = match row.get_value(1)? {
            Value::Blob(b) => b,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let vector = match decode_le_f32(&blob) {
            Some(v) => v,
            None => {
                warn!(
                    track_id,
                    len = blob.len(),
                    "skipping track: bad embedding blob length"
                );
                skipped += 1;
                continue;
            }
        };

        let key = text_opt(&row.get_value(2)?);
        let bpm = f32_opt(&row.get_value(3)?);
        let anchored = !matches!(row.get_value(4)?, Value::Null);
        let has_finding = !matches!(row.get_value(5)?, Value::Null);
        let certified = !matches!(row.get_value(6)?, Value::Null);
        let dismissed = !matches!(row.get_value(7)?, Value::Null);
        let is_duplicate = !matches!(row.get_value(8)?, Value::Null);
        let nearest_finding_score = f32_opt(&row.get_value(9)?);
        let duration_ms = u32_opt(&row.get_value(10)?);

        entries.push(Entry {
            id: track_id,
            vector,
            meta: Some(TrackMeta {
                key,
                bpm,
                anchored,
                certified,
                has_finding,
                dismissed,
                is_duplicate,
                nearest_finding_score,
                duration_ms,
            }),
        });
    }

    if skipped > 0 {
        warn!(skipped, "skipped malformed track rows during load");
    }
    Ok(Index::from_entries(entries))
}

async fn load_centroids(conn: &Connection) -> Result<Index> {
    let mut rows = conn.query(CENTROIDS_SQL, ()).await?;
    let mut entries: Vec<Entry> = Vec::new();
    let mut skipped = 0usize;

    while let Some(row) = rows.next().await? {
        let artist_id = match text_opt(&row.get_value(0)?) {
            Some(id) => id,
            None => {
                skipped += 1;
                continue;
            }
        };
        let blob = match row.get_value(1)? {
            Value::Blob(b) => b,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let vector = match decode_le_f32(&blob) {
            Some(v) => v,
            None => {
                warn!(
                    artist_id,
                    len = blob.len(),
                    "skipping centroid: bad blob length"
                );
                skipped += 1;
                continue;
            }
        };
        entries.push(Entry {
            id: artist_id,
            vector,
            meta: None,
        });
    }

    if skipped > 0 {
        warn!(skipped, "skipped malformed centroid rows during load");
    }
    Ok(Index::from_entries(entries))
}
