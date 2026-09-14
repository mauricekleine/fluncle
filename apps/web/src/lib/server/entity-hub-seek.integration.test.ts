import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// THE ENTITY HUBS PAST THEIR SHALLOW PAGES, against the real migrated schema.
//
// A numbered `/albums` · `/labels` · `/artists` page past the shallow offset threshold (and the MCP
// browse twin) is served off persisted boundaries. Only the gated total reads the whole entity
// table; the fingerprint's first row and the page itself walk the entity's unique slug index. These
// tests pin both halves of that contract: every page is exactly the slice of the unified
// alphabetical order the shallow path would serve (with the same total and A–Z lane), and the
// boundary statements take the slug index with no temp b-tree.

let db: Client;
let execute: MockInstance<Client["execute"]>;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

/** The SQL of every statement the reads under test have executed since the last reset. */
function executedSql(): string[] {
  return execute.mock.calls.map((call) => {
    const statement: unknown = call[0];

    if (typeof statement === "string") {
      return statement;
    }

    return typeof statement === "object" &&
      statement !== null &&
      "sql" in statement &&
      typeof statement.sql === "string"
      ? statement.sql
      : "";
  });
}

// Imported AFTER the mock so each module's `getDb` reads the fixture database.
const { ALBUMS_HUB_QUERY, listAlbumsHubPage } = await import("./albums");
const { ARTISTS_HUB_QUERY, listArtistsHubPage } = await import("./artists");
const {
  CATALOGUE_BROWSE_PAGE_SIZE,
  CATALOGUE_HUB_DEFAULT_LIMIT,
  LABELS_HUB_QUERY,
  catalogueEntityOffsetPageQuery,
  catalogueEntitySeekPageQuery,
  listLabelsBrowsePage,
  listLabelsHubPage,
} = await import("./labels");

type EntityTable = "albums" | "artists" | "labels";

type SeededEntity = { certified: number; id: string; renderable: number; slug: string };

const NOW = "2026-07-01T00:00:00.000Z";

/**
 * A deterministic entity world whose slug order, id order, and insertion order all disagree. Three
 * rows in five clear the gate (a floor-clearing catalogue row, or a CERTIFIED sub-floor row); the
 * other two are sub-floor catalogue rows that must never appear. Some slugs lead with a digit, so
 * the A–Z lane carries its `#` bucket.
 */
function entityWorld(count: number, prefix = ""): SeededEntity[] {
  return Array.from({ length: count }, (_, index) => {
    const band = index % 5;
    const lead =
      index % 9 === 0 ? String(index % 10) : String.fromCharCode(97 + ((index * 7) % 26));

    return {
      certified: band === 1 ? 1 : 0,
      id: `e-${prefix}${String((index * 7919) % 100_003).padStart(6, "0")}`,
      renderable: band === 1 ? 1 : band === 2 ? 2 : band === 3 ? 0 : 3 + (index % 4),
      slug: `${prefix}${lead}-entity-${String((index * 37) % 1000).padStart(3, "0")}-${index}`,
    };
  });
}

async function seedEntities(table: EntityTable, rows: SeededEntity[]): Promise<void> {
  await db.batch(
    rows.map((row) => ({
      args: [row.id, `Name ${row.slug}`, row.slug, NOW, NOW, row.renderable, row.certified],
      sql: `insert into ${table}
              (id, name, slug, created_at, updated_at, renderable_track_count, certified_finding_count)
            values (?, ?, ?, ?, ?, ?, ?)`,
    })),
    "write",
  );
}

/** The unified hub order over the gated set, computed independently of any SQL under test. */
function gatedOrder(rows: SeededEntity[]): string[] {
  return rows
    .filter((row) => row.certified > 0 || row.renderable >= 3)
    .sort((left, right) =>
      left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : left.id < right.id ? -1 : 1,
    )
    .map((row) => row.slug);
}

function pageSlugs(order: string[], page: number, pageSize: number): string[] {
  return order.slice((page - 1) * pageSize, page * pageSize);
}

async function storedFingerprint(hub: string): Promise<string | undefined> {
  const result = await db.execute({
    args: [hub],
    sql: `select fingerprint from hub_page_anchors where hub = ?`,
  });
  const fingerprint = result.rows[0]?.fingerprint;

  return typeof fingerprint === "string" ? fingerprint : undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute = vi.spyOn(db, "execute");
});

const HUBS = [
  {
    list: (page: number) => listAlbumsHubPage(page),
    name: "albums",
    table: "albums" as const,
  },
  {
    list: (page: number) => listLabelsHubPage(page),
    name: "labels",
    table: "labels" as const,
  },
  {
    list: (page: number) => listArtistsHubPage(page),
    name: "artists",
    table: "artists" as const,
  },
];

