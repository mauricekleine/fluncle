import {
  CONTRACT_D_ANCHOR_FORMAT_VERSION,
  CONTRACT_D_CRAWL_CLAIM_LIMIT,
  CONTRACT_D_HUB_PAGE_SIZE,
  defaultAnchorFixtureRows,
  publicAggregateFixtureBuckets,
} from "./fixture";
import { getScaleManifest, type FixtureCounts } from "./manifest";
import {
  type ContractContext,
  type ContractExecution,
  type ConvergenceObservation,
  type PerformanceContract,
  type PerformanceResult,
  type PerformanceStatement,
  PerformanceRegistry,
} from "./registry";

export const CONTRACT_D_WORK_CLASS = "projection" as const;

export const CONTRACT_D_CONTRACT_IDS = [
  "projection.crawl-two-lane-claim",
  "projection.crawl-two-lane-read",
  "projection.crawl-ready-sentinel",
  "projection.public-readiness",
  "projection.public-total",
  "projection.public-release-years",
  "projection.public-keys",
  "projection.qualified-artists",
  "projection.default-anchor-validity",
  "projection.default-anchor-keyset",
] as const;

const CONTRACT_D_OWNER = "synthetic-contract-d-worker";
const CONTRACT_D_TOKEN = "synthetic-contract-d-token";
const CONTRACT_D_NOW = "2026-01-01T00:00:00.000Z";
const CONTRACT_D_EXPIRES = "2026-01-01T00:15:00.000Z";
const CONTRACT_D_HUB = "tracks";
const CONTRACT_D_CLAUSE_HASH = "synthetic-default";

const CRAWL_COLUMNS = `claim_expires_at, claim_position, claim_token, claimed_by,
  created_at, demand_rank, generation, hop, label_slug, next_due_at, node_id, node_kind,
  parent_id, source_version, state, storable_rank, updated_at`;

const CRAWL_CLAIM: PerformanceStatement = {
  args: [
    Math.ceil(CONTRACT_D_CRAWL_CLAIM_LIMIT / 2),
    CONTRACT_D_CRAWL_CLAIM_LIMIT,
    CONTRACT_D_TOKEN,
    CONTRACT_D_EXPIRES,
    CONTRACT_D_OWNER,
    CONTRACT_D_NOW,
    CONTRACT_D_OWNER,
    CONTRACT_D_TOKEN,
  ],
  sql: `with release_ordered as materialized (
    select node_id, storable_rank, hop, demand_rank, created_at
      from perf_crawl_due_work indexed by perf_crawl_due_work_release_ready_idx
     where state = 'ready' and node_kind = 'release'
     order by storable_rank, hop, demand_rank, created_at, node_id
     limit ?1
  ), release_lane as materialized (
    select current.node_id,
           (select count(*) from release_ordered previous
             where previous.storable_rank < current.storable_rank
                or (previous.storable_rank = current.storable_rank and previous.hop < current.hop)
                or (previous.storable_rank = current.storable_rank and previous.hop = current.hop
                    and previous.demand_rank < current.demand_rank)
                or (previous.storable_rank = current.storable_rank and previous.hop = current.hop
                    and previous.demand_rank = current.demand_rank
                    and previous.created_at < current.created_at)
                or (previous.storable_rank = current.storable_rank and previous.hop = current.hop
                    and previous.demand_rank = current.demand_rank
                    and previous.created_at = current.created_at
                    and previous.node_id < current.node_id)) as position
      from release_ordered current
  ), general_ordered as materialized (
    select node_id, hop, demand_rank, created_at
      from perf_crawl_due_work indexed by perf_crawl_due_work_ready_idx
     where state = 'ready'
       and not exists (select 1 from release_lane where release_lane.node_id = perf_crawl_due_work.node_id)
     order by hop, demand_rank, created_at, node_id
     limit (?2 - (select count(*) from release_lane))
  ), candidates as materialized (
    select node_id, position from release_lane
    union all
    select current.node_id,
           (select count(*) from release_lane) +
           (select count(*) from general_ordered previous
             where previous.hop < current.hop
                or (previous.hop = current.hop and previous.demand_rank < current.demand_rank)
                or (previous.hop = current.hop and previous.demand_rank = current.demand_rank
                    and previous.created_at < current.created_at)
                or (previous.hop = current.hop and previous.demand_rank = current.demand_rank
                    and previous.created_at = current.created_at
                    and previous.node_id < current.node_id)) as position
      from general_ordered current
  )
  update perf_crawl_due_work
     set state = 'leased', next_due_at = null, claim_token = ?3,
         claim_expires_at = ?4, claimed_by = ?5,
         claim_position = (select candidates.position from candidates
                            where candidates.node_id = perf_crawl_due_work.node_id),
         updated_at = ?6
   where node_id in (select node_id from candidates)
     and not exists (
       select 1 from perf_crawl_due_work existing_claim
        where existing_claim.state = 'leased'
          and existing_claim.claimed_by = ?7
          and existing_claim.claim_token = ?8
     )`,
};

