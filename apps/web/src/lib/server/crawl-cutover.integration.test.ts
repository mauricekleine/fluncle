import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: async () => holder.db };
});

import { createIntegrationDb } from "./integration-db";
import {
  CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND,
  crawlCatalogue,
  initializeCrawlPhase,
} from "./crawl";
import { rebuildCrawlDueWork } from "./crawl-due-work";
import {
  CRAWL_CLAIM_REPAIR_DRAIN_BUDGET,
  CRAWL_CLAIM_SOURCE_MARKER_DRAIN_CAPACITY,
  CRAWL_DUE_CUTOVER_ENABLED_KEY,
  claimCrawlFrontierRows,
  isCrawlDueCutoverEnabled,
  settleClaimedCrawlFrontierRow,
  type CrawlClaimRepairDrainBudget,
} from "./crawl-cutover";
import { DueWorkMaintenancePendingError } from "./due-work";

const OLD = "2026-01-01T00:00:00.000Z";

/** A drain budget whose units are one row, so a small fixture exercises the multi-unit lanes. */
function narrowBudget(
  overrides: Partial<CrawlClaimRepairDrainBudget> = {},
): CrawlClaimRepairDrainBudget {
  return {
    nodeChunkRows: 1,
    nodeChunks: 8,
    sourcePageMarkers: 1,
    sourcePageRows: 1,
    sourcePages: 8,
    wallMs: 60_000,
    ...overrides,
  };
}

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

async function markLabelRepair(slug: string): Promise<void> {
  await db.execute({
    args: ["label", slug, 1, `source-version:${slug}`, OLD, OLD],
    sql: `insert into crawl_projection_repairs
      (source_type, source_id, source_epoch, source_version, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
  });
}

/** Three ready release nodes on one enabled label, the shape one repair marker fans out across. */
async function seedRepairableLabel(slug: string): Promise<string[]> {
  await seedLabel(slug, true);
  const ids = ["a", "b", "c"].map((suffix) => `release:${slug}-${suffix}`);
  for (const id of ids) {
    await seedNode({ externalId: id, hop: 0, id, kind: "release", labelSlug: slug });
  }
  await rebuildCrawlDueWork(db, { generation: `crawl-${slug}`, limit: 10 });
  return ids;
}

async function countByState(state: string): Promise<number> {
  const result = await db.execute({
    args: [state],
    sql: "select count(*) as n from crawl_due_work where state = ?",
  });
  return Number(result.rows[0]?.n ?? 0);
}

async function countRepairMarkers(): Promise<number> {
  const result = await db.execute("select count(*) as n from crawl_projection_repairs");
  return Number(result.rows[0]?.n ?? 0);
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
      return sql.includes("from crawl_frontier frontier") && sql.includes("frontier.id in");
    });
    expect(hydration).toBeDefined();
    const hydrationSql = typeof hydration === "string" ? hydration : hydration?.sql;
    expect(hydrationSql).not.toContain("order by");
    expect(typeof hydration === "string" ? [] : hydration?.args).toHaveLength(5);
    if (hydration !== undefined) {
      const explainedSql = typeof hydration === "string" ? hydration : hydration.sql;
      const plan = await db.execute({
        args: typeof hydration === "string" ? [] : hydration.args,
        sql: `explain query plan ${explainedSql}`,
      });
      const details = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");
      expect(details).toContain("SEARCH frontier");
      expect(details).not.toContain("SCAN frontier");
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

  it("drains a source marker no single fan-out page can clear, then claims", async () => {
    const ids = await seedRepairableLabel("wide");
    await markLabelRepair("wide");

    const claim = await claimCrawlFrontierRows(db, {
      budget: narrowBudget(),
      claimedBy: "test-pass",
      leaseMs: 60_000,
      limit: ids.length,
      token: "wide-token",
    });

    expect(claim.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(await countRepairMarkers()).toBe(0);
    expect(await countByState("repair")).toBe(0);
  });

  it("defers with the typed maintenance fault when source repair outlasts the drain budget", async () => {
    await seedRepairableLabel("deferred");
    await markLabelRepair("deferred");

    await expect(
      claimCrawlFrontierRows(db, {
        budget: narrowBudget({ sourcePages: 2 }),
        claimedBy: "test-pass",
        leaseMs: 60_000,
        limit: 3,
        token: "deferred-token",
      }),
    ).rejects.toBeInstanceOf(DueWorkMaintenancePendingError);

    // The deferred claim still converged the repair its budget allowed, so the next pass resumes
    // from that durable progress instead of starting the fan-out over.
    expect(await countByState("repair")).toBe(2);
    expect(await countRepairMarkers()).toBe(1);
  });

  it("drains node repair across chunks and defers when its chunk budget runs out", async () => {
    const ids = await seedRepairableLabel("nodes");
    await db.execute("update crawl_due_work set state = 'repair'");

    await expect(
      claimCrawlFrontierRows(db, {
        budget: narrowBudget({ nodeChunks: 1 }),
        claimedBy: "test-pass",
        leaseMs: 60_000,
        limit: 3,
        token: "nodes-deferred",
      }),
    ).rejects.toBeInstanceOf(DueWorkMaintenancePendingError);
    expect(await countByState("repair")).toBe(2);

    const claim = await claimCrawlFrontierRows(db, {
      budget: narrowBudget(),
      claimedBy: "test-pass",
      leaseMs: 60_000,
      limit: ids.length,
      token: "nodes-token",
    });
    expect(claim.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(await countByState("repair")).toBe(0);
  });

  it("stops the drain at the wall bound after the first unit", async () => {
    await seedRepairableLabel("stalled");
    await markLabelRepair("stalled");
    let reading = 0;
    const stalledClock = (): number => {
      const current = reading;
      reading += 1_000;
      return current;
    };

    await expect(
      claimCrawlFrontierRows(db, {
        budget: narrowBudget({ wallMs: 500 }),
        claimedBy: "test-pass",
        leaseMs: 60_000,
        limit: 3,
        now: stalledClock,
        token: "stalled-token",
      }),
    ).rejects.toBeInstanceOf(DueWorkMaintenancePendingError);
    // The first page always runs, so even a claim the wall bound stops advances the repair by one.
    expect(await countByState("repair")).toBe(1);
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

  it("absorbs more admission-minted source markers than its page budget and still claims", async () => {
    // THE ADMISSION INVARIANT, end to end: an operator ruling that lands many allow rules at once
    // makes one admission phase mint more source markers than the claim has pages. The claim must
    // clear all of them and go on to claim, or every tick after it answers pending instead.
    const rules = CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.sourcePages + 2;
    expect(rules).toBeLessThanOrEqual(CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND);
    for (let index = 0; index < rules; index += 1) {
      await seedAllowedRule(`absorb-${index}`, null);
    }
    const ids = await seedRepairableLabel("absorb");
    await setCutover("true");

    const initialization = await initializeCrawlPhase();
    expect(initialization.artistsRearmed).toBe(rules);
    expect(await countRepairMarkers()).toBe(rules);

    const claim = await claimCrawlFrontierRows(db, {
      claimedBy: "test-pass",
      leaseMs: 60_000,
      limit: ids.length,
      token: "absorb-token",
    });

    expect(claim.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(await countRepairMarkers()).toBe(0);
    expect(await countByState("repair")).toBe(0);
  });

  it("drains every source marker one admission phase can mint", () => {
    expect(CRAWL_ADMISSION_SOURCE_MARKER_MINT_BOUND).toBeLessThan(
      CRAWL_CLAIM_SOURCE_MARKER_DRAIN_CAPACITY,
    );
  });
});
