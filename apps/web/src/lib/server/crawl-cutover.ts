import {
  claimCrawlDueWork,
  CRAWL_REPAIR_MARKER_BUDGET,
  fanOutCrawlProjectionRepairs,
  markCrawlNodeRepairStatement,
  MAX_CRAWL_DUE_CHUNK_SIZE,
  promoteCrawlDueWork,
  repairCrawlDueNodes,
  type CrawlDueClient,
} from "./crawl-due-work";
import { DueWorkMaintenancePendingError } from "./due-work";
import { getSetting } from "./settings";

/** The crawler's claiming-reader flag. Only the exact string `true` opens the cutover. */
export const CRAWL_DUE_CUTOVER_ENABLED_KEY = "crawl_due_cutover_enabled";

/** One pass is clamped to five minutes at the HTTP surface; the lease clears that whole window. */
export const CRAWL_CATALOGUE_LEASE_MS = 10 * 60 * 1000;
export const CRAWL_CATALOGUE_CLAIM_OWNER = "crawl-catalogue";

export type ClaimedCrawlFrontierRow = {
  claim_expires_at: string;
  cursor: number;
  done_at: string | null;
  external_id: string;
  failures: number;
  hop: number;
  id: string;
  kind: "artist" | "label" | "release";
  label_slug: string | null;
  source: "fluncle" | "musicbrainz";
  source_version: string;
  updated_at: string;
};

export type ClaimedCrawlFrontierPage = {
  artistsRearmed: number;
  claimToken: string;
  rows: ClaimedCrawlFrontierRow[];
};

/** The queue name the crawl claim's typed pending answer carries into the server log. */
const CRAWL_CLAIM_REPAIR_WORK_KIND = "crawl-due-work";

export type CrawlClaimRepairDrainBudget = {
  /** Repair markers one node chunk may repair. */
  nodeChunkRows: number;
  /** Node repair chunks one claim may start. */
  nodeChunks: number;
  /** Due rows one source-repair page may fan out. */
  sourcePageRows: number;
  /** Source markers one source-repair page may clear while none of them expands a row. */
  sourcePageMarkers: number;
  /** Source-repair pages one claim may start. */
  sourcePages: number;
  /** Cumulative drain time after which no further page or chunk starts. */
  wallMs: number;
};

/**
 * The crawl repair one claim may drain before it answers `due_work_maintenance_pending` instead of
 * claiming. The first page and the first chunk always run, so a deferred claim has still converged
 * the repair its budget allowed and the next tick starts from that durable progress. The budget
 * multiplies bounded transactions and never enlarges one: a unit stays the chunk bound every other
 * crawl maintenance step already runs at, committing as its own guarded write batch. Hosted, a
 * page's write batch dominates its cost, so the wall bound is the one that binds and the unit caps
 * bound the transactions one claim can issue against a fast database. The claim runs inside an
 * admitted phase clamped to five minutes at the HTTP surface: the drain takes a small slice of that
 * window and leaves the rest for the paced provider work the phase was admitted for.
 */
export const CRAWL_CLAIM_REPAIR_DRAIN_BUDGET: Readonly<CrawlClaimRepairDrainBudget> = {
  nodeChunkRows: MAX_CRAWL_DUE_CHUNK_SIZE,
  nodeChunks: 4,
  sourcePageMarkers: CRAWL_REPAIR_MARKER_BUDGET,
  sourcePageRows: MAX_CRAWL_DUE_CHUNK_SIZE,
  sourcePages: 4,
  wallMs: 5_000,
};

/**
 * SOURCE MARKERS ONE CLAIM MAY CLEAR — the capacity side of the admission invariant.
 *
 * Every tick runs its admission phase and THEN this claim, and the admission phase mints source
 * repair markers of its own. A claim that cannot clear every marker its own tick minted defers with
 * `due_work_maintenance_pending` forever: the next tick mints the same number again, so the crawl
 * stops claiming rows entirely. The capacity therefore has to exceed the mint bound with margin,
 * and `crawl.ts` asserts exactly that against {@link CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND}.
 */
export const CRAWL_CLAIM_SOURCE_MARKER_DRAIN_CAPACITY =
  CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.sourcePages * CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.sourcePageMarkers;

export async function isCrawlDueCutoverEnabled(): Promise<boolean> {
  try {
    return (await getSetting(CRAWL_DUE_CUTOVER_ENABLED_KEY)) === "true";
  } catch {
    return false;
  }
}

