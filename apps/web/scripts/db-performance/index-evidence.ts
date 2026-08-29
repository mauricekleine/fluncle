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

const INDEX_EVIDENCE_LIMIT = 25;
const INDEX_EVIDENCE_ITERATIONS = 2;
const INDEX_EVIDENCE_WARMUP_ITERATIONS = 1;

/** Inventory indexes whose production consumer deliberately carries an `INDEXED BY` lock. */
export const INDEX_EVIDENCE_RUNTIME_LOCKED_INDEXES = [
  "artist_qualification_qualified_idx",
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
  supplementalStatements: PerformanceStatement[];
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
  const indexedSql = sql.replace("__INDEX__", fixtureIndex);

  return statement(
    mode === "production-lock" || mode === "supplemental-force"
      ? indexedSql
      : indexedSql.replace(new RegExp(`\\s+indexed\\s+by\\s+${fixtureIndex}\\b`, "gi"), ""),
  );
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
    tracks_bpm_idx: indexPlanStatement(
      indexName,
      "select bpm from perf_tracks indexed by __INDEX__ where bpm >= 160 and bpm <= 180 order by bpm limit 25",
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
    tracks_is_catalogue_idx: indexPlanStatement(
      indexName,
      "select count(*) from perf_tracks indexed by __INDEX__ where is_catalogue = 1",
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
    artifact_changes_stream_seq_idx: indexPlanStatement(
      indexName,
      "select stream, stream_version, seq from perf_artifact_changes indexed by __INDEX__ where stream = 'synthetic-stream-0' and stream_version = 1 and seq >= 1 order by stream, stream_version, seq limit 25",
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
    crawl_due_work_claim_position_idx: indexPlanStatement(
      indexName,
      "select claimed_by, claim_token, claim_position from perf_crawl_due_work indexed by __INDEX__ where state = 'leased' and claimed_by = 'synthetic-crawl-worker' and claim_token = 'synthetic-crawl-claim-000000002' order by claimed_by, claim_token, claim_position limit 25",
      "production-lock",
    ),
    crawl_due_work_label_slug_node_id_idx: indexPlanStatement(
      indexName,
      "select label_slug, node_id from perf_crawl_due_work indexed by __INDEX__ where label_slug = 'synthetic-label-000000001' order by label_slug, node_id limit 25",
      "production-lock",
    ),
    crawl_due_work_lease_idx: indexPlanStatement(
      indexName,
      "select node_id, claim_expires_at from perf_crawl_due_work indexed by __INDEX__ where state = 'leased' and claim_expires_at <= '9999-12-31' order by state, claim_expires_at, node_id limit 25",
      "production-lock",
    ),
    crawl_due_work_parent_id_node_id_idx: indexPlanStatement(
      indexName,
      "select parent_id, node_id from perf_crawl_due_work indexed by __INDEX__ where parent_id = 'synthetic-frontier-000000000' order by parent_id, node_id limit 25",
      "production-lock",
    ),
    crawl_due_work_ready_idx: indexPlanStatement(
      indexName,
      "select node_id from perf_crawl_due_work indexed by __INDEX__ where state = 'ready' and hop >= 0 order by state, hop, demand_rank, created_at, node_id limit 25",
      "production-lock",
    ),
    crawl_due_work_release_ready_idx: indexPlanStatement(
      indexName,
      "select node_id from perf_crawl_due_work indexed by __INDEX__ where state = 'ready' and node_kind = 'release' and storable_rank >= 0 order by state, storable_rank, hop, demand_rank, created_at, node_id limit 25",
      "production-lock",
    ),
    crawl_due_work_repair_idx: indexPlanStatement(
      indexName,
      "select node_id from perf_crawl_due_work indexed by __INDEX__ where state = 'repair' and node_id >= 'synthetic-frontier-lifecycle-000000001' order by state, node_id limit 25",
      "production-lock",
    ),
    crawl_due_work_scheduled_idx: indexPlanStatement(
      indexName,
      "select node_id, next_due_at from perf_crawl_due_work indexed by __INDEX__ where state = 'scheduled' and next_due_at <= '9999-12-31' order by state, next_due_at, node_id limit 25",
      "production-lock",
    ),
    crawl_projection_repairs_order_idx: indexPlanStatement(
      indexName,
      "select source_epoch, source_type, source_id from perf_crawl_projection_repairs indexed by __INDEX__ where source_epoch >= 0 order by source_epoch, source_type, source_id limit 25",
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
    maxRows: INDEX_EVIDENCE_LIMIT,
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
    requiredDetails.push(/INTEGER PRIMARY KEY.*rowid</i);
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
    forbidTempSort: true,
    growingTables: ["perf_tracks"],
    requiredDetails: [/perf_tracks_release_date_track_id_idx/i],
  };
  const references = productionLocked
    ? [DEFAULT_HUB_NON_NULL_PRODUCTION_LOCK, DEFAULT_HUB_NULL_PRODUCTION_LOCK]
    : [DEFAULT_HUB_NON_NULL_REFERENCE, DEFAULT_HUB_NULL_REFERENCE];

  return {
    maxRows: 96,
    minRows: 1,
    productionPlanPolicies: [policy, policy],
    references,
    statement: references[0] ?? DEFAULT_HUB_NON_NULL_REFERENCE,
    supplementalStatements: [DEFAULT_HUB_NON_NULL_SUPPLEMENTAL, DEFAULT_HUB_NULL_SUPPLEMENTAL],
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
  for (const supplemental of spec.supplementalStatements) {
    supplementalResults.push(await context.client.execute(supplemental));
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
    failures.push("an unforced production plan violated its exact consumer policy");
  }

  return failures;
}

function definitionFor(entry: IndexInventoryEntry): IndexEvidenceDefinition {
  const replacementIndexes: Record<string, string> = {
    artifact_change_checkpoints_running_idx: "artifact-change-checkpoints-primary-key",
    artifact_change_consumers_compaction_idx: "bounded-consumer-control-table",
    artifact_changes_created_seq_idx: "artifact-changes-integer-primary-key",
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

function planSpecFor(
  entry: IndexInventoryEntry,
  contractId: string,
): IndexPlanSpec | ComparisonSpec {
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
  return allIndexInventoryEntries(FINAL_INDEX_INVENTORY).flatMap((entry) =>
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
}

export function registerIndexEvidenceContracts(registry: {
  register: (contract: PerformanceContract) => unknown;
}): void {
  for (const contract of indexEvidenceContracts()) {
    registry.register(contract);
  }
}

export const INDEX_EVIDENCE_REQUIRED_PROFILES: readonly ScaleProfile[] = INDEX_AUDIT_PROFILES;