const CRAWL_READ: PerformanceStatement = {
  args: [CONTRACT_D_OWNER, CONTRACT_D_TOKEN],
  sql: `select ${CRAWL_COLUMNS}
    from perf_crawl_due_work indexed by perf_crawl_due_work_claim_position_idx
   where state = 'leased' and claimed_by = ? and claim_token = ?
   order by claim_position`,
};

const CRAWL_READY_SENTINEL: PerformanceStatement = {
  args: [],
  sql: `select node_id
    from perf_crawl_due_work indexed by perf_crawl_due_work_ready_idx
   where state = 'ready'
   order by hop, demand_rank, created_at, node_id
   limit 1`,
};

const CRAWL_CLEANUP: PerformanceStatement = {
  args: [CONTRACT_D_NOW, CONTRACT_D_OWNER, CONTRACT_D_TOKEN],
  sql: `update perf_crawl_due_work
    set state = 'ready', claim_position = null, claim_token = null,
        claimed_by = null, claim_expires_at = null, updated_at = ?
   where state = 'leased' and claimed_by = ? and claim_token = ?`,
};

const AGGREGATE_READY = `aggregate.state = 'complete'
  and aggregate.aggregate_epoch = aggregate.source_epoch
  and aggregate.generation <> ''
  and not exists (
    select 1 from perf_projection_repairs indexed by perf_projection_repairs_order_idx
     where projection = 'public_aggregates'
  )`;

const ARTIST_READY = `artist_state.state = 'complete'
  and artist_state.projection_epoch = artist_state.source_epoch
  and artist_state.generation <> ''
  and not exists (
    select 1 from perf_projection_repairs indexed by perf_projection_repairs_order_idx
     where projection = 'artist_qualification'
  )`;

const PUBLIC_READINESS: PerformanceStatement = {
  args: [],
  sql: `select aggregate.scope as aggregate_scope, artist_state.scope as artist_scope
    from perf_public_aggregate_state as aggregate
      indexed by sqlite_autoindex_perf_public_aggregate_state_1
    cross join perf_artist_qualification_state as artist_state
      indexed by sqlite_autoindex_perf_artist_qualification_state_1
   where aggregate.scope = 'tracks'
     and artist_state.scope = 'artists'
     and ${AGGREGATE_READY}
     and ${ARTIST_READY}
   limit 1`,
};

const PUBLIC_TOTAL: PerformanceStatement = {
  args: [],
  sql: `select aggregate.default_track_total as total
    from perf_public_aggregate_state as aggregate
      indexed by sqlite_autoindex_perf_public_aggregate_state_1
   where aggregate.scope = 'tracks' and ${AGGREGATE_READY}
   limit 1`,
};

const QUALIFIED_ARTISTS: PerformanceStatement = {
  args: [],
  sql: `select qualification.artist_id
    from perf_artist_qualification_state as artist_state
    left join perf_artist_qualification as qualification
      indexed by perf_artist_qualification_qualified_idx
      on qualification.is_qualified = 1
   where artist_state.scope = 'artists' and ${ARTIST_READY}
   order by qualification.artist_id`,
};

