//! Opt-in, file-backed Sonar resource proof.
//!
//! The default profile is a small ratio-preserving CI derivative. Exact 1x/2x
//! profiles require `--full-scale`; each profile runs in a fresh child process
//! so the OS peak-RSS high-water mark belongs to one scale only.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use libsql::{params, Builder, Connection, TransactionBehavior, Value};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sonar::artifact::{
    sha256_hex, SonarPayload, ValidatedBatch, ValidatedEvent, ValidatedOperation,
};
use sonar::consumer::published;
use sonar::decode::BLOB_LEN;
use sonar::index::TrackMeta;
use sonar::replica::Replica;
use sonar::server::AppState;
use sonar::state::StateStore;

const REPORT_SCHEMA_VERSION: u32 = 1;
const MEMORY_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DELTA_EVENTS: usize = 100;
const WARM_DELTA_SAMPLES: usize = 5;
const MANIFEST: &str = include_str!("../../../web/scripts/db-performance/manifest.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Profile {
    Ci,
    One,
    Two,
}

impl Profile {
    fn label(self) -> &'static str {
        match self {
            Self::Ci => "ci",
            Self::One => "1x",
            Self::Two => "2x",
        }
    }

    fn multiplier(self) -> usize {
        match self {
            Self::Ci | Self::One => 1,
            Self::Two => 2,
        }
    }
}

#[derive(Clone, Copy)]
struct Counts {
    centroids: usize,
    tracks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSizes {
    main_bytes: u64,
    shm_bytes: u64,
    total_bytes: u64,
    wal_bytes: u64,
}

struct ScratchDirectory(PathBuf);

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("sonar resource proof failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut profiles = vec![Profile::Ci];
    let mut child = false;
    let mut full_scale = false;
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--child" => child = true,
            "--full-scale" => full_scale = true,
            "--profile" => {
                let value = args.get(index + 1).context("--profile requires a value")?;
                profiles = parse_profiles(value)?;
                index += 1;
            }
            argument => bail!("unknown resource-proof option {argument}"),
        }
        index += 1;
    }
    if profiles.iter().any(|profile| *profile != Profile::Ci) && !full_scale {
        bail!("exact 1x/2x resource proofs require --full-scale");
    }
    if child {
        if profiles.len() != 1 {
            bail!("a resource-proof child accepts exactly one profile");
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let report = runtime.block_on(run_profile(profiles[0]))?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }

    let executable = env::current_exe().context("locating resource-proof executable")?;
    let started = Instant::now();
    let mut reports = Vec::with_capacity(profiles.len());
    for profile in profiles {
        eprintln!(
            "running isolated sonar resource profile {}",
            profile.label()
        );
        let mut command = Command::new(&executable);
        command
            .args(["--child", "--profile", profile.label()])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if profile != Profile::Ci {
            command.arg("--full-scale");
        }
        let output = command.output().context("starting resource-proof child")?;
        if !output.status.success() {
            bail!("resource-proof child {} failed", profile.label());
        }
        let report: JsonValue = serde_json::from_slice(&output.stdout)
            .with_context(|| format!("decoding {} child report", profile.label()))?;
        reports.push(report);
    }
    let passed = reports
        .iter()
        .all(|report| report.get("passed") == Some(&JsonValue::Bool(true)));
    let output = json!({
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": "fluncle.sonar.resource-proof",
        "execution": "dedicated-child-per-scale-serial",
        "networkSyncLatencyProved": false,
        "reports": reports,
        "durationMs": millis(started),
        "passed": passed,
    });
    println!("{}", serde_json::to_string(&output)?);
    if !passed {
        bail!("one or more resource profiles exceeded the proof contract");
    }
    Ok(())
}

