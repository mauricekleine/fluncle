import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";
import {
  auditCrawlDueWork,
  claimCrawlDueWork,
  completeCrawlDueClaim,
  crawlClaimStatement,
  crawlGeneralReadyQuery,
  crawlReleaseReadyQuery,
  fanOutCrawlProjectionRepairs,
  markCrawlNodeRepairStatement,
  markCrawlNodeRepairsByUpdatedAtStatement,
  markCrawlProjectionRepairStatement,
  readCrawlDueRebuild,
  rebuildCrawlDueWork,
  repairCrawlDueNodes,
  runCrawlDueRebuildChunk,
  shadowCrawlDueWork,
} from "./crawl-due-work";

const NOW = new Date("2026-01-10T12:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => db.close());

async function label(slug: string, seedState: "disabled" | "enabled" | "undecided"): Promise<void> {
  await db.execute({
    args: [`label:${slug}`, slug, slug, seedState, OLD, OLD],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
  });
}

async function rule(
  artistMbid: string,
  options: { rearmedAt?: null | string; verdict?: "allow" | "block" } = {},
): Promise<void> {
  await db.execute({
    args: [
      `rule:${artistMbid}:${options.verdict ?? "allow"}`,
      artistMbid,
      artistMbid,
      options.verdict ?? "allow",
      options.rearmedAt === undefined ? OLD : options.rearmedAt,
      OLD,
      OLD,
    ],
    sql: `insert into artist_rules
      (id, artist_mbid, artist_name, verdict, source, rearmed_at, created_at, updated_at)
      values (?1, ?2, ?3, ?4, 'operator', ?5, ?6, ?7)`,
  });
}

async function node(options: {
  attemptedAt?: null | string;
  createdAt?: string;
  doneAt?: null | string;
  externalId: string;
  failures?: number;
  hop: number;
  id: string;
  kind: "artist" | "label" | "release";
  labelSlug?: null | string;
  parentId?: null | string;
  state?: "done" | "failed" | "pending" | "skipped";
}): Promise<void> {
  await db.execute({
    args: [
      options.id,
      options.kind,
      options.externalId,
      options.hop,
      options.parentId ?? null,
      options.labelSlug ?? null,
      options.state ?? "pending",
      options.failures ?? 0,
      options.attemptedAt ?? null,
      options.doneAt ?? null,
      options.createdAt ?? OLD,
      options.createdAt ?? OLD,
    ],
    sql: `insert into crawl_frontier
      (id, kind, source, external_id, hop, parent_id, label_slug, state, failures,
       attempted_at, done_at, created_at, updated_at)
      values (?, ?, 'musicbrainz', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

function planDetails(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => String(row["detail"]));
}

describe("crawl due-work shadow runtime", () => {
  it("couples frontier commits and rollbacks, suppresses no-ops, and marks exact bounded batches", async () => {
    await db.execute(`create trigger reject_crawl_repair before insert on crawl_due_work
      when new.node_id = 'rollback-node'
      begin
        select raise(abort, 'crawl marker rejected');
      end`);
    await expect(
      db.batch(
        [
          {
            args: ["rollback-node", OLD, OLD],
            sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, state, created_at, updated_at)
              values (?, 'artist', 'musicbrainz', 'rollback', 0, 'pending', ?, ?)`,
          },
          markCrawlNodeRepairStatement("rollback-node", "rollback-v1", {
            now: OLD,
            onlyIfPreviousStatementChanged: true,
          }),
        ],
        "write",
      ),
    ).rejects.toThrow("crawl marker rejected");
    expect(
      (await db.execute(`select id from crawl_frontier where id = 'rollback-node'`)).rows,
    ).toEqual([]);

    await db.batch(
      [
        { args: [], sql: `update crawl_frontier set hop = 9 where id = 'missing-node'` },
        markCrawlNodeRepairStatement("missing-node", "no-op-v1", {
          now: OLD,
          onlyIfPreviousStatementChanged: true,
        }),
      ],
      "write",
    );
    expect((await db.execute(`select node_id from crawl_due_work`)).rows).toEqual([]);

    await node({ externalId: "exact-a", hop: 0, id: "exact:a", kind: "artist" });
    await node({ externalId: "exact-b", hop: 0, id: "exact:b", kind: "artist" });
    await node({ externalId: "untouched", hop: 0, id: "exact:c", kind: "artist" });
    const updatedAt = "2026-01-02T00:00:00.000Z";
    await db.batch(
      [
        {
          args: [updatedAt, "exact:a", "exact:b"],
          sql: `update crawl_frontier set hop = 1, updated_at = ? where id in (?, ?)`,
        },
        markCrawlNodeRepairsByUpdatedAtStatement(
          ["exact:a", "exact:b", "exact:c"],
          "exact-v1",
          updatedAt,
        ),
      ],
      "write",
    );
    expect((await db.execute(`select node_id from crawl_due_work order by node_id`)).rows).toEqual([
      { node_id: "exact:a" },
      { node_id: "exact:b" },
    ]);
    expect(() =>
      markCrawlNodeRepairsByUpdatedAtStatement(
        Array.from({ length: 501 }, (_, index) => `node:${index}`),
        "too-wide",
        updatedAt,
      ),
    ).toThrow("1 through 500");
  });

  it("matches legacy eligibility, retry windows, stale rearm, and the two claim lanes", async () => {
    await label("enabled", "enabled");
    await label("off", "disabled");
    await rule("allowed-parent");
    await rule("blocked-parent", { verdict: "block" });
    await rule("sibling-artist");
    await rule("stale-artist");

    await node({
      externalId: "release-enabled",
      hop: 2,
      id: "release:enabled",
      kind: "release",
      labelSlug: "enabled",
    });
    await node({
      externalId: "release-allowed",
      hop: 1,
      id: "release:allowed",
      kind: "release",
      labelSlug: "off",
      parentId: "musicbrainz:artist:allowed-parent",
    });
    await node({
      externalId: "release-cold",
      hop: 0,
      id: "release:cold",
      kind: "release",
      labelSlug: "off",
    });
    await node({
      externalId: "release-blocked",
      hop: 1,
      id: "release:blocked",
      kind: "release",
      labelSlug: "off",
      parentId: "musicbrainz:artist:blocked-parent",
    });
    await node({
      createdAt: "2026-01-01T00:00:01.000Z",
      externalId: "artist-pending",
      hop: 0,
      id: "artist:pending",
      kind: "artist",
    });
    await node({
      attemptedAt: "2026-01-10T10:00:00.000Z",
      externalId: "artist-retry",
      failures: 1,
      hop: 0,
      id: "artist:retry-due",
      kind: "artist",
      state: "failed",
    });
    await node({
      attemptedAt: "2026-01-10T11:59:00.000Z",
      externalId: "artist-future",
      failures: 1,
      hop: 0,
      id: "artist:retry-future",
      kind: "artist",
      state: "failed",
    });
    await node({
      attemptedAt: OLD,
      externalId: "artist-terminal",
      failures: 5,
      hop: 0,
      id: "artist:terminal",
      kind: "artist",
      state: "failed",
    });
    await node({
      doneAt: "2026-01-08T00:00:00.000Z",
      externalId: "stale-artist",
      hop: 0,
      id: "musicbrainz:artist:stale-artist",
      kind: "artist",
      state: "done",
    });
    await node({
      doneAt: "2026-01-08T00:00:00.000Z",
      externalId: "blocked-parent",
      hop: 0,
      id: "musicbrainz:artist:blocked-parent",
      kind: "artist",
      state: "done",
    });
    await node({
      doneAt: "2026-01-08T00:00:00.000Z",
      externalId: "sibling-artist",
      hop: 9,
      id: "musicbrainz:artist:sibling-artist",
      kind: "artist",
      state: "done",
    });
    await node({
      externalId: "sibling-artist",
      hop: 9,
      id: "musicbrainz:artist:sibling-artist:pending",
      kind: "artist",
    });

    await rebuildCrawlDueWork(db, { generation: "crawl-a", limit: 2 });
    expect(
      (
        await db.execute(`select storable_rank from crawl_due_work
          where node_id = 'release:blocked'`)
      ).rows[0]?.storable_rank,
    ).toBe(1);
    expect(
      (
        await db.execute(`select node_id, state from crawl_due_work
          where node_id in ('musicbrainz:artist:blocked-parent',
            'musicbrainz:artist:sibling-artist') order by node_id`)
      ).rows,
    ).toEqual([{ node_id: "musicbrainz:artist:sibling-artist", state: "scheduled" }]);
    expect(
      (
        await db.execute(`select state from crawl_due_work
          where node_id = 'musicbrainz:artist:sibling-artist:pending'`)
      ).rows[0]?.state,
    ).toBe("ready");
    const shadow = await shadowCrawlDueWork(db, { limit: 5, now: () => NOW });

    expect(shadow.matched).toBe(true);
    expect(shadow.projectedIds).toEqual([
      "release:allowed",
      "release:enabled",
      "release:cold",
      "artist:retry-due",
      "musicbrainz:artist:stale-artist",
    ]);
    expect(
      await db.execute(`select state, cursor from crawl_frontier
        where id = 'musicbrainz:artist:stale-artist'`),
    ).toMatchObject({ rows: [{ cursor: -1, state: "pending" }] });

    const claim = await claimCrawlDueWork(db, {
      claimedBy: "worker-a",
      leaseMs: 60_000,
      limit: 5,
      now: () => NOW,
      token: "claim-a",
    });
    expect(claim.items.map((row) => row.nodeId)).toEqual(shadow.projectedIds);
    expect(claim.items.map((row) => row.claimPosition)).toEqual([0, 1, 2, 3, 4]);
    expect(claim.items.every((row) => row.claimedBy === "worker-a")).toBe(true);
    expect(
      (
        await claimCrawlDueWork(db, {
          claimedBy: "worker-a",
          leaseMs: 60_000,
          limit: 5,
          now: () => NOW,
          token: "claim-a",
        })
      ).items.map((row) => row.nodeId),
    ).toEqual(shadow.projectedIds);

    const reclaimed = await claimCrawlDueWork(db, {
      claimedBy: "worker-b",
      leaseMs: 60_000,
      limit: 5,
      now: () => new Date("2026-01-10T12:02:00.000Z"),
      token: "claim-b",
    });
    expect(reclaimed.reaped).toBe(5);
    expect(reclaimed.items.map((row) => row.nodeId)).toEqual(shadow.projectedIds);
    expect(await completeCrawlDueClaim(db, reclaimed.items[0]?.nodeId ?? "", "wrong-token")).toBe(
      false,
    );
    expect(await completeCrawlDueClaim(db, reclaimed.items[0]?.nodeId ?? "", "claim-b")).toBe(true);
  });

  it("starts every steady selector at the intended partial index without a source scan or temp sort", async () => {
    const release = crawlReleaseReadyQuery(10);
    const general = crawlGeneralReadyQuery(10);
    const claim = crawlClaimStatement({
      claimExpiresAt: "2026-01-10T12:01:00.000Z",
      claimToken: "token",
      claimedBy: "worker",
      limit: 10,
      now: NOW.toISOString(),
    });
    const releasePlan = planDetails(
      (await db.execute({ args: release.args, sql: `explain query plan ${release.sql}` })).rows,
    );
    const generalPlan = planDetails(
      (await db.execute({ args: general.args, sql: `explain query plan ${general.sql}` })).rows,
    );
    const claimPlan = planDetails(
      (await db.execute({ args: claim.args, sql: `explain query plan ${claim.sql}` })).rows,
    );
    const joined = [...releasePlan, ...generalPlan, ...claimPlan].join("\n");

    expect(releasePlan.join("\n")).toContain("crawl_due_work_release_ready_idx");
    expect(generalPlan.join("\n")).toContain("crawl_due_work_ready_idx");
    expect(claimPlan.join("\n")).toContain("crawl_due_work_release_ready_idx");
    expect(claimPlan.join("\n")).toContain("crawl_due_work_ready_idx");
    expect(joined).not.toContain("crawl_frontier");
    expect(joined).not.toContain("USE TEMP B-TREE");
  });

  it("fans label and artist rule changes through bounded indexed rows, then repairs exact facts", async () => {
    await label("lane", "disabled");
    await node({
      externalId: "r1",
      hop: 1,
      id: "release:1",
      kind: "release",
      labelSlug: "lane",
      parentId: "musicbrainz:artist:parent",
    });
    await node({
      externalId: "r2",
      hop: 1,
      id: "release:2",
      kind: "release",
      labelSlug: "lane",
    });
    await node({
      doneAt: OLD,
      externalId: "parent",
      hop: 0,
      id: "musicbrainz:artist:parent",
      kind: "artist",
      state: "done",
    });
    await rebuildCrawlDueWork(db, { generation: "crawl-fanout", limit: 2 });

    await db.batch(
      [
        {
          args: [],
          sql: `update labels set seed_state = 'enabled', updated_at = '2026-01-02'
            where slug = 'lane'`,
        },
        markCrawlProjectionRepairStatement("label", "lane", {
          sourceEpoch: 1,
          sourceVersion: "label-v1",
        }),
      ],
      "write",
    );
    expect((await fanOutCrawlProjectionRepairs(db, { limit: 1 })).complete).toBe(false);
    expect(await repairCrawlDueNodes(db, { limit: 10 })).toMatchObject({
      hasMore: true,
      repaired: 0,
      scanned: 0,
    });
    expect((await fanOutCrawlProjectionRepairs(db, { limit: 1 })).complete).toBe(true);
    await repairCrawlDueNodes(db, { limit: 10 });
    expect(
      (await db.execute(`select node_id, storable_rank from crawl_due_work order by node_id`)).rows,
    ).toEqual([
      { node_id: "release:1", storable_rank: 0 },
      { node_id: "release:2", storable_rank: 0 },
    ]);

    await db.batch(
      [
        {
          args: [],
          sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, source, rearmed_at, created_at, updated_at)
            values ('rule-parent', 'parent', 'Parent', 'allow', 'operator', '2026-01-01',
                    '2026-01-01', '2026-01-01')`,
        },
        markCrawlProjectionRepairStatement("artist", "parent", {
          sourceEpoch: 2,
          sourceVersion: "artist-v1",
        }),
      ],
      "write",
    );
    await fanOutCrawlProjectionRepairs(db, { limit: 10 });
    await repairCrawlDueNodes(db, { limit: 10, now: () => NOW });
    expect(
      (
        await db.execute(`select state from crawl_due_work
        where node_id = 'musicbrainz:artist:parent'`)
      ).rows[0]?.state,
    ).toBe("scheduled");
  });

  it("preserves a newer crawl source marker that lands during bounded fanout", async () => {
    await label("race", "enabled");
    await node({
      externalId: "race-release",
      hop: 1,
      id: "release:race",
      kind: "release",
      labelSlug: "race",
    });
    await rebuildCrawlDueWork(db, { generation: "crawl-race", limit: 10 });
    await db.execute(
      markCrawlProjectionRepairStatement("label", "race", {
        sourceVersion: "marker-old",
      }),
    );
    let intercepted = false;
    const racingClient = {
      batch: async (...args: Parameters<Client["batch"]>) => {
        if (!intercepted) {
          intercepted = true;
          await db.execute({
            args: [],
            sql: `update crawl_projection_repairs
                  set source_epoch = source_epoch + 1, source_version = 'marker-new'
                  where source_type = 'label' and source_id = 'race'`,
          });
        }
        return db.batch(...args);
      },
      execute: db.execute.bind(db),
    };

    expect((await fanOutCrawlProjectionRepairs(racingClient, { limit: 1 })).complete).toBe(false);
    expect(
      (
        await db.execute(`select source_version from crawl_projection_repairs
          where source_type = 'label' and source_id = 'race'`)
      ).rows[0]?.source_version,
    ).toBe("marker-new");
  });

  it("resumes a sorted rebuild, preserves newer live repair, detects drift, and converges boundedly", async () => {
    for (let index = 0; index < 5; index += 1) {
      await node({
        externalId: `node-${index}`,
        hop: index % 2,
        id: `artist:${index}`,
        kind: "artist",
      });
    }
    const first = await runCrawlDueRebuildChunk(db, {
      generation: "crawl-resume",
      limit: 2,
      newGeneration: true,
      now: () => new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(first.complete).toBe(false);
    expect(first.checkpoint.cursor).toBe("artist:1");

    await db.batch(
      [
        {
          args: [],
          sql: `update crawl_frontier set hop = 9, updated_at = '2026-01-10T01:00:00.000Z'
            where id = 'artist:4'`,
        },
        markCrawlNodeRepairStatement("artist:4", "writer-v2", {
          now: "2026-01-10T01:00:00.000Z",
        }),
      ],
      "write",
    );
    await repairCrawlDueNodes(db, {
      limit: 10,
      now: () => new Date("2026-01-10T01:00:00.000Z"),
    });
    await rebuildCrawlDueWork(db, { generation: "ignored", limit: 2 });
    expect((await readCrawlDueRebuild(db))?.scannedCount).toBe(5);
    expect(
      (await db.execute(`select generation, hop from crawl_due_work where node_id = 'artist:4'`))
        .rows[0],
    ).toEqual({ generation: "live", hop: 9 });

    await db.execute(`update crawl_due_work set hop = 77 where node_id = 'artist:3'`);
    const drift = await auditCrawlDueWork(db, { repairLimit: 1, sourceVersion: "audit-v1" });
    expect(drift.matched).toBe(false);
    expect(drift.repairNodeIds).toEqual(["artist:3"]);
    await repairCrawlDueNodes(db, { limit: 1 });
    expect((await auditCrawlDueWork(db)).matched).toBe(true);

    await db.batch(
      [
        { args: ["artist:2"], sql: `delete from crawl_frontier where id = ?` },
        markCrawlNodeRepairStatement("artist:2", "writer-delete", {
          now: "2026-01-10T02:00:00.000Z",
        }),
      ],
      "write",
    );
    expect(
      (await db.execute(`select state from crawl_due_work where node_id = 'artist:2'`)).rows[0]
        ?.state,
    ).toBe("repair");
    await repairCrawlDueNodes(db, { limit: 1 });
    expect(
      (await db.execute(`select count(*) as total from crawl_due_work where node_id = 'artist:2'`))
        .rows[0]?.total,
    ).toBe(0);
    expect((await auditCrawlDueWork(db)).matched).toBe(true);
  });
});
