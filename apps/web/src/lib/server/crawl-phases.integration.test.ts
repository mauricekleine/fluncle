import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIntegrationDb } from "./integration-db";
import { markCrawlNodeRepairStatement, rebuildCrawlDueWork } from "./crawl-due-work";
import {
  commitCrawlPhase,
  CRAWL_PHASE_TOKEN_MAX_BYTES,
  fetchCrawlPhase,
  prepareCrawlPhase,
} from "./crawl";
import { CRAWL_DUE_CUTOVER_ENABLED_KEY } from "./crawl-cutover";
import { setMusicbrainzRateLimitForTests } from "./musicbrainz";

let db: Client;
let fixtureDirectory: string | undefined;
const timestamp = "2026-08-01T00:00:00.000Z";

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