fn parse_profiles(value: &str) -> Result<Vec<Profile>> {
    let mut profiles = Vec::new();
    for part in value.split(',') {
        let profile = match part {
            "ci" => Profile::Ci,
            "1x" => Profile::One,
            "2x" => Profile::Two,
            _ => bail!("resource-proof profile must be ci, 1x, 2x, or a comma-separated set"),
        };
        if profiles.contains(&profile) {
            bail!("resource-proof profile {part} was supplied more than once");
        }
        profiles.push(profile);
    }
    if profiles.is_empty() {
        bail!("resource-proof profile set is empty");
    }
    Ok(profiles)
}

async fn run_profile(profile: Profile) -> Result<JsonValue> {
    let profile_started_at = unix_millis();
    let profile_started = Instant::now();
    let counts = profile_counts(profile)?;
    if counts.tracks <= DELTA_EVENTS {
        bail!("resource-proof profile requires more than {DELTA_EVENTS} tracks");
    }
    let scratch = create_scratch(profile)?;
    let source_path = scratch.0.join("source.db");
    let delta_state_path = scratch.0.join("state-delta.db");
    let rebuild_state_path = scratch.0.join("state-rebuild.db");

    let fixture_started_at = unix_millis();
    let fixture_started = Instant::now();
    seed_source(&source_path, counts).await?;
    let fixture_window = single_window(fixture_started_at, millis(fixture_started));
    let replica = Replica::open_local_test_source(&source_path).await?;

    let initial_started_at = unix_millis();
    let initial_started = Instant::now();
    let delta_store = StateStore::open(&delta_state_path).await?;
    let initial = delta_store
        .replace_from_local_replica(&replica, 1, 1, now_unix())
        .await?;
    let initial_window = single_window(initial_started_at, millis(initial_started));
    let initial_digest = initial.manifest.artifact_digest.clone();
    let app = AppState::from_snapshot(published(&initial), "resource-proof".into());
    drop(initial);
    let rss_after_initial = peak_rss_bytes()?;

    let warm_started_at = unix_millis();
    let mut apply_samples = Vec::with_capacity(WARM_DELTA_SAMPLES);
    let mut publish_samples = Vec::with_capacity(WARM_DELTA_SAMPLES);
    let mut source_mutation_samples = Vec::with_capacity(WARM_DELTA_SAMPLES);
    let mut checkpoint = 1_u64;
    let mut changed = None;
    let mut overlap_rss_bytes = 0;
    let mut third_publish_refused = false;
    for sample in 0..WARM_DELTA_SAMPLES {
        let delta = make_delta(counts.tracks, sample, checkpoint)?;
        let source_started = Instant::now();
        apply_source_delta(&source_path, counts.tracks, sample).await?;
        source_mutation_samples.push(millis(source_started));
        let delta_started = Instant::now();
        let candidate = delta_store.apply_batch(&delta, now_unix()).await?;
        apply_samples.push(millis(delta_started));

        let held = (sample == 0).then(|| app.snapshot.load_full());
        let publish_started = Instant::now();
        app.publish(published(&candidate))?;
        publish_samples.push(millis(publish_started));
        if let Some(old_snapshot) = held {
            overlap_rss_bytes = peak_rss_bytes()?;
            third_publish_refused = app.publish(published(&candidate)).is_err();
            if !third_publish_refused {
                bail!(
                    "third generation publish was accepted while the retired generation was held"
                );
            }
            drop(old_snapshot);
            app.publish(published(&candidate))
                .context("publishing after retired generation release")?;
        }
        delta_store
            .finalize_pending_activated(delta.through_seq)
            .await?;
        checkpoint = delta.through_seq;
        changed = Some(candidate);
    }
    let warm_completed_at = unix_millis();
    let changed = changed.context("warm delta samples produced no candidate")?;
    let rss_after_warm = peak_rss_bytes()?;
    overlap_rss_bytes = overlap_rss_bytes.max(rss_after_warm);

    let before_checkpoint = file_sizes(&delta_state_path)?;
    delta_store.checkpoint_truncate().await?;
    let after_checkpoint = file_sizes(&delta_state_path)?;

    let rebuild_started_at = unix_millis();
    let rebuild_started = Instant::now();
    let rebuild_store = StateStore::open(&rebuild_state_path).await?;
    let rebuilt = rebuild_store
        .replace_from_local_replica(&replica, checkpoint, checkpoint, now_unix())
        .await?;
    let rebuild_window = single_window(rebuild_started_at, millis(rebuild_started));
    let parity_digest = changed.manifest.artifact_digest == rebuilt.manifest.artifact_digest;
    if !parity_digest {
        bail!(
            "bounded delta digest diverged from the full local rebuild: {}",
            diagnose_parity(&delta_state_path, &source_path).await?
        );
    }
    app.publish(published(&rebuilt))?;
    drop(changed);
    let rss_after_full_rebuild = peak_rss_bytes()?;
    rebuild_store.checkpoint_truncate().await?;
    let rebuild_checkpoint_sizes = file_sizes(&rebuild_state_path)?;
    drop(rebuild_store);

    corrupt_header(&rebuild_state_path)?;
    let recovery_started_at = unix_millis();
    let recovery_started = Instant::now();
    let (recovered_store, quarantined) = StateStore::open_recovering(&rebuild_state_path).await?;
    if !quarantined || !appended(&rebuild_state_path, ".corrupt").is_file() {
        bail!("corrupt resource-proof state was not quarantined");
    }
    let recovered = recovered_store
        .replace_from_local_replica(&replica, checkpoint, checkpoint, now_unix())
        .await?;
    let recovery_window = single_window(recovery_started_at, millis(recovery_started));
    let recovery_parity = recovered.manifest.artifact_digest == rebuilt.manifest.artifact_digest;
    if !recovery_parity {
        bail!("corruption recovery digest diverged from the full local rebuild");
    }
    app.publish(published(&recovered))?;
    recovered_store.checkpoint_truncate().await?;
    let recovery_sizes = file_sizes(&rebuild_state_path)?;
    let rss_after_recovery = peak_rss_bytes()?;

    let distributions = read_distributions(&source_path).await?;
    let peak_rss_bytes = peak_rss_bytes()?;
    let manifest = recovered.manifest.clone();
    let exact = profile != Profile::Ci;
    let total_elapsed_ms = millis(profile_started);
    let passed = manifest.track_rows == counts.tracks
        && manifest.centroid_rows == counts.centroids
        && manifest.raw_bytes
            == u64::try_from((counts.tracks + counts.centroids).saturating_mul(BLOB_LEN))?
        && parity_digest
        && recovery_parity
        && third_publish_refused
        && peak_rss_bytes <= MEMORY_LIMIT_BYTES;

    Ok(json!({
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": "fluncle.sonar.resource-proof.scale",
        "profile": profile.label(),
        "manifestProfile": match profile { Profile::Two => "2x", _ => "1x" },
        "multiplier": profile.multiplier(),
        "exactProfileCardinality": exact,
        "counts": {
            "trackVectors": manifest.track_rows,
            "centroidVectors": manifest.centroid_rows,
            "totalVectors": manifest.track_rows + manifest.centroid_rows,
            "bytesPerVector": BLOB_LEN,
            "trackRawVectorBytes": manifest.track_rows.saturating_mul(BLOB_LEN),
            "centroidRawVectorBytes": manifest.centroid_rows.saturating_mul(BLOB_LEN),
            "totalRawVectorBytes": manifest.raw_bytes,
            "boundedDeltaEventsPerSample": DELTA_EVENTS,
            "warmDeltaSamples": WARM_DELTA_SAMPLES,
        },
        "metadataDistributions": distributions,
        "windows": {
            "fixtureWrite": fixture_window,
            "initialFullReplaceBuildValidate": initial_window,
            "localSourceMutation": sampled_window(warm_started_at, warm_completed_at, &source_mutation_samples),
            "boundedDeltaApplyBuildValidate": sampled_window(warm_started_at, warm_completed_at, &apply_samples),
            "boundedDeltaPublish": sampled_window(warm_started_at, warm_completed_at, &publish_samples),
            "fullReplaceRebuild": rebuild_window,
            "corruptOpenRecoveringQuarantineRebuild": recovery_window,
            "total": single_window(profile_started_at, total_elapsed_ms),
        },
        "publication": {
            "oldSnapshotHeldAcrossPublish": true,
            "thirdPublishRefusedWhileRetiredHeld": third_publish_refused,
            "publishSucceededAfterRetiredDrop": true,
            "generationOverlapPeakRssBytes": overlap_rss_bytes,
            "generationOverlapHeadroomVs2GiBBytes": signed_headroom(overlap_rss_bytes),
        },
        "resources": {
            "source": "os-process-rss-and-filesystem-stat",
            "peakRssBytes": peak_rss_bytes,
            "peakHeadroomVs2GiBBytes": signed_headroom(peak_rss_bytes),
            "memoryLimitBytes": MEMORY_LIMIT_BYTES,
            "phasePeakRssBytes": {
                "afterInitialColdBuild": rss_after_initial,
                "duringGenerationOverlap": overlap_rss_bytes,
                "afterWarmSamples": rss_after_warm,
                "afterFullRebuild": rss_after_full_rebuild,
                "afterCorruptRecovery": rss_after_recovery,
            },
            "stateBeforeCheckpoint": before_checkpoint,
            "stateAfterCheckpoint": after_checkpoint,
            "fullRebuildAfterCheckpoint": rebuild_checkpoint_sizes,
            "recoveredAfterCheckpoint": recovery_sizes,
            "sonarComponentSourceFiles": file_sizes(&source_path)?,
        },
        "correctness": {
            "initialDigest": initial_digest,
            "boundedDeltaDigest": manifest.artifact_digest,
            "boundedDeltaMatchesFullRebuild": parity_digest,
            "corruptRecoveryMatchesFullRebuild": recovery_parity,
            "corruptFileQuarantined": quarantined,
        },
        "scope": {
            "localRowsStandForReplicaSync": true,
            "networkSyncLatencyProved": false,
            "measurementInterpretation": "Cold construction and exceptional recovery are explicitly labeled single-sample windows; the warm 100-event delta apply/build/validate and publish paths report five measured samples. Phase RSS values are cumulative OS high-water marks, including current-plus-candidate construction and live-plus-retired publication overlap, never computed corpus sizes.",
            "resourceEnvelope": "Sonar state/index lifecycle only; the source file contains the Sonar projection subset, not the full production replica, and does not prove full-replica disk capacity.",
            "caveat": hardware_caveat(),
        },
        "passed": passed,
    }))
}

