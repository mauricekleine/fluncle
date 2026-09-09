import {
  INDEX_AUDIT_PROFILES,
  FINAL_INDEX_INVENTORY,
  type IndexEvidenceDefinition,
  type IndexInventoryEntry,
  allIndexInventoryEntries,
} from "./index-inventory";
import { type ScaleProfile } from "./manifest";
import {
  type ContractContext,
  type ContractExecution,
  type PerformanceContract,
  type PerformanceResult,
  type PerformanceStatement,
} from "./registry";
import { analyzeExplainPlan, type ExplainPlanPolicy } from "./plan";
import {
  PRODUCTION_LOCK_INVENTORY,
  type ProductionLockContract,
  type ProductionLockEvidenceDefinition,
} from "./production-lock-inventory";
import { trackSitemapIndexCountStatement } from "../../src/lib/server/track-page";

const INDEX_EVIDENCE_LIMIT = 25;
const INDEX_EVIDENCE_ITERATIONS = 2;
const INDEX_EVIDENCE_WARMUP_ITERATIONS = 1;

/** Inventory indexes whose production consumer deliberately carries an `INDEXED BY` lock. */
export const INDEX_EVIDENCE_RUNTIME_LOCKED_INDEXES = [
  "artist_qualification_qualified_idx",
  "crawl_due_work_cleanup_idx",
  "crawl_due_work_claim_position_idx",
  "crawl_due_work_label_slug_node_id_idx",
  "crawl_due_work_lease_idx",
  "crawl_due_work_parent_id_node_id_idx",
  "crawl_due_work_ready_idx",
  "crawl_due_work_repair_idx",
  "crawl_due_work_release_ready_idx",
  "crawl_due_work_scheduled_idx",
  "crawl_projection_repairs_order_idx",
  "projection_repairs_order_idx",
  "tracks_anchor_order_idx",
  "tracks_anchor_queue_idx",
  "tracks_label_id_idx",
  "tracks_mb_recording_id_queue_idx",
  "tracks_release_date_track_id_idx",
] as const;

type IndexPlanSpec = {
  allowFullScanOf?: string;
  forbidTempSort?: boolean;
  minRows: number;
  maxRows: number;
  statement: PerformanceStatement;
};

type ComparisonSpec = IndexPlanSpec & {
  productionPlanPolicies: ExplainPlanPolicy[];
  references: PerformanceStatement[];
  /** Supplemental same-shape statements, normally the planner-unforced counterpart. */
  supplementalPlanPolicies?: ExplainPlanPolicy[];
  supplementalStatements: PerformanceStatement[];
};

type ProductionLockComparisonSpec = {
  expectedPlanUses: ProductionLockPlanUse[];
  locked: PerformanceStatement;
  lockedPolicy: ExplainPlanPolicy;
  maxRows: number;
  minRows: number;
  mutating: boolean;
  mutationPreparation?: PerformanceStatement;
  mutationRestoration?: PerformanceStatement[];
  mutationRows?: { max: number; min: number };
  unforced: PerformanceStatement;
  unforcedPolicy: ExplainPlanPolicy;
};

type ProductionLockPlanUse = {
  count: number;
  index: string;
  pattern: RegExp;
};

function statement(sql: string, args: PerformanceStatement["args"] = []): PerformanceStatement {
  return { args, sql };
}

function tableForIndex(indexName: string): string {
  if (indexName.startsWith("tracks_")) {
    return "perf_tracks";
  }
  if (indexName.startsWith("due_work_")) {
    return "perf_due_work";
  }
  if (indexName.startsWith("artifact_change_checkpoints_")) {
    return "perf_artifact_change_checkpoints";
  }
  if (indexName.startsWith("artifact_change_consumers_")) {
    return "perf_artifact_change_consumers";
  }
  if (indexName.startsWith("artifact_changes_")) {
    return "perf_artifact_changes";
  }
  if (indexName.startsWith("artifact_change_revisions_")) {
    return "perf_artifact_change_revisions";
  }
  if (indexName === "artist_qualification_qualified_idx") {
    return "perf_artist_qualification";
  }
  if (indexName === "artist_qualification_contributions_artist_track_idx") {
    return "perf_artist_qualification_contributions";
  }
  if (indexName.startsWith("artist_rules_")) {
    return "perf_artist_rules";
  }
  if (indexName.startsWith("crawl_due_work_")) {
    return "perf_crawl_due_work";
  }
  if (indexName === "projection_repairs_order_idx") {
    return "perf_projection_repairs";
  }
  if (indexName === "crawl_projection_repairs_order_idx") {
    return "perf_crawl_projection_repairs";
  }
  if (indexName.startsWith("operation_receipts_")) {
    return "perf_operation_receipts";
  }
  if (indexName.startsWith("database_admission_contenders_")) {
    return "perf_database_admission_contenders";
  }

  throw new Error(`no final index evidence fixture table for ${indexName}`);
}

function fixtureIndexName(indexName: string): string {
  return `perf_${indexName}`;
}

type IndexPlanStatementMode = "production-lock" | "supplemental-force" | "unforced";

function indexPlanStatement(
  indexName: string,
  sql: string,
  mode: IndexPlanStatementMode = "unforced",
): PerformanceStatement {
  const fixtureIndex = fixtureIndexName(indexName);
  const indexedSql = sql.replaceAll("__INDEX__", fixtureIndex);

  return statement(
    mode === "production-lock" || mode === "supplemental-force"
      ? indexedSql
      : indexedSql.replace(new RegExp(`\\s+indexed\\s+by\\s+${fixtureIndex}\\b`, "gi"), ""),
  );
}

function productionLockStatementPair(
  indexes: readonly string[],
  sql: string,
  args: PerformanceStatement["args"],
): { locked: PerformanceStatement; unforced: PerformanceStatement } {
  let lockedSql = sql;
  for (const index of indexes) {
    lockedSql = indexPlanStatement(
      index,
      lockedSql.replaceAll(`__${index.toUpperCase()}__`, "__INDEX__"),
      "production-lock",
    ).sql;
  }

  let unforcedSql = lockedSql;
  for (const index of indexes) {
    unforcedSql = indexPlanStatement(index, unforcedSql, "unforced").sql;
  }

  return {
    locked: statement(lockedSql, args),
    unforced: statement(unforcedSql, args),
  };
}

function genericTrackPlan(indexName: string): IndexPlanSpec {
  const table = "perf_tracks";
  const plans: Record<string, PerformanceStatement> = {
    tracks_album_id_idx: indexPlanStatement(
      indexName,
      "select album_id from perf_tracks indexed by __INDEX__ where album_id = 'synthetic-album-000000000' limit 25",
    ),
    tracks_anchor_order_idx: indexPlanStatement(
      indexName,
      `select id, has_isrc, has_embedding, nearest_finding_score
         from perf_tracks indexed by __INDEX__
        where spotify_uri is null
          and has_isrc = 1
          and has_embedding = 1
          and nearest_finding_score >= 0.5
        order by has_isrc desc, has_embedding desc, nearest_finding_score desc, id desc
        limit 25`,
      "production-lock",
    ),
    tracks_anchor_queue_idx: indexPlanStatement(
      indexName,
      "select isrc from perf_tracks indexed by __INDEX__ where spotify_uri is null and isrc is not null and isrc >= 'synthetic-isrc-000000001' order by isrc limit 25",
      "production-lock",
    ),
    tracks_anchor_review_idx: indexPlanStatement(
      indexName,
      "select id from perf_tracks indexed by __INDEX__ where anchor_review_json is not null and id >= 'synthetic-track-000000000' order by id limit 25",
    ),
    tracks_artist_credits_backfill_queue_idx: indexPlanStatement(
      indexName,
      "select id from perf_tracks indexed by __INDEX__ where artist_credits_backfilled_at is null and artist_edges_backfilled_at is not null and id >= 'synthetic-track-000000000' order by id limit 25",
    ),
    tracks_artist_edges_backfill_queue_idx: indexPlanStatement(
      indexName,
      "select id from perf_tracks indexed by __INDEX__ where artist_edges_backfilled_at is null and id >= 'synthetic-track-000000000' order by id limit 25",
    ),
    tracks_bpm_idx: statement(
      `select tracks.id as track_id, tracks.title, tracks.artists_json, tracks.album,
              tracks.album_image_url, tracks.bpm, tracks.key, tracks.label, tracks.release_date,
              tracks.spotify_url, findings.log_id,
              (select name from perf_galaxies where perf_galaxies.id = findings.galaxy_id)
                as galaxy_name
         from perf_tracks tracks left join perf_findings findings on findings.track_id = tracks.id
        where tracks.bpm >= ? and tracks.bpm <= ?
        order by case when findings.track_id is null then 1 else 0 end asc,
                 tracks.release_date desc, tracks.id asc
        limit ?`,
      [160, 180, INDEX_EVIDENCE_LIMIT],
    ),
    tracks_capture_priority_track_id_idx: indexPlanStatement(
      indexName,
      `select id, capture_priority
         from perf_tracks indexed by __INDEX__
        where capture_priority is not null and capture_priority >= 0
        order by capture_priority desc, id desc
        limit 25`,
    ),
    tracks_capture_verification_verified_at_idx: indexPlanStatement(
      indexName,
      "select capture_verification, capture_verified_at from perf_tracks indexed by __INDEX__ where capture_verification = 'mismatch' order by capture_verified_at limit 25",
    ),
    tracks_catalogue_active_track_id_idx: indexPlanStatement(
      indexName,
      "select id from perf_tracks indexed by __INDEX__ where is_catalogue = 1 and dismissed_at is null and id >= 'synthetic-track-000000000' order by id limit 25",
    ),
    tracks_catalogue_capture_idx: indexPlanStatement(
      indexName,
      `select id, capture_priority
         from perf_tracks indexed by __INDEX__
        where is_catalogue = 1 and dismissed_at is null and capture_priority >= 0
        order by capture_priority desc, id desc
        limit 25`,
    ),
    tracks_catalogue_ear_idx: indexPlanStatement(
      indexName,
      `select id, nearest_finding_score
         from perf_tracks indexed by __INDEX__
        where is_catalogue = 1 and dismissed_at is null and nearest_finding_score >= 0.5
        order by nearest_finding_score desc, id desc
        limit 25`,
    ),
    tracks_deezer_track_id_idx: indexPlanStatement(
      indexName,
      "select deezer_track_id from perf_tracks indexed by __INDEX__ where deezer_track_id = 'synthetic-deezer-000000001' limit 25",
    ),
    tracks_demand_score_idx: indexPlanStatement(
      indexName,
      "select demand_score from perf_tracks indexed by __INDEX__ where demand_score is not null and demand_score >= 0 order by demand_score desc limit 25",
    ),
    tracks_discogs_release_idx: indexPlanStatement(
      indexName,
      "select in_release_id from perf_tracks indexed by __INDEX__ where in_release_id is not null and in_release_id >= 1 order by in_release_id limit 25",
    ),
    tracks_dismissed_idx: indexPlanStatement(
      indexName,
      "select dismissed_at from perf_tracks indexed by __INDEX__ where dismissed_at is not null and dismissed_at >= '2026-01-01' order by dismissed_at desc limit 25",
    ),
    tracks_embed_queue_idx: indexPlanStatement(
      indexName,
      "select id from perf_tracks indexed by __INDEX__ where source_audio_key is not null and has_embedding = 0 and id >= 'synthetic-track-000000000' order by id limit 25",
    ),
    tracks_fresh_catalogue_idx: indexPlanStatement(
      indexName,
      `select id, release_date
         from perf_tracks indexed by __INDEX__
        where is_catalogue = 1 and release_date >= '2024-01-01' and release_date < '2027-01-01'
        order by release_date desc, id desc
        limit 25`,
    ),
    tracks_funnel_scan_idx: indexPlanStatement(
      indexName,
      `select
           sum(case when is_catalogue = 1 then 1 else 0 end) as catalogue_rows,
           sum(case when has_embedding = 1 then 1 else 0 end) as embedded_rows,
           sum(case when spotify_uri is not null then 1 else 0 end) as anchored_rows,
           sum(case when source_audio_key is not null then 1 else 0 end) as captured_rows,
           sum(case when analyzed_from = 'full' then 1 else 0 end) as full_analysis_rows,
           sum(case when dismissed_at is not null then 1 else 0 end) as dismissed_rows,
           sum(case when duplicate_of_track_id is not null then 1 else 0 end) as duplicates,
           sum(case when nearest_finding_score is not null then 1 else 0 end) as ranked_rows,
           sum(case when duration_ms > 0 then 1 else 0 end) as duration_rows,
           sum(case when spotify_anchor_attempted_at is not null then 1 else 0 end) as anchor_attempts,
           sum(case when isrc is not null then 1 else 0 end) as isrc_rows,
           sum(case when spotify_anchor_attempts > 0 then 1 else 0 end) as attempted_rows,
           count(artists_json) as credited_rows,
           count(label_id) as labeled_rows
      from perf_tracks indexed by __INDEX__`,
    ),
    tracks_is_catalogue_idx: statement(
      "select count(*) as total from perf_tracks where perf_tracks.is_catalogue = 1",
    ),
    tracks_isrc_idx: indexPlanStatement(
      indexName,
      "select isrc from perf_tracks indexed by __INDEX__ where isrc = 'synthetic-isrc-000000001' limit 25",
    ),
    tracks_key_idx: indexPlanStatement(
      indexName,
      "select key from perf_tracks indexed by __INDEX__ where key = 'C minor' limit 25",
    ),
    tracks_label_id_idx: indexPlanStatement(
      indexName,
      "select label_id from perf_tracks indexed by __INDEX__ where label_id = 'synthetic-label-000000000' limit 25",
      "production-lock",
    ),
    tracks_mb_recording_id_idx: indexPlanStatement(
      indexName,
      "select mb_recording_id from perf_tracks indexed by __INDEX__ where mb_recording_id = 'synthetic-recording-000000000' limit 25",
    ),
    tracks_mb_recording_id_queue_idx: indexPlanStatement(
      indexName,
      "select id from perf_tracks indexed by __INDEX__ where mb_recording_id is null and mb_recording_id_attempted_at is null and id >= 'synthetic-track-000000000' order by id limit 25",
      "production-lock",
    ),
    tracks_nearest_finding_score_idx: indexPlanStatement(
      "tracks_catalogue_ear_idx",
      `select id, nearest_finding_score
         from perf_tracks indexed by __INDEX__
        where is_catalogue = 1 and dismissed_at is null
          and nearest_finding_score is not null and duplicate_of_track_id is null
          and duration_ms < 900000
        order by nearest_finding_score desc, id desc
        limit 25`,
    ),
    tracks_source_audio_attempted_at_idx: indexPlanStatement(
      indexName,
      "select source_audio_attempted_at from perf_tracks indexed by __INDEX__ where source_audio_attempted_at >= '2026-01-01' order by source_audio_attempted_at limit 25",
    ),
    tracks_spotify_uri_idx: indexPlanStatement(
      indexName,
      "select spotify_uri from perf_tracks indexed by __INDEX__ where spotify_uri = 'synthetic-spotify-uri-000000001' limit 25",
    ),
    tracks_vendor_worklist_idx: indexPlanStatement(
      indexName,
      `select id, capture_priority
         from perf_tracks indexed by __INDEX__
        where is_catalogue = 1 and capture_priority >= 0
        order by capture_priority desc, id desc
        limit 25`,
    ),
  };
  const selected = plans[indexName];

  if (!selected) {
    throw new Error(`no track plan evidence statement for ${indexName}`);
  }

  return {
    allowFullScanOf: indexName === "tracks_funnel_scan_idx" ? table : undefined,
    forbidTempSort: indexName === "tracks_bpm_idx" ? false : undefined,
    maxRows: indexName === "tracks_funnel_scan_idx" ? 1 : INDEX_EVIDENCE_LIMIT,
    minRows: 1,
    statement: selected,
  };
}