const ANCHOR_VALIDITY: PerformanceStatement = {
  args: [CONTRACT_D_HUB, CONTRACT_D_CLAUSE_HASH, CONTRACT_D_ANCHOR_FORMAT_VERSION],
  sql: `select anchors.anchors_json, aggregate.default_track_total as total
    from perf_public_aggregate_state as aggregate
      indexed by sqlite_autoindex_perf_public_aggregate_state_1
    join perf_hub_page_anchor_validity as validity
      indexed by sqlite_autoindex_perf_hub_page_anchor_validity_1
      on validity.hub = ? and validity.clause_hash = ?
     and validity.anchor_format_version = ?
     and validity.order_epoch = aggregate.release_hub_order_epoch
     and validity.generation = aggregate.generation
    join perf_hub_page_anchors as anchors
      indexed by sqlite_autoindex_perf_hub_page_anchors_1
      on anchors.hub = validity.hub and anchors.clause_hash = validity.clause_hash
   where aggregate.scope = 'tracks' and ${AGGREGATE_READY}
   limit 1`,
};

const KEYSET: PerformanceStatement = {
  args: ["2026", "synthetic-track-000000464", CONTRACT_D_HUB_PAGE_SIZE],
  sql: `select perf_tracks.id as track_id, perf_tracks.release_date as rd
    from perf_tracks indexed by perf_tracks_release_date_track_id_idx
   where (perf_tracks.release_date, perf_tracks.id) < (?, ?)
   order by perf_tracks.release_date desc, perf_tracks.id desc
   limit ?`,
};

const KEYSET_NULL_FILL: PerformanceStatement = {
  args: [CONTRACT_D_HUB_PAGE_SIZE],
  sql: `select perf_tracks.id as track_id, perf_tracks.release_date as rd
    from perf_tracks indexed by perf_tracks_release_date_track_id_idx
   where perf_tracks.release_date is null
   order by perf_tracks.release_date desc, perf_tracks.id desc
   limit ?`,
};

const PROJECTION_NO_TEMP_SORT = { forbidTempSort: true } as const;
const CRAWL_CLAIM_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_crawl_due_work"],
    requiredDetails: [
      /perf_crawl_due_work_release_ready_idx/i,
      /perf_crawl_due_work_ready_idx/i,
      /sqlite_autoindex_perf_crawl_due_work_1/i,
    ],
  },
  statement: CRAWL_CLAIM,
};
const CRAWL_READ_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_crawl_due_work"],
    requiredDetails: [/perf_crawl_due_work_claim_position_idx/i],
  },
  statement: CRAWL_READ,
};
const CRAWL_READY_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_crawl_due_work"],
    requiredDetails: [/perf_crawl_due_work_ready_idx/i],
  },
  statement: CRAWL_READY_SENTINEL,
};
const PUBLIC_READINESS_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_projection_repairs"],
    requiredDetails: [
      /sqlite_autoindex_perf_public_aggregate_state_1/i,
      /sqlite_autoindex_perf_artist_qualification_state_1/i,
      /perf_projection_repairs_order_idx/i,
    ],
  },
  statement: PUBLIC_READINESS,
};
const PUBLIC_TOTAL_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_projection_repairs"],
    requiredDetails: [
      /sqlite_autoindex_perf_public_aggregate_state_1/i,
      /perf_projection_repairs_order_idx/i,
    ],
  },
  statement: PUBLIC_TOTAL,
};
const PUBLIC_BUCKET_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_projection_repairs"],
    requiredDetails: [
      /sqlite_autoindex_perf_public_aggregate_state_1/i,
      /sqlite_autoindex_perf_public_aggregate_counts_1/i,
      /perf_projection_repairs_order_idx/i,
    ],
  },
};
const QUALIFIED_ARTISTS_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_artist_qualification", "perf_projection_repairs"],
    requiredDetails: [
      /sqlite_autoindex_perf_artist_qualification_state_1/i,
      /perf_artist_qualification_qualified_idx/i,
      /perf_projection_repairs_order_idx/i,
    ],
  },
  statement: QUALIFIED_ARTISTS,
};
const ANCHOR_VALIDITY_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_projection_repairs"],
    requiredDetails: [
      /sqlite_autoindex_perf_public_aggregate_state_1/i,
      /sqlite_autoindex_perf_hub_page_anchor_validity_1/i,
      /sqlite_autoindex_perf_hub_page_anchors_1/i,
      /perf_projection_repairs_order_idx/i,
    ],
  },
  statement: ANCHOR_VALIDITY,
};
const KEYSET_PLAN = {
  policy: {
    ...PROJECTION_NO_TEMP_SORT,
    growingTables: ["perf_tracks"],
    requiredDetails: [
      /perf_tracks_release_date_track_id_idx/i,
      /\(\(release_date,id\)<\(\?,\?\)\)/i,
    ],
  },
  statement: KEYSET,
};

