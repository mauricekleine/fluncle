#!/usr/bin/env bun
/**
 * Resume and audit the crawl/public shadow projections against a configured local database.
 * Importing this file is inert; direct invocation refuses hosted and non-loopback URLs before the
 * application client is opened.
 */
import { getDb } from "../src/lib/server/db";
import {
  auditCrawlDueWork,
  fanOutCrawlProjectionRepairs,
  rebuildCrawlDueWork,
  repairCrawlDueNodes,
  shadowCrawlDueWork,
  type CrawlDueClient,
} from "../src/lib/server/crawl-due-work";
import { loadLocalEnv, readEnv } from "../src/lib/server/env";
import {
  auditPublicProjections,
  rebuildDefaultTrackHubAnchors,
  rebuildPublicProjection,
  repairPublicProjectionChunk,
  shadowPublicProjections,
  type PublicProjectionClient,
} from "../src/lib/server/public-projections";

type ShadowProjectionClient = CrawlDueClient & PublicProjectionClient;

export function isLocalShadowProjectionDatabaseUrl(url: string): boolean {
  return (
    url === ":memory:" ||
    url.startsWith("file:") ||
    /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(url)
  );
}

export async function backfillShadowProjections(
  client: ShadowProjectionClient,
  options: {
    auditOnly?: boolean;
    limit?: number;
    newGeneration?: boolean;
    repairLimit?: number;
  } = {},
): Promise<{
  artistMatched: boolean;
  crawlMatched: boolean;
  publicAggregatesMatched: boolean;
  rebuilt: number;
  repaired: number;
  scheduled: number;
  shadowMatched: boolean;
}> {
  const limit = options.limit ?? 100;
  let rebuilt = 0;

  if (options.auditOnly !== true) {
    await rebuildCrawlDueWork(client, {
      limit,
      newGeneration: options.newGeneration,
    });
    rebuilt += 1;
    await rebuildPublicProjection(client, "public_aggregates", {
      limit,
      newGeneration: options.newGeneration,
    });
    rebuilt += 1;
    await rebuildPublicProjection(client, "artist_qualification", {
      limit,
      newGeneration: options.newGeneration,
    });
    rebuilt += 1;
    await rebuildDefaultTrackHubAnchors(client);
  }

  const repairLimit = options.repairLimit ?? 0;
  const crawlAudit = await auditCrawlDueWork(client, { repairLimit });
  const publicAudit = await auditPublicProjections(client, { repairLimit });
  const scheduled =
    crawlAudit.repairNodeIds.length +
    publicAudit.scheduledArtistRepairs.length +
    publicAudit.scheduledTrackRepairs.length;
  let repaired = 0;
  if (repairLimit > 0) {
    await fanOutCrawlProjectionRepairs(client, { limit: repairLimit });
    repaired += (await repairCrawlDueNodes(client, { limit: repairLimit })).repaired;
    repaired += (await repairPublicProjectionChunk(client, { limit: repairLimit })).repaired;
  }
  const crawl = repairLimit > 0 ? await auditCrawlDueWork(client) : crawlAudit;
  const finalPublicAudit = repairLimit > 0 ? await auditPublicProjections(client) : publicAudit;
  const [crawlShadow, publicShadow] = await Promise.all([
    shadowCrawlDueWork(client, { limit }),
    shadowPublicProjections(client),
  ]);
  return {
    artistMatched: finalPublicAudit.artistMatched && publicShadow.qualifiedArtistsMatched,
    crawlMatched: crawl.matched && crawlShadow.matched,
    publicAggregatesMatched:
      finalPublicAudit.aggregatesMatched &&
      publicShadow.aggregateBucketsMatched &&
      publicShadow.defaultTotalMatched &&
      publicShadow.anchorOrderMatched &&
      publicShadow.anchorEpochMatched,
    rebuilt,
    repaired,
    scheduled,
    shadowMatched: crawlShadow.matched && publicShadow.matched,
  };
}

function numberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be followed by a non-negative integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  await loadLocalEnv({ force: true });
  const url = await readEnv("TURSO_DATABASE_URL");
  if (!isLocalShadowProjectionDatabaseUrl(url)) {
    throw new Error("shadow projection backfill only accepts a configured local database URL");
  }
  const client = await getDb();
  try {
    const limit = numberFlag("--limit", 100);
    if (limit < 1) {
      throw new Error("--limit must be followed by a positive integer");
    }
    const result = await backfillShadowProjections(client, {
      auditOnly: process.argv.includes("--audit-only"),
      limit,
      newGeneration: process.argv.includes("--new-generation"),
      repairLimit: numberFlag("--repair-limit", 0),
    });
    console.log(JSON.stringify(result));
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}