function frontierRow(row: Record<string, unknown>): ClaimedCrawlFrontierRow | undefined {
  if (
    typeof row["id"] !== "string" ||
    typeof row["claim_expires_at"] !== "string" ||
    (row["kind"] !== "artist" && row["kind"] !== "label" && row["kind"] !== "release") ||
    (row["source"] !== "fluncle" && row["source"] !== "musicbrainz") ||
    typeof row["external_id"] !== "string" ||
    typeof row["source_version"] !== "string" ||
    typeof row["updated_at"] !== "string"
  ) {
    return undefined;
  }
  return {
    claim_expires_at: row["claim_expires_at"],
    cursor: Number(row["cursor"]),
    done_at: (row["done_at"] as null | string) ?? null,
    external_id: row["external_id"],
    failures: Number(row["failures"]),
    hop: Number(row["hop"]),
    id: row["id"],
    kind: row["kind"],
    label_slug: (row["label_slug"] as null | string) ?? null,
    source: row["source"],
    source_version: row["source_version"],
    updated_at: row["updated_at"],
  };
}

/**
 * Repair only bounded marker pages, then claim and PK-hydrate exactly the ordered claimed IDs.
 * Both repair lanes drain under {@link CRAWL_CLAIM_REPAIR_DRAIN_BUDGET}: a source marker wider than
 * one page is the ordinary shape, not a fault, so the pages keep going until the markers are gone
 * or the budget stops them. Repair that outlasts the budget is designed backpressure — the claim
 * answers the typed `due_work_maintenance_pending` 503 that the crawl sweep reports as a paused
 * tick, never a fault that fails the sweep and leaves the frontier unclaimed.
 */
export async function claimCrawlFrontierRows(
  client: CrawlDueClient,
  options: {
    budget?: CrawlClaimRepairDrainBudget;
    claimedBy: string;
    leaseMs: number;
    limit: number;
    now?: () => number;
    token: string;
  },
): Promise<ClaimedCrawlFrontierPage> {
  const budget = options.budget ?? CRAWL_CLAIM_REPAIR_DRAIN_BUDGET;
  const now = options.now ?? (() => performance.now());
  let spentMs = 0;
  let sourcePages = 0;
  let nodeChunks = 0;
  const timed = async <Result>(unit: () => Promise<Result>): Promise<Result> => {
    const startedAt = now();
    try {
      return await unit();
    } finally {
      spentMs += now() - startedAt;
    }
  };
  const mayStart = (started: number, cap: number): boolean =>
    started < cap && spentMs < budget.wallMs;
  // A page's own marker run is wall-bounded too: `spentMs` only advances once the page returns, so
  // the page carries the remaining wall budget in with it and stops clearing markers when it is out.
  const drainSourcePage = () => {
    sourcePages += 1;
    const startedAt = now();
    const remainingMs = budget.wallMs - spentMs;
    return timed(() =>
      fanOutCrawlProjectionRepairs(client, {
        limit: budget.sourcePageRows,
        markerBudget: budget.sourcePageMarkers,
        mayContinue: () => now() - startedAt < remainingMs,
      }),
    );
  };
  const drainNodeChunk = () => {
    nodeChunks += 1;
    return timed(() => repairCrawlDueNodes(client, { limit: budget.nodeChunkRows }));
  };

  let source = await drainSourcePage();
  while (source.marker !== undefined && mayStart(sourcePages, budget.sourcePages)) {
    source = await drainSourcePage();
  }
  // Node repair defers while any source marker still stands, so the node lane is also the source
  // lane's convergence probe: its first chunk always runs, and further chunks start only once a page
  // has found no marker left to fan out.
  const sourceConverged = source.marker === undefined;
  let nodes = await drainNodeChunk();
  while (sourceConverged && nodes.hasMore && mayStart(nodeChunks, budget.nodeChunks)) {
    nodes = await drainNodeChunk();
  }
  if (!sourceConverged || nodes.hasMore) {
    throw new DueWorkMaintenancePendingError(CRAWL_CLAIM_REPAIR_WORK_KIND);
  }

  if (options.limit === 0) {
    const promotion = await promoteCrawlDueWork(client, {
      limit: MAX_CRAWL_DUE_CHUNK_SIZE,
    });
    return {
      artistsRearmed: promotion.artistsRearmed,
      claimToken: options.token,
      rows: [],
    };
  }

  const claim = await claimCrawlDueWork(client, {
    claimedBy: options.claimedBy,
    leaseMs: options.leaseMs,
    limit: options.limit,
    token: options.token,
  });
  const ids = claim.items.map((item) => item.nodeId);
  if (ids.length === 0) {
    return {
      artistsRearmed: claim.artistsRearmed,
      claimToken: claim.claimToken,
      rows: [],
    };
  }

  const hydrated = await client.execute({
    args: [...ids, claim.claimToken],
    sql: `select frontier.id, frontier.kind, frontier.source, frontier.external_id, frontier.hop,
        frontier.cursor, frontier.failures, frontier.label_slug, frontier.done_at,
        frontier.updated_at, due.source_version, due.claim_expires_at
      from crawl_frontier frontier
      join crawl_due_work due on due.node_id = frontier.id
      where frontier.id in (${ids.map(() => "?").join(", ")})
        and due.state = 'leased' and due.claim_token = ?`,
  });
  const byId = new Map<string, ClaimedCrawlFrontierRow>();
  for (const candidate of hydrated.rows) {
    const row = frontierRow(candidate);
    if (row !== undefined) {
      byId.set(row.id, row);
    }
  }
  return {
    artistsRearmed: claim.artistsRearmed,
    claimToken: claim.claimToken,
    rows: ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    }),
  };
}

