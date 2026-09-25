import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";

let db: Client;
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});
const { hubClauseHash } = await import("./hub-page-anchors");
const { ALBUMS_HUB_QUERY, listAlbumsHubPage, listAlbumsThisMonth } = await import("./albums");
const { ARTISTS_HUB_QUERY, listArtistsHubPage, listArtistsThisMonth } = await import("./artists");
const { LABELS_HUB_QUERY, catalogueEntityOffsetPageQuery, listLabelsHubPage, listLabelsThisMonth } =
  await import("./labels");

beforeEach(async () => {
  db = await createIntegrationDb();
});

const hubs = [
  { list: listAlbumsHubPage, query: ALBUMS_HUB_QUERY, strip: listAlbumsThisMonth, table: "albums" },
  {
    list: listArtistsHubPage,
    query: ARTISTS_HUB_QUERY,
    strip: listArtistsThisMonth,
    table: "artists",
  },
  { list: listLabelsHubPage, query: LABELS_HUB_QUERY, strip: listLabelsThisMonth, table: "labels" },
] as const;

async function seed(table: string, count: number) {
  await db.batch(
    Array.from({ length: count }, (_, i) => ({
      args: [
        `id-${i}`,
        `Name ${i}`,
        `slug-${String(i).padStart(4, "0")}`,
        3 + (i % 7),
        i % 2 ? "2026-09-20" : "2026-08-01",
        "2026-01-01",
        "2026-01-01",
      ],
      sql: `insert into ${table} (id, name, slug, renderable_track_count, latest_release_date,
      created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)`,
    })),
    "write",
  );
}

async function plan(statement: { sql: string; args: (number | string)[] }) {
  const result = await db.execute({
    args: statement.args,
    sql: `explain query plan ${statement.sql}`,
  });
  return result.rows.map((row) => (typeof row.detail === "string" ? row.detail : "")).join("\n");
}

describe.each(hubs)("$table hub orders", ({ table, query, list, strip }) => {
  it("keeps alphabetical pages and letters, while the other orders have their own rank", async () => {
    await seed(table, 80);
    const az = await list(1);
    const most = await list(1, undefined, "most");
    const recent = await list(1, undefined, "recent");
    expect(az.items[0]?.slug).toBe("slug-0000");
    expect(az.letters?.length).toBeGreaterThan(0);
    expect(most.letters).toEqual([]);
    expect(recent.letters).toEqual([]);
    expect(most.items[0]?.slug).toBe("slug-0006");
    expect(recent.items[0]?.slug).toBe("slug-0079");
    expect((await list(1, "Name 7", "most")).items[0]?.slug).toBe("slug-0076");
    await db.execute(`update ${table} set latest_release_date = null where id = 'id-79'`);
    expect((await list(2, undefined, "recent")).items.at(-1)?.slug).toBe("slug-0079");
  });

  it("walks its partial indexes for the most and recent offsets without sorting", async () => {
    await seed(table, 700);
    const projection = `${query.slugExpr} as slug`;
    const most = catalogueEntityOffsetPageQuery(query, 48, 0, projection, "most");
    const recent = catalogueEntityOffsetPageQuery(query, 48, 0, projection, "recent");
    expect(await plan(most)).toContain(`${table}_hub_most_idx`);
    expect(await plan(recent)).toContain(`${table}_hub_recent_idx`);
    expect(await plan(most)).not.toContain("USE TEMP B-TREE");
  });

  it("never skips or repeats a Most tracks row on a deep page after counts move", async () => {
    await seed(table, 900);
    await list(11, undefined, "most");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await db.execute(
      `update ${table} set renderable_track_count = 12 where id in (select id from ${table} order by id desc limit 30)`,
    );
    const truth = await db.execute(
      `select ${query.slugExpr} as slug from ${query.entity}
       order by -${query.alias}.renderable_track_count asc, ${query.slugExpr} asc
       limit 48 offset ${48 * 11}`,
    );
    const page = await list(12, undefined, "most");
    expect(page.items.map((item) => item.slug)).toEqual(truth.rows.map((row) => row.slug));
  });

  it("keeps the A–Z anchor address and serves Most tracks without persisted boundaries", async () => {
    await seed(table, 900);
    await list(11);
    await list(11, undefined, "most");
    await vi.waitFor(async () => {
      const rows = await db.execute({
        args: [`${table}-hub`],
        sql: "select clause_hash from hub_page_anchors where hub = ?",
      });
      expect(rows.rows).toHaveLength(1);
    });
    const address = hubClauseHash(
      JSON.stringify({
        entity: query.entity,
        floor: query.floor,
        orderBy: "g.slug asc, g.id asc",
        pageSize: 48,
        where: `(${query.alias}.certified_finding_count > 0 or ${query.alias}.renderable_track_count >= ?)`,
        whereVisibility: query.visibilityWhere ?? null,
      }),
    );
    const azAddress = await db.execute({
      args: [`${table}-hub`, address],
      sql: "select clause_hash from hub_page_anchors where hub = ? and clause_hash = ?",
    });
    expect(azAddress.rows).toHaveLength(1);
    const page = await list(12, undefined, "most");
    const expected = Array.from({ length: 900 }, (_, i) => i)
      .sort((a, b) => 3 + (b % 7) - (3 + (a % 7)) || a - b)
      .slice(48 * 11, 48 * 12)
      .map((i) => `slug-${String(i).padStart(4, "0")}`);
    expect(page.items.map((item) => item.slug)).toEqual(expected);
  });

  it("reads the strip off the recent index's window range, most tracks first", async () => {
    await seed(table, 14);
    const executed: { sql: string; args: (number | string)[] }[] = [];
    const original = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation((async (input: unknown) => {
      const statement = input as InStatement | string;
      if (typeof statement !== "string" && statement.sql.includes("latest_release_date >= ?")) {
        executed.push({ args: statement.args as (number | string)[], sql: statement.sql });
      }
      return original(statement as InStatement);
    }) as Client["execute"]);
    const items = await strip(new Date("2026-09-25T00:00:00Z"), 12);
    expect(await plan(executed[0] ?? { args: [], sql: "select 1" })).toContain(
      `${table}_hub_recent_idx (latest_release_date>?)`,
    );
    expect(items.map((item) => item.slug)).toEqual([
      "slug-0013",
      "slug-0005",
      "slug-0011",
      "slug-0003",
      "slug-0009",
      "slug-0001",
      "slug-0007",
    ]);
  });
});

it("maps an album tile's lead credits and released year", async () => {
  await seed("albums", 1);
  await db.execute("update albums set latest_release_date = '2026-09-20' where id = 'id-0'");
  await seedCatalogueTrack(db, { artists: ["Lead", "Guest"], trackId: "tile-track" });
  await db.execute(
    "update tracks set album_id = 'id-0', release_date = '2026-09-20' where track_id = 'tile-track'",
  );
  const tile = (await listAlbumsHubPage(1)).items[0];
  expect(tile?.artists).toEqual(["Lead", "Guest"]);
  expect(tile?.year).toBe("2026");
});