function genericDatabaseScalePlan(indexName: string): IndexPlanSpec {
  const plans: Record<string, PerformanceStatement> = {
    artifact_change_checkpoints_running_idx: statement(
      `select consumer_id, stream, stream_version
         from perf_artifact_change_checkpoints
        where consumer_id = 'synthetic-consumer-000000000'
          and stream = 'synthetic-stream-0' and stream_version = 1 and phase = 'rebuild'`,
    ),
    artifact_change_consumers_compaction_idx: statement(
      `select min(case
         when state = 'active' then applied_through_seq
         when state = 'rebuilding' then snapshot_seq
         else null
       end) as barrier
       from perf_artifact_change_consumers
       where state in ('active', 'rebuilding')`,
    ),
    artifact_change_revisions_event_seq_idx: indexPlanStatement(
      indexName,
      "select event_seq from perf_artifact_change_revisions indexed by __INDEX__ where event_seq >= 1 order by event_seq limit 25",
    ),
    artifact_changes_created_seq_idx: statement(
      "select seq from perf_artifact_changes where seq <= 100000 order by seq limit 25",
    ),
    artifact_changes_revision_idx: indexPlanStatement(
      indexName,
      "select stream, stream_version, subject_type, subject_id, revision from perf_artifact_changes indexed by __INDEX__ where stream = 'synthetic-stream-0' and stream_version = 1 and subject_type = 'track' and subject_id = 'synthetic-track-000000000' and revision = 1 limit 25",
    ),
    artifact_changes_stream_seq_idx: statement(
      `select created_at, format_version, operation, payload_blob, payload_json,
              producer, revision, seq, stream, stream_version, subject_id, subject_type
         from perf_artifact_changes
        where seq > ?
        order by seq
        limit ?`,
      [0, INDEX_EVIDENCE_LIMIT + 1],
    ),
    artist_qualification_contributions_artist_track_idx: indexPlanStatement(
      indexName,
      "select artist_id, track_id from perf_artist_qualification_contributions indexed by __INDEX__ where artist_id = 'synthetic-artist-000000000' order by artist_id, track_id limit 25",
    ),
    artist_qualification_qualified_idx: indexPlanStatement(
      indexName,
      "select artist_id from perf_artist_qualification indexed by __INDEX__ where is_qualified = 1 and artist_id >= 'synthetic-artist-000000000' order by is_qualified, artist_id limit 25",
      "production-lock",
    ),
    artist_rules_crawl_lookup_idx: indexPlanStatement(
      indexName,
      `select artist_mbid
         from perf_artist_rules indexed by __INDEX__
        where artist_mbid = substr('musicbrainz:artist:synthetic-artist-000000000',
                                   length('musicbrainz:artist:') + 1)
          and verdict = 'allow'
        limit 25`,
    ),
    crawl_due_work_cleanup_idx: indexPlanStatement(
      indexName,
      `select generation, node_id, updated_at from (
        select generation, node_id, updated_at
          from perf_crawl_due_work indexed by __INDEX__
         where state <> 'repair' and generation < 'live' and node_id > ''
        union all
        select generation, node_id, updated_at
          from perf_crawl_due_work indexed by __INDEX__
         where state <> 'repair' and generation > 'live'
           and generation < 'synthetic-contract-z' and node_id > ''
        union all
        select generation, node_id, updated_at
          from perf_crawl_due_work indexed by __INDEX__
         where state <> 'repair' and generation > 'synthetic-contract-z' and node_id > ''
        union all
        select generation, node_id, updated_at
          from perf_crawl_due_work indexed by __INDEX__
         where state <> 'repair' and generation = 'live'
           and updated_at < '2027-01-01T00:00:00.000Z' and node_id > ''
      ) order by generation, updated_at, node_id limit 25`,
      "production-lock",
    ),
    crawl_due_work_lease_idx: indexPlanStatement(
      indexName,
      "select node_id, claim_expires_at from perf_crawl_due_work indexed by __INDEX__ where state = 'leased' and claim_expires_at <= '9999-12-31' order by state, claim_expires_at, node_id limit 25",
      "production-lock",
    ),
    database_admission_contenders_active_lane_idx: indexPlanStatement(
      indexName,
      "select lane from perf_database_admission_contenders indexed by __INDEX__ where state = 'active' and lane = 'write' limit 25",
    ),
    database_admission_contenders_lease_idx: indexPlanStatement(
      indexName,
      "select lane, contender_id from perf_database_admission_contenders indexed by __INDEX__ where state = 'active' and lease_expires_at_ms <= 100000 order by state, lease_expires_at_ms, lane, contender_id limit 25",
    ),
    database_admission_contenders_owner_run_idx: indexPlanStatement(
      indexName,
      "select owner_id, run_id from perf_database_admission_contenders indexed by __INDEX__ where owner_id = 'synthetic-owner-000000000' and run_id = 'synthetic-run-000000000' limit 25",
    ),
    database_admission_contenders_queue_heartbeat_idx: indexPlanStatement(
      indexName,
      "select contender_id, queue_heartbeat_at_ms from perf_database_admission_contenders indexed by __INDEX__ where state = 'queued' and queue_heartbeat_at_ms >= 0 order by state, queue_heartbeat_at_ms, contender_id limit 25",
    ),
    database_admission_contenders_queue_idx: indexPlanStatement(
      indexName,
      "select contender_id, enqueued_at_ms from perf_database_admission_contenders indexed by __INDEX__ where lane = 'write' and state = 'queued' order by lane, state, enqueued_at_ms, contender_id limit 25",
    ),
    due_work_claim_idx: indexPlanStatement(
      indexName,
      "select subject_id, sort_key from perf_due_work indexed by __INDEX__ where work_kind = 'youtube-provenance-findings' and state = 'leased' and claimed_by = 'synthetic-owner-000000002' and claim_token = 'synthetic-claim-000000002' order by work_kind, state, claimed_by, claim_token, sort_key, subject_id limit 25",
    ),
    due_work_lease_idx: indexPlanStatement(
      indexName,
      "select subject_id, claim_expires_at from perf_due_work indexed by __INDEX__ where state = 'leased' and claim_expires_at <= '2026-01-02' order by state, claim_expires_at, work_kind, subject_id limit 25",
    ),
    due_work_ready_idx: indexPlanStatement(
      indexName,
      "select subject_id, sort_key from perf_due_work indexed by __INDEX__ where work_kind = 'mbid-isrc-lookup' and state = 'ready' and sort_key >= '000000000' order by work_kind, state, sort_key, subject_id limit 25",
    ),
    due_work_repair_idx: indexPlanStatement(
      indexName,
      "select subject_id from perf_due_work indexed by __INDEX__ where state = 'repair' and subject_type = 'track' and subject_id >= 'synthetic-due-subject-000000001' order by state, subject_type, subject_id limit 25",
    ),
    due_work_scheduled_idx: indexPlanStatement(
      indexName,
      "select subject_id, next_due_at from perf_due_work indexed by __INDEX__ where work_kind = 'youtube-provenance-findings' and state = 'scheduled' and next_due_at <= '2026-01-02' order by work_kind, state, next_due_at, subject_id limit 25",
    ),
    operation_receipts_operation_audit_idx: statement(
      "select operation_id, state, created_at, updated_at from perf_operation_receipts where operation_key = 'synthetic-operation-key-000000000'",
    ),
    operation_receipts_stale_accepted_idx: indexPlanStatement(
      indexName,
      "select operation_key, updated_at from perf_operation_receipts indexed by __INDEX__ where state = 'accepted' and updated_at <= '2026-01-03' order by state, updated_at, operation_key limit 25",
    ),
    projection_repairs_order_idx: indexPlanStatement(
      indexName,
      "select projection, source_epoch, subject_type, subject_id from perf_projection_repairs indexed by __INDEX__ where projection = 'synthetic-index-evidence' and source_epoch >= 0 order by projection, source_epoch, subject_type, subject_id limit 25",
      "production-lock",
    ),
  };
  const selected = plans[indexName];

  if (!selected) {
    throw new Error(`no database-scale plan evidence statement for ${indexName}`);
  }

  return {
    allowFullScanOf:
      indexName === "artifact_change_consumers_compaction_idx"
        ? "perf_artifact_change_consumers"
        : undefined,
    maxRows:
      indexName === "artifact_changes_stream_seq_idx"
        ? INDEX_EVIDENCE_LIMIT + 1
        : INDEX_EVIDENCE_LIMIT,
    minRows: indexName === "crawl_projection_repairs_order_idx" ? 0 : 1,
    statement: selected,
  };
}

