import { DATABASE_CLIENT_BOUNDS } from "./client-bounds";
import { DUE_WORK_COLUMNS, DUE_WORK_COLUMN_NAMES } from "../../src/lib/server/due-work-columns";
import { registerContractD } from "./contract-d";
import { registerFinalProofContracts } from "./final-proof";
import { registerIndexEvidenceContracts } from "./index-evidence";
import { simulateMixedLoad } from "./mixed-load";
import { analyzeExplainPlan } from "./plan";
import {
  type ConvergenceObservation,
  type ContractExecution,
  type PerformanceContract,
  type PerformanceResult,
  type PerformanceStatement,
  PerformanceRegistry,
  executePerformanceBatch,
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

function trackRefsOrdered(rows: readonly unknown[]): unknown[] {
  return [...rows].sort((left, right) => {
    const byTrack = valueAt(left, "track_id").localeCompare(valueAt(right, "track_id"));

    return byTrack === 0
      ? valueAt(left, "log_id").localeCompare(valueAt(right, "log_id"))
      : byTrack;
  });
}

type ComparisonContractOptions = Omit<
  PerformanceContract,
  "execute" | "plan" | "terminalProof" | "validate"
> & {
  after: PerformanceStatement;
  before: PerformanceStatement;
  normalizeRows?: (rows: readonly unknown[]) => unknown[];
  plan: NonNullable<PerformanceContract["plan"]>;
};

/** Keep baseline plans and equivalence reads in terminalProof; execute measures only `after`. */
function comparisonContract(options: ComparisonContractOptions): PerformanceContract {
  const { after, before, normalizeRows, plan, ...contract } = options;
  const measuredRequestCount = contract.iterations + (contract.warmupIterations ?? 0);

  return {
    ...contract,
    async execute(context): Promise<ContractExecution> {
      const startedAt = context.now();
      const afterResult = await context.client.execute(after);

      return {
        affectedRowCount: afterResult.rowsAffected ?? 0,
        durationMs: Math.max(0, context.now() - startedAt),
        metadata: {
          finalStatementRequestCount: 1,
          timingScope: "single-final-statement",
        },
        rawResult: afterResult,
        resultRowCount: afterResult.rows.length,
      };
    },
    plan,
    terminalProof: {
      async execute(context): Promise<ContractExecution> {
        const beforePlanResult = await context.client.execute({
          args: before.args,
          sql: `EXPLAIN QUERY PLAN ${before.sql}`,
        });
        const beforePlan = analyzeExplainPlan(explainDetails(beforePlanResult), plan.policy);
        const beforeResult = await context.client.execute(before);
        const afterResult = await context.client.execute(after);
        const normalize = normalizeRows ?? ((rows: readonly unknown[]) => [...rows]);
        const beforeOutput = serializableRows(normalize(beforeResult.rows));
        const afterOutput = serializableRows(normalize(afterResult.rows));

        return {
          metadata: {
            afterOutput,
            afterResultRowCount: afterResult.rows.length,
            beforeFullScanCount: beforePlan.fullScans.length,
            beforeOutput,
            beforePlanDetails: beforePlan.details.join(" | "),
            beforePlanViolationCount: beforePlan.violations.length,
            beforeResultRowCount: beforeResult.rows.length,
            measuredRequestCount,
            outputsEquivalent: beforeOutput === afterOutput,
            terminalPlanRequestCount: 1,
            terminalProofRequestCount: 3,
            totalRequestCount: measuredRequestCount + 4,
          },
          rawResult: afterResult,
          resultRowCount: afterResult.rows.length,
        };
      },
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
    entity === "artists"
      ? ["perf_tracks", "perf_track_artists", "perf_artists"]
      : ["perf_tracks", `perf_${entity}`];

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

const TRACK_RESOLVER_PLAN_POLICY = {
  forbidTempSort: true,
  growingTables: ["perf_findings", "perf_tracks", "preferred_finding", "preferred_track"],
  requiredDetails: [/sqlite_autoindex_perf_tracks_1/i, /perf_findings_log_id_unique/i],
} as const;

const TRACK_RESOLVER_RAW_ID = "synthetic-track-000000000";
const TRACK_RESOLVER_LOG_ID = "synthetic-log-000000000";

const OPTIONAL_TRACK_RESOLVER_BEFORE = {
  args: [TRACK_RESOLVER_RAW_ID, TRACK_RESOLVER_RAW_ID],
  sql: `select perf_tracks.id as track_id, perf_findings.log_id
          from perf_tracks
          left join perf_findings on perf_findings.track_id = perf_tracks.id
         where perf_tracks.id = ? or perf_findings.log_id = ?
         limit 1`,
} satisfies PerformanceStatement;

const OPTIONAL_TRACK_RESOLVER_AFTER = {
  args: [TRACK_RESOLVER_RAW_ID, TRACK_RESOLVER_RAW_ID, TRACK_RESOLVER_RAW_ID],
  sql: `with resolved_track(track_id) as (
          select perf_tracks.id from perf_tracks
           where perf_tracks.id = ?
          union all
          select perf_findings.track_id from perf_findings
          join perf_tracks on perf_tracks.id = perf_findings.track_id
           where perf_findings.log_id = ?
             and not exists (
                   select 1 from perf_tracks preferred_track
                    where preferred_track.id = ?
                 )
          limit 1
        )
        select perf_tracks.id as track_id, perf_findings.log_id
          from resolved_track
          join perf_tracks on perf_tracks.id = resolved_track.track_id
          left join perf_findings on perf_findings.track_id = perf_tracks.id
         limit 1`,
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: OPTIONAL_TRACK_RESOLVER_AFTER,
    before: OPTIONAL_TRACK_RESOLVER_BEFORE,
    description: "Optional-finding track resolvers seek raw and Log IDs through separate indexes",
    id: "track-resolver.optional-finding",
    iterations: 20,
    plan: { policy: TRACK_RESOLVER_PLAN_POLICY, statement: OPTIONAL_TRACK_RESOLVER_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

const ALL_TRACK_MATCHES_BEFORE = {
  args: [TRACK_RESOLVER_LOG_ID, TRACK_RESOLVER_LOG_ID],
  sql: `select perf_tracks.id as track_id, perf_findings.log_id
          from perf_tracks
          left join perf_findings on perf_findings.track_id = perf_tracks.id
         where perf_tracks.id = ? or perf_findings.log_id = ?`,
} satisfies PerformanceStatement;

const ALL_TRACK_MATCHES_AFTER = {
  args: [TRACK_RESOLVER_LOG_ID, TRACK_RESOLVER_LOG_ID, TRACK_RESOLVER_LOG_ID],
  sql: `with resolved_tracks(track_id) as (
          select perf_tracks.id from perf_tracks
           where perf_tracks.id = ?
          union all
          select perf_findings.track_id from perf_findings
          join perf_tracks on perf_tracks.id = perf_findings.track_id
           where perf_findings.log_id = ? and perf_findings.track_id <> ?
        )
        select perf_tracks.id as track_id, perf_findings.log_id
          from resolved_tracks
          join perf_tracks on perf_tracks.id = resolved_tracks.track_id
          left join perf_findings on perf_findings.track_id = perf_tracks.id`,
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: ALL_TRACK_MATCHES_AFTER,
    before: ALL_TRACK_MATCHES_BEFORE,
    description: "Identity references preserve all cross-namespace matches through indexed seeks",
    id: "track-resolver.all-matches",
    iterations: 20,
    normalizeRows: trackRefsOrdered,
    plan: { policy: TRACK_RESOLVER_PLAN_POLICY, statement: ALL_TRACK_MATCHES_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

const REQUIRED_FINDING_RESOLVER_BEFORE = {
  args: [TRACK_RESOLVER_LOG_ID, TRACK_RESOLVER_LOG_ID],
  sql: `select perf_tracks.id as track_id, perf_findings.log_id
          from perf_findings
          join perf_tracks on perf_tracks.id = perf_findings.track_id
         where perf_tracks.id = ? or perf_findings.log_id = ?
         limit 1`,
} satisfies PerformanceStatement;

const REQUIRED_FINDING_RESOLVER_AFTER = {
  args: [TRACK_RESOLVER_LOG_ID, TRACK_RESOLVER_LOG_ID, TRACK_RESOLVER_LOG_ID],
  sql: `with resolved_track(track_id) as (
          select perf_tracks.id from perf_tracks
          join perf_findings on perf_findings.track_id = perf_tracks.id
           where perf_tracks.id = ?
          union all
          select perf_findings.track_id from perf_findings
          join perf_tracks on perf_tracks.id = perf_findings.track_id
           where perf_findings.log_id = ?
             and not exists (
                   select 1 from perf_tracks preferred_track
                   join perf_findings preferred_finding
                     on preferred_finding.track_id = preferred_track.id
                    where preferred_track.id = ?
                 )
          limit 1
        )
        select perf_tracks.id as track_id, perf_findings.log_id
          from resolved_track
          join perf_findings on perf_findings.track_id = resolved_track.track_id
          join perf_tracks on perf_tracks.id = resolved_track.track_id
         limit 1`,
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: REQUIRED_FINDING_RESOLVER_AFTER,
    before: REQUIRED_FINDING_RESOLVER_BEFORE,
    description: "Finding-only track resolvers seek both identities and preserve certification",
    id: "track-resolver.required-finding",
    iterations: 20,
    plan: { policy: TRACK_RESOLVER_PLAN_POLICY, statement: REQUIRED_FINDING_RESOLVER_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

const BULK_TRACK_RESOLVER_INPUTS = [
  TRACK_RESOLVER_RAW_ID,
  TRACK_RESOLVER_LOG_ID,
  "synthetic-missing-track",
] as const;
const BULK_TRACK_RESOLVER_PLACEHOLDERS = BULK_TRACK_RESOLVER_INPUTS.map(() => "?").join(", ");

const BULK_TRACK_RESOLVER_BEFORE = {
  args: [...BULK_TRACK_RESOLVER_INPUTS, ...BULK_TRACK_RESOLVER_INPUTS],
  sql: `select perf_tracks.id as track_id, perf_findings.log_id
          from perf_tracks
          left join perf_findings on perf_findings.track_id = perf_tracks.id
         where perf_tracks.id in (${BULK_TRACK_RESOLVER_PLACEHOLDERS})
            or perf_findings.log_id in (${BULK_TRACK_RESOLVER_PLACEHOLDERS})`,
} satisfies PerformanceStatement;

const BULK_TRACK_RESOLVER_AFTER = {
  args: [...BULK_TRACK_RESOLVER_INPUTS],
  sql: `with input(value) as (values ${BULK_TRACK_RESOLVER_INPUTS.map(() => "(?)").join(", ")}),
        resolved_tracks(track_id, log_id) as (
          select perf_tracks.id, perf_findings.log_id
            from input
            join perf_tracks on perf_tracks.id = input.value
            left join perf_findings on perf_findings.track_id = perf_tracks.id
          union all
          select perf_tracks.id, perf_findings.log_id
            from input
            join perf_findings on perf_findings.log_id = input.value
            join perf_tracks on perf_tracks.id = perf_findings.track_id
           where not exists (
                 select 1 from perf_tracks preferred_track
                  where preferred_track.id = input.value
               )
             and not exists (
                   select 1 from input raw_input
                    where raw_input.value = perf_findings.track_id
                 )
        )
        select track_id, log_id from resolved_tracks`,
} satisfies PerformanceStatement;

performanceRegistry.register(
  comparisonContract({
    after: BULK_TRACK_RESOLVER_AFTER,
    before: BULK_TRACK_RESOLVER_BEFORE,
    description: "Bulk track collection resolves a bounded input set without a catalogue scan",
    id: "track-resolver.bulk",
    iterations: 20,
    normalizeRows: trackRefsOrdered,
    plan: { policy: TRACK_RESOLVER_PLAN_POLICY, statement: BULK_TRACK_RESOLVER_AFTER },
    warmupIterations: 2,
    workClass: "route-db",
  }),
);

const ARTIST_LINK_TRACK_IDS = [
  "synthetic-track-000000000",
  "synthetic-track-000000001",
  "synthetic-track-000000002",
  "synthetic-track-000000003",
  "synthetic-track-000000004",
  "synthetic-track-000000511",
  "synthetic-track-000001272",
] as const;
const ARTIST_LINK_PLACEHOLDERS = ARTIST_LINK_TRACK_IDS.map(() => "?").join(", ");
const ARTIST_LINK_TRIPLES = JSON.stringify([
  [ARTIST_LINK_TRACK_IDS[0], 1, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[1], 1, "synthetic-mbid-unclaimed"],
  [ARTIST_LINK_TRACK_IDS[2], 1, "synthetic-mbid-collision"],
  [ARTIST_LINK_TRACK_IDS[3], 2, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[3], 3, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[4], 1, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[5], 1, "synthetic-mbid-identity"],
  [ARTIST_LINK_TRACK_IDS[6], 1, "synthetic-mbid-identity"],
]);
const ARTIST_LINK_ARGS = [ARTIST_LINK_TRIPLES, ...ARTIST_LINK_TRACK_IDS];

const ARTIST_LINK_BEFORE = {
  args: ARTIST_LINK_ARGS,
  sql: `with credit_id as (
          select cast(json_extract(value, '$[0]') as text) as track_id,
                 cast(json_extract(value, '$[1]') as integer) as position,
                 cast(json_extract(value, '$[2]') as text) as mbid
            from json_each(?)
        ),
        legacy_candidate as (
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
           where perf_tracks.id in (${ARTIST_LINK_PLACEHOLDERS})
        )
        select track_id, artist_id, min(position) as position, is_catalogue
          from legacy_candidate
         group by track_id, artist_id, is_catalogue`,
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
  growingTables: ["claimed", "perf_artists", "perf_tracks"],
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

function scalarCount(result: PerformanceResult): number {
  const row = result.rows[0];
  if (typeof row !== "object" || row === null || !("n" in row)) {
    return -1;
  }

  const value = (row as { n?: unknown }).n;
  return typeof value === "number" || typeof value === "bigint"
    ? Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? Number(value)
      : -1
    : -1;
}

function convergenceEvidence(
  category: ConvergenceObservation["category"],
  scope: string,
  sourceRows: number,
  projectedRows: number,
  repairRows: number,
): ConvergenceObservation {
  const countsAreValid = [sourceRows, projectedRows, repairRows].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  const countMismatch = sourceRows !== projectedRows;
  const repairMismatch = repairRows !== 0;

  return {
    category,
    converged: countsAreValid && !countMismatch && !repairMismatch,
    fieldMismatches: countsAreValid ? Number(countMismatch) + Number(repairMismatch) : 1,
    missingRows: countsAreValid ? Math.max(0, sourceRows - projectedRows) : 0,
    projectedRows,
    repairRows,
    scope,
    sourceRows,
    unexpectedRows: countsAreValid ? Math.max(0, projectedRows - sourceRows) : 0,
  };
}

async function dueWorkConvergence(
  context: Pick<ContractContext, "client">,
  workKind: string,
  sourceColumn: string,
): Promise<ConvergenceObservation> {
  const source = await context.client.execute({
    args: [],
    sql: `select count(*) as n from perf_tracks where ${sourceColumn} = 1`,
  });
  const projected = await context.client.execute({
    args: [workKind],
    sql: "select count(*) as n from due_work where work_kind = ? and state = 'ready'",
  });

  return convergenceEvidence("queue", "due-work", scalarCount(source), scalarCount(projected), 0);
}

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

const DUE_WORK_READY_READ = {
  args: ["youtube-provenance-findings", 25],
  sql: `select subject_id from due_work
    where work_kind = ? and state = 'ready'
    order by sort_key, subject_id
    limit ?`,
};

const DUE_WORK_CLAIM = {
  args: [
    "synthetic-claim-token",
    "2099-01-01T00:01:00.000Z",
    "synthetic-worker",
    "2099-01-01T00:00:00.000Z",
    "youtube-provenance-findings",
    25,
    "youtube-provenance-findings",
    "2099-01-01T00:00:00.000Z",
    "youtube-provenance-findings",
    "synthetic-worker",
    "synthetic-claim-token",
  ],
  sql: `update due_work
    set state = 'leased', claim_token = ?, claim_expires_at = ?, claimed_by = ?, updated_at = ?
    where (work_kind, subject_type, subject_id) in (
      select work_kind, subject_type, subject_id from due_work
      where work_kind = ? and state = 'ready'
      order by sort_key, subject_id
      limit ?
    )
    and not exists (
      select 1 from due_work scheduled_due
      where scheduled_due.work_kind = ? and scheduled_due.state = 'scheduled'
        and scheduled_due.next_due_at <= ?
    )
    and not exists (
      select 1 from due_work existing_claim
      where existing_claim.work_kind = ? and existing_claim.state = 'leased'
        and existing_claim.claimed_by = ? and existing_claim.claim_token = ?
    )`,
};

const DUE_WORK_PROMOTE = {
  args: [
    "2099-01-01T00:00:00.000Z",
    "youtube-provenance-findings",
    "2099-01-01T00:00:00.000Z",
    500,
  ],
  sql: `update due_work set state = 'ready', updated_at = ?
    where (work_kind, subject_type, subject_id) in (
      select work_kind, subject_type, subject_id from due_work
      where work_kind = ? and state = 'scheduled' and next_due_at <= ?
      order by next_due_at, subject_id limit ?
    )`,
};

const DUE_WORK_REAP = {
  args: [
    "2099-01-01T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z",
    "youtube-provenance-findings",
    "2099-01-01T00:00:00.000Z",
    500,
  ],
  sql: `update due_work
    set state = case when next_due_at <= ? then 'ready' else 'scheduled' end,
        claim_token = null, claim_expires_at = null, claimed_by = null, updated_at = ?
    where (work_kind, subject_type, subject_id) in (
      select work_kind, subject_type, subject_id from due_work
      where state = 'leased' and work_kind = ? and claim_expires_at <= ?
      order by claim_expires_at, work_kind, subject_id limit ?
    )`,
};

export const DUE_WORK_PERFORMANCE_CLAIM_RESULT = {
  args: ["youtube-provenance-findings", "synthetic-worker", "synthetic-claim-token"],
  sql: `select ${DUE_WORK_COLUMNS} from due_work
    where work_kind = ? and state = 'leased' and claimed_by = ? and claim_token = ?
    order by sort_key, subject_id`,
} satisfies PerformanceStatement;

const DUE_WORK_CLAIM_SENTINEL = {
  args: ["youtube-provenance-findings"],
  sql: `select subject_id from due_work
    where work_kind = ? and state = 'ready'
    order by sort_key, subject_id
    limit 1`,
};

const DUE_WORK_CLAIM_CLEANUP = {
  args: ["youtube-provenance-findings", "synthetic-worker", "synthetic-claim-token"],
  sql: `update due_work set state = 'ready', claim_token = null,
        claim_expires_at = null, claimed_by = null
        where work_kind = ? and state = 'leased' and claimed_by = ? and claim_token = ?`,
};

function dueWorkClaimRowsHaveProductionShape(rows: readonly unknown[]): boolean {
  return rows.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      DUE_WORK_COLUMN_NAMES.every((column) => Object.hasOwn(row, column)) &&
      Object.keys(row).length === DUE_WORK_COLUMN_NAMES.length,
  );
}

async function cleanupPerformanceDueWorkClaim(
  context: Parameters<PerformanceContract["execute"]>[0],
): Promise<void> {
  await context.client.execute(DUE_WORK_CLAIM_CLEANUP);
}

performanceRegistry.register({
  description: "A bounded due-work claim seeks and updates only the maintained backlog page",
  async execute(context) {
    await cleanupPerformanceDueWorkClaim(context);
    let execution: ContractExecution | undefined;
    try {
      const startedAt = context.now();
      const results = await executePerformanceBatch(context.client, [
        DUE_WORK_PROMOTE,
        DUE_WORK_REAP,
        DUE_WORK_CLAIM,
        DUE_WORK_PERFORMANCE_CLAIM_RESULT,
        DUE_WORK_CLAIM_SENTINEL,
      ]);
      const durationMs = Math.max(0, context.now() - startedAt);
      const mutation = results[2] ?? { rows: [] };
      const result = results[3] ?? { rows: [] };
      const sentinel = results[4] ?? { rows: [] };
      execution = {
        affectedRowCount: mutation.rowsAffected ?? 0,
        batchCount: 1,
        durationMs,
        invariants: { atomicityViolations: results.length === 5 ? 0 : 1 },
        metadata: {
          batchResultCount: results.length,
          claimResultColumnCount: Object.keys(result.rows[0] ?? {}).length,
          claimResultRowsHaveProductionShape: dueWorkClaimRowsHaveProductionShape(result.rows),
          measuredRequestCount: 1,
          measuredStatementCount: 5,
          readySentinelRows: sentinel.rows.length,
          transactionalBatch: true,
        },
        rawResult: result,
        resultRowCount: result.rows.length,
      };
    } finally {
      await cleanupPerformanceDueWorkClaim(context);
    }
    if (execution === undefined) {
      throw new Error("due-work claim contract did not produce an observation");
    }
    const convergence = await dueWorkConvergence(
      context,
      "youtube-provenance-findings",
      "youtube_backlog",
    );
    return {
      ...execution,
      convergence,
    };
  },
  id: "fixture.due-work-claim",
  iterations: 20,
  plan: {
    policy: {
      forbidTempSort: true,
      growingTables: ["due_work"],
      requiredDetails: [/due_work_claim_idx/i, /due_work_ready_idx/i, /due_work_scheduled_idx/i],
    },
    statement: DUE_WORK_CLAIM,
  },
  validate(execution) {
    const failures: string[] = [];
    if (execution.affectedRowCount !== 25) {
      failures.push(`due-work claim affected ${execution.affectedRowCount ?? 0} rows, expected 25`);
    }
    if (execution.resultRowCount !== 25) {
      failures.push(`bounded due-work claim returned ${execution.resultRowCount} rows`);
    }
    if (execution.metadata?.batchResultCount !== 5) {
      failures.push("transactional due-work claim did not return all five statement results");
    }
    if (execution.metadata?.readySentinelRows !== 1) {
      failures.push("due-work claim did not retain one ready sentinel row");
    }
    if (
      execution.metadata?.claimResultColumnCount !== DUE_WORK_COLUMN_NAMES.length ||
      execution.metadata?.claimResultRowsHaveProductionShape !== true
    ) {
      failures.push("due-work claim result did not match the production row shape");
    }

    return failures;
  },
  warmupIterations: 2,
  workClass: "queue",
});

performanceRegistry.register(
  sqlContract({
    convergence: (context) =>
      dueWorkConvergence(context, "youtube-provenance-findings", "youtube_backlog"),
    description: "A bounded due-work ready read seeks the maintained backlog index",
    id: "fixture.due-work-ready",
    iterations: 20,
    plan: {
      policy: {
        forbidTempSort: true,
        growingTables: ["due_work"],
        requiredDetails: [/due_work_ready_idx/i],
      },
      statement: DUE_WORK_READY_READ,
    },
    statement: DUE_WORK_READY_READ,
    validate(execution) {
      return execution.resultRowCount === 25
        ? []
        : [`bounded due-work read returned ${execution.resultRowCount} rows`];
    },
    warmupIterations: 2,
    workClass: "queue",
  }),
);

const DUE_WORK_EMPTY_READ = {
  args: ["analyze-findings", 1],
  sql: `select subject_id from due_work
    where work_kind = ? and state = 'ready'
    order by sort_key, subject_id
    limit ?`,
};

performanceRegistry.register(
  sqlContract({
    convergence: (context) =>
      dueWorkConvergence(context, "analyze-findings", "full_analysis_backlog"),
    description: "An empty due-work probe seeks the same ready index without a source scan",
    id: "fixture.due-work-ready-empty",
    iterations: 20,
    plan: {
      policy: {
        forbidTempSort: true,
        growingTables: ["due_work"],
        requiredDetails: [/due_work_ready_idx/i],
      },
      statement: DUE_WORK_EMPTY_READ,
    },
    statement: DUE_WORK_EMPTY_READ,
    validate(execution) {
      return execution.resultRowCount === 0
        ? []
        : [`empty due-work read returned ${execution.resultRowCount} rows`];
    },
    warmupIterations: 2,
    workClass: "queue",
  }),
);

registerContractD(performanceRegistry);
registerFinalProofContracts(performanceRegistry);
registerIndexEvidenceContracts(performanceRegistry);

async function executeMixedLoadContract(): Promise<ContractExecution> {
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
}

function validateMixedLoadContract(): readonly string[] {
  return simulateMixedLoad({ bounds: DATABASE_CLIENT_BOUNDS }).violations;
}

for (const contract of [
  {
    description: "Held heavy reader, public reads, and serialized batches honor per-client bounds",
    id: "client.mixed-load",
    workClass: "route-db" as const,
  },
  {
    description: "Mixed-client public reads remain within the end-to-end latency budget",
    id: "client.mixed-load-e2e",
    workClass: "route-e2e" as const,
  },
]) {
  performanceRegistry.register({
    ...contract,
    execute: executeMixedLoadContract,
    iterations: 20,
    validate: validateMixedLoadContract,
  });
}

export function selectPerformanceContracts(ids: readonly string[]) {
  if (ids.length === 0) {
    return performanceRegistry.list();
  }

  return [...new Set(ids)].map((id) => performanceRegistry.get(id));
}