function countsFor(context: ContractContext): FixtureCounts {
  return context.fixtureCounts ?? getScaleManifest(context.profile).counts;
}

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) {
    return undefined;
  }

  return (row as Record<string, unknown>)[field];
}

function rowString(row: unknown, field: string): string {
  const value = rowValue(row, field);

  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : "";
}

function rowNumber(row: unknown, field: string): number {
  return Number(rowValue(row, field));
}

function countValue(result: PerformanceResult): number {
  return rowNumber(result.rows[0], "n");
}

async function crawlConvergence(context: ContractContext): Promise<ConvergenceObservation> {
  const source = await context.client.execute(
    "select count(*) as n from perf_crawl_frontier where state = 'pending'",
  );
  const projected = await context.client.execute(
    "select count(*) as n from perf_crawl_due_work where state = 'ready'",
  );
  const repairs = await context.client.execute(
    "select count(*) as n from perf_crawl_projection_repairs",
  );
  const sourceRows = countValue(source);
  const projectedRows = countValue(projected);
  const repairRows = countValue(repairs);
  const countsAreValid = [sourceRows, projectedRows, repairRows].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  const countMismatch = sourceRows !== projectedRows;

  return {
    category: "projection",
    converged: countsAreValid && !countMismatch && repairRows === 0,
    fieldMismatches: countsAreValid && countMismatch ? 1 : countsAreValid ? 0 : 1,
    missingRows: countsAreValid ? Math.max(0, sourceRows - projectedRows) : 0,
    projectedRows,
    repairRows,
    scope: "crawl-due-work",
    sourceRows,
    unexpectedRows: countsAreValid ? Math.max(0, projectedRows - sourceRows) : 0,
  };
}

function jsonRows(rows: readonly unknown[]): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function observation(
  result: PerformanceResult,
  startedAt: number,
  context: ContractContext,
  metadata: Record<string, boolean | number | string | null>,
  affectedRowCount?: number,
  convergence?: ConvergenceObservation,
): ContractExecution {
  return {
    affectedRowCount,
    convergence,
    durationMs: Math.max(0, context.now() - startedAt),
    metadata,
    rawResult: result,
    resultRowCount: result.rows.length,
  };
}

async function cleanupCrawl(context: ContractContext): Promise<void> {
  await context.client.execute(CRAWL_CLEANUP);
}

function crawlMetadata(
  claimRows: number,
  rows: readonly unknown[],
  hasMoreRows: number,
  expectedClaimRows: number,
): Record<string, boolean | number | string | null> {
  const positionsContiguous = rows.every(
    (row, index) => rowNumber(row, "claim_position") === index && rowString(row, "node_id") !== "",
  );
  const releaseLaneRows = rows.filter((row) => rowString(row, "node_kind") === "release").length;

  return {
    claimRows,
    expectedClaimRows,
    expectedReadRows: CONTRACT_D_CRAWL_CLAIM_LIMIT,
    hasMoreRows,
    positionsContiguous,
    readRows: rows.length,
    releaseLaneRows,
  };
}

