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
/// `certified = a findings row with a Log ID exists`.
///
/// The findings join REQUIRES `f.log_id IS NOT NULL`, not merely a findings row.
/// `findings.log_id` is nullable (a straggler awaiting its one-time coordinate
/// backfill), and the app-wide meaning of "certified" — the certification rail,
/// "Fluncle speaks about it" — is the Log ID, not the row. The `/log` neighbours
/// surface filters `findings.log_id IS NOT NULL`, so `certified` here must match
/// that exactly or the flag flip could surface an un-coordinated finding on `/log`.
const TRACKS_SQL: &str =
    "select t.track_id, t.embedding_blob, t.key, t.bpm, t.spotify_uri, f.track_id as finding_id \
     from tracks t left join findings f on f.track_id = t.track_id and f.log_id is not null \
     where t.embedding_blob is not null";

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
        let certified = !matches!(row.get_value(5)?, Value::Null);

        entries.push(Entry {
            id: track_id,
            vector,
            meta: Some(TrackMeta {
                key,
                bpm,
                anchored,
                certified,
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