function planFor(
  definition: IndexEvidenceDefinition,
  spec: IndexPlanSpec,
): { policy: ExplainPlanPolicy; statement: PerformanceStatement } {
  const requiredDetails: RegExp[] = [];
  const fixtureIndex = fixtureIndexName(definition.requiredIndexName);

  if (definition.requiredIndexName === "artifact-changes-integer-primary-key") {
    requiredDetails.push(/INTEGER PRIMARY KEY.*rowid[<>]/i);
  } else if (definition.requiredIndexName === "bounded-consumer-control-table") {
    // The exact compaction barrier spans active and rebuilding consumers, so the removed active-only
    // partial index is unusable. The registered-consumer table is a bounded control set, not corpus
    // data; its explicit scan is the structural proof for this drop.
    requiredDetails.push(/(?:SCAN|SEARCH) perf_artifact_change_consumers/i);
  } else if (definition.requiredIndexName === "artifact-change-checkpoints-primary-key") {
    requiredDetails.push(/sqlite_autoindex_perf_artifact_change_checkpoints_1/i);
  } else if (definition.requiredIndexName === "operation-receipts-primary-key") {
    requiredDetails.push(/sqlite_autoindex_perf_operation_receipts_1/i);
  } else {
    requiredDetails.push(new RegExp(`\\b${fixtureIndex}\\b`, "i"));
  }

  if (spec.allowFullScanOf && definition.requiredIndexName !== "bounded-consumer-control-table") {
    requiredDetails.push(new RegExp(`USING COVERING INDEX ${fixtureIndex}`, "i"));
  }

  return {
    policy: {
      allowFullScanOf: spec.allowFullScanOf ? [spec.allowFullScanOf] : undefined,
      forbidTempSort: spec.forbidTempSort ?? true,
      growingTables: [definition.growingTable],
      requiredDetails,
    },
    statement: spec.statement,
  };
}

function serializableRows(rows: readonly unknown[]): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function explainDetails(result: PerformanceResult): string[] {
  return result.rows.flatMap((row) => {
    if (typeof row === "object" && row !== null && "detail" in row) {
      const detail = (row as { detail?: unknown }).detail;
      return typeof detail === "string" ? [detail] : [];
    }

    return [];
  });
}

/** Time only the statement a production consumer runs; structural proof requests stay untimed. */
async function executeTimedFinalStatement(
  context: ContractContext,
  statement: PerformanceStatement,
): Promise<{ durationMs: number; result: PerformanceResult }> {
  const startedAt = context.now();
  const result = await context.client.execute(statement);

  return {
    durationMs: Math.max(0, context.now() - startedAt),
    result,
  };
}

async function executeSimpleIndexStatement(
  spec: IndexPlanSpec,
  context: ContractContext,
): Promise<ContractExecution> {
  const finalStatement = await executeTimedFinalStatement(context, spec.statement);

  return {
    durationMs: finalStatement.durationMs,
    metadata: {
      finalStatementRequestCount: 1,
      timingScope: "worst-single-final-statement",
    },
    rawResult: finalStatement.result,
    resultRowCount: finalStatement.result.rows.length,
  };
}

async function executeSimpleIndexProof(
  definition: IndexEvidenceDefinition,
  spec: IndexPlanSpec,
  context: ContractContext,
): Promise<ContractExecution> {
  const result = await context.client.execute(spec.statement);
  const droppedIndex =
    definition.inventoryEntry.decision === "drop"
      ? await context.client.execute({
          args: [fixtureIndexName(definition.inventoryEntry.name)],
          sql: "select name from sqlite_master where type = 'index' and name = ?",
        })
      : { rows: [] };
  const terminalProofRequestCount = definition.inventoryEntry.decision === "drop" ? 2 : 1;

  return {
    metadata: {
      cardinalityBound: result.rows.length >= spec.minRows && result.rows.length <= spec.maxRows,
      droppedIndexAbsent:
        definition.inventoryEntry.decision !== "drop" || droppedIndex.rows.length === 0,
      indexAuditEntry: definition.inventoryEntry.name,
      measuredRequestCount: INDEX_EVIDENCE_ITERATIONS + INDEX_EVIDENCE_WARMUP_ITERATIONS,
      minimumResultRows: spec.minRows,
      requiredIndex: definition.requiredIndexName,
      resultBound: spec.maxRows,
      terminalPlanRequestCount: 1,
      terminalProofRequestCount,
      totalRequestCount:
        INDEX_EVIDENCE_ITERATIONS +
        INDEX_EVIDENCE_WARMUP_ITERATIONS +
        terminalProofRequestCount +
        1,
    },
    rawResult: result,
    resultRowCount: result.rows.length,
  };
}

function validateSimpleIndexProof(
  definition: IndexEvidenceDefinition,
  spec: IndexPlanSpec,
  execution: ContractExecution,
): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];

  if (metadata.indexAuditEntry !== definition.inventoryEntry.name) {
    failures.push("index evidence is attached to the wrong inventory entry");
  }
  if (metadata.requiredIndex !== definition.requiredIndexName) {
    failures.push("index evidence requires the wrong surviving index");
  }
  if (definition.inventoryEntry.decision === "drop" && metadata.droppedIndexAbsent !== true) {
    failures.push("dropped index is still present in the final fixture schema");
  }
  if (
    metadata.cardinalityBound !== true ||
    execution.resultRowCount < spec.minRows ||
    execution.resultRowCount > spec.maxRows
  ) {
    failures.push("index evidence exceeded its bounded result cardinality");
  }

  return failures;
}