async function executeCrawl(
  context: ContractContext,
  measureClaim: boolean,
): Promise<ContractExecution> {
  await cleanupCrawl(context);

  let claimRows = 0;
  let rows: readonly unknown[] = [];
  let hasMoreRows = 0;
  let startedAt = 0;
  let execution: ContractExecution | undefined;

  try {
    if (measureClaim) {
      startedAt = context.now();
      const claim = await context.client.execute(CRAWL_CLAIM);
      claimRows = claim.rowsAffected ?? 0;
    } else {
      const claim = await context.client.execute(CRAWL_CLAIM);
      claimRows = claim.rowsAffected ?? 0;
      startedAt = context.now();
    }

    const read = await context.client.execute(CRAWL_READ);
    rows = read.rows;
    const hasMore = await context.client.execute(CRAWL_READY_SENTINEL);
    hasMoreRows = hasMore.rows.length;
    const metadata = crawlMetadata(claimRows, rows, hasMoreRows, CONTRACT_D_CRAWL_CLAIM_LIMIT);
    execution = observation(read, startedAt, context, metadata, claimRows);
  } finally {
    await cleanupCrawl(context);
  }

  if (execution === undefined) {
    throw new Error("crawl contract did not produce an observation");
  }

  return {
    ...execution,
    convergence: await crawlConvergence(context),
  };
}

function validateCrawl(execution: ContractExecution): readonly string[] {
  const failures: string[] = [];
  const metadata = execution.metadata ?? {};

  if (execution.affectedRowCount !== CONTRACT_D_CRAWL_CLAIM_LIMIT) {
    failures.push(
      `claim affected ${execution.affectedRowCount ?? 0} rows, expected ${CONTRACT_D_CRAWL_CLAIM_LIMIT}`,
    );
  }
  if (execution.resultRowCount !== CONTRACT_D_CRAWL_CLAIM_LIMIT) {
    failures.push(
      `read returned ${execution.resultRowCount} rows, expected ${CONTRACT_D_CRAWL_CLAIM_LIMIT}`,
    );
  }
  if (metadata.hasMoreRows !== 1) {
    failures.push("ready sentinel did not return one remaining row");
  }
  if (metadata.positionsContiguous !== true) {
    failures.push("claim positions were not contiguous and non-empty");
  }

  return failures;
}

async function executeReadySentinel(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const result = await context.client.execute(CRAWL_READY_SENTINEL);

  return observation(result, startedAt, context, { expectedRows: 1 });
}

function validateOneRow(execution: ContractExecution): readonly string[] {
  return execution.resultRowCount === 1
    ? []
    : [`expected one row, got ${execution.resultRowCount}`];
}

function publicBucketStatement(kind: "key" | "release_date_bucket"): PerformanceStatement {
  const order = kind === "release_date_bucket" ? "desc" : "asc";

  return {
    args: [kind],
    sql: `select counts.bucket, counts.track_count
      from perf_public_aggregate_state as aggregate
        indexed by sqlite_autoindex_perf_public_aggregate_state_1
      left join perf_public_aggregate_counts as counts
        indexed by sqlite_autoindex_perf_public_aggregate_counts_1
        on counts.aggregate_kind = ?
     where aggregate.scope = 'tracks' and ${AGGREGATE_READY}
     order by counts.bucket ${order}`,
  };
}

function expectedBuckets(
  counts: FixtureCounts,
  kind: "key" | "release_date_bucket",
): { bucket: string; count: number }[] {
  const values =
    kind === "key"
      ? publicAggregateFixtureBuckets(counts).key
      : publicAggregateFixtureBuckets(counts).releaseDate;

  return values
    .filter((entry): entry is { bucket: string; count: number } => entry.bucket !== null)
    .sort((left, right) => {
      const result = left.bucket < right.bucket ? -1 : left.bucket > right.bucket ? 1 : 0;
      return kind === "release_date_bucket" ? -result : result;
    });
}

async function executePublicBucket(
  context: ContractContext,
  kind: "key" | "release_date_bucket",
): Promise<ContractExecution> {
  const statement = publicBucketStatement(kind);
  const startedAt = context.now();
  const result = await context.client.execute(statement);
  const expected = expectedBuckets(countsFor(context), kind);
  const actual = result.rows.map((row) => ({
    bucket: rowString(row, "bucket"),
    count: rowNumber(row, "track_count"),
  }));

  return observation(result, startedAt, context, {
    actual: jsonRows(actual),
    expected: jsonRows(expected),
    expectedRows: expected.length,
    rowsEquivalent: jsonRows(actual) === jsonRows(expected),
  });
}

