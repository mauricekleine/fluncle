import {
  claimCrawlDueWork,
  fanOutCrawlProjectionRepairs,
  markCrawlNodeRepairStatement,
  MAX_CRAWL_DUE_CHUNK_SIZE,
  promoteCrawlDueWork,
  repairCrawlDueNodes,
  type CrawlDueClient,
} from "./crawl-due-work";
import { getSetting } from "./settings";

/** The crawler's claiming-reader flag. Only the exact string `true` opens the cutover. */
export const CRAWL_DUE_CUTOVER_ENABLED_KEY = "crawl_due_cutover_enabled";

/** One pass is clamped to five minutes at the HTTP surface; the lease clears that whole window. */
export const CRAWL_CATALOGUE_LEASE_MS = 10 * 60 * 1000;
export const CRAWL_CATALOGUE_CLAIM_OWNER = "crawl-catalogue";

export type ClaimedCrawlFrontierRow = {
  cursor: number;
  done_at: string | null;
  external_id: string;
  failures: number;
  hop: number;
  id: string;
  kind: "artist" | "label" | "release";
  label_slug: string | null;
  source: "fluncle" | "musicbrainz";
};

export type ClaimedCrawlFrontierPage = {
  artistsRearmed: number;
  claimToken: string;
  rows: ClaimedCrawlFrontierRow[];
};

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
    (row["kind"] !== "artist" && row["kind"] !== "label" && row["kind"] !== "release") ||
    (row["source"] !== "fluncle" && row["source"] !== "musicbrainz") ||
    typeof row["external_id"] !== "string"
  ) {
    return undefined;
  }
  return {
    cursor: Number(row["cursor"]),
    done_at: (row["done_at"] as null | string) ?? null,
    external_id: row["external_id"],
    failures: Number(row["failures"]),
    hop: Number(row["hop"]),
    id: row["id"],
    kind: row["kind"],
    label_slug: (row["label_slug"] as null | string) ?? null,
    source: row["source"],
  };
}

/** Repair only bounded marker pages, then claim and PK-hydrate exactly the ordered claimed IDs. */
export async function claimCrawlFrontierRows(
  client: CrawlDueClient,
  options: {
    claimedBy: string;
    leaseMs: number;
    limit: number;
    token: string;
  },
): Promise<ClaimedCrawlFrontierPage> {
  let fanoutBudget = MAX_CRAWL_DUE_CHUNK_SIZE;
  while (fanoutBudget > 0) {
    const fanout = await fanOutCrawlProjectionRepairs(client, { limit: fanoutBudget });
    if (fanout.marker === undefined) {
      break;
    }
    fanoutBudget -= Math.max(fanout.expanded, 1);
    if (!fanout.complete) {
      throw new Error("crawl due-work source repair remains after the bounded maintenance pass");
    }
  }
  const repaired = await repairCrawlDueNodes(client, { limit: MAX_CRAWL_DUE_CHUNK_SIZE });
  if (repaired.hasMore) {
    throw new Error("crawl due-work node repair remains after the bounded maintenance pass");
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

  const claim = await claimCrawlDueWork(client, options);
  const ids = claim.items.map((item) => item.nodeId);
  if (ids.length === 0) {
    return {
      artistsRearmed: claim.artistsRearmed,
      claimToken: claim.claimToken,
      rows: [],
    };
  }

  const hydrated = await client.execute({
    args: ids,
    sql: `select id, kind, source, external_id, hop, cursor, failures, label_slug, done_at
      from crawl_frontier
      where id in (${ids.map(() => "?").join(", ")})`,
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