fn profile_counts(profile: Profile) -> Result<Counts> {
    let manifest: JsonValue = serde_json::from_str(MANIFEST)?;
    let tracks = manifest["tables"]["tracks"]
        .as_u64()
        .context("manifest tracks count is missing")?;
    let embeddings = manifest["tables"]["trackEmbeddings"]
        .as_u64()
        .context("manifest embedding count is missing")?;
    let artists = manifest["tables"]["artists"]
        .as_u64()
        .context("manifest artist count is missing")?;
    let (tracks, centroids) = match profile {
        Profile::Ci => {
            let ci_tracks = 512_u64;
            (
                ((embeddings * ci_tracks + tracks / 2) / tracks).max(1),
                ((artists * ci_tracks + tracks / 2) / tracks).max(1),
            )
        }
        Profile::One | Profile::Two => (
            embeddings * u64::try_from(profile.multiplier())?,
            artists * u64::try_from(profile.multiplier())?,
        ),
    };
    Ok(Counts {
        centroids: usize::try_from(centroids)?,
        tracks: usize::try_from(tracks)?,
    })
}

async fn seed_source(path: &Path, counts: Counts) -> Result<()> {
    let db = Builder::new_local(path).build().await?;
    let conn = db.connect()?;
    conn.execute_batch(
        "pragma journal_mode=wal; pragma synchronous=full;\
         create table tracks(track_id text primary key,key text,bpm real,spotify_uri text,dismissed_at text,duplicate_of_track_id text,nearest_finding_score real,duration_ms integer);\
         create table track_embeddings(track_id text primary key,embedding_blob blob not null);\
         create table findings(track_id text primary key,log_id text);\
         create table artifact_change_revisions(stream text,stream_version integer,subject_type text,subject_id text,revision integer);\
         create table artifact_changes(seq integer primary key autoincrement);\
         create table artist_centroids(artist_id text primary key,centroid_blob blob not null);",
    )
    .await?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .await?;
    let track_stmt = tx.prepare("insert into tracks(track_id,key,bpm,spotify_uri,dismissed_at,duplicate_of_track_id,nearest_finding_score,duration_ms) values(?,?,?,?,?,?,?,?)").await?;
    let vector_stmt = tx
        .prepare("insert into track_embeddings(track_id,embedding_blob) values(?,?)")
        .await?;
    let finding_stmt = tx
        .prepare("insert into findings(track_id,log_id) values(?,?)")
        .await?;
    let revision_stmt = tx.prepare("insert into artifact_change_revisions(stream,stream_version,subject_type,subject_id,revision) values('sonar.track',1,'track',?,1)").await?;
    for row in 0..counts.tracks {
        let id = track_id(row);
        let meta = track_meta(row);
        track_stmt
            .execute(params![
                id.clone(),
                meta.key,
                meta.bpm.map(f64::from),
                meta.anchored.then_some(format!("spotify:track:{id}")),
                meta.dismissed.then_some("synthetic-dismissed"),
                meta.is_duplicate.then_some("synthetic-original"),
                meta.nearest_finding_score.map(f64::from),
                meta.duration_ms.map(i64::from),
            ])
            .await
            .with_context(|| format!("inserting source track {id}"))?;
        track_stmt.reset();
        vector_stmt
            .execute(params![id.clone(), vector_blob(row, 0)])
            .await?;
        vector_stmt.reset();
        revision_stmt.execute([id.clone()]).await?;
        revision_stmt.reset();
        if meta.has_finding {
            finding_stmt
                .execute(params![id, meta.certified.then_some(format!("F{row:06}")),])
                .await?;
            finding_stmt.reset();
        }
    }
    let centroid_stmt = tx
        .prepare("insert into artist_centroids(artist_id,centroid_blob) values(?,?)")
        .await?;
    for row in 0..counts.centroids {
        centroid_stmt
            .execute(params![format!("artist-{row:06}"), vector_blob(row, 7)])
            .await?;
        centroid_stmt.reset();
    }
    drop(track_stmt);
    drop(vector_stmt);
    drop(finding_stmt);
    drop(revision_stmt);
    drop(centroid_stmt);
    tx.commit().await?;
    conn.execute("insert into artifact_changes default values", ())
        .await?;
    Ok(())
}