function validateBuckets(execution: ContractExecution): readonly string[] {
  const failures: string[] = [];

  if (execution.metadata?.rowsEquivalent !== true) {
    failures.push("projected bucket rows differ from the deterministic fixture");
  }
  if (execution.resultRowCount !== execution.metadata?.expectedRows) {
    failures.push("projected bucket cardinality changed");
  }

  return failures;
}

async function executePublicTotal(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const result = await context.client.execute(PUBLIC_TOTAL);
  const expected = countsFor(context).tracks;
  const actual = rowNumber(result.rows[0], "total");

  return observation(result, startedAt, context, {
    actual,
    expected,
    totalEquivalent: result.rows.length === 1 && actual === expected,
  });
}

function validateTotal(execution: ContractExecution): readonly string[] {
  return execution.metadata?.totalEquivalent === true
    ? []
    : ["projected total does not match tracks cardinality"];
}

async function executeQualifiedArtists(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const result = await context.client.execute(QUALIFIED_ARTISTS);
  const expectedIds = Array.from(
    { length: Math.min(6, countsFor(context).artists) },
    (_value, index) => `synthetic-artist-${index.toString().padStart(9, "0")}`,
  );
  const actualIds = result.rows.map((row) => rowString(row, "artist_id"));

  return observation(result, startedAt, context, {
    actualIds: JSON.stringify(actualIds),
    expectedIds: JSON.stringify(expectedIds),
    rowsEquivalent: JSON.stringify(actualIds) === JSON.stringify(expectedIds),
  });
}

function validateQualifiedArtists(execution: ContractExecution): readonly string[] {
  return execution.metadata?.rowsEquivalent === true
    ? []
    : ["qualified artist IDs differ from the deterministic projection"];
}

type Anchor = { id: string; key: null | string; page: number };

function parseAnchors(value: unknown): Anchor[] | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    const anchors: Anchor[] = [];
    const ids = new Set<string>();
    for (const candidate of parsed) {
      if (typeof candidate !== "object" || candidate === null) {
        return null;
      }
      const record = candidate as Record<string, unknown>;
      const id = record.id;
      const key = record.key;
      const page = Number(record.page);
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        ids.has(id) ||
        (key !== null && typeof key !== "string") ||
        !Number.isSafeInteger(page) ||
        page < 2
      ) {
        return null;
      }
      ids.add(id);
      anchors.push({ id, key: key as null | string, page });
    }
    return anchors;
  } catch {
    return null;
  }
}

function anchorsAreComplete(anchors: readonly Anchor[], total: number): boolean {
  return (
    anchors.length === Math.floor(total / CONTRACT_D_HUB_PAGE_SIZE) &&
    anchors.every((anchor, index) => anchor.page === index + 2)
  );
}

async function executeAnchorValidity(context: ContractContext): Promise<ContractExecution> {
  const startedAt = context.now();
  const result = await context.client.execute(ANCHOR_VALIDITY);
  const row = result.rows[0];
  const total = rowNumber(row, "total");
  const anchors = parseAnchors(rowValue(row, "anchors_json"));
  const expectedAnchors = defaultAnchorFixtureRows(countsFor(context));
  const anchorsEquivalent =
    anchors !== null && JSON.stringify(anchors) === JSON.stringify(expectedAnchors);
  const jsonValid = anchors !== null;

  return observation(result, startedAt, context, {
    anchorRows: anchors?.length ?? 0,
    anchorsEquivalent,
    complete: anchors !== null && anchorsAreComplete(anchors, total),
    expectedAnchorRows: expectedAnchors.length,
    expectedTotal: countsFor(context).tracks,
    jsonValid,
    total,
  });
}

