import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { simulateMixedLoad } from "./mixed-load";
import { analyzeExplainPlan } from "./plan";
import {
  type ContractExecution,
  type PerformanceContract,
  type PerformanceResult,
  type PerformanceStatement,
  PerformanceRegistry,
  sqlContract,
} from "./registry";

export const performanceRegistry = new PerformanceRegistry();

function explainDetails(result: PerformanceResult): string[] {
  return result.rows.map((row, index) => {
    if (typeof row === "object" && row !== null && "detail" in row) {
      const detail = (row as { detail?: unknown }).detail;

      if (typeof detail === "string") {
        return detail;
      }
    }

    throw new Error(`EXPLAIN QUERY PLAN row ${index} has no string detail`);
  });
}

function serializableRows(rows: readonly unknown[]): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function valueAt(row: unknown, field: string): string {
  if (typeof row !== "object" || row === null || !(field in row)) {
    return "";
  }

  const value = (row as Record<string, unknown>)[field];

  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : "";
}

function newestFirst(rows: readonly unknown[]): unknown[] {
  return [...rows].sort((left, right) => {
    const byLastmod = valueAt(right, "lastmod").localeCompare(valueAt(left, "lastmod"));

    return byLastmod === 0
      ? valueAt(left, "track_id").localeCompare(valueAt(right, "track_id"))
      : byLastmod;
  });
}

type ComparisonContractOptions = Omit<PerformanceContract, "execute" | "plan" | "validate"> & {
  after: PerformanceStatement;
  before: PerformanceStatement;
  normalizeRows?: (rows: readonly unknown[]) => unknown[];
  plan: NonNullable<PerformanceContract["plan"]>;
};

function comparisonContract(options: ComparisonContractOptions): PerformanceContract {
  const { after, before, normalizeRows, plan, ...contract } = options;

  return {
    ...contract,
    async execute(context): Promise<ContractExecution> {
      const beforePlanResult = await context.client.execute({
        args: before.args,
        sql: `EXPLAIN QUERY PLAN ${before.sql}`,
      });
      const beforePlan = analyzeExplainPlan(explainDetails(beforePlanResult), plan.policy);
      const beforeResult = await context.client.execute(before);
      const startedAt = context.now();
      const afterResult = await context.client.execute(after);
      const durationMs = Math.max(0, context.now() - startedAt);
      const normalize = normalizeRows ?? ((rows: readonly unknown[]) => [...rows]);
      const beforeOutput = serializableRows(normalize(beforeResult.rows));
      const afterOutput = serializableRows(normalize(afterResult.rows));

      return {
        affectedRowCount: afterResult.rowsAffected ?? 0,
        durationMs,
        metadata: {
          afterOutput,
          afterResultRowCount: afterResult.rows.length,
          beforeFullScanCount: beforePlan.fullScans.length,
          beforeOutput,
          beforePlanDetails: beforePlan.details.join(" | "),
          beforePlanViolationCount: beforePlan.violations.length,
          beforeResultRowCount: beforeResult.rows.length,
          outputsEquivalent: beforeOutput === afterOutput,
        },
        rawResult: afterResult,
        resultRowCount: afterResult.rows.length,
      };
    },
    plan,
    validate(execution) {
      const failures: string[] = [];

      if (execution.metadata?.outputsEquivalent !== true) {
        failures.push("before and after outputs differ");
      }

      if (execution.metadata?.beforeResultRowCount !== execution.resultRowCount) {
        failures.push("before and after row counts differ");
      }

      return failures;
    },
  };
}

const FINDING_PLAN_POLICY = {
  allowFullScanOf: ["perf_findings"],
  forbidTempSort: true,
  growingTables: ["perf_tracks"],
  requiredDetails: [/\b(?:SCAN|SEARCH)(?: TABLE)? perf_findings\b/i],
} as const;

const FINDING_PAGES_BEFORE = {
  args: [],
  sql: `select perf_findings.track_id,
               max(coalesce(perf_findings.video_squared_at, ''),
                   coalesce(perf_findings.updated_at, ''),
                   perf_findings.added_at) as lastmod
        from perf_findings
        join perf_tracks on perf_tracks.id = perf_findings.track_id
        where perf_findings.log_id is not null
        order by lastmod desc`,
} satisfies PerformanceStatement;