fn make_delta(track_count: usize, sample: usize, from_seq: u64) -> Result<ValidatedBatch> {
    let mut events = Vec::with_capacity(DELTA_EVENTS);
    for offset in 0..DELTA_EVENTS {
        let seq = from_seq
            .checked_add(u64::try_from(offset + 1)?)
            .context("resource-proof delta sequence overflow")?;
        let (subject_id, revision, operation) = if offset < 2 {
            (
                track_id(track_count - 1 - (sample * 2 + offset)),
                2,
                ValidatedOperation::Delete,
            )
        } else if offset < DELTA_EVENTS - 2 {
            let payload = payload(track_meta(offset));
            (
                track_id(offset),
                u64::try_from(sample + 2)?,
                ValidatedOperation::Upsert {
                    blob: vector_blob(offset, sample + 1),
                    payload,
                },
            )
        } else {
            let row = track_count + sample * 2 + offset - (DELTA_EVENTS - 2);
            let payload = payload(track_meta(row));
            (
                new_track_id(row),
                1,
                ValidatedOperation::Upsert {
                    blob: vector_blob(row, sample + 1),
                    payload,
                },
            )
        };
        events.push(ValidatedEvent {
            operation,
            payload_digest: sha256_hex(&[subject_id.as_bytes(), &seq.to_be_bytes()]),
            revision,
            seq,
            subject_id,
        });
    }
    Ok(ValidatedBatch {
        batch_digest: sha256_hex(&[
            b"sonar-resource-proof-delta",
            &u64::try_from(sample)?.to_be_bytes(),
        ]),
        events,
        from_seq,
        head_seq: from_seq
            .checked_add(u64::try_from(DELTA_EVENTS)?)
            .context("resource-proof head sequence overflow")?,
        through_seq: from_seq
            .checked_add(u64::try_from(DELTA_EVENTS)?)
            .context("resource-proof through sequence overflow")?,
    })
}

