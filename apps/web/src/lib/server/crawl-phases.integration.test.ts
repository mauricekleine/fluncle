import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIntegrationDb } from "./integration-db";
import { markCrawlNodeRepairStatement, rebuildCrawlDueWork } from "./crawl-due-work";
import {
  crawlCatalogue as crawlCatalogueContract,
  MAX_CRAWL_PREPARE_LIMIT,
} from "@fluncle/contracts/orpc";

import {
  commitCrawlNodes,
  commitCrawlPhase,
  CRAWL_PHASE_TOKEN_MAX_BYTES,
  type CrawlPhasePrepareResult,
  crawlCatalogue as runCrawlCatalogue,
  fetchCrawlPhase,
  initializeCrawlPhase,
  prepareCrawlPhase,
  settleGloballyBlockedFrontier,
} from "./crawl";
import { CRAWL_BOX_FETCH_ENABLED_KEY, CRAWL_DUE_CUTOVER_ENABLED_KEY } from "./crawl-cutover";
import { resolveCrawlHold } from "./crawl-plausibility";
import { setMusicbrainzRateLimitForTests } from "./musicbrainz";
import { mergeLabel } from "./labels";

let db: Client;
let fixtureDirectory: string | undefined;
const timestamp = "2026-08-01T00:00:00.000Z";
const crawlInputSchema = crawlCatalogueContract["~orpc"].inputSchema;
const crawlOutputSchema = crawlCatalogueContract["~orpc"].outputSchema;
if (!crawlInputSchema || !crawlOutputSchema) {
  throw new Error("crawl catalogue contract schema is missing");
}

type TransactionCounts = {
  batch: number;
  commit: number;
  execute: number;
  maxBatchStatements: number;
  statements: unknown[];
};

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: async () => db };
});

function providerRelease(trackCount: number, titleBytes = 0): object {
  return providerReleaseWithArtistCount(trackCount, titleBytes, trackCount);
}

function providerReleaseWithArtistCount(
  trackCount: number,
  titleBytes = 0,
  artistCount = trackCount,
): object {
  const tracks = Array.from({ length: trackCount }, (_, index) => ({
    recording: {
      "artist-credit": [
        {
          artist: {
            id: `artist-${index % artistCount}`,
            name: `Artist ${index % artistCount}`,
          },
        },
      ],
      id: `recording-${index}`,
      isrcs: [],
      length: 180_000,
      title: titleBytes > 0 ? `${index}-${"x".repeat(titleBytes)}` : `Track ${index}`,
    },
  }));
  return {
    id: "release-phase",
    "label-info": [{ label: { id: "label-phase-mbid", name: "Phase Label" } }],
    media: [
      { tracks: tracks.slice(0, Math.ceil(trackCount / 3)) },
      { tracks: tracks.slice(Math.ceil(trackCount / 3), Math.ceil((trackCount * 2) / 3)) },
      { tracks: tracks.slice(Math.ceil((trackCount * 2) / 3)) },
    ],
    relations: [],
    "release-group": { id: "release-group-phase" },
    title: "Phase Album",
  };
}

function providerBatchRelease(
  id: string | undefined,
  label: { id?: string; name: string },
): object {
  return {
    ...providerRelease(1),
    id,
    "label-info": [{ label }],
    media: [
      {
        tracks: [
          {
            recording: {
              "artist-credit": [{ artist: { id: "artist-0", name: "Artist 0" } }],
              id: `recording-${id}`,
              length: 180_000,
              title: `Track ${id}`,
            },
          },
        ],
      },
    ],
  };
}

function providerBrowse(childCount: number): object {
  return {
    "release-count": childCount,
    releases: Array.from({ length: childCount }, (_, index) => ({
      id: `browse-release-${index}`,
      status: "Official",
    })),
  };
}

function instrumentTransactions(client: Client): { client: Client; counts: TransactionCounts } {
  const counts: TransactionCounts = {
    batch: 0,
    commit: 0,
    execute: 0,
    maxBatchStatements: 0,
    statements: [],
  };
  const originalTransaction = client.transaction.bind(client);
  client.transaction = (async (...args: Parameters<Client["transaction"]>) => {
    const transaction = await originalTransaction(...args);
    const originalExecute = transaction.execute.bind(transaction);
    const originalBatch = transaction.batch.bind(transaction);
    const originalCommit = transaction.commit.bind(transaction);
    transaction.execute = ((...executeArgs: Parameters<typeof transaction.execute>) => {
      counts.execute += 1;
      counts.statements.push(executeArgs[0]);
      return originalExecute(...executeArgs);
    }) as typeof transaction.execute;
    transaction.batch = ((...batchArgs: Parameters<typeof transaction.batch>) => {
      counts.batch += 1;
      const statements = batchArgs[0];
      counts.statements.push(...statements);
      counts.maxBatchStatements = Math.max(counts.maxBatchStatements, statements.length);
      return originalBatch(...batchArgs);
    }) as typeof transaction.batch;
    transaction.commit = (async (...commitArgs: Parameters<typeof transaction.commit>) => {
      counts.commit += 1;
      return originalCommit(...commitArgs);
    }) as typeof transaction.commit;
    return transaction;
  }) as Client["transaction"];
  return { client, counts };
}

function executedSql(statement: unknown): string {
  if (typeof statement === "string") {
    return statement;
  }
  if (typeof statement === "object" && statement !== null && "sql" in statement) {
    return typeof statement.sql === "string" ? statement.sql : "";
  }
  return "";
}

async function seedRelease(): Promise<void> {
  await db.execute({
    args: [CRAWL_DUE_CUTOVER_ENABLED_KEY, "true"],
    sql: "insert into settings (key, value) values (?, ?)",
  });
  await db.execute({
    args: [timestamp, timestamp],
    sql: `insert into labels
      (id, name, slug, seed_state, mb_label_id, created_at, updated_at)
      values ('label-phase', 'Phase Label', 'phase-label', 'enabled', 'label-phase-mbid', ?, ?)`,
  });
  await db.execute({
    args: [timestamp, timestamp],
    sql: `insert into crawl_frontier
      (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
      values ('musicbrainz:release:release-phase', 'release', 'musicbrainz',
        'release-phase', 0, 'phase-label', ?, ?)`,
  });
  await rebuildCrawlDueWork(db, { generation: crypto.randomUUID(), limit: 10 });
}

async function seedBrowseNode(): Promise<void> {
  await db.execute("delete from crawl_due_work");
  await db.execute("delete from crawl_frontier");
  await db.execute({
    args: [timestamp, timestamp],
    sql: `insert into crawl_frontier
      (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
      values ('musicbrainz:artist:browse-artist', 'artist', 'musicbrainz',
        'browse-artist', 0, 'phase-label', ?, ?)`,
  });
  await db.batch(
    [markCrawlNodeRepairStatement("musicbrainz:artist:browse-artist", crypto.randomUUID())],
    "write",
  );
}

async function prepareAndFetch(): Promise<Awaited<ReturnType<typeof fetchCrawlPhase>>> {
  const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
  expect(prepared.kind).toBe("prepared");
  const item = prepared.items[0];
  if (!item) {
    throw new Error("test expected a prepared crawl token");
  }
  return fetchCrawlPhase(item.preparedToken);
}