function validateAnchorValidity(execution: ContractExecution): readonly string[] {
  const metadata = execution.metadata ?? {};
  const failures: string[] = [];

  if (execution.resultRowCount !== 1) {
    failures.push("default anchor proof returned no singleton document");
  }
  for (const field of ["anchorsEquivalent", "complete", "jsonValid"] as const) {
    if (metadata[field] !== true) {
      failures.push(`default anchor ${field} check failed`);
    }
  }
  if (metadata.total !== metadata.expectedTotal) {
    failures.push("default anchor total does not match the projected total");
  }

  return failures;
}

function trackIndexAtRank(
  rank: number,
  buckets: ReturnType<typeof publicAggregateFixtureBuckets>["releaseDate"],
): number {
  let start = 0;
  let rankStart = 1;

  for (const bucket of buckets) {
    if (rank <= rankStart + bucket.count - 1) {
      return start + bucket.count - (rank - rankStart) - 1;
    }
    start += bucket.count;
    rankStart += bucket.count;
  }

  return -1;
}

function expectedKeysetRows(
  counts: FixtureCounts,
  anchor: Anchor,
): { id: string; rd: null | string }[] {
  const buckets = publicAggregateFixtureBuckets(counts).releaseDate;
  const rank = (anchor.page - 1) * CONTRACT_D_HUB_PAGE_SIZE;

  return Array.from({ length: CONTRACT_D_HUB_PAGE_SIZE }, (_value, offset) => {
    const index = trackIndexAtRank(rank + offset + 1, buckets);
    const releaseDate = buckets.reduce<null | string>((found, bucket, bucketIndex) => {
      const start = buckets.slice(0, bucketIndex).reduce((sum, entry) => sum + entry.count, 0);
      return found ?? (index >= start && index < start + bucket.count ? bucket.bucket : null);
    }, null);

    return { id: `synthetic-track-${index.toString().padStart(9, "0")}`, rd: releaseDate };
  });
}

async function executeKeyset(context: ContractContext): Promise<ContractExecution> {
  const anchorResult = await context.client.execute(ANCHOR_VALIDITY);
  const anchor = parseAnchors(rowValue(anchorResult.rows[0], "anchors_json"))
    ?.filter((candidate) => candidate.key !== null)
    .at(-1);

  if (!anchor) {
    throw new Error("Contract D keyset requires a valid default anchor");
  }

  const statement: PerformanceStatement = {
    args: [anchor.key, anchor.id, CONTRACT_D_HUB_PAGE_SIZE],
    sql: KEYSET.sql,
  };
  const expected = expectedKeysetRows(countsFor(context), anchor);
  const startedAt = context.now();
  const primary = await context.client.execute(statement);
  const remaining = CONTRACT_D_HUB_PAGE_SIZE - primary.rows.length;
  const fill =
    remaining > 0
      ? await context.client.execute({ args: [remaining], sql: KEYSET_NULL_FILL.sql })
      : { rows: [] };
  const result = { ...primary, rows: [...primary.rows, ...fill.rows] };
  const actual = result.rows.map((row) => ({
    id: rowString(row, "track_id"),
    rd: rowValue(row, "rd") as null | string,
  }));

  return observation(result, startedAt, context, {
    actualFirstId: actual[0]?.id ?? null,
    actualLastId: actual.at(-1)?.id ?? null,
    expectedFirstId: expected[0]?.id ?? null,
    expectedLastId: expected.at(-1)?.id ?? null,
    nullFillRows: fill.rows.length,
    rowsEquivalent: JSON.stringify(actual) === JSON.stringify(expected),
  });
}

function validateKeyset(execution: ContractExecution): readonly string[] {
  const failures: string[] = [];

  if (execution.resultRowCount !== CONTRACT_D_HUB_PAGE_SIZE) {
    failures.push(
      `keyset returned ${execution.resultRowCount} rows, expected ${CONTRACT_D_HUB_PAGE_SIZE}`,
    );
  }
  if (execution.metadata?.rowsEquivalent !== true) {
    failures.push("keyset rows differ from the persisted-anchor order");
  }

  return failures;
}