const FINDING_PAGES_AFTER = {
  args: [],
  sql: `select perf_findings.track_id,
               max(coalesce(perf_findings.video_squared_at, ''),
                   coalesce(perf_findings.updated_at, ''),
                   perf_findings.added_at) as lastmod
        from perf_findings
        cross join perf_tracks on perf_tracks.id = perf_findings.track_id
        where perf_findings.log_id is not null`,
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: FINDING_PAGES_AFTER,
    before: FINDING_PAGES_BEFORE,
    description: "Finding sitemap rows start from findings and preserve ordered lastmod output",
    id: "sitemap.finding-pages",
    iterations: 20,
    normalizeRows: newestFirst,
    plan: { policy: FINDING_PLAN_POLICY, statement: FINDING_PAGES_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

const FINDING_STATS_BEFORE = {
  args: [],
  sql: `select count(*) as n,
               max(max(coalesce(perf_findings.video_squared_at, ''),
                       coalesce(perf_findings.updated_at, ''),
                       perf_findings.added_at)) as lastmod
        from perf_findings
        join perf_tracks on perf_tracks.id = perf_findings.track_id
        where perf_findings.log_id is not null`,
} satisfies PerformanceStatement;

const FINDING_STATS_AFTER = {
  args: [],
  sql: FINDING_STATS_BEFORE.sql.replace("join perf_tracks", "cross join perf_tracks"),
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: FINDING_STATS_AFTER,
    before: FINDING_STATS_BEFORE,
    description: "Finding sitemap count and lastmod start from the certified corpus",
    id: "sitemap.finding-stats",
    iterations: 20,
    plan: { policy: FINDING_PLAN_POLICY, statement: FINDING_STATS_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

function entityLastmodStatements(entity: "albums" | "artists" | "labels"): {
  after: PerformanceStatement;
  before: PerformanceStatement;
} {
  const edgeJoin =
    entity === "artists"
      ? `cross join perf_track_artists on perf_track_artists.track_id = perf_tracks.id
         cross join perf_artists on perf_artists.id = perf_track_artists.artist_id`
      : `cross join perf_${entity} on perf_${entity}.id = perf_tracks.${entity.slice(0, -1)}_id`;
  const countTable = `perf_${entity}`;
  const before = {
    args: [3],
    sql: `select max(perf_findings.added_at) as lastmod
          from perf_findings
          join perf_tracks on perf_tracks.id = perf_findings.track_id
          ${edgeJoin}
          where ${countTable}.renderable_track_count >= ?`,
  } satisfies PerformanceStatement;

  return {
    after: {
      args: before.args,
      sql: before.sql.replace("join perf_tracks", "cross join perf_tracks"),
    },
    before,
  };
}

for (const entity of ["albums", "artists", "labels"] as const) {
  const statements = entityLastmodStatements(entity);
  const growingTables =
    entity === "artists" ? ["perf_tracks", "perf_track_artists"] : ["perf_tracks"];

  performanceRegistry.register(
    comparisonContract({
      after: statements.after,
      before: statements.before,
      description: `${entity} sitemap lastmod starts from findings and preserves its scalar output`,
      id: `sitemap.${entity}-lastmod`,
      iterations: 20,
      plan: {
        policy: { ...FINDING_PLAN_POLICY, growingTables },
        statement: statements.after,
      },
      warmupIterations: 2,
      workClass: "route-db",
    }),
  );
}

const ARTIST_LINK_TRACK_IDS = [
  "synthetic-track-000000000",
  "synthetic-track-000000001",
  "synthetic-track-000000002",
  "synthetic-track-000000003",
  "synthetic-track-000000004",
] as const;
const ARTIST_LINK_PLACEHOLDERS = ARTIST_LINK_TRACK_IDS.map(() => "?").join(", ");
const ARTIST_LINK_TRIPLES = JSON.stringify([
  [ARTIST_LINK_TRACK_IDS[0], 1, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[1], 1, "synthetic-mbid-unclaimed"],
  [ARTIST_LINK_TRACK_IDS[2], 1, "synthetic-mbid-collision"],
  [ARTIST_LINK_TRACK_IDS[3], 2, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[4], 1, "synthetic-mbid-identity"],
]);
const ARTIST_LINK_ARGS = [ARTIST_LINK_TRIPLES, ...ARTIST_LINK_TRACK_IDS];

const ARTIST_LINK_BEFORE = {
  args: ARTIST_LINK_ARGS,
  sql: `with credit_id as (
          select cast(json_extract(value, '$[0]') as text) as track_id,
                 cast(json_extract(value, '$[1]') as integer) as position,
                 cast(json_extract(value, '$[2]') as text) as mbid
            from json_each(?)
        )
        select perf_tracks.id as track_id, perf_artists.id as artist_id,
               cast(credit.key as integer) + 1 as position, perf_tracks.is_catalogue
          from perf_tracks
          join json_each(perf_tracks.artists_json) credit
          left join credit_id
            on credit_id.track_id = perf_tracks.id
           and credit_id.position = cast(credit.key as integer) + 1
          join perf_artists on case
            when credit_id.mbid is not null then (
                 perf_artists.mbid = credit_id.mbid
              or (perf_artists.mbid is null
                  and perf_artists.name = credit.value collate nocase
                  and not exists (
                        select 1 from perf_artists claimed
                         where claimed.mbid = credit_id.mbid
                      ))
            )
            else perf_artists.name = credit.value collate nocase
          end
         where perf_tracks.id in (${ARTIST_LINK_PLACEHOLDERS})`,
} satisfies PerformanceStatement;

const ARTIST_LINK_AFTER = {
  args: ARTIST_LINK_ARGS,
  sql: `with credit_id as materialized (
          select cast(json_extract(value, '$[0]') as text) as track_id,
                 cast(json_extract(value, '$[1]') as integer) as position,
                 cast(json_extract(value, '$[2]') as text) as mbid
            from json_each(?)
        ),
        requested_credit as materialized (
          select perf_tracks.id as track_id,
                 cast(credit.key as integer) + 1 as position,
                 cast(credit.value as text) as artist_name,
                 perf_tracks.is_catalogue,
                 credit_id.mbid
            from perf_tracks
            join json_each(perf_tracks.artists_json) credit
            left join credit_id
              on credit_id.track_id = perf_tracks.id
             and credit_id.position = cast(credit.key as integer) + 1
           where perf_tracks.id in (${ARTIST_LINK_PLACEHOLDERS})
        ),
        resolved_candidate as materialized (
          select credit.track_id, perf_artists.id as artist_id,
                 credit.position, credit.is_catalogue
            from requested_credit credit
            cross join perf_artists indexed by perf_artists_mbid_idx
              on perf_artists.mbid = credit.mbid
           where credit.mbid is not null
          union all
          select credit.track_id, perf_artists.id as artist_id,
                 credit.position, credit.is_catalogue
            from requested_credit credit
            cross join perf_artists indexed by perf_artists_name_nocase_idx
              on perf_artists.name collate nocase = credit.artist_name
           where credit.mbid is not null
             and perf_artists.mbid is null
             and not exists (
                   select 1 from perf_artists claimed indexed by perf_artists_mbid_idx
                    where claimed.mbid = credit.mbid
                 )
          union all
          select credit.track_id, perf_artists.id as artist_id,
                 credit.position, credit.is_catalogue
            from requested_credit credit
            cross join perf_artists indexed by perf_artists_name_nocase_idx
              on perf_artists.name collate nocase = credit.artist_name
           where credit.mbid is null
        ),
        resolved_edge as (
          select candidate.track_id, candidate.artist_id,
                 candidate.position, candidate.is_catalogue
            from resolved_candidate candidate
           where not exists (
                 select 1 from resolved_candidate earlier
                  where earlier.track_id = candidate.track_id
                    and earlier.artist_id = candidate.artist_id
                    and earlier.position < candidate.position
           )
        )
        select track_id, artist_id, position, is_catalogue from resolved_edge`,
} satisfies PerformanceStatement;

const ARTIST_LINK_PLAN_POLICY = {
  forbidTempSort: true,
  growingTables: ["perf_artists", "perf_tracks"],
  requiredDetails: [
    /sqlite_autoindex_perf_tracks_1/i,
    /perf_artists_mbid_idx/i,
    /perf_artists_name_nocase_idx/i,
  ],
} as const;

function artistEdgesOrdered(rows: readonly unknown[]): unknown[] {
  return [...rows].sort((left, right) => {
    for (const field of ["track_id", "artist_id", "position"]) {
      const comparison = valueAt(left, field).localeCompare(valueAt(right, field));

      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  });
}

performanceRegistry.register(
  comparisonContract({
    after: ARTIST_LINK_AFTER,
    before: ARTIST_LINK_BEFORE,
    description: "Artist links resolve one requested credit set through sargable identity branches",
    id: "artist-link.identity-resolution",
    iterations: 20,
    normalizeRows: artistEdgesOrdered,
    plan: { policy: ARTIST_LINK_PLAN_POLICY, statement: ARTIST_LINK_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

const ARTIST_NAME_BEFORE = {
  args: ARTIST_LINK_TRACK_IDS,
  sql: `select perf_tracks.id as track_id, perf_artists.id as artist_id,
               cast(credit.key as integer) + 1 as position, perf_tracks.is_catalogue
          from perf_tracks
          join json_each(perf_tracks.artists_json) credit
          join perf_artists on perf_artists.name = credit.value collate nocase
         where perf_tracks.id in (${ARTIST_LINK_PLACEHOLDERS})`,
} satisfies PerformanceStatement;

const ARTIST_NAME_AFTER = {
  args: ARTIST_LINK_TRACK_IDS,
  sql: ARTIST_NAME_BEFORE.sql.replace(
    "join perf_artists on",
    "cross join perf_artists indexed by perf_artists_name_nocase_idx on",
  ),
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: ARTIST_NAME_AFTER,
    before: ARTIST_NAME_BEFORE,
    description: "Artist links without credit MBIDs retain the indexed historical name fold",
    id: "artist-link.name-resolution",
    iterations: 20,
    normalizeRows: artistEdgesOrdered,
    plan: {
      policy: {
        forbidTempSort: true,
        growingTables: ["perf_artists", "perf_tracks"],
        requiredDetails: [/sqlite_autoindex_perf_tracks_1/i, /perf_artists_name_nocase_idx/i],
      },
      statement: ARTIST_NAME_AFTER,
    },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

performanceRegistry.register(
  sqlContract({
    description: "A bounded pending-frontier claim uses the synthetic eligibility index",
    id: "fixture.frontier-pending-claim",
    iterations: 20,
    plan: {
      policy: {
        forbidTempSort: true,
        growingTables: ["perf_crawl_frontier"],
        requiredDetails: [/perf_crawl_frontier_state_id_idx/i],
      },
      statement: {
        args: ["pending", 25],
        sql: "select id from perf_crawl_frontier where state = ? order by id limit ?",
      },
    },
    statement: {
      args: ["pending", 25],
      sql: "select id from perf_crawl_frontier where state = ? order by id limit ?",
    },
    validate(execution) {
      if (execution.resultRowCount < 1 || execution.resultRowCount > 25) {
        return [`bounded claim returned ${execution.resultRowCount} rows`];
      }

      return [];
    },
    warmupIterations: 2,
    workClass: "queue",
  }),
);

performanceRegistry.register({
  description: "Held heavy reader, public reads, and serialized batches honor per-client bounds",
  async execute() {
    const report = simulateMixedLoad();
    const writes = report.events.filter((event) => event.workClass === "write-batch");

    return {
      batchCount: writes.reduce((sum, event) => sum + (event.batchCount ?? 0), 0),
      durationMs: report.latencyMs["public-read"].p95,
      metadata: {
        heavyReaderLatencyP50Ms: report.latencyMs["heavy-reader"].p50,
        heavyReaderLatencyP95Ms: report.latencyMs["heavy-reader"].p95,
        heavyReaderLatencyP99Ms: report.latencyMs["heavy-reader"].p99,
        heavyReaderQueueP50Ms: report.queueMs["heavy-reader"].p50,
        heavyReaderQueueP95Ms: report.queueMs["heavy-reader"].p95,
        heavyReaderQueueP99Ms: report.queueMs["heavy-reader"].p99,
        maxPrimaryConcurrency: report.maxConcurrentByClient.primary,
        primaryBound: report.bounds.primary,
        publicReadLatencyP50Ms: report.latencyMs["public-read"].p50,
        publicReadLatencyP95Ms: report.latencyMs["public-read"].p95,
        publicReadLatencyP99Ms: report.latencyMs["public-read"].p99,
        publicReadQueueP50Ms: report.queueMs["public-read"].p50,
        publicReadQueueP95Ms: report.queueMs["public-read"].p95,
        publicReadQueueP99Ms: report.queueMs["public-read"].p99,
        scope: report.scope,
        telemetryBound: report.bounds.telemetry,
        violations: report.violations.length,
        writeBatchLatencyP50Ms: report.latencyMs["write-batch"].p50,
        writeBatchLatencyP95Ms: report.latencyMs["write-batch"].p95,
        writeBatchLatencyP99Ms: report.latencyMs["write-batch"].p99,
        writeBatchQueueP50Ms: report.queueMs["write-batch"].p50,
        writeBatchQueueP95Ms: report.queueMs["write-batch"].p95,
        writeBatchQueueP99Ms: report.queueMs["write-batch"].p99,
      },
      queueMs: report.queueMs["public-read"].p95,
      resultRowCount: report.events.length,
    };
  },
  id: "client.mixed-load",
  iterations: 20,
  validate() {
    return simulateMixedLoad({ bounds: DATABASE_CLIENT_BOUNDS }).violations;
  },
  workClass: "route-db",
});

export function selectPerformanceContracts(ids: readonly string[]) {
  if (ids.length === 0) {
    return performanceRegistry.list();
  }

  return [...new Set(ids)].map((id) => performanceRegistry.get(id));
}
