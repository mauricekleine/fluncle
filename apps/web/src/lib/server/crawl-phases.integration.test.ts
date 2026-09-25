import { type Client } from "@libsql/client";
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
  commitCrawlPhase,
  CRAWL_PHASE_TOKEN_MAX_BYTES,
  type CrawlPhasePrepareResult,
  crawlCatalogue as runCrawlCatalogue,
  fetchCrawlPhase,
  initializeCrawlPhase,
  prepareCrawlPhase,
} from "./crawl";
import { CRAWL_BOX_FETCH_ENABLED_KEY, CRAWL_DUE_CUTOVER_ENABLED_KEY } from "./crawl-cutover";
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
  const counts: TransactionCounts = { batch: 0, commit: 0, execute: 0, maxBatchStatements: 0 };
  const originalTransaction = client.transaction.bind(client);
  client.transaction = (async (...args: Parameters<Client["transaction"]>) => {
    const transaction = await originalTransaction(...args);
    const originalExecute = transaction.execute.bind(transaction);
    const originalBatch = transaction.batch.bind(transaction);
    const originalCommit = transaction.commit.bind(transaction);
    transaction.execute = ((...executeArgs: Parameters<typeof transaction.execute>) => {
      counts.execute += 1;
      return originalExecute(...executeArgs);
    }) as typeof transaction.execute;
    transaction.batch = ((...batchArgs: Parameters<typeof transaction.batch>) => {
      counts.batch += 1;
      const statements = batchArgs[0];
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
  it("preserves the first-prepare repair sample flag through the oRPC input contract", () => {
    const delivered = crawlInputSchema.parse({
      body: { limit: 1, maxHop: 2, phase: "prepare", sampleStorableRepair: true },
      query: {},
    });
    expect(delivered.body).toMatchObject({ phase: "prepare", sampleStorableRepair: true });
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
          new Response(JSON.stringify(providerReleaseWithArtistCount(100, 0, 1)), { status: 200 }),
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
    ).toBe(22);
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