describe.each(HUBS)("the $name hub past its shallow pages", (hub) => {
  it("serves every deep page off persisted boundaries as the exact slice of the unified order", async () => {
    const rows = entityWorld(1_100);
    const order = gatedOrder(rows);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;
    const pageCount = Math.ceil(order.length / pageSize);

    await seedEntities(hub.table, rows);

    const shallow = await hub.list(1);
    // No boundaries yet: the direct slice answers, and a build is scheduled behind it.
    const unanchored = await hub.list(11);

    expect(pageCount).toBeGreaterThan(11);
    expect(unanchored.items.map((item) => item.slug)).toEqual(pageSlugs(order, 11, pageSize));
    await vi.waitFor(async () => expect(await storedFingerprint(`${hub.name}-hub`)).toBeDefined());

    for (let page = 11; page <= pageCount; page += 1) {
      execute.mockClear();

      const served = await hub.list(page);

      expect(served.items.map((item) => item.slug)).toEqual(pageSlugs(order, page, pageSize));
      expect(served.total).toBe(order.length);
      expect(served.pageCount).toBe(pageCount);
      expect(served.letters).toEqual(shallow.letters);
      // The boundary path answered, and no statement on it materialized the whole gated set.
      expect(executedSql().some((sql) => sql.includes("from hub_page_anchors"))).toBe(true);
      expect(executedSql().some((sql) => sql.includes("materialized"))).toBe(false);
    }
  });

  it("keeps a stale boundary set serving and rebuilds it to the exact order", async () => {
    const rows = entityWorld(1_100);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;

    await seedEntities(hub.table, rows);
    await hub.list(11);
    await vi.waitFor(async () => expect(await storedFingerprint(`${hub.name}-hub`)).toBeDefined());

    const builtFingerprint = await storedFingerprint(`${hub.name}-hub`);
    // Forty more entities sorting ahead of every boundary: the total and the first row both move.
    const grown = entityWorld(40, "0-new-");

    await seedEntities(hub.table, grown);

    const order = gatedOrder([...rows, ...grown]);
    const stale = await hub.list(12);

    // The total is always read live, whatever the boundaries say.
    expect(stale.total).toBe(order.length);
    await vi.waitFor(async () =>
      expect(await storedFingerprint(`${hub.name}-hub`)).not.toBe(builtFingerprint),
    );

    for (const page of [11, 12, Math.ceil(order.length / pageSize)]) {
      const rebuilt = await hub.list(page);

      expect(rebuilt.items.map((item) => item.slug)).toEqual(pageSlugs(order, page, pageSize));
    }
  });
});

describe("the MCP browse past its shallow pages", () => {
  it("serves deep browse pages off boundaries, with the entity name riding the row", async () => {
    const rows = entityWorld(1_100);
    const order = gatedOrder(rows);
    const pageSize = CATALOGUE_BROWSE_PAGE_SIZE;
    const pageCount = Math.ceil(order.length / pageSize);

    await seedEntities("labels", rows);
    await listLabelsBrowsePage(11);
    await vi.waitFor(async () => expect(await storedFingerprint("labels-browse")).toBeDefined());

    for (let page = 11; page <= pageCount; page += 1) {
      execute.mockClear();

      const served = await listLabelsBrowsePage(page);

      expect(served.items.map((item) => item.slug)).toEqual(pageSlugs(order, page, pageSize));
      expect(served.items.map((item) => item.name)).toEqual(
        pageSlugs(order, page, pageSize).map((slug) => `Name ${slug}`),
      );
      expect(served.total).toBe(order.length);
      expect(executedSql().some((sql) => sql.includes("materialized"))).toBe(false);
    }
  });
});

describe("the boundary statements on the real schema", () => {
  const QUERIES = [
    { index: "albums_slug_unique", query: ALBUMS_HUB_QUERY },
    { index: "labels_slug_unique", query: LABELS_HUB_QUERY },
    { index: "artists_slug_unique", query: ARTISTS_HUB_QUERY },
  ];

  async function planDetails(statement: { args: (number | string)[]; sql: string }) {
    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });

    return plan.rows.map((row) => (typeof row.detail === "string" ? row.detail : "")).join("\n");
  }

  it.each(QUERIES)(
    "walks $index for the first-row probe and seeks it for the page",
    async ({ index, query }) => {
      const firstRow = await planDetails(catalogueEntityOffsetPageQuery(query, 1, 0));
      const seek = await planDetails(
        catalogueEntitySeekPageQuery(query, CATALOGUE_HUB_DEFAULT_LIMIT, 12, [
          { id: "boundary-id", key: "m", page: 12 },
        ]),
      );

      expect(firstRow).toContain(`USING INDEX ${index}`);
      expect(firstRow).not.toContain("USE TEMP B-TREE");
      expect(seek).toContain(`USING INDEX ${index} (slug>?)`);
      expect(seek).not.toContain("USE TEMP B-TREE");
    },
  );
});