beforeEach(async () => {
  process.env.ADMIN_SESSION_SECRET = "crawl-phase-test-secret";
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-crawl-phase-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  setMusicbrainzRateLimitForTests(0);
  await seedRelease();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("crawl admission phases", () => {
  it("settles a globally blocked artist browse without fetching MusicBrainz", async () => {
    await seedBrowseNode();
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into artist_rules
        (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
        values ('rule-blocked', 'browse-artist', 'Blocked', 'block', 'operator', ?, ?)`,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareCrawlPhase({ limit: 1 });
    expect(prepared.items[0]?.fetchPlan).toEqual({ kind: "none" });
    await commitCrawlPhase(await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? ""));
    const node = await db.execute(`select state, note from crawl_frontier
      where id = 'musicbrainz:artist:browse-artist'`);
    expect(node.rows[0]).toMatchObject({ note: "global artist block", state: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();

    await db.execute("delete from artist_rules where id = 'rule-blocked'");
    await db.execute("update labels set seed_state = 'disabled'");
    await initializeCrawlPhase();
    const rearmed = await prepareCrawlPhase({ limit: 1 });
    expect(rearmed.items[0]?.fetchPlan.kind).toBe("single");
  });

  it("settles releases under a globally blocked artist and rechecks the rule at commit", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, created_at, updated_at)
        values ('musicbrainz:artist:blocked-parent', 'artist', 'musicbrainz',
          'blocked-parent', 1, ?, ?)`,
    });
    await db.execute(`update crawl_frontier set hop = 2,
      parent_id = 'musicbrainz:artist:blocked-parent' where external_id = 'release-phase'`);
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into artist_rules
        (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
        values ('rule-blocked', 'blocked-parent', 'Blocked', 'block', 'operator', ?, ?)`,
    });
    const prepared = await prepareCrawlPhase({ limit: 1 });
    expect(prepared.items[0]?.fetchPlan).toEqual({ kind: "none" });
    await db.execute("delete from artist_rules where id = 'rule-blocked'");
    await commitCrawlPhase(await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? ""));
    const node = await db.execute(`select state, note from crawl_frontier
      where external_id = 'release-phase'`);
    expect(node.rows[0]).toMatchObject({
      note: "artist rule changed before skip",
      state: "pending",
    });
    const next = await prepareCrawlPhase({ limit: 1 });
    expect(next.items[0]?.fetchPlan.kind).toBe("single");
  });

  it("settles a blocked parent's release without fetching details", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, created_at, updated_at)
        values ('musicbrainz:artist:blocked-parent', 'artist', 'musicbrainz',
          'blocked-parent', 1, ?, ?)`,
    });
    await db.execute(`update crawl_frontier set hop = 2,
      parent_id = 'musicbrainz:artist:blocked-parent' where external_id = 'release-phase'`);
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into artist_rules
        (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
        values ('rule-blocked', 'blocked-parent', 'Blocked', 'block', 'operator', ?, ?)`,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareCrawlPhase({ limit: 1 });
    expect(prepared.items[0]?.fetchPlan).toEqual({ kind: "none" });
    await commitCrawlPhase(await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? ""));

    const release = await db.execute(`select state, note from crawl_frontier
      where external_id = 'release-phase'`);
    expect(release.rows[0]).toMatchObject({
      note: "global parent artist block",
      state: "skipped",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await db.execute("delete from artist_rules where id = 'rule-blocked'");
    await db.execute("update labels set seed_state = 'disabled'");
    await initializeCrawlPhase();
    const rearmed = await prepareCrawlPhase({ limit: 1 });
    expect(rearmed.items[0]?.fetchPlan.kind).toBe("single");
  });

  it("reads the global artist block once for a whole prepared batch", async () => {
    await db.execute({
      args: [timestamp, timestamp, timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, created_at, updated_at)
        values ('musicbrainz:artist:blocked-parent', 'artist', 'musicbrainz',
          'blocked-parent', 1, ?, ?),
          ('musicbrainz:artist:free-artist', 'artist', 'musicbrainz', 'free-artist', 1, ?, ?)`,
    });
    await db.execute(`update crawl_frontier set hop = 2,
      parent_id = 'musicbrainz:artist:blocked-parent' where external_id = 'release-phase'`);
    await db.batch(
      [
        markCrawlNodeRepairStatement("musicbrainz:artist:blocked-parent", crypto.randomUUID()),
        markCrawlNodeRepairStatement("musicbrainz:artist:free-artist", crypto.randomUUID()),
      ],
      "write",
    );
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into artist_rules
        (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
        values ('rule-blocked', 'blocked-parent', 'Blocked', 'block', 'operator', ?, ?)`,
    });
    const execute = vi.spyOn(db, "execute");

    const prepared = await prepareCrawlPhase({ limit: MAX_CRAWL_PREPARE_LIMIT, maxHop: 2 });

    const plans = Object.fromEntries(
      prepared.items.map((item) => [item.nodeId, item.fetchPlan.kind]),
    );
    expect(plans).toEqual({
      "musicbrainz:artist:blocked-parent": "none",
      "musicbrainz:artist:free-artist": "single",
      "musicbrainz:release:release-phase": "none",
    });
    const blockReads = execute.mock.calls.filter(([statement]) =>
      /from crawl_frontier as node\s+where node\.id (?:=|in)/.test(executedSql(statement)),
    );
    expect(blockReads).toHaveLength(1);
  });

  it("settles an existing blocked backlog in bounded resumable passes", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, created_at, updated_at)
        values ('musicbrainz:artist:blocked-parent', 'artist', 'musicbrainz',
          'blocked-parent', 1, ?, ?)`,
    });
    await db.execute(`update crawl_frontier set hop = 2,
      parent_id = 'musicbrainz:artist:blocked-parent' where external_id = 'release-phase'`);
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into artist_rules
        (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
        values ('rule-blocked', 'blocked-parent', 'Blocked', 'block', 'operator', ?, ?)`,
    });
    expect(await settleGloballyBlockedFrontier(db, 1)).toBe(1);
    expect(await settleGloballyBlockedFrontier(db, 1)).toBe(1);
    expect(await settleGloballyBlockedFrontier(db, 1)).toBe(0);
    const nodes = await db.execute(`select state, note from crawl_frontier order by id`);
    expect(nodes.rows.map((row) => row.state)).toEqual(["skipped", "skipped"]);
  });

  it.each(["allow", "block", "unlisted"] as const)(
    "keeps %s rules outside the global block gate",
    async (verdict) => {
      await seedBrowseNode();
      await db.execute({
        args: [verdict, verdict === "unlisted" ? null : "label-phase", timestamp, timestamp],
        sql: `insert into artist_rules
          (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
          values ('rule-other', 'browse-artist', 'Other', ?, ?, 'operator', ?, ?)`,
      });
      const prepared = await prepareCrawlPhase({ limit: 1 });
      expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
    },
  );

  it("keeps browsing a global block with a scoped allow that can still store tracks", async () => {
    await seedBrowseNode();
    await db.batch(
      [
        {
          args: [timestamp, timestamp],
          sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
            values ('rule-global-block', 'browse-artist', 'Blocked', 'block', 'operator', ?, ?)`,
        },
        {
          args: [timestamp, timestamp],
          sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
            values ('rule-scoped-allow', 'browse-artist', 'Blocked', 'allow',
              'label-phase', 'operator', ?, ?)`,
        },
      ],
      "write",
    );
    const prepared = await prepareCrawlPhase({ limit: 1 });
    expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
  });

  it("re-arms a skipped blocked artist at hop zero when a scoped allow is added", async () => {
    await seedBrowseNode();
    await db.execute(`update crawl_frontier
      set hop = 2, state = 'skipped', note = 'global artist block'
      where id = 'musicbrainz:artist:browse-artist'`);
    await db.execute("update labels set seed_state = 'disabled'");
    await db.batch(
      [
        {
          args: [timestamp, timestamp],
          sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
            values ('rule-global-block', 'browse-artist', 'Blocked', 'block', 'operator', ?, ?)`,
        },
        {
          args: [timestamp, timestamp],
          sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
            values ('rule-scoped-allow', 'browse-artist', 'Blocked', 'allow',
              'label-phase', 'operator', ?, ?)`,
        },
      ],
      "write",
    );

    await initializeCrawlPhase();

    const artist = await db.execute(`select hop, parent_id, state, note from crawl_frontier
      where id = 'musicbrainz:artist:browse-artist'`);
    expect(artist.rows[0]).toMatchObject({
      hop: 0,
      note: null,
      parent_id: null,
      state: "pending",
    });
    const prepared = await prepareCrawlPhase({ limit: 1 });
    expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
  });

  it("keeps a pending release when another artist discovers it", async () => {
    await seedBrowseNode();
    await db.batch(
      [
        {
          args: [timestamp, timestamp],
          sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, state, created_at, updated_at)
            values ('musicbrainz:artist:blocked-parent', 'artist', 'musicbrainz',
              'blocked-parent', 1, 'skipped', ?, ?)`,
        },
        {
          args: [timestamp, timestamp],
          sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, parent_id, state, created_at, updated_at)
            values ('musicbrainz:release:shared-release', 'release', 'musicbrainz',
              'shared-release', 2, 'musicbrainz:artist:blocked-parent', 'pending', ?, ?)`,
        },
        {
          args: [timestamp, timestamp],
          sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
            values ('rule-blocked', 'blocked-parent', 'Blocked', 'block', 'operator', ?, ?)`,
        },
      ],
      "write",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ "release-count": 1, releases: [{ id: "shared-release" }] }),
            { status: 200 },
          ),
        ),
      ),
    );

    const prepared = await prepareCrawlPhase({ limit: 1 });
    await commitCrawlPhase(await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? ""));

    const release = await db.execute(`select parent_id, state from crawl_frontier
      where id = 'musicbrainz:release:shared-release'`);
    expect(release.rows[0]).toMatchObject({
      parent_id: "musicbrainz:artist:browse-artist",
      state: "pending",
    });
  });

  it("preserves the first-prepare repair sample flag through the oRPC input contract", () => {
    const delivered = crawlInputSchema.parse({
      body: { limit: 1, maxHop: 2, phase: "prepare", sampleStorableRepair: true },
      query: {},
    });
    expect(delivered.body).toMatchObject({ phase: "prepare", sampleStorableRepair: true });
  });

  it("preserves the skip-pending-count flag through the oRPC input contract", () => {
    const delivered = crawlInputSchema.parse({
      body: { limit: 1, maxHop: 2, phase: "prepare", skipFrontierPendingCount: true },
      query: {},
    });
    expect(delivered.body).toMatchObject({ phase: "prepare", skipFrontierPendingCount: true });
  });

  it("counts the pending frontier on a prepare that does not opt out", async () => {
    const execute = vi.spyOn(db, "execute");
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    const counted = execute.mock.calls.filter(([statement]) =>
      executedSql(statement).includes("from crawl_frontier where state = 'pending'"),
    );
    expect(counted).toHaveLength(1);
    expect(typeof prepared.frontierPending).toBe("number");
  });

  it("skips the full pending-frontier count when the prepare opts out", async () => {
    const execute = vi.spyOn(db, "execute");
    const prepared = await prepareCrawlPhase({
      limit: 1,
      maxHop: 2,
      skipFrontierPendingCount: true,
    });
    const counted = execute.mock.calls.some(([statement]) =>
      executedSql(statement).includes("from crawl_frontier where state = 'pending'"),
    );
    expect(counted).toBe(false);
    expect(prepared.kind).toBe("prepared");
    expect(prepared).not.toHaveProperty("frontierPending");
    const delivered = crawlOutputSchema.parse({ ...prepared, ok: true, phase: "prepare" });
    expect(delivered).not.toHaveProperty("frontierPending");
  });

  it("preserves prepare telemetry through the oRPC output contract", async () => {
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    const delivered = crawlOutputSchema.parse({
      ...prepared,
      ok: true,
      phase: "prepare",
    });
    expect(delivered).toMatchObject({ items: [{ nodeKind: "release" }], storableReady: true });
  });

  it("preserves a positive legacy release numerator through the oRPC output contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(providerRelease(1))))),
    );
    const pass = await runCrawlCatalogue({ limit: 1, maxHop: 2 });
    expect(pass.releaseDetailsStored).toBe(1);
    const delivered = crawlOutputSchema.parse({ ...pass, ok: true });
    expect(delivered).toHaveProperty("releaseDetailsStored", 1);
  });

  it("reports storable release work while its due-work row awaits repair", async () => {
    await db.execute(`update crawl_due_work set state = 'repair', storable_rank = 1,
      repair_entered_at = '2026-08-01T00:00:01.000Z'
      where node_id = 'musicbrainz:release:release-phase'`);
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2, sampleStorableRepair: true });
    expect(prepared.storableReady).toBe(true);
  });

  it("uses only the ready lane when the repair sample flag is absent", async () => {
    await db.execute(`update crawl_due_work set state = 'repair', storable_rank = 1,
      repair_entered_at = '2026-08-01T00:00:01.000Z'
      where node_id = 'musicbrainz:release:release-phase'`);
    const execute = vi.spyOn(db, "execute");
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    const sampledRepair = execute.mock.calls.some(([statement]) => {
      const sql = executedSql(statement);
      return sql.includes("crawl_due_work_repair_idx") && sql.includes("crawl_frontier as node");
    });
    expect(sampledRepair).toBe(false);
    expect(prepared.storableReady).toBeNull();
  });

  it("returns unknown after a capped repair sample without a storable release", async () => {
    await db.execute("update labels set seed_state = 'disabled' where id = 'label-phase'");
    await db.execute(`update crawl_due_work set state = 'repair', storable_rank = 1,
      repair_entered_at = '2026-08-01T00:00:01.000Z'
      where node_id = 'musicbrainz:release:release-phase'`);
    await db.batch(
      Array.from({ length: 200 }, (_, index) => ({
        args: [`musicbrainz:release:repair-${String(index).padStart(3, "0")}`, timestamp],
        sql: `insert into crawl_due_work
          (node_id, node_kind, state, hop, demand_rank, created_at, storable_rank,
           generation, source_version, updated_at, repair_entered_at)
          values (?, 'release', 'repair', 0, 1, ?, 1,
            'test', 'test', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      })),
      "write",
    );
    const execute = vi.spyOn(db, "execute");
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2, sampleStorableRepair: true });
    const cappedSample = execute.mock.calls.find(([statement]) => {
      const sql = executedSql(statement);
      return sql.includes("repair_page") && sql.includes("crawl_due_work_repair_idx");
    });
    expect(cappedSample).toBeDefined();
    expect(cappedSample?.[0]).toMatchObject({ args: [200] });
    expect(executedSql(cappedSample?.[0])).toContain("order by node_id limit ?");
    expect(prepared.storableReady).toBeNull();
  });

  it("settles a terminal known-disabled release without a MusicBrainz call and re-arms after enable", async () => {
    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute("update labels set seed_state = 'disabled' where id = 'label-phase'");
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, release_label_slug,
         created_at, updated_at)
        values ('musicbrainz:release:release-phase', 'release', 'musicbrainz',
          'release-phase', 2, 'phase-label', 'phase-label', ?, ?)`,
    });
    await rebuildCrawlDueWork(db, { generation: crypto.randomUUID(), limit: 10 });
    await db.batch(
      [markCrawlNodeRepairStatement("musicbrainz:release:release-phase", crypto.randomUUID())],
      "write",
    );
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(providerRelease(1)))),
    );
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    expect(prepared.items[0]?.fetchPlan).toEqual({ kind: "none" });
    const fetched = await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? "");
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(await commitCrawlPhase(fetched)).toMatchObject({
      outcome: "committed",
      result: { releaseDetailsStored: 0, tracksWritten: 0 },
    });
    expect(
      (await db.execute("select state from crawl_frontier where external_id = 'release-phase'"))
        .rows[0]?.state,
    ).toBe("skipped");

    await db.execute("update labels set seed_state = 'enabled' where id = 'label-phase'");
    const rearmed = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    expect(rearmed.items[0]?.fetchPlan.kind).toBe("single");
    const stored = await commitCrawlPhase(
      await fetchCrawlPhase(rearmed.items[0]?.preparedToken ?? ""),
    );
    expect(stored).toMatchObject({ result: { releaseDetailsStored: 1, tracksWritten: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds an implausibly credited release inside the admitted commit and stores it once released", async () => {
    await db.execute("update labels set founding_date = '2009' where id = 'label-phase'");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ...providerRelease(1), date: "1969" }))),
      ),
    );

    const held = await commitCrawlPhase(await prepareAndFetch());
    expect(held).toMatchObject({
      outcome: "committed",
      result: { releaseDetailsStored: 0, tracksHeldImplausible: 1, tracksWritten: 0 },
    });
    expect(
      (
        await db.execute(
          "select state from crawl_release_holds where release_mbid = 'release-phase'",
        )
      ).rows[0]?.state,
    ).toBe("held");

    await resolveCrawlHold("release-phase", "store");
    const rearmed = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    expect(rearmed.items[0]?.nodeId).toBe("musicbrainz:release:release-phase");
    const stored = await commitCrawlPhase(
      await fetchCrawlPhase(rearmed.items[0]?.preparedToken ?? ""),
    );
    expect(stored).toMatchObject({ result: { releaseDetailsStored: 1, tracksWritten: 1 } });
  });

  it("still fetches an undecided-label terminal release", async () => {
    await db.execute("update labels set seed_state = 'undecided' where id = 'label-phase'");
    await db.execute(`update crawl_frontier set hop = 2, release_label_slug = 'phase-label'
      where external_id = 'release-phase'`);
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(providerRelease(1)))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
    await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? "");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms a skipped disabled release after a scoped artist allow", async () => {
    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute("update labels set seed_state = 'disabled' where id = 'label-phase'");
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, release_label_slug, state, note,
         created_at, updated_at)
        values ('musicbrainz:release:release-phase', 'release', 'musicbrainz',
          'release-phase', 2, 'phase-label', 'phase-label', 'skipped',
          'disabled own label at terminal hop', ?, ?)`,
    });
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into artist_rules
        (id, artist_mbid, artist_name, label_id, source, verdict, created_at, updated_at)
        values ('rule-phase', 'artist-0', 'Artist 0', 'label-phase', 'operator', 'allow', ?, ?)`,
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(providerRelease(1)))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
    const receipt = await commitCrawlPhase(
      await fetchCrawlPhase(prepared.items[0]?.preparedToken ?? ""),
    );
    expect(receipt).toMatchObject({ result: { releaseDetailsStored: 1, tracksWritten: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms a disabled terminal release after its label merges into an enabled label", async () => {
    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
        values ('label-loser', 'Losing Label', 'losing-label', 'disabled', ?, ?)`,
    });
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, release_label_slug, state, note,
         created_at, updated_at)
        values ('musicbrainz:release:release-phase', 'release', 'musicbrainz',
          'release-phase', 2, 'losing-label', 'losing-label', 'skipped',
          'disabled own label at terminal hop', ?, ?)`,
    });
    await mergeLabel("losing-label", "phase-label");
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
    expect(
      (await db.execute("select state from crawl_frontier where external_id = 'release-phase'"))
        .rows[0]?.state,
    ).toBe("pending");
  });

  it("re-arms exactly the releases whose own label or confirmed alias is enabled or carries an allow", async () => {
    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute("update labels set seed_state = 'disabled' where id = 'label-phase'");
    const labels = [
      ["label-on", "enabled"],
      ["label-allowed", "disabled"],
      ["label-blocked", "disabled"],
      ["label-off", "disabled"],
    ] as const;
    for (const [id, seedState] of labels) {
      await db.execute({
        args: [id, id, id, seedState, timestamp, timestamp],
        sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
      });
    }
    for (const [id, labelId, verdict] of [
      ["rule-allow", "label-allowed", "allow"],
      ["rule-block", "label-blocked", "block"],
    ] as const) {
      await db.execute({
        args: [id, verdict, labelId, timestamp, timestamp],
        sql: `insert into artist_rules
          (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
          values (?, 'artist-scope', 'Scope Artist', ?, ?, 'operator', ?, ?)`,
      });
    }
    for (const [id, labelId, aliasSlug, status] of [
      ["alias-on", "label-on", "alias-on", "confirmed"],
      ["alias-allowed", "label-allowed", "alias-allowed", "confirmed"],
      ["alias-on-candidate", "label-on", "alias-on-candidate", "candidate"],
      ["alias-off", "label-off", "alias-off", "confirmed"],
    ] as const) {
      await db.execute({
        args: [id, aliasSlug, aliasSlug, labelId, status, timestamp],
        sql: `insert into label_aliases (id, alias, alias_slug, label_id, kind, source, status, created_at)
          values (?, ?, ?, ?, 'name', 'operator', ?, ?)`,
      });
    }
    const slugs = [
      "label-on",
      "label-allowed",
      "alias-on",
      "alias-allowed",
      "label-blocked",
      "label-off",
      "alias-on-candidate",
      "alias-off",
    ];
    for (const slug of slugs) {
      await db.execute({
        args: [`musicbrainz:release:${slug}`, slug, slug, slug, timestamp, timestamp],
        sql: `insert into crawl_frontier
          (id, kind, source, external_id, hop, label_slug, release_label_slug, state, note,
           created_at, updated_at)
          values (?, 'release', 'musicbrainz', ?, 2, ?, ?, 'skipped',
            'disabled own label at terminal hop', ?, ?)`,
      });
    }
    const executed: string[] = [];
    const execute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation((statement: InStatement) => {
      if (
        typeof statement !== "string" &&
        statement.sql.includes("crawl_frontier_disabled_skip_idx")
      ) {
        executed.push(statement.sql);
      }
      return execute(statement);
    });

    await prepareCrawlPhase({ limit: 1, maxHop: 2 });

    const states = await execute(
      "select external_id, state from crawl_frontier where kind = 'release' order by external_id",
    );
    expect(
      Object.fromEntries(
        states.rows.map((row) => [
          typeof row.external_id === "string" ? row.external_id : "",
          typeof row.state === "string" ? row.state : "",
        ]),
      ),
    ).toStrictEqual({
      "alias-allowed": "pending",
      "alias-off": "skipped",
      "alias-on": "pending",
      "alias-on-candidate": "skipped",
      "label-allowed": "pending",
      "label-blocked": "skipped",
      "label-off": "skipped",
      "label-on": "pending",
    });
    expect(executed).toHaveLength(1);
    const plan = await execute({
      args: [10],
      sql: `explain query plan ${executed[0] ?? ""}`,
    });
    const details = plan.rows.map((row) => (typeof row.detail === "string" ? row.detail : ""));
    expect(details.filter((detail) => /^SCAN label\b/.test(detail))).toStrictEqual([]);
    expect(details.filter((detail) => detail.startsWith("SEARCH alias "))).toStrictEqual([
      "SEARCH alias USING INDEX label_aliases_label_slug_source_idx (label_id=?)",
      "SEARCH alias USING INDEX label_aliases_label_slug_source_idx (label_id=?)",
    ]);
  });

  it("re-arms a disabled terminal release when the hop limit widens", async () => {
    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute("update labels set seed_state = 'disabled' where id = 'label-phase'");
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, release_label_slug, state, note,
         created_at, updated_at)
        values ('musicbrainz:release:release-phase', 'release', 'musicbrainz',
          'release-phase', 2, 'phase-label', 'phase-label', 'skipped',
          'disabled own label at terminal hop', ?, ?)`,
    });
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 3 });
    expect(prepared.items[0]?.fetchPlan.kind).toBe("single");
  });

  it("claims at most two nearby nodes while preserving release and discovery progress", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, created_at, updated_at)
        values ('musicbrainz:artist:discovery', 'artist', 'musicbrainz', 'discovery', 1, ?, ?)`,
    });
    await db.batch(
      [markCrawlNodeRepairStatement("musicbrainz:artist:discovery", crypto.randomUUID())],
      "write",
    );

    const prepared = await prepareCrawlPhase({ limit: 2, maxHop: 2 });
    expect(prepared.items.map((item) => item.nodeId)).toEqual([
      "musicbrainz:release:release-phase",
      "musicbrainz:artist:discovery",
    ]);
  });

  it("claims up to the prepare bound and refuses a batch wider than the claim lease allows", async () => {
    for (let index = 0; index < MAX_CRAWL_PREPARE_LIMIT + 2; index += 1) {
      const nodeId = `musicbrainz:artist:wide-${index}`;
      await db.execute({
        args: [nodeId, `wide-${index}`, timestamp, timestamp],
        sql: `insert into crawl_frontier
          (id, kind, source, external_id, hop, created_at, updated_at)
          values (?, 'artist', 'musicbrainz', ?, 1, ?, ?)`,
      });
      await db.batch([markCrawlNodeRepairStatement(nodeId, crypto.randomUUID())], "write");
    }

    const prepared = await prepareCrawlPhase({ limit: MAX_CRAWL_PREPARE_LIMIT, maxHop: 2 });
    expect(prepared.items).toHaveLength(MAX_CRAWL_PREPARE_LIMIT);

    await expect(
      prepareCrawlPhase({ limit: MAX_CRAWL_PREPARE_LIMIT + 1, maxHop: 2 }),
    ).rejects.toThrow(/crawl prepare limit/);
  });

  it("returns a throttled node to the frontier without charging it a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 503 }))),
    );

    const fetched = await prepareAndFetch();
    const receipt = await commitCrawlPhase(fetched);

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { failed: 1, rateLimited: true },
    });

    const row = await db.execute(
      "select state, failures, note from crawl_frontier where id = 'musicbrainz:release:release-phase'",
    );
    expect(row.rows[0]?.state).toBe("pending");
    expect(Number(row.rows[0]?.failures)).toBe(0);
    expect(row.rows[0]?.note).toBe("musicbrainz rate-limited");
  });

  it("charges a failure for a provider failure that is not a throttle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("not json at all", { status: 200 }))),
    );

    const fetched = await prepareAndFetch();
    const receipt = await commitCrawlPhase(fetched);

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { failed: 1, rateLimited: false },
    });
    const row = await db.execute(
      "select state, failures from crawl_frontier where id = 'musicbrainz:release:release-phase'",
    );
    expect(row.rows[0]?.state).toBe("failed");
    expect(Number(row.rows[0]?.failures)).toBe(1);
  });

  it("issues no per-label write when every enabled seed already holds its frontier node", async () => {
    const first = await initializeCrawlPhase();
    expect(first.kind).toBe("initialized");
    expect(first.seeded).toBe(1);

    const issued: string[] = [];
    const originalBatch = db.batch.bind(db);
    const originalExecute = db.execute.bind(db);
    db.batch = (async (...args: Parameters<typeof db.batch>) => {
      issued.push(JSON.stringify(args[0]));
      return originalBatch(...args);
    }) as Client["batch"];
    db.execute = (async (...args: Parameters<typeof db.execute>) => {
      issued.push(JSON.stringify(args[0]));
      return originalExecute(...args);
    }) as Client["execute"];

    try {
      const second = await initializeCrawlPhase();
      expect(second.seeded).toBe(0);
      expect(
        issued.filter((statement) => statement.includes("insert into crawl_frontier")),
      ).toEqual([]);
    } finally {
      db.batch = originalBatch;
      db.execute = originalExecute;
    }
  });

  it("mints only the enabled seed labels whose frontier node is missing", async () => {
    await initializeCrawlPhase();
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into labels
        (id, name, slug, seed_state, created_at, updated_at)
        values ('label-late', 'Late Label', 'late-label', 'enabled', ?, ?)`,
    });

    const seeded = await initializeCrawlPhase();

    expect(seeded.seeded).toBe(1);
    const nodes = await db.execute(
      "select id from crawl_frontier where source = 'fluncle' and kind = 'label' order by id",
    );
    expect(nodes.rows.map((row) => row["id"])).toEqual([
      "fluncle:label:late-label",
      "fluncle:label:phase-label",
    ]);
  });

  it("commits a normal multi-medium release atomically through the existing crawler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(providerRelease(60)), { status: 200 })),
      ),
    );

    const fetched = await prepareAndFetch();
    expect(Buffer.byteLength(fetched.commitToken)).toBeLessThan(CRAWL_PHASE_TOKEN_MAX_BYTES);
    const receipt = await commitCrawlPhase(fetched);

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, failed: 0, tracksFound: 60, tracksWritten: 60 },
    });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(60);
    expect((await db.execute("select count(*) as n from track_duplicate_keys")).rows[0]?.n).toBe(
      60,
    );
    expect(
      (
        await db.execute(
          "select state, attempts from crawl_frontier where id = 'musicbrainz:release:release-phase'",
        )
      ).rows[0],
    ).toEqual({ attempts: 1, state: "done" });
    expect(await commitCrawlPhase(fetched)).toMatchObject({ outcome: "committed", replayed: true });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(60);
  });

  it("loads one narrow label fold index per commit batch and stores release tracks", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
        values ('musicbrainz:release:release-second', 'release', 'musicbrainz', 'release-second', 0,
                'phase-label', ?, ?)`,
    });
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
        values ('musicbrainz:artist:browse-artist', 'artist', 'musicbrainz', 'browse-artist', 0,
                'phase-label', ?, ?)`,
    });
    await db.batch(
      [
        "musicbrainz:release:release-phase",
        "musicbrainz:release:release-second",
        "musicbrainz:artist:browse-artist",
      ].map((id) => markCrawlNodeRepairStatement(id, crypto.randomUUID())),
      "write",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const id = url.pathname.split("/").at(-1);
        const body = url.searchParams.has("artist")
          ? {
              "release-count": 2,
              releases: [
                {
                  id: "browse-exact",
                  "label-info": [{ label: { id: "label-phase-mbid", name: "Other Spelling" } }],
                },
                { id: "browse-fold", "label-info": [{ label: { name: "PHASE LABEL" } }] },
              ],
            }
          : providerBatchRelease(id, { id: "label-phase-mbid", name: "Phase Label" });
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const prepared = await prepareCrawlPhase({ limit: 3, maxHop: 2 });
    expect(prepared.items).toHaveLength(3);
    const items = await Promise.all(
      prepared.items.map((item) => fetchCrawlPhase(item.preparedToken)),
    );
    const instrumented = instrumentTransactions(db);
    const batch = await commitCrawlNodes(items);
    expect(batch.receipts).toHaveLength(3);
    expect(batch.receipts.every((receipt) => receipt.outcome === "committed")).toBe(true);
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(2);
    const ownLabels = await db.execute(
      "select release_label_slug from crawl_frontier where external_id in ('browse-exact', 'browse-fold')",
    );
    expect(ownLabels.rows).toHaveLength(2);
    expect(ownLabels.rows.every((row) => row.release_label_slug === "phase-label")).toBe(true);
    const statements = instrumented.counts.statements.map(executedSql);
    const labelReads = statements.filter((sql) => /select[\s\S]*from labels\b/.test(sql));
    const fullReads = labelReads.filter((sql) => !/\bwhere\b/i.test(sql));
    expect(fullReads).toEqual(["select id, name from labels"]);
    expect(labelReads.every((sql) => !/triage_reason|disambiguation/.test(sql))).toBe(true);
    expect(
      statements.filter((sql) =>
        /select artist_mbid, label_id, verdict from artist_rules/.test(sql),
      ),
    ).toHaveLength(2);
  });

  it("retries a failed label index load on the next item of the same batch", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
        values ('musicbrainz:release:release-second', 'release', 'musicbrainz', 'release-second', 0,
                'phase-label', ?, ?)`,
    });
    await db.batch(
      ["release-phase", "release-second"].map((id) =>
        markCrawlNodeRepairStatement(`musicbrainz:release:${id}`, crypto.randomUUID()),
      ),
      "write",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(
          new Response(
            JSON.stringify(
              providerBatchRelease(url.pathname.split("/").at(-1), {
                id: "label-phase-mbid",
                name: "Phase Label",
              }),
            ),
            { status: 200 },
          ),
        );
      }),
    );
    const prepared = await prepareCrawlPhase({ limit: 2, maxHop: 2 });
    expect(prepared.items).toHaveLength(2);
    const items = await Promise.all(
      prepared.items.map((item) => fetchCrawlPhase(item.preparedToken)),
    );
    const originalTransaction = db.transaction.bind(db);
    let indexAttempts = 0;
    db.transaction = (async (...args: Parameters<Client["transaction"]>) => {
      const transaction = await originalTransaction(...args);
      const originalExecute = transaction.execute.bind(transaction);
      transaction.execute = ((...executeArgs: Parameters<typeof transaction.execute>) => {
        if (executedSql(executeArgs[0]) === "select id, name from labels") {
          indexAttempts += 1;
          if (indexAttempts === 1) {
            return Promise.reject(new Error("fixture label index read failure"));
          }
        }
        return originalExecute(...executeArgs);
      }) as typeof transaction.execute;
      return transaction;
    }) as Client["transaction"];
    const batch = await commitCrawlNodes(items);
    expect(batch.receipts.map((receipt) => receipt.outcome)).toEqual([
      "safely-retryable",
      "committed",
    ]);
    expect(indexAttempts).toBe(2);
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(1);
    const [first] = items;
    if (!first) {
      throw new Error("test expected a first fetched crawl item");
    }
    const retried = await commitCrawlNodes([first]);
    expect(retried.receipts.map((receipt) => receipt.outcome)).toEqual(["committed"]);
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(2);
  });

  it.each([
    { labelMbid: "label-phase-mbid", resolution: "MBID" },
    { labelMbid: undefined, resolution: "fold" },
  ])(
    "reads fresh label decisions per item through $resolution resolution",
    async ({ labelMbid }) => {
      await db.execute("update labels set seed_state = 'undecided'");
      await db.execute({
        args: [timestamp, timestamp],
        sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
        values ('musicbrainz:release:release-second', 'release', 'musicbrainz', 'release-second', 0,
                'phase-label', ?, ?)`,
      });
      await db.batch(
        ["release-phase", "release-second"].map((id) =>
          markCrawlNodeRepairStatement(`musicbrainz:release:${id}`, crypto.randomUUID()),
        ),
        "write",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          return Promise.resolve(
            new Response(
              JSON.stringify(
                providerBatchRelease(url.pathname.split("/").at(-1), {
                  id: labelMbid,
                  name: "PHASE LABEL",
                }),
              ),
              { status: 200 },
            ),
          );
        }),
      );
      const prepared = await prepareCrawlPhase({ limit: 2, maxHop: 2 });
      expect(prepared.items).toHaveLength(2);
      const items = await Promise.all(
        prepared.items.map((item) => fetchCrawlPhase(item.preparedToken)),
      );
      let committed = 0;
      const batch = await commitCrawlNodes(items, {
        commit: async (item, context) => {
          const receipt = await commitCrawlPhase(item, context);
          committed += 1;
          if (committed === 1) {
            await db.execute("update labels set seed_state = 'enabled' where id = 'label-phase'");
          }
          return receipt;
        },
      });
      expect(batch.receipts[0]).toMatchObject({
        outcome: "committed",
        result: { tracksSkippedLabelGate: 1, tracksWritten: 0 },
      });
      expect(batch.receipts[1]).toMatchObject({
        outcome: "committed",
        result: { tracksSkippedLabelGate: 0, tracksWritten: 1 },
      });
      expect((await db.execute("select label, label_id from tracks")).rows).toEqual([
        { label: "Phase Label", label_id: "label-phase" },
      ]);
    },
  );

  it.each([
    { firstOutcome: "committed", rollbackFirst: false },
    { firstOutcome: "safely-retryable", rollbackFirst: true },
  ])(
    "rechecks minted label candidates across $firstOutcome items and preserves canonical spelling",
    async ({ rollbackFirst, firstOutcome }) => {
      if (rollbackFirst) {
        await db.execute(`create trigger reject_first_release_receipt before update on operation_receipts
        when new.result_identity = 'musicbrainz:release:release-new-first'
        begin select raise(abort, 'fixture receipt write failure'); end`);
      }
      await db.execute({
        args: [timestamp, timestamp],
        sql: `insert into artist_rules (id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
          values ('rule-allow', 'artist-0', 'Artist 0', 'allow', 'operator', ?, ?)`,
      });
      const run = async (batched: boolean) => {
        await db.execute("delete from tracks");
        await db.execute("delete from operation_receipts");
        await db.execute("delete from crawl_due_work");
        await db.execute("delete from crawl_frontier");
        await db.execute("delete from labels where slug = 'new-batch-label'");
        for (const externalId of ["release-new-first", "release-new-second"]) {
          await db.execute({
            args: [`musicbrainz:release:${externalId}`, externalId, timestamp, timestamp],
            sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
            values (?, 'release', 'musicbrainz', ?, 0, 'phase-label', ?, ?)`,
          });
        }
        await db.batch(
          ["release-new-first", "release-new-second"].map((id) =>
            markCrawlNodeRepairStatement(`musicbrainz:release:${id}`, crypto.randomUUID()),
          ),
          "write",
        );
        vi.stubGlobal(
          "fetch",
          vi.fn((input: string | URL | Request) => {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            const id = url.pathname.split("/").at(-1);
            return Promise.resolve(
              new Response(
                JSON.stringify(
                  providerBatchRelease(id, {
                    id:
                      id === "release-new-first" || rollbackFirst
                        ? "new-batch-label-mbid"
                        : undefined,
                    name: id === "release-new-first" ? "New Batch Label" : "NEW BATCH LABEL",
                  }),
                ),
                { status: 200 },
              ),
            );
          }),
        );
        const prepared = await prepareCrawlPhase({ limit: 2, maxHop: 2 });
        expect(prepared.items).toHaveLength(2);
        const items = await Promise.all(
          prepared.items.map((item) => fetchCrawlPhase(item.preparedToken)),
        );
        const receipts = batched ? (await commitCrawlNodes(items)).receipts : [];
        if (!batched) {
          for (const item of items) {
            receipts.push({ operationKey: item.operationKey, ...(await commitCrawlPhase(item)) });
          }
        }
        expect(receipts[0]).toMatchObject({ outcome: firstOutcome });
        if (!rollbackFirst) {
          expect(receipts[0]).toMatchObject({ result: { labelsDiscovered: ["New Batch Label"] } });
        }
        expect(receipts[1]).toMatchObject({
          outcome: "committed",
          result: {
            labelsDiscovered: rollbackFirst ? ["NEW BATCH LABEL"] : [],
          },
        });
        const labels = await db.execute(
          "select id, name, slug, mb_label_id, seed_state from labels where slug = 'new-batch-label'",
        );
        expect(labels.rows).toHaveLength(1);
        expect((await db.execute("select count(*) as n from labels")).rows[0]?.n).toBe(2);
        const stored = await db.execute("select label, label_id from tracks order by track_id");
        expect(stored.rows).toHaveLength(rollbackFirst ? 1 : 2);
        for (const row of stored.rows) {
          expect(row).toMatchObject({
            label: rollbackFirst ? "NEW BATCH LABEL" : "New Batch Label",
            label_id: labels.rows[0]?.id,
          });
        }
        const frontier = await db.execute(
          "select id, state, note from crawl_frontier where kind = 'release' order by id",
        );
        return {
          frontier: frontier.rows,
          labels: labels.rows.map(({ id: _id, ...row }) => row),
          results: receipts.map((receipt) => receipt.result),
        };
      };
      expect(await run(true)).toEqual(await run(false));
    },
  );

  it("keeps a 100-child browse commit within seven transaction operations", async () => {
    await seedBrowseNode();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(providerBrowse(100)), { status: 200 })),
      ),
    );

    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    const item = prepared.items[0];
    if (!item) {
      throw new Error("test expected a prepared browse token");
    }
    const fetched = await fetchCrawlPhase(item.preparedToken);
    const instrumented = instrumentTransactions(db);
    db = instrumented.client;

    const receipt = await commitCrawlPhase(fetched);
    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, failed: 0, nodesEnqueued: 100 },
    });
    expect(
      instrumented.counts.execute + instrumented.counts.batch + instrumented.counts.commit,
    ).toBe(7);
    expect(instrumented.counts.maxBatchStatements).toBe(200);
  });

  it("keeps a representative 100-track release within twenty-five transaction operations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ...providerReleaseWithArtistCount(100, 0, 1), date: "2013-06-10" }),
            { status: 200 },
          ),
        ),
      ),
    );

    const fetched = await prepareAndFetch();
    const instrumented = instrumentTransactions(db);
    db = instrumented.client;
    const receipt = await commitCrawlPhase(fetched);

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, failed: 0, tracksFound: 100, tracksWritten: 100 },
    });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(100);
    expect(
      instrumented.counts.execute + instrumented.counts.batch + instrumented.counts.commit,
    ).toBe(25);
    expect(instrumented.counts.maxBatchStatements).toBe(500);
  });

  it("retains supported semantics for a release with more than one hundred tracks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(providerReleaseWithArtistCount(101, 0, 1)), { status: 200 }),
        ),
      ),
    );

    const fetched = await prepareAndFetch();
    const receipt = await commitCrawlPhase(fetched);

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, failed: 0, tracksFound: 101, tracksWritten: 101 },
    });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(101);
  });

  it("accepts a multi-medium provider envelope near the signed size ceiling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(providerRelease(100, 13_000)), { status: 200 }),
        ),
      ),
    );

    const fetched = await prepareAndFetch();
    const bytes = Buffer.byteLength(fetched.commitToken);
    expect(bytes).toBeGreaterThan(CRAWL_PHASE_TOKEN_MAX_BYTES * 0.75);
    expect(bytes).toBeLessThan(CRAWL_PHASE_TOKEN_MAX_BYTES);
    expect(await commitCrawlPhase(fetched)).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, failed: 0, tracksFound: 100, tracksWritten: 100 },
    });
  });

  it("turns an oversized provider envelope into an honest failed node without truncation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(providerRelease(100, 30_000)), { status: 200 }),
        ),
      ),
    );

    const fetched = await prepareAndFetch();
    expect(Buffer.byteLength(fetched.commitToken)).toBeLessThan(CRAWL_PHASE_TOKEN_MAX_BYTES);
    const receipt = await commitCrawlPhase(fetched);

    expect(receipt).toMatchObject({ outcome: "committed", result: { expanded: 0, failed: 1 } });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(0);
    expect(
      (
        await db.execute(
          "select state, failures, note from crawl_frontier where id = 'musicbrainz:release:release-phase'",
        )
      ).rows[0],
    ).toMatchObject({
      failures: 1,
      note: "MusicBrainz response exceeded the bounded crawl provider envelope",
      state: "failed",
    });
  });

  it("rejects an expired provider result before any expansion mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(providerRelease(3)), { status: 200 })),
      ),
    );
    const fetched = await prepareAndFetch();
    await db.execute(`update crawl_due_work set claim_expires_at = '${timestamp}'
      where node_id = 'musicbrainz:release:release-phase'`);

    const receipt = await commitCrawlPhase(fetched);
    expect(receipt).toMatchObject({ outcome: "rejected", result: { code: "stale_crawl_claim" } });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(0);
    expect(
      (
        await db.execute(
          "select state, attempts from crawl_frontier where id = 'musicbrainz:release:release-phase'",
        )
      ).rows[0],
    ).toEqual({ attempts: 0, state: "pending" });
  });

  it("rejects a provider result when newer frontier state replaces its signed snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(providerRelease(3)), { status: 200 })),
      ),
    );
    const fetched = await prepareAndFetch();
    await db.execute(`update crawl_frontier set cursor = 9, updated_at = '2026-08-02T00:00:00.000Z'
      where id = 'musicbrainz:release:release-phase'`);

    expect(await commitCrawlPhase(fetched)).toMatchObject({
      outcome: "rejected",
      result: { code: "stale_crawl_claim" },
    });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(0);
    expect(
      (
        await db.execute(
          "select cursor, state, attempts from crawl_frontier where id = 'musicbrainz:release:release-phase'",
        )
      ).rows[0],
    ).toEqual({ attempts: 0, cursor: 9, state: "pending" });
  });

  it("reads a newer label ruling inside commit instead of reusing pre-provider scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(providerRelease(3)), { status: 200 })),
      ),
    );
    const fetched = await prepareAndFetch();
    await db.execute("update labels set seed_state = 'disabled' where id = 'label-phase'");

    const receipt = await commitCrawlPhase(fetched);
    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, tracksFound: 3, tracksSkippedLabelGate: 3, tracksWritten: 0 },
    });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(0);
  });

  it("rolls every expansion mutation back when the final claim settle cannot commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(providerRelease(3)), { status: 200 })),
      ),
    );
    const fetched = await prepareAndFetch();
    await db.execute(`create trigger reject_phase_settle before insert on crawl_due_work
      when new.node_id = 'musicbrainz:release:release-phase' and new.state = 'repair'
      begin select raise(abort, 'settle rejected'); end`);

    expect(await commitCrawlPhase(fetched)).toMatchObject({ outcome: "safely-retryable" });
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(0);
    expect((await db.execute("select count(*) as n from track_duplicate_keys")).rows[0]?.n).toBe(0);
    expect(
      (
        await db.execute(
          "select state, attempts from crawl_frontier where id = 'musicbrainz:release:release-phase'",
        )
      ).rows[0],
    ).toEqual({ attempts: 0, state: "pending" });
    expect((await db.execute("select count(*) as n from operation_receipts")).rows[0]?.n).toBe(0);
  });

  it("signs terminal and unresolved seed plans without undefined payload fields", async () => {
    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute("delete from labels");
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
        values ('seed-no-mbid', 'Seed Without MBID', 'seed-without-mbid', 'enabled', ?, ?)`,
    });
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
        values ('fluncle:label:seed-without-mbid', 'label', 'fluncle',
          'seed-without-mbid', 0, 'seed-without-mbid', ?, ?)`,
    });
    await db.batch(
      [markCrawlNodeRepairStatement("fluncle:label:seed-without-mbid", crypto.randomUUID())],
      "write",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ labels: [{ id: "resolved-label", name: "Seed Without MBID" }] }),
            { status: 200 },
          ),
        ),
      ),
    );

    const seedFetched = await prepareAndFetch();
    expect(await commitCrawlPhase(seedFetched)).toMatchObject({ outcome: "committed" });
    expect(
      (
        await db.execute(
          "select state from crawl_frontier where id = 'musicbrainz:label:resolved-label'",
        )
      ).rows[0]?.state,
    ).toBe("pending");

    await db.execute("delete from crawl_due_work");
    await db.execute("delete from crawl_frontier");
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, created_at, updated_at)
        values ('musicbrainz:artist:terminal', 'artist', 'musicbrainz', 'terminal', 3, ?, ?)`,
    });
    await db.batch(
      [markCrawlNodeRepairStatement("musicbrainz:artist:terminal", crypto.randomUUID())],
      "write",
    );
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    const item = prepared.items[0];
    if (!item) {
      throw new Error("test expected a terminal crawl token");
    }
    const terminalFetched = await fetchCrawlPhase(item.preparedToken);
    expect(await commitCrawlPhase(terminalFetched)).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, tracksFound: 0 },
    });
  });
});

describe("crawl provider bodies fetched by the box", () => {
  const RELEASE_URL =
    "https://musicbrainz.org/ws/2/release/release-phase" +
    "?inc=recordings+artist-credits+isrcs+labels+release-groups+url-rels&fmt=json";

  async function prepareOne(): Promise<CrawlPhasePrepareResult["items"][number]> {
    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });
    const item = prepared.items[0];
    if (!item) {
      throw new Error("test expected a prepared crawl token");
    }
    return item;
  }

  function refuseWorkerFetch(): ReturnType<typeof vi.fn> {
    const spy = vi.fn(() => {
      throw new Error("the Worker must not reach MusicBrainz when the box supplied the body");
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("issues the exact url the box may fetch, host pinned to MusicBrainz", async () => {
    const item = await prepareOne();
    expect(item.fetchPlan).toEqual({ kind: "single", url: RELEASE_URL });
    expect(new URL(RELEASE_URL).host).toBe("musicbrainz.org");
  });

  it("commits a box-fetched release without the Worker reaching MusicBrainz at all", async () => {
    const spy = refuseWorkerFetch();
    const item = await prepareOne();
    const fetched = await fetchCrawlPhase(item.preparedToken, [
      { body: providerRelease(6), outcome: "body", url: RELEASE_URL },
    ]);

    expect(await commitCrawlPhase(fetched)).toMatchObject({
      outcome: "committed",
      result: { expanded: 1, failed: 0, tracksFound: 6, tracksWritten: 6 },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("yields a receipt identical to the Worker's own fetch of the same bytes", async () => {
    const fixture = providerRelease(9);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 }))),
    );
    const workerReceipt = await commitCrawlPhase(await prepareAndFetch());

    const workerDb = db;
    const boxDirectory = await mkdtemp(join(tmpdir(), "fluncle-crawl-parity-"));
    try {
      db = await createIntegrationDb({ url: `file:${join(boxDirectory, "parity.db")}` });
      await seedRelease();
      refuseWorkerFetch();
      const item = await prepareOne();
      const boxReceipt = await commitCrawlPhase(
        await fetchCrawlPhase(item.preparedToken, [
          { body: fixture, outcome: "body", url: RELEASE_URL },
        ]),
      );
      expect(boxReceipt).toEqual(workerReceipt);
    } finally {
      db.close();
      db = workerDb;
      await rm(boxDirectory, { force: true, recursive: true });
    }
  });

  it("refuses a body for a url this claim did not issue", async () => {
    const item = await prepareOne();
    await expect(
      fetchCrawlPhase(item.preparedToken, [
        {
          body: providerRelease(1),
          outcome: "body",
          url: "https://musicbrainz.org/ws/2/release/some-other-release?fmt=json",
        },
      ]),
    ).rejects.toThrow(/not for a url this claim issued/);
  });

  it("refuses a body from any host but MusicBrainz", async () => {
    const item = await prepareOne();
    for (const url of [
      RELEASE_URL.replace("https://musicbrainz.org", "https://musicbrainz.org.evil.example"),
      RELEASE_URL.replace("https://", "http://"),
      "not a url at all",
    ]) {
      await expect(
        fetchCrawlPhase(item.preparedToken, [{ body: providerRelease(1), outcome: "body", url }]),
      ).rejects.toThrow(/crawl fetch body carries a url/);
    }
  });

  it("refuses a body prepared for a DIFFERENT node's claim", async () => {
    await db.execute({
      args: [timestamp, timestamp],
      sql: `insert into crawl_frontier
        (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
        values ('musicbrainz:release:other-release', 'release', 'musicbrainz',
          'other-release', 0, 'phase-label', ?, ?)`,
    });
    await db.batch(
      [markCrawlNodeRepairStatement("musicbrainz:release:other-release", crypto.randomUUID())],
      "write",
    );
    const prepared = await prepareCrawlPhase({ limit: 2, maxHop: 2 });
    const [first, second] = prepared.items;
    if (!first || !second) {
      throw new Error("test expected two prepared crawl tokens");
    }
    const foreignUrl = second.fetchPlan.kind === "single" ? second.fetchPlan.url : "";

    await expect(
      fetchCrawlPhase(first.preparedToken, [
        { body: providerRelease(1), outcome: "body", url: foreignUrl },
      ]),
    ).rejects.toThrow(/not for a url this claim issued/);
  });

  it("refuses a repeated url", async () => {
    const item = await prepareOne();
    await expect(
      fetchCrawlPhase(item.preparedToken, [
        { body: providerRelease(1), outcome: "body", url: RELEASE_URL },
        { body: providerRelease(2), outcome: "body", url: RELEASE_URL },
      ]),
    ).rejects.toThrow(/repeat a url/);
  });

  it("settles a supplied body past the envelope bound as a failed node, never a truncated one", async () => {
    refuseWorkerFetch();
    const item = await prepareOne();
    const receipt = await commitCrawlPhase(
      await fetchCrawlPhase(item.preparedToken, [
        {
          body: providerRelease(4, CRAWL_PHASE_TOKEN_MAX_BYTES),
          outcome: "body",
          url: RELEASE_URL,
        },
      ]),
    );

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { failed: 1, rateLimited: false },
    });
    const row = await db.execute(
      "select state, cursor from crawl_frontier where id = 'musicbrainz:release:release-phase'",
    );
    expect(row.rows[0]?.state).toBe("failed");
    expect((await db.execute("select count(*) as n from tracks")).rows[0]?.n).toBe(0);
  });

  it("returns a box-side throttle to the frontier without charging it a failure", async () => {
    refuseWorkerFetch();
    const item = await prepareOne();
    const receipt = await commitCrawlPhase(
      await fetchCrawlPhase(item.preparedToken, [{ outcome: "throttled", url: RELEASE_URL }]),
    );

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { failed: 1, rateLimited: true },
    });
    const row = await db.execute(
      "select state, failures from crawl_frontier where id = 'musicbrainz:release:release-phase'",
    );
    expect(row.rows[0]?.state).toBe("pending");
    expect(Number(row.rows[0]?.failures)).toBe(0);
  });

  it("charges a failure for a box-side body that is not JSON, exactly as a Worker fetch does", async () => {
    refuseWorkerFetch();
    const item = await prepareOne();
    const receipt = await commitCrawlPhase(
      await fetchCrawlPhase(item.preparedToken, [{ outcome: "invalid", url: RELEASE_URL }]),
    );

    expect(receipt).toMatchObject({
      outcome: "committed",
      result: { failed: 1, rateLimited: false },
    });
  });

  it("falls back to Worker egress for a url the box did not supply", async () => {
    const spy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(providerRelease(3)), { status: 200 })),
    );
    vi.stubGlobal("fetch", spy);
    const item = await prepareOne();

    const receipt = await commitCrawlPhase(await fetchCrawlPhase(item.preparedToken, []));
    expect(receipt).toMatchObject({ outcome: "committed", result: { tracksWritten: 3 } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ignores supplied bodies entirely once the flag is flipped off", async () => {
    await db.execute({
      args: [CRAWL_BOX_FETCH_ENABLED_KEY, "false"],
      sql: "insert into settings (key, value) values (?, ?)",
    });
    const spy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(providerRelease(2)), { status: 200 })),
    );
    vi.stubGlobal("fetch", spy);

    const prepared = await prepareCrawlPhase({ limit: 1, maxHop: 2 });

    expect(prepared.boxFetch).toBe(false);
    const item = prepared.items[0];
    if (!item) {
      throw new Error("test expected a prepared crawl token");
    }

    const receipt = await commitCrawlPhase(
      await fetchCrawlPhase(item.preparedToken, [
        { body: providerRelease(60), outcome: "body", url: RELEASE_URL },
      ]),
    );
    expect(receipt).toMatchObject({ outcome: "committed", result: { tracksWritten: 2 } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("accepts box-fetched bodies by default, so a new Worker and an old sweep agree", async () => {
    expect((await prepareCrawlPhase({ limit: 1, maxHop: 2 })).boxFetch).toBe(true);
  });

  it("issues a probe and a bounded offset slot for a re-armed browse tail", async () => {
    await seedBrowseNode();
    await db.execute(
      "update crawl_frontier set cursor = -1 where id = 'musicbrainz:artist:browse-artist'",
    );
    const item = await prepareOne();

    expect(item.fetchPlan).toEqual({
      countField: "release-count",
      kind: "tail",
      pageSize: 100,
      pageUrlTemplate:
        "https://musicbrainz.org/ws/2/release?artist=browse-artist&limit=100&offset={offset}&inc=labels&fmt=json",
      probeUrl:
        "https://musicbrainz.org/ws/2/release?artist=browse-artist&limit=1&offset=0&inc=labels&fmt=json",
    });

    refuseWorkerFetch();
    const receipt = await commitCrawlPhase(
      await fetchCrawlPhase(item.preparedToken, [
        {
          body: { "release-count": 250, releases: [] },
          outcome: "body",
          url: "https://musicbrainz.org/ws/2/release?artist=browse-artist&limit=1&offset=0&inc=labels&fmt=json",
        },
        {
          body: providerBrowse(2),
          outcome: "body",
          url: "https://musicbrainz.org/ws/2/release?artist=browse-artist&limit=100&offset=150&inc=labels&fmt=json",
        },
      ]),
    );
    expect(receipt).toMatchObject({ outcome: "committed", result: { expanded: 1 } });
  });

  it("refuses a tail page url whose offset slot is not a bounded integer", async () => {
    await seedBrowseNode();
    await db.execute(
      "update crawl_frontier set cursor = -1 where id = 'musicbrainz:artist:browse-artist'",
    );
    const item = await prepareOne();

    for (const offset of ["-1", "1e9", "150%20", "", "0150"]) {
      await expect(
        fetchCrawlPhase(item.preparedToken, [
          {
            body: providerBrowse(1),
            outcome: "body",
            url: `https://musicbrainz.org/ws/2/release?artist=browse-artist&limit=100&offset=${offset}&inc=labels&fmt=json`,
          },
        ]),
      ).rejects.toThrow(/not for a url this claim issued/);
    }
  });

  it("rejects a body submitted under an expired claim", async () => {
    const item = await prepareOne();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      await expect(
        fetchCrawlPhase(item.preparedToken, [
          { body: providerRelease(1), outcome: "body", url: RELEASE_URL },
        ]),
      ).rejects.toThrow(/expired crawl phase token/);
    } finally {
      vi.useRealTimers();
    }
  });
});
