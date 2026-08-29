import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import { crawlCatalogue } from "./crawl";
import { rebuildCrawlDueWork } from "./crawl-due-work";
import {
  CRAWL_DUE_CUTOVER_ENABLED_KEY,
  claimCrawlFrontierRows,
  isCrawlDueCutoverEnabled,
  settleClaimedCrawlFrontierRow,
} from "./crawl-cutover";

const OLD = "2026-01-01T00:00:00.000Z";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

afterEach(() => db.close());

async function setCutover(value: string): Promise<void> {
  await db.execute({
    args: [CRAWL_DUE_CUTOVER_ENABLED_KEY, value],
    sql: `insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value`,
  });
}

async function seedLabel(slug: string, enabled: boolean): Promise<void> {
  await db.execute({
    args: [`label:${slug}`, slug, slug, enabled ? "enabled" : "disabled", OLD, OLD],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
  });
}

async function seedNode(options: {
  createdAt?: string;
  externalId: string;
  hop: number;
  id: string;
  kind: "artist" | "label" | "release";
  labelSlug?: string;
  source?: "fluncle" | "musicbrainz";
}): Promise<void> {
  await db.execute({
    args: [
      options.id,
      options.kind,
      options.source ?? "musicbrainz",
      options.externalId,
      options.hop,
      options.labelSlug ?? null,
      options.createdAt ?? OLD,
      options.createdAt ?? OLD,
    ],
    sql: `insert into crawl_frontier
      (id, kind, source, external_id, hop, label_slug, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function seedAllowedRule(artistMbid: string, rearmedAt: null | string = OLD): Promise<void> {
  await db.execute({
    args: [`rule:${artistMbid}`, artistMbid, artistMbid, rearmedAt, OLD, OLD],
    sql: `insert into artist_rules
      (id, artist_mbid, artist_name, verdict, source, rearmed_at, created_at, updated_at)
      values (?1, ?2, ?3, 'allow', 'operator', ?4, ?5, ?6)`,
  });
}

describe("crawl runtime cutover", () => {
  it("is default-off, exact-literal-true, and fail-closed on a settings read error", async () => {
    expect(await isCrawlDueCutoverEnabled()).toBe(false);
    await setCutover("false");
    expect(await isCrawlDueCutoverEnabled()).toBe(false);
    await setCutover("1");
    expect(await isCrawlDueCutoverEnabled()).toBe(false);
    await setCutover("true");
    expect(await isCrawlDueCutoverEnabled()).toBe(true);

    holder.db = {
      execute: async () => {
        throw new Error("settings unavailable");
      },
    } as unknown as Client;
    expect(await isCrawlDueCutoverEnabled()).toBe(false);
  });

  it("claims the two maintained lanes and hydrates only claimed PKs in claim_position order", async () => {
    await seedLabel("enabled", true);
    await seedLabel("off", false);
    await seedNode({
      externalId: "cold",
      hop: 0,
      id: "release:cold",
      kind: "release",
      labelSlug: "off",
    });
    await seedNode({
      externalId: "enabled",
      hop: 2,
      id: "release:enabled",
      kind: "release",
      labelSlug: "enabled",
    });
    await seedNode({ externalId: "label", hop: 0, id: "label:zero", kind: "label" });
    await seedNode({ externalId: "artist", hop: 1, id: "artist:one", kind: "artist" });
    await rebuildCrawlDueWork(db, { generation: "crawl-cutover", limit: 10 });

    const statements: InStatement[] = [];
    const traced = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement) => {
        statements.push(statement);
        return db.execute(statement);
      },
    };
    const claim = await claimCrawlFrontierRows(traced, {
      claimedBy: "test-pass",
      leaseMs: 60_000,
      limit: 4,
      token: "claim-token",
    });
    expect(claim.rows.map((row) => row.id)).toEqual([
      "release:enabled",
      "release:cold",
      "label:zero",
      "artist:one",
    ]);
    const hydration = statements.find((statement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      return sql.includes("from crawl_frontier") && sql.includes("where id in");
    });
    expect(hydration).toBeDefined();
    const hydrationSql = typeof hydration === "string" ? hydration : hydration?.sql;
    expect(hydrationSql).not.toContain("order by");
    expect(typeof hydration === "string" ? [] : hydration?.args).toHaveLength(4);
    if (hydration !== undefined) {
      const explainedSql = typeof hydration === "string" ? hydration : hydration.sql;
      const plan = await db.execute({
        args: typeof hydration === "string" ? [] : hydration.args,
        sql: `explain query plan ${explainedSql}`,
      });
      const details = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");
      expect(details).toContain("SEARCH crawl_frontier");
      expect(details).not.toContain("SCAN crawl_frontier");
      expect(details).not.toContain("USE TEMP B-TREE");
    }
  });

  it("atomically settles only the owned token and rolls source, lease, and marker back together", async () => {
    await seedNode({ externalId: "atomic", hop: 0, id: "artist:atomic", kind: "artist" });
    await rebuildCrawlDueWork(db, { generation: "crawl-atomic", limit: 10 });
    await claimCrawlFrontierRows(db, {
      claimedBy: "test-pass",
      leaseMs: 60_000,
      limit: 1,
      token: "owned-token",
    });

    expect(
      await settleClaimedCrawlFrontierRow(db, {
        claimToken: "stale-token",
        failures: 1,
        id: "artist:atomic",
        state: "failed",
      }),
    ).toBe(false);
    expect(
      (await db.execute(`select state, attempts from crawl_frontier where id = 'artist:atomic'`))
        .rows[0],
    ).toEqual({ attempts: 0, state: "pending" });

    await db.execute(`create trigger reject_claim_repair before insert on crawl_due_work
      when new.node_id = 'artist:atomic' and new.state = 'repair'
      begin select raise(abort, 'repair rejected'); end`);
    await expect(
      settleClaimedCrawlFrontierRow(db, {
        claimToken: "owned-token",
        id: "artist:atomic",
        state: "done",
      }),
    ).rejects.toThrow("repair rejected");
    expect(
      (await db.execute(`select state, attempts from crawl_frontier where id = 'artist:atomic'`))
        .rows[0],
    ).toEqual({ attempts: 0, state: "pending" });
    expect(
      (
        await db.execute(
          `select state, claim_token from crawl_due_work where node_id = 'artist:atomic'`,
        )
      ).rows[0],
    ).toEqual({ claim_token: "owned-token", state: "leased" });

    await db.execute(`drop trigger reject_claim_repair`);
    expect(
      await settleClaimedCrawlFrontierRow(db, {
        claimToken: "owned-token",
        cursor: 7,
        failures: 1,
        id: "artist:atomic",
        note: "temporary",
        state: "failed",
      }),
    ).toBe(true);
    expect(
      (
        await db.execute(`select state, cursor, failures, attempts
          from crawl_frontier where id = 'artist:atomic'`)
      ).rows[0],
    ).toEqual({ attempts: 1, cursor: 7, failures: 1, state: "failed" });
    expect(
      (
        await db.execute(
          `select state, claim_token from crawl_due_work where node_id = 'artist:atomic'`,
        )
      ).rows[0],
    ).toEqual({ claim_token: null, state: "repair" });
  });

  it("routes an open crawl pass through claims and never issues the legacy selector", async () => {
    await seedLabel("off", false);
    await seedNode({
      externalId: "off",
      hop: 0,
      id: "fluncle:label:off",
      kind: "label",
      labelSlug: "off",
      source: "fluncle",
    });
    await rebuildCrawlDueWork(db, { generation: "crawl-open", limit: 10 });
    await setCutover("true");

    const statements: string[] = [];
    const guarded = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);
        if (sql.includes("order by is_storable desc")) {
          throw new Error("legacy crawl selector reached");
        }
        return db.execute(statement);
      },
    } as Client;
    holder.db = guarded;
    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(pass).toMatchObject({ expanded: 1, failed: 0 });
    expect(statements.some((sql) => sql.includes("claim_position"))).toBe(true);
    expect(statements.some((sql) => sql.includes("order by is_storable desc"))).toBe(false);
  });

  it("rearms stale allowed artists from bounded due state even when no nodes are claimed", async () => {
    await seedAllowedRule("stale-allowed");
    await seedNode({
      externalId: "stale-allowed",
      hop: 0,
      id: "musicbrainz:artist:stale-allowed",
      kind: "artist",
    });
    await db.execute({
      args: [OLD, OLD],
      sql: `update crawl_frontier
        set state = 'done', done_at = ?, updated_at = ?
        where id = 'musicbrainz:artist:stale-allowed'`,
    });
    await rebuildCrawlDueWork(db, { generation: "crawl-stale-rearm", limit: 10 });
    await setCutover("true");

    expect(
      (
        await db.execute(`select state from crawl_due_work
          where node_id = 'musicbrainz:artist:stale-allowed'`)
      ).rows[0]?.state,
    ).toBe("scheduled");

    const statements: string[] = [];
    const guarded = {
      batch: db.batch.bind(db),
      execute: async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);
        if (
          sql.includes("select node.id from crawl_frontier as node") &&
          sql.includes("outstanding.rearmed_at is null")
        ) {
          throw new Error("legacy stale-artist selector reached");
        }
        return db.execute(statement);
      },
    } as Client;
    holder.db = guarded;

    const pass = await crawlCatalogue({ limit: 0 });
    expect(pass.artistsRearmed).toBe(1);
    expect(
      (
        await db.execute(`select state, cursor from crawl_frontier
          where id = 'musicbrainz:artist:stale-allowed'`)
      ).rows[0],
    ).toEqual({ cursor: -1, state: "pending" });
    expect(
      statements.some(
        (sql) =>
          sql.includes("select node.id from crawl_frontier as node") &&
          sql.includes("outstanding.rearmed_at is null"),
      ),
    ).toBe(false);
  });

  it("drains multiple bounded rule fanouts before claiming", async () => {
    await seedAllowedRule("forward-a", null);
    await seedAllowedRule("forward-b", null);
    await setCutover("true");

    const pass = await crawlCatalogue({ limit: 0 });
    expect(pass.artistsRearmed).toBe(2);
    expect(
      (
        await db.execute(`select node_id, state from crawl_due_work
          where node_id in ('musicbrainz:artist:forward-a', 'musicbrainz:artist:forward-b')
          order by node_id`)
      ).rows,
    ).toEqual([
      { node_id: "musicbrainz:artist:forward-a", state: "ready" },
      { node_id: "musicbrainz:artist:forward-b", state: "ready" },
    ]);
    expect(
      (await db.execute("select count(*) as n from crawl_projection_repairs")).rows[0]?.n,
    ).toBe(0);
  });
});