function crawlContract(measureClaim: boolean): PerformanceContract {
  return {
    description: measureClaim
      ? "Crawl due work claims the maximum two-lane page and reads its ordered lease"
      : "Crawl due work reads a maximum two-lane claim through its lease-position index",
    async execute(context) {
      return executeCrawl(context, measureClaim);
    },
    id: measureClaim ? CONTRACT_D_CONTRACT_IDS[0] : CONTRACT_D_CONTRACT_IDS[1],
    iterations: 8,
    plan: measureClaim ? CRAWL_CLAIM_PLAN : CRAWL_READ_PLAN,
    validate: validateCrawl,
    warmupIterations: 1,
    workClass: CONTRACT_D_WORK_CLASS,
  };
}

function bucketContract(kind: "key" | "release_date_bucket"): PerformanceContract {
  const statement = publicBucketStatement(kind);
  const isRelease = kind === "release_date_bucket";

  return {
    description: isRelease
      ? "Public projection serves literal release-year buckets from maintained counts"
      : "Public projection serves literal key buckets from maintained counts",
    async execute(context) {
      return executePublicBucket(context, kind);
    },
    id: isRelease ? CONTRACT_D_CONTRACT_IDS[5] : CONTRACT_D_CONTRACT_IDS[6],
    iterations: 8,
    plan: { ...PUBLIC_BUCKET_PLAN, statement },
    validate: validateBuckets,
    warmupIterations: 1,
    workClass: CONTRACT_D_WORK_CLASS,
  };
}

export function contractDContracts(): PerformanceContract[] {
  return [
    crawlContract(true),
    crawlContract(false),
    {
      description: "Crawl due work proves a bounded ready sentinel after a maximum claim",
      execute: executeReadySentinel,
      id: CONTRACT_D_CONTRACT_IDS[2],
      iterations: 8,
      plan: CRAWL_READY_PLAN,
      validate: validateOneRow,
      warmupIterations: 1,
      workClass: CONTRACT_D_WORK_CLASS,
    },
    {
      description: "Public projections expose one clean-through readiness proof",
      execute: async (context) => {
        const startedAt = context.now();
        const result = await context.client.execute(PUBLIC_READINESS);
        return observation(result, startedAt, context, { expectedRows: 1 });
      },
      id: CONTRACT_D_CONTRACT_IDS[3],
      iterations: 8,
      plan: PUBLIC_READINESS_PLAN,
      validate: validateOneRow,
      warmupIterations: 1,
      workClass: CONTRACT_D_WORK_CLASS,
    },
    {
      description: "Public projection serves the unfiltered total from aggregate state",
      execute: executePublicTotal,
      id: CONTRACT_D_CONTRACT_IDS[4],
      iterations: 8,
      plan: PUBLIC_TOTAL_PLAN,
      validate: validateTotal,
      warmupIterations: 1,
      workClass: CONTRACT_D_WORK_CLASS,
    },
    bucketContract("release_date_bucket"),
    bucketContract("key"),
    {
      description: "Public projection serves the qualified artist ID set by partial index",
      execute: executeQualifiedArtists,
      id: CONTRACT_D_CONTRACT_IDS[7],
      iterations: 8,
      plan: QUALIFIED_ARTISTS_PLAN,
      validate: validateQualifiedArtists,
      warmupIterations: 1,
      workClass: CONTRACT_D_WORK_CLASS,
    },
    {
      description:
        "Default hub anchors require current validity, state, epoch, generation, and JSON",
      execute: executeAnchorValidity,
      id: CONTRACT_D_CONTRACT_IDS[8],
      iterations: 8,
      plan: ANCHOR_VALIDITY_PLAN,
      validate: validateAnchorValidity,
      warmupIterations: 1,
      workClass: CONTRACT_D_WORK_CLASS,
    },
    {
      description: "Default hub keyset paging seeks from a validated sparse anchor",
      execute: executeKeyset,
      id: CONTRACT_D_CONTRACT_IDS[9],
      iterations: 8,
      plan: KEYSET_PLAN,
      validate: validateKeyset,
      warmupIterations: 1,
      workClass: CONTRACT_D_WORK_CLASS,
    },
  ];
}

export function registerContractD(registry: PerformanceRegistry): void {
  for (const contract of contractDContracts()) {
    registry.register(contract);
  }
}