/** The exact durable claim + source snapshot fence checked before a provider result may write. */
export async function isClaimedCrawlFrontierRowCurrent(
  client: CrawlDueClient,
  row: ClaimedCrawlFrontierRow,
  claimToken: string,
): Promise<boolean> {
  const result = await client.execute({
    args: [
      row.id,
      claimToken,
      row.source_version,
      row.claim_expires_at,
      new Date().toISOString(),
      row.kind,
      row.source,
      row.external_id,
      row.hop,
      row.cursor,
      row.failures,
      row.label_slug,
      row.done_at,
      row.updated_at,
    ],
    sql: `select 1
      from crawl_due_work due
      join crawl_frontier frontier on frontier.id = due.node_id
      where due.node_id = ? and due.state = 'leased' and due.claim_token = ?
        and due.source_version = ? and due.claim_expires_at = ? and due.claim_expires_at > ?
        and frontier.kind = ? and frontier.source = ? and frontier.external_id = ?
        and frontier.hop = ? and frontier.cursor = ? and frontier.failures = ?
        and frontier.label_slug is ? and frontier.done_at is ? and frontier.updated_at = ?
      limit 1`,
  });
  return result.rows.length === 1;
}

/**
 * Settle one claimed source row and replace only that exact lease with its repair marker. The
 * second statement's affected row is the ownership verdict; the final `changes()` guard makes a
 * stale token incapable of appending work.
 */
export async function settleClaimedCrawlFrontierRow(
  client: CrawlDueClient,
  options: {
    claimToken: string;
    cursor?: number;
    failures?: number;
    id: string;
    note?: string;
    state: "done" | "failed" | "pending" | "skipped";
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await client.batch(
    [
      {
        args: [
          options.state,
          options.state,
          options.state === "done" ? now : null,
          options.state,
          options.cursor ?? 0,
          options.failures ?? 0,
          options.note ?? null,
          now,
          now,
          options.id,
          options.id,
          options.claimToken,
        ],
        sql: `update crawl_frontier
          set state = ?1,
              done_at = case
                when ?2 = 'done' then ?3
                when ?4 in ('pending', 'failed') and done_at is not null then done_at
                else null
              end,
              cursor = ?5, failures = ?6, note = ?7,
              attempts = attempts + 1, attempted_at = ?8, updated_at = ?9
          where id = ?10 and exists (
            select 1 from crawl_due_work
            where node_id = ?11 and state = 'leased' and claim_token = ?12
          )`,
      },
      {
        args: [options.id, options.claimToken],
        sql: `delete from crawl_due_work
          where node_id = ? and state = 'leased' and claim_token = ?
            and changes() > 0`,
      },
      markCrawlNodeRepairStatement(options.id, `crawl-settle:${crypto.randomUUID()}`, {
        now,
        onlyIfPreviousStatementChanged: true,
      }),
    ],
    "write",
  );
  return (results[1]?.rowsAffected ?? 0) > 0;
}