const DEFAULT_HUB_NON_NULL_REFERENCE = statement(
  `select id as track_id, release_date as rd
     from perf_tracks
    where (release_date, id) < ('2026', 'synthetic-track-000000464')
    order by release_date desc, id desc
    limit 48`,
);
const DEFAULT_HUB_NON_NULL_PRODUCTION_LOCK = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id, release_date as rd
     from perf_tracks indexed by __INDEX__
    where (release_date, id) < ('2026', 'synthetic-track-000000464')
    order by release_date desc, id desc
    limit 48`,
  "production-lock",
);
const DEFAULT_HUB_NON_NULL_SUPPLEMENTAL = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id, release_date as rd
     from perf_tracks indexed by __INDEX__
    where (release_date, id) < ('2026', 'synthetic-track-000000464')
    order by release_date desc, id desc
    limit 48`,
  "supplemental-force",
);
const DEFAULT_HUB_NULL_REFERENCE = statement(
  `select id as track_id, release_date as rd
     from perf_tracks
    where release_date is null
    order by release_date desc, id desc
    limit 48`,
);
const DEFAULT_HUB_NULL_PRODUCTION_LOCK = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id, release_date as rd
     from perf_tracks indexed by __INDEX__
    where release_date is null
    order by release_date desc, id desc
    limit 48`,
  "production-lock",
);
const DEFAULT_HUB_NULL_SUPPLEMENTAL = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id, release_date as rd
     from perf_tracks indexed by __INDEX__
    where release_date is null
    order by release_date desc, id desc
    limit 48`,
  "supplemental-force",
);
const DEFAULT_HUB_NON_NULL_UNFORCED = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id, release_date as rd
     from perf_tracks indexed by __INDEX__
    where (release_date, id) < ('2026', 'synthetic-track-000000464')
    order by release_date desc, id desc
    limit 48`,
);
const DEFAULT_HUB_NULL_UNFORCED = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id, release_date as rd
     from perf_tracks indexed by __INDEX__
    where release_date is null
    order by release_date desc, id desc
    limit 48`,
);
const DEFAULT_HUB_PAGE_ONE_PRODUCTION_LOCK = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id
     from perf_tracks indexed by __INDEX__
    order by release_date desc, id desc
    limit 48`,
  "production-lock",
);
const DEFAULT_HUB_NULL_ANCHOR_PRODUCTION_LOCK = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id
     from perf_tracks indexed by __INDEX__
    where release_date is null and id < 'synthetic-track-000100000'
    order by release_date desc, id desc
    limit 48`,
  "production-lock",
);
const DEFAULT_HUB_PAGE_ONE_SUPPLEMENTAL = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id
     from perf_tracks indexed by __INDEX__
    order by release_date desc, id desc
    limit 48`,
);
const DEFAULT_HUB_NULL_ANCHOR_SUPPLEMENTAL = indexPlanStatement(
  "tracks_release_date_track_id_idx",
  `select id as track_id
     from perf_tracks indexed by __INDEX__
    where release_date is null and id < 'synthetic-track-000100000'
    order by release_date desc, id desc
    limit 48`,
);

function releaseDateComparison(
  references: PerformanceStatement[],
  supplementalStatements: PerformanceStatement[],
  productionPlanPolicies: ExplainPlanPolicy[],
): ComparisonSpec {
  return {
    maxRows: INDEX_EVIDENCE_LIMIT,
    minRows: 1,
    productionPlanPolicies,
    references,
    statement: references[0] ?? statement("select 1 where 0"),
    supplementalStatements,
  };
}

function defaultHubComparison(productionLocked = false): ComparisonSpec {
  const policy: ExplainPlanPolicy = {
    allowFullScanOf: productionLocked ? ["perf_tracks"] : undefined,
    forbidTempSort: true,
    growingTables: ["perf_tracks"],
    requiredDetails: [/perf_tracks_release_date_track_id_idx/i],
  };
  const references = productionLocked
    ? [
        DEFAULT_HUB_PAGE_ONE_PRODUCTION_LOCK,
        DEFAULT_HUB_NON_NULL_PRODUCTION_LOCK,
        DEFAULT_HUB_NULL_ANCHOR_PRODUCTION_LOCK,
        DEFAULT_HUB_NULL_PRODUCTION_LOCK,
      ]
    : [DEFAULT_HUB_NON_NULL_REFERENCE, DEFAULT_HUB_NULL_REFERENCE];

  return {
    maxRows: productionLocked ? 192 : 96,
    minRows: 1,
    productionPlanPolicies: productionLocked ? [policy, policy, policy, policy] : [policy, policy],
    references,
    statement: references[0] ?? DEFAULT_HUB_NON_NULL_REFERENCE,
    supplementalPlanPolicies: productionLocked ? [policy, policy, policy, policy] : undefined,
    supplementalStatements: productionLocked
      ? [
          DEFAULT_HUB_PAGE_ONE_SUPPLEMENTAL,
          DEFAULT_HUB_NON_NULL_UNFORCED,
          DEFAULT_HUB_NULL_ANCHOR_SUPPLEMENTAL,
          DEFAULT_HUB_NULL_UNFORCED,
        ]
      : [DEFAULT_HUB_NON_NULL_SUPPLEMENTAL, DEFAULT_HUB_NULL_SUPPLEMENTAL],
  };
}

async function executeComparisonStatements(
  spec: ComparisonSpec,
  context: ContractContext,
): Promise<ContractExecution> {
  const finalStatementDurations: number[] = [];
  const referenceResults: PerformanceResult[] = [];

  for (const reference of spec.references) {
    const finalStatement = await executeTimedFinalStatement(context, reference);
    referenceResults.push(finalStatement.result);
    finalStatementDurations.push(finalStatement.durationMs);
  }

  return {
    durationMs: finalStatementDurations.reduce(
      (worst, durationMs) => Math.max(worst, durationMs),
      0,
    ),
    metadata: {
      finalStatementRequestCount: spec.references.length,
      timingScope: "worst-single-final-statement",
    },
    resultRowCount: referenceResults.reduce((total, result) => total + result.rows.length, 0),
  };
}

/** Terminal-only structural proof; measured comparison statements run in executeComparisonStatements. */
async function executeComparisonProof(
  definition: IndexEvidenceDefinition,
  spec: ComparisonSpec,
  context: ContractContext,
): Promise<ContractExecution> {
  const referenceResults: PerformanceResult[] = [];
  const referencePlanDetails: string[][] = [];
  const referencePlanAnalyses = [];
  const supplementalPlanDetails: string[][] = [];
  const supplementalPlanAnalyses = [];
  const supplementalResults: PerformanceResult[] = [];

  for (const [index, reference] of spec.references.entries()) {
    referenceResults.push(await context.client.execute(reference));
    const referencePlan = await context.client.execute({
      args: reference.args,
      sql: `EXPLAIN QUERY PLAN ${reference.sql}`,
    });
    const details = explainDetails(referencePlan);
    const productionPolicy = spec.productionPlanPolicies[index];
    if (productionPolicy === undefined) {
      throw new Error(
        `missing production plan policy ${index} for ${definition.inventoryEntry.name}`,
      );
    }
    referencePlanDetails.push(details);
    referencePlanAnalyses.push(analyzeExplainPlan(details, productionPolicy));
  }
  for (const [index, supplemental] of spec.supplementalStatements.entries()) {
    supplementalResults.push(await context.client.execute(supplemental));
    const supplementalPolicy = spec.supplementalPlanPolicies?.[index];
    if (supplementalPolicy !== undefined) {
      const supplementalPlan = await context.client.execute({
        args: supplemental.args,
        sql: `EXPLAIN QUERY PLAN ${supplemental.sql}`,
      });
      const details = explainDetails(supplementalPlan);
      supplementalPlanDetails.push(details);
      supplementalPlanAnalyses.push(analyzeExplainPlan(details, supplementalPolicy));
    }
  }

  const referenceRows = referenceResults.flatMap((result) => result.rows);
  const supplementalRows = supplementalResults.flatMap((result) => result.rows);
  const droppedIndex =
    definition.inventoryEntry.decision === "drop"
      ? await context.client.execute({
          args: [fixtureIndexName(definition.inventoryEntry.name)],
          sql: "select name from sqlite_master where type = 'index' and name = ?",
        })
      : { rows: [] };
  const terminalProofRequestCount =
    spec.references.length * 2 +
    spec.supplementalStatements.length +
    supplementalPlanAnalyses.length +
    (definition.inventoryEntry.decision === "drop" ? 1 : 0);

  return {
    metadata: {
      cardinalityBound:
        referenceRows.length >= spec.minRows && referenceRows.length <= spec.maxRows,
      droppedIndexAbsent:
        definition.inventoryEntry.decision !== "drop" || droppedIndex.rows.length === 0,
      indexAuditEntry: definition.inventoryEntry.name,
      measuredRequestCount:
        spec.references.length * (INDEX_EVIDENCE_ITERATIONS + INDEX_EVIDENCE_WARMUP_ITERATIONS),
      minimumResultRows: spec.minRows,
      outputsEquivalent: serializableRows(referenceRows) === serializableRows(supplementalRows),
      productionPlanDetails: JSON.stringify(referencePlanDetails),
      productionPlanUsesDroppedIndex:
        definition.inventoryEntry.decision === "drop" &&
        referencePlanDetails.some((details) =>
          details.some((detail) =>
            new RegExp(`\\b${fixtureIndexName(definition.inventoryEntry.name)}\\b`, "i").test(
              detail,
            ),
          ),
        ),
      productionPlanViolations: referencePlanAnalyses.reduce(
        (count, analysis) => count + analysis.violations.length,
        0,
      ),
      referenceResultRowCount: referenceRows.length,
      requiredIndex: definition.requiredIndexName,
      resultBound: spec.maxRows,
      supplementalPlanDetails: JSON.stringify(supplementalPlanDetails),
      supplementalPlanViolations: supplementalPlanAnalyses.reduce(
        (count, analysis) => count + analysis.violations.length,
        0,
      ),
      terminalPlanRequestCount: 1,
      terminalProofRequestCount,
      totalRequestCount:
        spec.references.length * (INDEX_EVIDENCE_ITERATIONS + INDEX_EVIDENCE_WARMUP_ITERATIONS) +
        terminalProofRequestCount +
        1,
    },
    resultRowCount: referenceRows.length,
  };
}

function validateComparisonProof(
  definition: IndexEvidenceDefinition,
  spec: ComparisonSpec,
  execution: ContractExecution,
): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures = [...validateSimpleIndexProof(definition, spec, execution)];

  if (metadata.outputsEquivalent !== true) {
    failures.push("consumer output changed against its alternate indexed proof");
  }
  if (
    definition.inventoryEntry.decision === "drop" &&
    (metadata.droppedIndexAbsent !== true || metadata.productionPlanUsesDroppedIndex !== false)
  ) {
    failures.push("drop proof still depends on the removed singleton");
  }
  if (metadata.referenceResultRowCount !== execution.resultRowCount) {
    failures.push("reference and replacement-index cardinalities differ");
  }
  if (metadata.productionPlanViolations !== 0) {
    failures.push("a production consumer plan violated its exact consumer policy");
  }
  if (
    metadata.supplementalPlanViolations !== undefined &&
    metadata.supplementalPlanViolations !== 0
  ) {
    failures.push("a supplemental same-shape plan violated its consumer policy");
  }

  return failures;
}

function definitionFor(entry: IndexInventoryEntry): IndexEvidenceDefinition {
  const replacementIndexes: Record<string, string> = {
    artifact_change_checkpoints_running_idx: "artifact-change-checkpoints-primary-key",
    artifact_change_consumers_compaction_idx: "bounded-consumer-control-table",
    artifact_changes_created_seq_idx: "artifact-changes-integer-primary-key",
    artifact_changes_stream_seq_idx: "artifact-changes-integer-primary-key",
    operation_receipts_operation_audit_idx: "operation-receipts-primary-key",
    tracks_capture_priority_idx: "tracks_vendor_worklist_idx",
    tracks_nearest_finding_score_idx: "tracks_catalogue_ear_idx",
  };
  const requiredIndexName = replacementIndexes[entry.name] ?? entry.name;

  return {
    growingTable: tableForIndex(entry.name),
    inventoryEntry: entry,
    requiredIndexName,
  };
}

function forceTracksIndex(
  reference: PerformanceStatement,
  indexName: string,
): PerformanceStatement {
  const indexedFrom = new RegExp(`\\bfrom\\s+perf_tracks\\s+t\\b`, "i");
  const forcedSql = reference.sql.replace(
    indexedFrom,
    `from perf_tracks t indexed by ${fixtureIndexName(indexName)}`,
  );

  if (forcedSql === reference.sql) {
    throw new Error(`cannot force ${indexName} on a tracks evidence statement`);
  }

  return statement(forcedSql, reference.args);
}

const CRAWL_DUE_EVIDENCE_COLUMNS = `claim_expires_at, claim_position, claim_token, claimed_by,
  created_at, demand_rank, generation, hop, label_slug, next_due_at, node_id, node_kind,
  parent_id, source_version, state, storable_rank, updated_at`;

function reviewedCrawlComparison(entry: IndexInventoryEntry): ComparisonSpec | undefined {
  const statements: Partial<Record<string, PerformanceStatement>> = {
    crawl_due_work_claim_position_idx: statement(
      `select ${CRAWL_DUE_EVIDENCE_COLUMNS}
         from perf_crawl_due_work indexed by __INDEX__
        where state = 'leased' and claimed_by = ? and claim_token = ?
        order by claim_position`,
      ["synthetic-crawl-worker", "synthetic-crawl-claim-000000002"],
    ),
    crawl_due_work_label_slug_node_id_idx: statement(
      `select node_id from perf_crawl_due_work indexed by __INDEX__
        where label_slug = ? and state <> 'repair' limit ?`,
      ["synthetic-label-000000001", INDEX_EVIDENCE_LIMIT],
    ),
    crawl_due_work_parent_id_node_id_idx: statement(
      `select node_id from perf_crawl_due_work
        where node_id = ? and state <> 'repair'
        union all
        select node_id from perf_crawl_due_work indexed by __INDEX__
        where parent_id = ? and state <> 'repair' and node_id <> ?1
        limit ?`,
      ["synthetic-frontier-000000000", "synthetic-frontier-000000000", INDEX_EVIDENCE_LIMIT],
    ),
    crawl_due_work_ready_idx: statement(
      `select ${CRAWL_DUE_EVIDENCE_COLUMNS}
         from perf_crawl_due_work indexed by __INDEX__
        where state = 'ready' and node_id not in (?)
        order by hop, demand_rank, created_at, node_id
        limit ?`,
      ["synthetic-frontier-000000000", INDEX_EVIDENCE_LIMIT],
    ),
    crawl_due_work_release_ready_idx: statement(
      `select ${CRAWL_DUE_EVIDENCE_COLUMNS}
         from perf_crawl_due_work indexed by __INDEX__
        where state = 'ready' and node_kind = 'release'
        order by storable_rank, hop, demand_rank, created_at, node_id
        limit ?`,
      [INDEX_EVIDENCE_LIMIT],
    ),
    crawl_due_work_repair_idx: statement(
      `select ${CRAWL_DUE_EVIDENCE_COLUMNS}
         from perf_crawl_due_work indexed by __INDEX__
        where state = 'repair' order by node_id limit ?`,
      [INDEX_EVIDENCE_LIMIT],
    ),
    crawl_due_work_scheduled_idx: statement(
      `select due.node_id
         from perf_crawl_due_work as due indexed by __INDEX__
         join perf_crawl_frontier as source on source.id = due.node_id
        where due.state = 'scheduled' and due.next_due_at <= ?
          and source.state = 'done' and source.kind = 'artist' and source.source = 'musicbrainz'
        order by due.next_due_at, due.node_id limit ?`,
      ["9999-12-31T23:59:59.999Z", INDEX_EVIDENCE_LIMIT],
    ),
    crawl_projection_repairs_order_idx: statement(
      `select source_type, source_id, source_epoch, source_version, created_at, updated_at
         from perf_crawl_projection_repairs indexed by __INDEX__
        order by source_epoch, source_type, source_id limit 1`,
    ),
  };
  const template = statements[entry.name];
  if (template === undefined) {
    return undefined;
  }

  const productionLock = {
    ...indexPlanStatement(entry.name, template.sql, "production-lock"),
    args: template.args,
  };
  const unforced = {
    ...indexPlanStatement(entry.name, template.sql, "unforced"),
    args: template.args,
  };
  const growingTables =
    entry.name === "crawl_due_work_scheduled_idx"
      ? ["perf_crawl_due_work", "perf_crawl_frontier"]
      : [tableForIndex(entry.name)];
  const productionRequiredDetails = [new RegExp(`\\b${fixtureIndexName(entry.name)}\\b`, "i")];
  if (entry.name === "crawl_due_work_parent_id_node_id_idx") {
    productionRequiredDetails.push(/sqlite_autoindex_perf_crawl_due_work_1/i);
  }
  if (entry.name === "crawl_due_work_scheduled_idx") {
    productionRequiredDetails.push(/perf_crawl_frontier_state_id_idx/i);
  }
  const allowFullScanOf =
    entry.name === "crawl_projection_repairs_order_idx"
      ? ["perf_crawl_projection_repairs"]
      : undefined;

  return {
    maxRows: entry.name === "crawl_due_work_claim_position_idx" ? 500 : INDEX_EVIDENCE_LIMIT,
    minRows: 1,
    productionPlanPolicies: [
      {
        allowFullScanOf,
        forbidTempSort: true,
        growingTables,
        requiredDetails: productionRequiredDetails,
      },
    ],
    references: [productionLock],
    statement: productionLock,
    supplementalPlanPolicies: [{ allowFullScanOf, forbidTempSort: true, growingTables }],
    supplementalStatements: [unforced],
  };
}

function lockedAndUnforcedConsumerComparison(
  locked: PerformanceStatement,
  unforced: PerformanceStatement,
  policy: ExplainPlanPolicy,
  bounds: Pick<IndexPlanSpec, "maxRows" | "minRows">,
  supplementalPolicyOverrides: Partial<ExplainPlanPolicy> = {},
): ComparisonSpec {
  const { requiredDetails: _requiredDetails, ...unforcedPolicy } = policy;
  return {
    ...bounds,
    productionPlanPolicies: [policy],
    references: [locked],
    statement: locked,
    supplementalPlanPolicies: [{ ...unforcedPolicy, ...supplementalPolicyOverrides }],
    supplementalStatements: [unforced],
  };
}

function lockedTrackConsumerStatement(
  indexName: string,
  sql: string,
  args: PerformanceStatement["args"],
): { locked: PerformanceStatement; unforced: PerformanceStatement } {
  return {
    locked: statement(indexPlanStatement(indexName, sql, "production-lock").sql, args),
    unforced: statement(indexPlanStatement(indexName, sql).sql, args),
  };
}

function planSpecFor(
  entry: IndexInventoryEntry,
  contractId: string,
): IndexPlanSpec | ComparisonSpec {
  const reviewedCrawl = reviewedCrawlComparison(entry);
  if (reviewedCrawl !== undefined) {
    return reviewedCrawl;
  }

  if (entry.name === "tracks_anchor_queue_idx") {
    const consumer = lockedTrackConsumerStatement(
      entry.name,
      `select count(*) as n
         from perf_tracks indexed by __INDEX__
        where isrc is not null and spotify_uri is null
          and not exists (
            select 1 from perf_findings where perf_findings.track_id = perf_tracks.id
          )`,
      [],
    );
    return lockedAndUnforcedConsumerComparison(
      consumer.locked,
      consumer.unforced,
      {
        forbidTempSort: true,
        growingTables: ["perf_tracks", "perf_findings"],
        requiredDetails: [/perf_tracks_anchor_queue_idx/i, /perf_findings/i],
      },
      { maxRows: 1, minRows: 1 },
    );
  }

  if (entry.name === "tracks_label_id_idx") {
    const consumer = lockedTrackConsumerStatement(
      entry.name,
      `select t.id as track_id
         from perf_tracks t indexed by __INDEX__
        where t.label_id = ?
          and exists (select 1 from perf_track_artists ta where ta.track_id = t.id)
          and not exists (
            select 1 from perf_projection_repairs pr
             where pr.projection = 'artist_qualification' and pr.subject_type = 'track'
               and pr.subject_id = t.id and pr.source_epoch >= ?
          )
        limit ?`,
      ["synthetic-label-000000000", 2, INDEX_EVIDENCE_LIMIT],
    );
    return lockedAndUnforcedConsumerComparison(
      consumer.locked,
      consumer.unforced,
      {
        forbidTempSort: true,
        growingTables: ["perf_tracks", "perf_track_artists", "perf_projection_repairs"],
        requiredDetails: [
          /perf_tracks_label_id_idx/i,
          /perf_track_artists/i,
          /perf_projection_repairs/i,
        ],
      },
      { maxRows: INDEX_EVIDENCE_LIMIT, minRows: 1 },
      { forbidTempSort: false },
    );
  }

  if (entry.name === "tracks_mb_recording_id_queue_idx") {
    const consumer = lockedTrackConsumerStatement(
      entry.name,
      `select id as track_id, isrc
         from perf_tracks indexed by __INDEX__
        where mb_recording_id is null
          and mb_recording_id_attempted_at is null
          and isrc is not null and isrc != ''
          and substr(id, 1, 3) != 'mb_'
          and id > ?
        order by id asc
        limit ?`,
      ["synthetic-track-000000000", INDEX_EVIDENCE_LIMIT],
    );
    return lockedAndUnforcedConsumerComparison(
      consumer.locked,
      consumer.unforced,
      {
        forbidTempSort: true,
        growingTables: ["perf_tracks"],
        requiredDetails: [/perf_tracks_mb_recording_id_queue_idx/i],
      },
      { maxRows: INDEX_EVIDENCE_LIMIT, minRows: 1 },
      { forbidTempSort: false },
    );
  }

  if (entry.name === "artist_qualification_qualified_idx") {
    const locked = statement(
      indexPlanStatement(
        entry.name,
        `select qualification.artist_id
         from perf_artist_qualification_state as artist_state
         left join perf_artist_qualification as qualification
           indexed by __INDEX__ on qualification.is_qualified = 1
        where artist_state.scope = 'artists'
          and artist_state.state = 'complete'
          and artist_state.projection_epoch = artist_state.source_epoch
          and not exists (
            select 1 from perf_projection_repairs where projection = 'artist_qualification'
          )
        order by qualification.artist_id`,
        "production-lock",
      ).sql,
      [],
    );
    const unforced = statement(indexPlanStatement(entry.name, locked.sql).sql, locked.args);
    return lockedAndUnforcedConsumerComparison(
      locked,
      unforced,
      {
        forbidTempSort: true,
        growingTables: [
          "perf_artist_qualification",
          "perf_artist_qualification_state",
          "perf_projection_repairs",
        ],
        requiredDetails: [/perf_artist_qualification_qualified_idx/i, /perf_projection_repairs/i],
      },
      { maxRows: INDEX_EVIDENCE_LIMIT, minRows: 0 },
    );
  }

  if (entry.name === "tracks_anchor_order_idx") {
    const consumer = lockedTrackConsumerStatement(
      entry.name,
      `select t.id as track_id, t.title, t.artists_json, t.isrc, t.label, t.duration_ms,
              t.source_audio_key, t.source_audio_rejected, t.capture_priority, t.bpm,
              t.analyzed_from, t.source_audio_failures, f.log_id as log_id,
              (f.track_id is not null) as certified
         from perf_tracks t indexed by __INDEX__
         left join perf_findings f on f.track_id = t.id
        where f.track_id is null
          and t.spotify_uri is null
          and (t.spotify_anchor_attempted_at is null or t.spotify_anchor_attempted_at < ?)
          and (t.label_id is null or t.label_id not in (
            select id from perf_labels where seed_state = 'disabled'
          ))
          and t.duration_ms > 0
          and t.dismissed_at is null
          and t.duplicate_of_track_id is null
          and coalesce(t.spotify_anchor_attempts, 0) < 6
          and lower(t.artists_json) not in (?, ?, ?, ?, ?, ?)
        order by t.has_isrc desc, t.has_embedding desc, t.nearest_finding_score desc, t.id desc
        limit ?`,
      [
        "2026-01-01T00:00:00.000Z",
        '["unknown artist"]',
        '["various artists"]',
        '["va"]',
        '["unknown"]',
        '["[unknown]"]',
        '["traditional"]',
        INDEX_EVIDENCE_LIMIT,
      ],
    );
    return lockedAndUnforcedConsumerComparison(
      consumer.locked,
      consumer.unforced,
      {
        allowFullScanOf: ["t", "perf_labels"],
        forbidTempSort: true,
        growingTables: ["t", "perf_tracks", "perf_findings", "perf_labels"],
        requiredDetails: [/perf_tracks_anchor_order_idx/i, /perf_findings/i, /perf_labels/i],
      },
      { maxRows: INDEX_EVIDENCE_LIMIT, minRows: 1 },
      { forbidTempSort: false },
    );
  }

  if (entry.name === "projection_repairs_order_idx") {
    const locked = statement(
      indexPlanStatement(
        entry.name,
        `select projection, subject_type, subject_id, source_epoch, source_version
         from perf_projection_repairs indexed by __INDEX__
        where projection = ? and subject_type = ?
        order by source_epoch, subject_type, subject_id
        limit 1`,
        "production-lock",
      ).sql,
      ["artist_qualification", "label"],
    );
    const unforced = statement(indexPlanStatement(entry.name, locked.sql).sql, locked.args);
    return lockedAndUnforcedConsumerComparison(
      locked,
      unforced,
      {
        forbidTempSort: false,
        growingTables: ["perf_projection_repairs"],
        requiredDetails: [/perf_projection_repairs_order_idx/i],
      },
      { maxRows: 1, minRows: 0 },
    );
  }

  if (entry.name === "tracks_capture_priority_idx") {
    // The compact fixture has no vendor reliability columns. Project equivalent fixture state under
    // the production names, then run the unchanged catalogue predicate/order/result shapes so the
    // surviving vendor-worklist index is still tested without widening the fixture schema.
    const apple = statement(
      `with vendor_tracks as (
        select t.id as track_id, t.isrc, t.album_id,
               t.source_audio_attempted_at as backfill_apple_music_attempted_at,
               t.spotify_anchor_attempts as backfill_apple_music_failures,
               t.source_audio_key as apple_music_url,
               t.source_audio_key as backfill_apple_music_done_at,
               t.is_catalogue, t.capture_priority
          from perf_tracks t
      )
      select t.track_id, t.isrc, t.album_id,
             t.backfill_apple_music_attempted_at as attempted_at,
             t.backfill_apple_music_failures as failures
        from vendor_tracks t
       where t.is_catalogue = 1
         and t.apple_music_url is null
         and t.isrc is not null and trim(t.isrc) <> ''
         and t.backfill_apple_music_done_at is null
         and (t.backfill_apple_music_attempted_at is null
              or t.backfill_apple_music_attempted_at < ?)
       order by t.capture_priority desc, t.track_id desc
       limit ?`,
      ["2026-01-01T00:00:00.000Z", INDEX_EVIDENCE_LIMIT],
    );
    const deezer = statement(
      `with vendor_tracks as (
        select t.id as track_id, t.isrc, t.duration_ms,
               t.deezer_track_id,
               t.source_audio_attempted_at as backfill_deezer_attempted_at,
               t.spotify_anchor_attempts as backfill_deezer_failures,
               t.is_catalogue, t.capture_priority
          from perf_tracks t
      )
      select t.track_id, t.isrc, t.duration_ms
        from vendor_tracks t
       where t.is_catalogue = 1
         and t.deezer_track_id is null
         and t.backfill_deezer_attempted_at is null
         and t.backfill_deezer_failures < ?
         and t.isrc is not null and trim(t.isrc) <> ''
         and t.duration_ms > 0
       order by t.capture_priority desc, t.track_id desc
       limit ?`,
      [3, INDEX_EVIDENCE_LIMIT],
    );
    const beatport = statement(
      `with vendor_tracks as (
        select t.id as track_id, t.isrc, t.title, t.artists_json,
               t.source_audio_attempted_at as backfill_beatport_attempted_at,
               t.spotify_anchor_attempts as backfill_beatport_failures,
               t.source_audio_key as beatport_url,
               t.source_audio_key as backfill_beatport_done_at,
               t.is_catalogue, t.capture_priority
          from perf_tracks t
      )
      select t.track_id, t.isrc, t.title, t.artists_json,
             t.backfill_beatport_attempted_at as attempted_at,
             t.backfill_beatport_failures as failures
        from vendor_tracks t
       where t.is_catalogue = 1
         and t.beatport_url is null
         and t.isrc is not null and trim(t.isrc) <> ''
         and t.backfill_beatport_done_at is null
         and (t.backfill_beatport_attempted_at is null
              or (t.backfill_beatport_failures > 0
                  and t.backfill_beatport_attempted_at < ?))
       order by t.capture_priority desc, t.track_id desc
       limit ?`,
      ["2026-01-01T00:00:00.000Z", INDEX_EVIDENCE_LIMIT],
    );
    const policy: ExplainPlanPolicy = {
      forbidTempSort: true,
      growingTables: ["perf_tracks"],
      requiredDetails: [/perf_tracks_vendor_worklist_idx/i],
    };

    return {
      maxRows: INDEX_EVIDENCE_LIMIT * 3,
      minRows: 1,
      productionPlanPolicies: [policy, policy, policy],
      references: [apple, deezer, beatport],
      statement: apple,
      supplementalStatements: [
        forceTracksIndex(apple, "tracks_vendor_worklist_idx"),
        forceTracksIndex(deezer, "tracks_vendor_worklist_idx"),
        forceTracksIndex(beatport, "tracks_vendor_worklist_idx"),
      ],
    };
  }

  if (entry.name === "tracks_release_date_idx") {
    if (contractId === "index.tracks-release-date-default-hub") {
      return defaultHubComparison();
    }

    if (contractId === "index.tracks-release-date-fresh") {
      const projection =
        "tracks.id, tracks.title, tracks.artists_json, tracks.release_date, findings.log_id";
      const branches = [
        {
          args: ["synthetic-artist-000000000", "2024-01-01", "2026-12-31", 25],
          driver: /perf_track_artists_artist_id_idx/i,
          sql: `select ${projection}
            from perf_findings findings join perf_tracks tracks on tracks.id = findings.track_id
            join perf_track_artists track_artists on track_artists.track_id = tracks.id
            where track_artists.artist_id = ?
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.id desc
            limit ?`,
        },
        {
          args: ["synthetic-label-000000000", "2024-01-01", "2026-12-31", 25],
          driver: /perf_tracks_label_id_idx/i,
          sql: `select ${projection}
            from perf_findings findings join perf_tracks tracks on tracks.id = findings.track_id
            where tracks.label_id = ?
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.id desc
            limit ?`,
        },
        {
          args: ["synthetic-artist-000000000", "2024-01-01", "2026-12-31", 25],
          driver: /perf_track_artists_artist_id_idx/i,
          sql: `select ${projection}
            from perf_tracks tracks
            left join perf_findings findings on findings.track_id = tracks.id
            join perf_track_artists track_artists on track_artists.track_id = tracks.id
            where findings.track_id is null
              and track_artists.artist_id = ?
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.id desc
            limit ?`,
        },
        {
          args: ["synthetic-label-000000000", "2024-01-01", "2026-12-31", 25],
          driver: /perf_tracks_label_id_idx/i,
          sql: `select ${projection}
            from perf_tracks tracks
            left join perf_findings findings on findings.track_id = tracks.id
            where findings.track_id is null
              and tracks.label_id = ?
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.id desc
            limit ?`,
        },
      ];
      const references = branches.map((branch) => statement(branch.sql, branch.args));
      const supplemental = references.map((reference) =>
        statement(
          reference.sql.replace(
            "perf_tracks tracks",
            "perf_tracks tracks indexed by perf_tracks_release_date_track_id_idx",
          ),
          reference.args,
        ),
      );
      return {
        ...releaseDateComparison(
          references,
          supplemental,
          branches.map((branch) => ({
            forbidTempSort: false,
            growingTables: ["perf_tracks", "perf_track_artists", "perf_findings"],
            requiredDetails: [branch.driver],
          })),
        ),
        maxRows: 100,
      };
    }

    if (contractId === "index.tracks-release-date-public-findings") {
      const exact = `select tracks.id, tracks.title, tracks.artists_json, tracks.album_image_url,
                tracks.release_date, findings.log_id,
                fresh_lead_artist.image_url as artist_image_url,
                fresh_lead_artist.image_key as artist_image_key,
                fresh_lead_artist.image_state as artist_image_state,
                fresh_lead_artist.image_updated_at as artist_image_updated_at
         from perf_findings findings join perf_tracks tracks on tracks.id = findings.track_id
         left join perf_artists fresh_lead_artist on fresh_lead_artist.id = (
           select track_artists.artist_id from perf_track_artists track_artists
            where track_artists.track_id = tracks.id
            order by track_artists.position asc limit 1)
        where tracks.release_date >= ? and tracks.release_date <= ?
        order by tracks.release_date desc, tracks.id desc
        limit ?`;
      const args = ["2026-10-01", "2026-12-31", 60];
      const forced = exact.replace(
        "perf_tracks tracks",
        "perf_tracks tracks indexed by perf_tracks_release_date_track_id_idx",
      );
      return {
        ...releaseDateComparison(
          [statement(exact, args)],
          [statement(forced, args)],
          [
            {
              allowFullScanOf: ["perf_findings"],
              forbidTempSort: false,
              growingTables: ["perf_tracks", "perf_findings", "perf_track_artists", "perf_artists"],
              requiredDetails: [
                /perf_findings/i,
                /perf_tracks/i,
                /perf_track_artists/i,
                /perf_artists/i,
              ],
            },
          ],
        ),
        maxRows: 60,
      };
    }

    if (contractId === "index.tracks-release-date-public-records") {
      const exact = `select albums.slug as slug, min(albums.name) as name,
                max(tracks.release_date) as release_date,
                count(distinct tracks.id) as track_count,
                group_concat(distinct credit.value) as artists,
                albums.image_key as image_key, albums.image_state as image_state,
                albums.image_updated_at as image_updated_at,
                (select candidate.album_image_url
                   from perf_tracks candidate
                  where candidate.album_id = albums.id and candidate.album_image_url is not null
                  order by candidate.release_date is null asc,
                           candidate.release_date desc, candidate.id asc
                  limit 1) as cover_url
         from perf_tracks tracks
         join perf_albums albums on albums.id = tracks.album_id
         join json_each(tracks.artists_json) credit
        where tracks.release_date >= ? and tracks.release_date <= ?
        group by albums.id
        order by max(tracks.release_date) desc, min(albums.name) collate nocase asc
        limit ?`;
      const args = ["2026-10-01", "2026-12-31", 24];
      const forced = exact.replace(
        "from perf_tracks tracks",
        "from perf_tracks tracks indexed by perf_tracks_release_date_track_id_idx",
      );
      return {
        ...releaseDateComparison(
          [statement(exact, args)],
          [statement(forced, args)],
          [
            {
              forbidTempSort: false,
              growingTables: ["perf_tracks", "perf_albums"],
              requiredDetails: [/perf_tracks_release_date_track_id_idx/i, /perf_albums/i],
            },
          ],
        ),
        forbidTempSort: false,
        maxRows: 24,
      };
    }

    if (contractId === "index.tracks-release-date-year") {
      const exact = `select substr(tracks.release_date, 1, 4) as year, count(*) as n
         from perf_tracks tracks
        where tracks.release_date is not null
        group by year
        order by year desc`;
      const forced = exact.replace(
        "from perf_tracks tracks",
        "from perf_tracks tracks indexed by perf_tracks_release_date_track_id_idx",
      );
      return {
        ...releaseDateComparison(
          [statement(exact)],
          [statement(forced)],
          [
            {
              allowFullScanOf: ["perf_tracks"],
              forbidTempSort: false,
              growingTables: ["perf_tracks"],
              requiredDetails: [/perf_tracks_release_date_track_id_idx/i],
            },
          ],
        ),
        allowFullScanOf: "perf_tracks",
        forbidTempSort: false,
        maxRows: 25,
      };
    }

    if (contractId === "index.tracks-release-date-search") {
      const exact = `select tracks.id as track_id, tracks.title, tracks.artists_json, tracks.album,
                tracks.album_image_url, tracks.bpm, tracks.key, tracks.label,
                tracks.release_date, tracks.spotify_url, findings.log_id,
                (select name from perf_galaxies galaxies where galaxies.id = findings.galaxy_id)
                  as galaxy_name
         from perf_tracks tracks
         left join perf_findings findings on findings.track_id = tracks.id
        where tracks.release_date >= '2024' and tracks.release_date < '2027'
        order by case when findings.track_id is null then 1 else 0 end asc,
                 tracks.release_date desc, tracks.id asc
        limit 25`;
      const forced = exact.replace(
        "from perf_tracks tracks",
        "from perf_tracks tracks indexed by perf_tracks_release_date_track_id_idx",
      );
      return {
        ...releaseDateComparison(
          [statement(exact)],
          [statement(forced)],
          [
            {
              forbidTempSort: false,
              growingTables: ["perf_tracks", "perf_findings"],
              requiredDetails: [/perf_tracks_release_date_track_id_idx/i],
            },
          ],
        ),
        forbidTempSort: false,
      };
    }

    throw new Error(`unknown release-date drop contract ${contractId}`);
  }

  if (entry.name === "tracks_release_date_track_id_idx") {
    return defaultHubComparison(true);
  }
  return entry.name.startsWith("tracks_")
    ? genericTrackPlan(entry.name)
    : genericDatabaseScalePlan(entry.name);
}

function productionLockPolicy(
  expectedPlanUses: readonly ProductionLockPlanUse[],
  growingTables: readonly string[],
  options: Pick<ExplainPlanPolicy, "allowFullScanOf" | "forbidTempSort"> = {},
): ExplainPlanPolicy {
  return {
    allowFullScanOf: options.allowFullScanOf,
    forbidTempSort: options.forbidTempSort ?? true,
    growingTables,
    requiredDetails: expectedPlanUses.map((use) => use.pattern),
  };
}

function unforcedProductionLockPolicy(policy: ExplainPlanPolicy): ExplainPlanPolicy {
  return { ...policy, requiredDetails: [] };
}

function productionLockSpec(reference: ProductionLockContract): ProductionLockComparisonSpec {
  if (reference.id === "index.production-lock.sitemap-index-count") {
    const production = trackSitemapIndexCountStatement();
    const locked = statement(
      production.sql
        .replaceAll("tracks_sitemap_indexable_cover_idx", "perf_tracks_sitemap_indexable_cover_idx")
        .replace(/\btracks\b/g, "perf_tracks"),
      production.args,
    );
    const unforced = statement(
      locked.sql.replaceAll(" indexed by perf_tracks_sitemap_indexable_cover_idx", ""),
      locked.args,
    );
    const expectedPlanUses = [
      {
        count: 2,
        index: "tracks_sitemap_indexable_cover_idx",
        pattern:
          /(?:SCAN|SEARCH) perf_tracks USING (?:COVERING )?INDEX perf_tracks_sitemap_indexable_cover_idx/i,
      },
    ];
    const lockedPolicy = productionLockPolicy(expectedPlanUses, ["perf_tracks"], {
      allowFullScanOf: ["perf_tracks"],
    });

    return {
      expectedPlanUses,
      locked,
      lockedPolicy,
      maxRows: 1,
      minRows: 1,
      mutating: false,
      unforced,
      unforcedPolicy: unforcedProductionLockPolicy(lockedPolicy),
    };
  }

  if (reference.id === "index.production-lock.artist-link") {
    const trackIds = [
      "synthetic-track-000000000",
      "synthetic-track-000000001",
      "synthetic-track-000000002",
      "synthetic-track-000000003",
      "synthetic-track-000000004",
    ];
    const placeholders = trackIds.map(() => "?").join(", ");
    const triples = JSON.stringify([
      [trackIds[0], 1, "synthetic-mbid-identity"],
      [trackIds[1], 1, "synthetic-mbid-unclaimed"],
      [trackIds[2], 1, "synthetic-mbid-collision"],
      [trackIds[3], 2, "synthetic-mbid-identity"],
      [trackIds[3], 3, "synthetic-mbid-identity"],
      [trackIds[4], 1, "synthetic-mbid-identity"],
    ]);
    const statements = productionLockStatementPair(
      reference.indexes,
      `with credit_id as materialized (
         select cast(json_extract(value, '$[0]') as text) as track_id,
                cast(json_extract(value, '$[1]') as integer) as position,
                cast(json_extract(value, '$[2]') as text) as mbid
           from json_each(?)
       ),
       requested_credit as materialized (
         select tracks.id as track_id,
                cast(credit.key as integer) + 1 as position,
                cast(credit.value as text) as artist_name,
                tracks.is_catalogue,
                credit_id.mbid
           from perf_tracks tracks
           join json_each(tracks.artists_json) credit
           left join credit_id
             on credit_id.track_id = tracks.id
            and credit_id.position = cast(credit.key as integer) + 1
          where tracks.id in (${placeholders})
       ),
       resolved_candidate as materialized (
         select credit.track_id, artist.id as artist_id, credit.position, credit.is_catalogue
           from requested_credit credit
           cross join perf_artists artist indexed by __ARTISTS_MBID_IDX__
             on artist.mbid = credit.mbid
          where credit.mbid is not null
         union all
         select credit.track_id, artist.id as artist_id, credit.position, credit.is_catalogue
           from requested_credit credit
           cross join perf_artists artist indexed by __ARTISTS_NAME_NOCASE_IDX__
             on artist.name collate nocase = credit.artist_name
          where credit.mbid is not null
            and artist.mbid is null
            and not exists (
                  select 1 from perf_artists claimed indexed by __ARTISTS_MBID_IDX__
                   where claimed.mbid = credit.mbid
                )
         union all
         select credit.track_id, artist.id as artist_id, credit.position, credit.is_catalogue
           from requested_credit credit
           cross join perf_artists artist indexed by __ARTISTS_NAME_NOCASE_IDX__
             on artist.name collate nocase = credit.artist_name
          where credit.mbid is null
       ),
       resolved_edge as (
         select candidate.track_id, candidate.artist_id, candidate.position
           from resolved_candidate candidate
          where not exists (
                select 1
                  from resolved_candidate earlier
                 where earlier.track_id = candidate.track_id
                   and earlier.artist_id = candidate.artist_id
                   and earlier.position < candidate.position
          )
       )
       insert or ignore into perf_track_artists (track_id, artist_id, position)
       select track_id, artist_id, position from resolved_edge
       returning track_id, artist_id,
                 (select tracks.is_catalogue
                    from perf_tracks tracks
                   where tracks.id = perf_track_artists.track_id) as is_catalogue,
                 (select tracks.key is not null and tracks.has_embedding = 1
                    from perf_tracks tracks
                   where tracks.id = perf_track_artists.track_id) as is_rankable`,
      [triples, ...trackIds],
    );
    const expectedPlanUses = [
      {
        count: 1,
        index: "artists_mbid_idx",
        pattern: /SEARCH artist USING (?:COVERING )?INDEX perf_artists_mbid_idx \(mbid=\?\)/i,
      },
      {
        count: 1,
        index: "artists_mbid_idx",
        pattern: /SEARCH claimed USING (?:COVERING )?INDEX perf_artists_mbid_idx \(mbid=\?\)/i,
      },
      {
        count: 2,
        index: "artists_name_nocase_idx",
        pattern:
          /SEARCH artist USING (?:COVERING )?INDEX perf_artists_name_nocase_idx \(name=\?\)/i,
      },
    ];
    const originalEdges = trackIds.flatMap((trackId, index) => [
      [trackId, `synthetic-artist-${index.toString().padStart(9, "0")}`, 1, null],
      [trackId, `synthetic-artist-${(index * 7 + 3).toString().padStart(9, "0")}`, 2, "remixer"],
    ]);
    const policy = productionLockPolicy(expectedPlanUses, [
      "tracks",
      "artist",
      "claimed",
      "perf_track_artists",
    ]);
    return {
      ...statements,
      expectedPlanUses,
      lockedPolicy: policy,
      maxRows: 25,
      minRows: 0,
      mutating: true,
      mutationPreparation: statement(
        `delete from perf_track_artists where track_id in (${placeholders})`,
        trackIds,
      ),
      mutationRestoration: [
        statement(`delete from perf_track_artists where track_id in (${placeholders})`, trackIds),
        statement(
          `insert into perf_track_artists (track_id, artist_id, position, role)
           values ${originalEdges.map(() => "(?, ?, ?, ?)").join(", ")}`,
          originalEdges.flat(),
        ),
      ],
      mutationRows: { max: 7, min: 7 },
      unforcedPolicy: unforcedProductionLockPolicy(policy),
    };
  }

  if (reference.id === "index.production-lock.mixable-artists") {
    const statements = productionLockStatementPair(
      reference.indexes,
      `select artists.name, artists.slug, artists.image_url,
              artists.rankable_track_count as track_count
         from perf_artists artists indexed by __ARTISTS_MIXABLE_ORDER_IDX__
        where artists.rankable_track_count > 0
          and artists.name like ? collate nocase
        order by -artists.rankable_track_count asc, artists.name asc
        limit ?`,
      ["%Synthetic Artist%", 60],
    );
    const expectedPlanUses = [
      {
        count: 1,
        index: "artists_mixable_order_idx",
        pattern: /SCAN artists USING INDEX perf_artists_mixable_order_idx/i,
      },
    ];
    const policy = productionLockPolicy(expectedPlanUses, ["artists"], {
      allowFullScanOf: ["artists"],
    });
    return {
      ...statements,
      expectedPlanUses,
      lockedPolicy: policy,
      maxRows: 60,
      minRows: 1,
      mutating: false,
      unforcedPolicy: unforcedProductionLockPolicy(policy),
    };
  }

  if (reference.id === "index.production-lock.due-work-cleanup") {
    const statements = productionLockStatementPair(
      reference.indexes,
      `select generation, subject_id, updated_at from (
         select generation, subject_id, updated_at
           from perf_due_work indexed by __DUE_WORK_CLEANUP_IDX__
          where work_kind = ? and subject_type = ? and state <> 'repair'
            and generation < ? and subject_id > ?
         union all
         select generation, subject_id, updated_at
           from perf_due_work indexed by __DUE_WORK_CLEANUP_IDX__
          where work_kind = ? and subject_type = ? and state <> 'repair'
            and generation > ? and generation < ? and subject_id > ?
         union all
         select generation, subject_id, updated_at
           from perf_due_work indexed by __DUE_WORK_CLEANUP_IDX__
          where work_kind = ? and subject_type = ? and state <> 'repair'
            and generation > ? and subject_id > ?
         union all
         select generation, subject_id, updated_at
           from perf_due_work indexed by __DUE_WORK_CLEANUP_IDX__
          where work_kind = ? and subject_type = ? and state <> 'repair'
            and generation = 'live' and updated_at < ? and subject_id > ?
       ) order by generation, updated_at, subject_id limit ?`,
      [
        "youtube-provenance-findings",
        "track",
        "live",
        "",
        "youtube-provenance-findings",
        "track",
        "live",
        "synthetic-index-evidence",
        "",
        "youtube-provenance-findings",
        "track",
        "synthetic-index-evidence",
        "",
        "youtube-provenance-findings",
        "track",
        "2027-01-01T00:00:00.000Z",
        "",
        INDEX_EVIDENCE_LIMIT,
      ],
    );
    const expectedPlanUses = [
      {
        count: 1,
        index: "due_work_cleanup_idx",
        pattern:
          /SEARCH perf_due_work USING INDEX perf_due_work_cleanup_idx \(work_kind=\? AND subject_type=\? AND generation<\?\)/i,
      },
      {
        count: 1,
        index: "due_work_cleanup_idx",
        pattern:
          /SEARCH perf_due_work USING INDEX perf_due_work_cleanup_idx \(work_kind=\? AND subject_type=\? AND generation>\? AND generation<\?\)/i,
      },
      {
        count: 1,
        index: "due_work_cleanup_idx",
        pattern:
          /SEARCH perf_due_work USING INDEX perf_due_work_cleanup_idx \(work_kind=\? AND subject_type=\? AND generation>\?\)/i,
      },
      {
        count: 1,
        index: "due_work_cleanup_idx",
        pattern:
          /SEARCH perf_due_work USING INDEX perf_due_work_cleanup_idx \(work_kind=\? AND subject_type=\? AND generation=\? AND updated_at<\?\)/i,
      },
    ];
    const policy = productionLockPolicy(expectedPlanUses, ["perf_due_work"]);
    return {
      ...statements,
      expectedPlanUses,
      lockedPolicy: policy,
      maxRows: INDEX_EVIDENCE_LIMIT,
      minRows: 1,
      mutating: false,
      unforcedPolicy: unforcedProductionLockPolicy(policy),
    };
  }

  if (reference.id === "index.production-lock.rankable-artist-repair") {
    const statements = productionLockStatementPair(
      reference.indexes,
      `with affected(id) as (
         select artist_id from perf_track_artists where track_id = ?
       ), truth(id, rankable) as (
         select affected.id, count(tracks.id)
           from affected
           left join perf_track_artists artist_tracks indexed by __TRACK_ARTISTS_ARTIST_ID_IDX__
             on artist_tracks.artist_id = affected.id
           left join perf_tracks tracks on tracks.id = artist_tracks.track_id
             and tracks.key is not null and tracks.has_embedding = 1
          group by affected.id
       )
       update perf_artists
          set rankable_track_count = truth.rankable
         from truth
        where perf_artists.id = truth.id
          and perf_artists.rankable_track_count <> truth.rankable`,
      ["synthetic-track-000000000"],
    );
    const expectedPlanUses = [
      {
        count: 1,
        index: "track_artists_artist_id_idx",
        pattern:
          /SEARCH artist_tracks USING INDEX perf_track_artists_artist_id_idx \(artist_id=\?\)/i,
      },
    ];
    const policy = productionLockPolicy(expectedPlanUses, [
      "perf_track_artists",
      "artist_tracks",
      "perf_tracks",
      "tracks",
      "perf_artists",
    ]);
    return {
      ...statements,
      expectedPlanUses,
      lockedPolicy: policy,
      maxRows: 0,
      minRows: 0,
      mutating: true,
      mutationPreparation: statement(
        `update perf_artists set rankable_track_count = -1
          where id in (select artist_id from perf_track_artists where track_id = ?)`,
        ["synthetic-track-000000000"],
      ),
      mutationRestoration: [
        statement(
          `update perf_artists set rankable_track_count =
             case id when 'synthetic-artist-000000000' then 1
                     when 'synthetic-artist-000000003' then 4 end
            where id in ('synthetic-artist-000000000', 'synthetic-artist-000000003')`,
        ),
      ],
      mutationRows: { max: 2, min: 2 },
      unforcedPolicy: unforcedProductionLockPolicy(policy),
    };
  }

  if (reference.id === "index.production-lock.public-projection-audit-chunk") {
    const statements = productionLockStatementPair(
      reference.indexes,
      `with page as (
         select distinct artist_id as id
           from perf_track_artists indexed by __TRACK_ARTISTS_ARTIST_ID_IDX__
          where artist_id > ? order by artist_id limit ?
       )
       select page.id as artist_id,
              count(case when f.track_id is not null then 1 end) as certified_finding_count,
              coalesce(sum(case when l.seed_state = 'enabled'
                then case when ta.role = 'remixer' then 1 else 2 end else 0 end), 0)
                as enabled_credit_half_units
         from page
         left join perf_track_artists ta on ta.artist_id = page.id
         left join perf_tracks t on t.id = ta.track_id
         left join perf_findings f on f.track_id = t.id
         left join perf_labels l on l.id = t.label_id
        group by page.id order by page.id`,
      ["", INDEX_EVIDENCE_LIMIT],
    );
    const expectedPlanUses = [
      {
        count: 1,
        index: "track_artists_artist_id_idx",
        pattern:
          /SEARCH perf_track_artists USING COVERING INDEX perf_track_artists_artist_id_idx \(artist_id>\?\)/i,
      },
    ];
    const policy = productionLockPolicy(
      expectedPlanUses,
      ["perf_track_artists", "ta", "t", "f", "l"],
      { forbidTempSort: false },
    );
    return {
      ...statements,
      expectedPlanUses,
      lockedPolicy: policy,
      maxRows: INDEX_EVIDENCE_LIMIT,
      minRows: 1,
      mutating: false,
      unforcedPolicy: unforcedProductionLockPolicy(policy),
    };
  }

  if (reference.id === "index.production-lock.mixable-artists-reconciliation") {
    const ids = [
      "synthetic-artist-000000000",
      "synthetic-artist-000000001",
      "synthetic-artist-000000002",
      "synthetic-artist-000000003",
    ];
    const statements = productionLockStatementPair(
      reference.indexes,
      `with page(id) as (values ${ids.map(() => "(?)").join(", ")}),
            truth(id, rankable) as (
              select page.id, count(tracks.id)
                from page
                left join perf_track_artists indexed by __TRACK_ARTISTS_ARTIST_ID_IDX__
                  on perf_track_artists.artist_id = page.id
                left join perf_tracks tracks on tracks.id = perf_track_artists.track_id
                  and tracks.key is not null and tracks.has_embedding = 1
               group by page.id
            )
       update perf_artists
          set rankable_track_count = truth.rankable
         from truth
        where perf_artists.id = truth.id
          and perf_artists.rankable_track_count <> truth.rankable`,
      ids,
    );
    const expectedPlanUses = [
      {
        count: 1,
        index: "track_artists_artist_id_idx",
        pattern:
          /SEARCH perf_track_artists USING INDEX perf_track_artists_artist_id_idx \(artist_id=\?\)/i,
      },
    ];
    const policy = productionLockPolicy(
      expectedPlanUses,
      ["perf_track_artists", "tracks", "perf_artists"],
      { forbidTempSort: false },
    );
    return {
      ...statements,
      expectedPlanUses,
      lockedPolicy: policy,
      maxRows: 0,
      minRows: 0,
      mutating: true,
      mutationPreparation: statement(
        `update perf_artists set rankable_track_count = -1
          where id in (${ids.map(() => "?").join(", ")})`,
        ids,
      ),
      mutationRestoration: [
        statement(
          `update perf_artists set rankable_track_count =
             case id when 'synthetic-artist-000000000' then 1
                     when 'synthetic-artist-000000001' then 2
                     when 'synthetic-artist-000000002' then 3
                     when 'synthetic-artist-000000003' then 4 end
            where id in (${ids.map(() => "?").join(", ")})`,
          ids,
        ),
      ],
      mutationRows: { max: 4, min: 4 },
      unforcedPolicy: unforcedProductionLockPolicy(policy),
    };
  }

  throw new Error(`unknown production-lock contract ${reference.id}`);
}

async function executeProductionLockStatement(
  spec: ProductionLockComparisonSpec,
  context: ContractContext,
): Promise<ContractExecution> {
  if (spec.mutationPreparation) {
    await context.client.execute(spec.mutationPreparation);
  }
  const finalStatement = await executeTimedFinalStatement(context, spec.locked);
  for (const restoration of spec.mutationRestoration ?? []) {
    await context.client.execute(restoration);
  }

  return {
    affectedRowCount:
      (finalStatement.result.rowsAffected ?? 0) > 0
        ? (finalStatement.result.rowsAffected ?? 0)
        : finalStatement.result.rows.length,
    durationMs: finalStatement.durationMs,
    metadata: {
      finalStatementRequestCount: 1,
      preparationRequestCount: spec.mutationPreparation ? 1 : 0,
      restorationRequestCount: spec.mutationRestoration?.length ?? 0,
      timingScope: "worst-single-final-statement",
    },
    rawResult: finalStatement.result,
    resultRowCount: finalStatement.result.rows.length,
  };
}

function mutationRowCount(result: PerformanceResult): number {
  const rowsAffected = result.rowsAffected ?? 0;
  return rowsAffected > 0 ? rowsAffected : result.rows.length;
}

function planUseCounts(
  details: readonly string[],
  expectedPlanUses: readonly ProductionLockPlanUse[],
): { actual: number; expected: number; index: string; pattern: string }[] {
  return expectedPlanUses.map((use) => ({
    actual: details.filter((detail) => use.pattern.test(detail)).length,
    expected: use.count,
    index: use.index,
    pattern: use.pattern.source,
  }));
}

function planUsesMatch(counts: readonly { actual: number; expected: number }[]): boolean {
  return counts.every((entry) => entry.actual === entry.expected);
}

async function executeProductionLockProof(
  reference: ProductionLockContract,
  spec: ProductionLockComparisonSpec,
  context: ContractContext,
): Promise<ContractExecution> {
  const lockedPlan = await context.client.execute({
    args: spec.locked.args,
    sql: `EXPLAIN QUERY PLAN ${spec.locked.sql}`,
  });
  const unforcedPlan = await context.client.execute({
    args: spec.unforced.args,
    sql: `EXPLAIN QUERY PLAN ${spec.unforced.sql}`,
  });
  const lockedDetails = explainDetails(lockedPlan);
  const unforcedDetails = explainDetails(unforcedPlan);
  const lockedAnalysis = analyzeExplainPlan(lockedDetails, spec.lockedPolicy);
  const unforcedAnalysis = analyzeExplainPlan(unforcedDetails, spec.unforcedPolicy);
  let outputsEquivalent: boolean | null = null;
  let referenceRowCount = 0;
  let terminalProofRequestCount = 2;
  let lockedAffectedRows: number | null = null;
  let unforcedAffectedRows: number | null = null;

  if (spec.mutating) {
    if (!spec.mutationPreparation || !spec.mutationRows) {
      throw new Error(`mutating production-lock contract ${reference.id} has no reset contract`);
    }
    await context.client.execute(spec.mutationPreparation);
    const lockedResult = await context.client.execute(spec.locked);
    for (const restoration of spec.mutationRestoration ?? []) {
      await context.client.execute(restoration);
    }
    await context.client.execute(spec.mutationPreparation);
    const unforcedResult = await context.client.execute(spec.unforced);
    for (const restoration of spec.mutationRestoration ?? []) {
      await context.client.execute(restoration);
    }
    lockedAffectedRows = mutationRowCount(lockedResult);
    unforcedAffectedRows = mutationRowCount(unforcedResult);
    outputsEquivalent =
      lockedAffectedRows === unforcedAffectedRows &&
      serializableRows(lockedResult.rows) === serializableRows(unforcedResult.rows);
    referenceRowCount = lockedResult.rows.length;
    terminalProofRequestCount += 4 + (spec.mutationRestoration?.length ?? 0) * 2;
  } else {
    const lockedResult = await context.client.execute(spec.locked);
    const unforcedResult = await context.client.execute(spec.unforced);
    outputsEquivalent =
      serializableRows(lockedResult.rows) === serializableRows(unforcedResult.rows);
    referenceRowCount = lockedResult.rows.length;
    terminalProofRequestCount += 2;
  }

  const lockedPlanUseCounts = planUseCounts(lockedDetails, spec.expectedPlanUses);
  const unforcedPlanUseCounts = planUseCounts(unforcedDetails, spec.expectedPlanUses);
  const allUnforcedLockSitesChosen = planUsesMatch(unforcedPlanUseCounts);
  const mutationCardinality =
    !spec.mutating ||
    (lockedAffectedRows !== null &&
      unforcedAffectedRows !== null &&
      spec.mutationRows !== undefined &&
      lockedAffectedRows >= spec.mutationRows.min &&
      lockedAffectedRows <= spec.mutationRows.max &&
      unforcedAffectedRows >= spec.mutationRows.min &&
      unforcedAffectedRows <= spec.mutationRows.max);
  const requestsPerMeasuredIteration = spec.mutationPreparation
    ? 2 + (spec.mutationRestoration?.length ?? 0)
    : 1;

  return {
    metadata: {
      cardinalityBound:
        mutationCardinality &&
        (spec.mutating || (referenceRowCount >= spec.minRows && referenceRowCount <= spec.maxRows)),
      expectedProductionLockCount: reference.expectedLockCount,
      lockClassification: allUnforcedLockSitesChosen ? "redundant" : "necessary",
      lockedAffectedRows,
      lockedPlanDetails: JSON.stringify(lockedDetails),
      lockedPlanUseCounts: JSON.stringify(lockedPlanUseCounts),
      lockedPlanViolations: lockedAnalysis.violations.length,
      measuredRequestCount:
        (INDEX_EVIDENCE_ITERATIONS + INDEX_EVIDENCE_WARMUP_ITERATIONS) *
        requestsPerMeasuredIteration,
      minimumResultRows: spec.minRows,
      outputsEquivalent,
      resultBound: spec.maxRows,
      terminalPlanRequestCount: 1,
      terminalProofRequestCount,
      totalRequestCount:
        (INDEX_EVIDENCE_ITERATIONS + INDEX_EVIDENCE_WARMUP_ITERATIONS) *
          requestsPerMeasuredIteration +
        terminalProofRequestCount +
        1,
      unforcedAffectedRows,
      unforcedPlanDetails: JSON.stringify(unforcedDetails),
      unforcedPlanUseCounts: JSON.stringify(unforcedPlanUseCounts),
      unforcedPlanViolations: unforcedAnalysis.violations.length,
    },
    resultRowCount: referenceRowCount,
  };
}

function validateProductionLockProof(
  spec: ProductionLockComparisonSpec,
  execution: ContractExecution,
): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];

  if (metadata.cardinalityBound !== true) {
    failures.push("production-lock evidence exceeded its bounded result cardinality");
  }
  if (metadata.lockedPlanViolations !== 0) {
    failures.push("the production-lock plan violated its real-consumer policy");
  }
  if (metadata.unforcedPlanViolations !== 0) {
    failures.push("the unforced same-shape plan violated its real-consumer policy");
  }
  if (metadata.outputsEquivalent !== true) {
    failures.push("the locked and unforced real-consumer outputs differ");
  }
  const lockedPlanUseCounts = JSON.parse(String(metadata.lockedPlanUseCounts ?? "[]")) as {
    actual: number;
    expected: number;
  }[];
  if (!planUsesMatch(lockedPlanUseCounts)) {
    failures.push("the production-lock plan did not use every lock at its declared site");
  }

  return failures;
}

function productionLockEvidenceContracts(): PerformanceContract[] {
  return PRODUCTION_LOCK_INVENTORY.contracts.map((reference) => {
    const spec = productionLockSpec(reference);
    const expectedPlanUseCount = spec.expectedPlanUses.reduce((total, use) => total + use.count, 0);
    if (expectedPlanUseCount !== reference.expectedLockCount) {
      throw new Error(
        `${reference.id} declares ${reference.expectedLockCount} locks but ${expectedPlanUseCount} plan sites`,
      );
    }
    const definition: ProductionLockEvidenceDefinition = {
      contractId: reference.id,
      expectedLockCount: reference.expectedLockCount,
      growingTables: [...(spec.lockedPolicy.growingTables ?? [])],
      indexes: [...reference.indexes],
    };

    return {
      description: `Production-lock evidence outside the audit inventory: ${reference.query}`,
      execute: (context) => executeProductionLockStatement(spec, context),
      id: reference.id,
      iterations: INDEX_EVIDENCE_ITERATIONS,
      plan: { policy: spec.lockedPolicy, statement: spec.locked },
      productionLockEvidence: definition,
      terminalProof: {
        execute: (context) => executeProductionLockProof(reference, spec, context),
        validate: (execution) => validateProductionLockProof(spec, execution),
      },
      validate: (execution) => {
        if (!spec.mutationRows) {
          return [];
        }
        const affected = execution.affectedRowCount ?? 0;
        return affected >= spec.mutationRows.min && affected <= spec.mutationRows.max
          ? []
          : [
              `production-lock mutation affected ${affected} rows, expected ${spec.mutationRows.min}-${spec.mutationRows.max}`,
            ];
      },
      warmupIterations: INDEX_EVIDENCE_WARMUP_ITERATIONS,
      workClass: spec.mutating ? "mutation" : "projection",
    } satisfies PerformanceContract;
  });
}

function comparisonContract(
  entry: IndexInventoryEntry,
  contractId: string,
  definition: IndexEvidenceDefinition,
  spec: ComparisonSpec,
): PerformanceContract {
  const productionPolicy = spec.productionPlanPolicies[0];
  const productionStatement = spec.references[0];
  if (productionPolicy === undefined || productionStatement === undefined) {
    throw new Error(`comparison contract ${contractId} has no production plan`);
  }

  return {
    description: `Index evidence for ${entry.name}: ${entry.finalConsumer.query}`,
    execute: (context) => executeComparisonStatements(spec, context),
    id: contractId,
    indexEvidence: definition,
    iterations: INDEX_EVIDENCE_ITERATIONS,
    plan: { policy: productionPolicy, statement: productionStatement },
    terminalProof: {
      execute: (context) => executeComparisonProof(definition, spec, context),
      validate: (execution) => validateComparisonProof(definition, spec, execution),
    },
    warmupIterations: INDEX_EVIDENCE_WARMUP_ITERATIONS,
    workClass: "projection",
  };
}

export function indexEvidenceContracts(): PerformanceContract[] {
  const inventoryContracts = allIndexInventoryEntries(FINAL_INDEX_INVENTORY).flatMap((entry) =>
    entry.performanceContracts.map((reference) => {
      const definition = definitionFor(entry);
      const spec = planSpecFor(entry, reference.id);

      if ("references" in spec) {
        return comparisonContract(entry, reference.id, definition, spec);
      }

      const plan = planFor(definition, spec);
      return {
        description: `Index evidence for ${entry.name}: ${entry.finalConsumer.query}`,
        execute: (context: ContractContext) => executeSimpleIndexStatement(spec, context),
        id: reference.id,
        indexEvidence: definition,
        iterations: INDEX_EVIDENCE_ITERATIONS,
        plan,
        terminalProof: {
          execute: (context: ContractContext) => executeSimpleIndexProof(definition, spec, context),
          validate: (execution: ContractExecution) =>
            validateSimpleIndexProof(definition, spec, execution),
        },
        warmupIterations: INDEX_EVIDENCE_WARMUP_ITERATIONS,
        workClass: "projection",
      } satisfies PerformanceContract;
    }),
  );

  return [...inventoryContracts, ...productionLockEvidenceContracts()];
}

export function registerIndexEvidenceContracts(registry: {
  register: (contract: PerformanceContract) => unknown;
}): void {
  for (const contract of indexEvidenceContracts()) {
    registry.register(contract);
  }
}

export const INDEX_EVIDENCE_REQUIRED_PROFILES: readonly ScaleProfile[] = INDEX_AUDIT_PROFILES;