async fn apply_source_delta(path: &Path, track_count: usize, sample: usize) -> Result<()> {
    let db = Builder::new_local(path).build().await?;
    let conn = db.connect()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .await?;
    for offset in 0..2 {
        let row = track_count - 1 - (sample * 2 + offset);
        let id = track_id(row);
        tx.execute("delete from findings where track_id=?", [id.clone()])
            .await?;
        tx.execute(
            "delete from track_embeddings where track_id=?",
            [id.clone()],
        )
        .await?;
        tx.execute("delete from tracks where track_id=?", [id.clone()])
            .await?;
        tx.execute(
            "update artifact_change_revisions set revision=2 where subject_id=?",
            [id],
        )
        .await?;
    }
    for row in 2..DELTA_EVENTS - 2 {
        let id = track_id(row);
        tx.execute(
            "update track_embeddings set embedding_blob=? where track_id=?",
            params![vector_blob(row, sample + 1), id.clone()],
        )
        .await?;
        tx.execute(
            "update artifact_change_revisions set revision=? where subject_id=?",
            params![i64::try_from(sample + 2)?, id],
        )
        .await?;
    }
    for row in track_count + sample * 2..track_count + sample * 2 + 2 {
        let id = new_track_id(row);
        let meta = track_meta(row);
        tx.execute(
            "insert into tracks(track_id,key,bpm,spotify_uri,dismissed_at,duplicate_of_track_id,nearest_finding_score,duration_ms) values(?,?,?,?,?,?,?,?)",
            params![id.clone(), meta.key, meta.bpm.map(f64::from), meta.anchored.then_some(format!("spotify:track:{id}")), meta.dismissed.then_some("synthetic-dismissed"), meta.is_duplicate.then_some("synthetic-original"), meta.nearest_finding_score.map(f64::from), meta.duration_ms.map(i64::from)],
        )
        .await
        .with_context(|| format!("inserting delta source track {id}"))?;
        tx.execute(
            "insert into track_embeddings(track_id,embedding_blob) values(?,?)",
            params![id.clone(), vector_blob(row, sample + 1)],
        )
        .await?;
        tx.execute("insert into artifact_change_revisions(stream,stream_version,subject_type,subject_id,revision) values('sonar.track',1,'track',?,1)", [id.clone()]).await?;
        if meta.has_finding {
            tx.execute(
                "insert into findings(track_id,log_id) values(?,?)",
                params![id, meta.certified.then_some(format!("F{row:06}"))],
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

fn track_meta(row: usize) -> TrackMeta {
    let certified = row % 1_277 == 0;
    TrackMeta {
        key: (row % 29 != 0).then(|| format!("{}A", row % 12 + 1)),
        bpm: (row % 31 != 0).then_some(160.0 + (row % 40) as f32 * 0.5),
        anchored: row % 25 != 0,
        certified,
        has_finding: certified || row % 1_241 == 0,
        dismissed: row % 101 == 0,
        is_duplicate: row % 103 == 0,
        nearest_finding_score: (row % 7 != 0).then_some(0.5 + (row % 500) as f32 / 1_024.0),
        duration_ms: (row % 113 != 0)
            .then_some(120_000 + u32::try_from(row % 240_000).unwrap_or_default()),
    }
}

fn payload(meta: TrackMeta) -> SonarPayload {
    SonarPayload {
        anchored: meta.anchored,
        bpm: meta.bpm.map(f64::from),
        certified: meta.certified,
        dismissed: meta.dismissed,
        duration_ms: meta.duration_ms,
        has_finding: meta.has_finding,
        is_duplicate: meta.is_duplicate,
        key: meta.key,
        nearest_finding_score: meta.nearest_finding_score.map(f64::from),
    }
}

fn vector_blob(row: usize, generation: usize) -> Vec<u8> {
    let mut blob = vec![0_u8; BLOB_LEN];
    for lane in 0..8 {
        let value = 0.25
            + ((row.wrapping_mul(17) + generation * 31 + lane * 13) % 10_000) as f32 / 10_000.0;
        let start = lane * std::mem::size_of::<f32>();
        blob[start..start + 4].copy_from_slice(&value.to_le_bytes());
    }
    blob
}

async fn read_distributions(path: &Path) -> Result<JsonValue> {
    let db = Builder::new_local(path).build().await?;
    let conn = db.connect()?;
    Ok(json!({
        "anchored": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.spotify_uri is not null").await?,
        "certified": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id join findings f on f.track_id=t.track_id where f.log_id is not null").await?,
        "hasFinding": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id join findings f on f.track_id=t.track_id").await?,
        "dismissed": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.dismissed_at is not null").await?,
        "duplicates": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.duplicate_of_track_id is not null").await?,
        "nullKey": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.key is null").await?,
        "nullBpm": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.bpm is null").await?,
        "nullNearestFindingScore": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.nearest_finding_score is null").await?,
        "nullDurationMs": scalar(&conn, "select count(*) from tracks t join track_embeddings e on e.track_id=t.track_id where t.duration_ms is null").await?,
    }))
}

async fn scalar(conn: &Connection, sql: &str) -> Result<u64> {
    let mut rows = conn.query(sql, ()).await?;
    let row = rows
        .next()
        .await?
        .context("distribution query returned no row")?;
    match row.get_value(0)? {
        Value::Integer(value) => Ok(u64::try_from(value)?),
        _ => bail!("distribution query returned a non-integer"),
    }
}

async fn diagnose_parity(state_path: &Path, source_path: &Path) -> Result<String> {
    let db = Builder::new_local(state_path).build().await?;
    let conn = db.connect()?;
    conn.execute(
        "attach database ? as source",
        [source_path.to_string_lossy().to_string()],
    )
    .await?;
    let missing = scalar(&conn, "select count(*) from sonar_tracks s left join source.track_embeddings e on e.track_id=s.id where e.track_id is null").await?;
    let extra = scalar(&conn, "select count(*) from source.track_embeddings e left join sonar_tracks s on s.id=e.track_id where s.id is null").await?;
    let vector = scalar(&conn, "select count(*) from sonar_tracks s join source.track_embeddings e on e.track_id=s.id where s.vector != e.embedding_blob").await?;
    let mut vector_rows = conn.query("select s.id,hex(substr(s.vector,1,4)),hex(substr(e.embedding_blob,1,4)) from sonar_tracks s join source.track_embeddings e on e.track_id=s.id where s.vector != e.embedding_blob order by s.id limit 20", ()).await?;
    let mut vector_ids = Vec::new();
    while let Some(row) = vector_rows.next().await? {
        vector_ids.push(format!(
            "{}:{}/{}",
            row.get::<String>(0)?,
            row.get::<String>(1)?,
            row.get::<String>(2)?
        ));
    }
    let revision = scalar(&conn, "select count(*) from sonar_revisions s join (select subject_id,max(revision) revision from source.artifact_change_revisions group by subject_id) r on r.subject_id=s.id where s.revision != r.revision").await?;
    Ok(format!(
        "missing={missing}, extra={extra}, vector={vector}({}), revision={revision}",
        vector_ids.join(",")
    ))
}

fn create_scratch(profile: Profile) -> Result<ScratchDirectory> {
    let parent = env::var_os("SONAR_RESOURCE_PROOF_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    fs::create_dir_all(&parent)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = parent.join(format!(
        "fluncle-sonar-resource-{}-{}-{nonce}",
        profile.label(),
        std::process::id()
    ));
    fs::create_dir(&path)?;
    Ok(ScratchDirectory(path))
}

fn file_sizes(path: &Path) -> Result<FileSizes> {
    let main_bytes = file_len(path)?;
    let wal_bytes = file_len(&appended(path, "-wal"))?;
    let shm_bytes = file_len(&appended(path, "-shm"))?;
    Ok(FileSizes {
        main_bytes,
        shm_bytes,
        total_bytes: main_bytes
            .saturating_add(wal_bytes)
            .saturating_add(shm_bytes),
        wal_bytes,
    })
}

fn file_len(path: &Path) -> Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn appended(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn corrupt_header(path: &Path) -> Result<()> {
    let mut file = OpenOptions::new().write(true).open(path)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(b"not-a-sqlite-resource-proof-header")?;
    file.sync_all()?;
    Ok(())
}

fn peak_rss_bytes() -> Result<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let max_rss = unsafe { usage.assume_init() }.ru_maxrss;
    let value = u64::try_from(max_rss).context("OS peak RSS was negative")?;
    #[cfg(target_os = "macos")]
    return Ok(value);
    #[cfg(not(target_os = "macos"))]
    Ok(value.saturating_mul(1024))
}

fn hardware_caveat() -> String {
    let os = command_text("uname", &["-s", "-r"])
        .unwrap_or_else(|| format!("{} {}", env::consts::OS, env::consts::ARCH));
    let hardware = if cfg!(target_os = "macos") {
        command_text("sysctl", &["-n", "machdep.cpu.brand_string"])
    } else {
        fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|contents| {
                contents
                    .lines()
                    .find_map(|line| line.strip_prefix("model name\t: ").map(str::to_owned))
            })
    }
    .unwrap_or_else(|| env::consts::ARCH.into());
    format!(
        "Measured locally on {hardware}; {os}; architecture {}. This is exact local process/disk evidence, not a deployed-box or network replica-sync latency measurement.",
        env::consts::ARCH
    )
}

fn command_text(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn track_id(row: usize) -> String {
    format!("track-{row:06}")
}

fn new_track_id(row: usize) -> String {
    format!("track-new-{row:06}")
}

fn millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn single_window(started_unix_ms: u64, duration_ms: u64) -> JsonValue {
    json!({
        "startedUnixMs": started_unix_ms,
        "completedUnixMs": started_unix_ms.saturating_add(duration_ms),
        "sampleCount": 1,
        "durationsMs": [duration_ms],
        "minMs": duration_ms,
        "maxMs": duration_ms,
        "interpretation": "single-sample; percentiles omitted because one observation is not a distribution",
    })
}

fn sampled_window(started_unix_ms: u64, completed_unix_ms: u64, samples: &[u64]) -> JsonValue {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let percentile = |numerator: usize| -> u64 {
        let rank = sorted.len().saturating_mul(numerator).saturating_add(99) / 100;
        sorted[rank.saturating_sub(1).min(sorted.len().saturating_sub(1))]
    };
    json!({
        "startedUnixMs": started_unix_ms,
        "completedUnixMs": completed_unix_ms,
        "sampleCount": samples.len(),
        "durationsMs": samples,
        "minMs": sorted.first().copied().unwrap_or_default(),
        "p50Ms": percentile(50),
        "p95Ms": percentile(95),
        "maxMs": sorted.last().copied().unwrap_or_default(),
        "interpretation": "measured-distribution",
    })
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn signed_headroom(observed: u64) -> i64 {
    i128::from(MEMORY_LIMIT_BYTES)
        .saturating_sub(i128::from(observed))
        .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}
