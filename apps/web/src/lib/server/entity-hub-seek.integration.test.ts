import { type Client, type InStatement, type TransactionMode } from "@libsql/client";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;
let execute: MockInstance<Client["execute"]>;
let batch: MockInstance<Client["batch"]>;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

function statementText(statement: unknown): string {
  if (typeof statement === "string") {
    return statement;
  }

  return typeof statement === "object" &&
    statement !== null &&
    "sql" in statement &&
    typeof statement.sql === "string"
    ? statement.sql
    : "";
}

function executedSql(): string[] {
  return execute.mock.calls.map((call) => statementText(call[0]));
}

function readBatches(): string[][] {
  return batch.mock.calls
    .filter((call) => call[1] === "read")
    .map((call) => call[0].map((statement) => statementText(statement)));
}

function allSql(): string[] {
  return [...executedSql(), ...readBatches().flat()];
}

function carriesGate(sql: string): boolean {
  return sql.includes("renderable_track_count >= ");
}

const { ALBUMS_HUB_QUERY, ALBUM_INDEX_MIN_TRACKS, listAlbumsHubPage } = await import("./albums");
const { ARTISTS_HUB_QUERY, ARTIST_INDEX_MIN_FINDINGS, listArtistsHubPage } =
  await import("./artists");
const {
  CATALOGUE_BROWSE_PAGE_SIZE,
  CATALOGUE_HUB_DEFAULT_LIMIT,
  LABELS_HUB_QUERY,
  LABEL_INDEX_MIN_TRACKS,
  catalogueEntityCountQuery,
  catalogueEntityLetterCountsQuery,
  catalogueEntityOffsetPageQuery,
  catalogueEntitySeekPageQuery,
  hubInclusionWhere,
  letterPages,
  listLabelsBrowsePage,
  listLabelsHubPage,
} = await import("./labels");

type EntityTable = "albums" | "artists" | "labels";

type SeededEntity = { certified: number; id: string; renderable: number; slug: string };

const NOW = "2026-07-01T00:00:00.000Z";

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

function bySlugThenId(left: { id: string; slug: string }, right: { id: string; slug: string }) {
  return left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : left.id < right.id ? -1 : 1;
}

type ReferenceRow = {
  cert: number;
  certified: number;
  id: string;
  kind: string;
  n: number;
  name: string;
  slug: string;
  track_count: number;
};

async function referenceHubPage(
  table: EntityTable,
  page: number,
  pageSize: number,
  withLetters: boolean,
) {
  const letterArm = withLetters
    ? `union all
       select 'letter' as kind, '' as id, substr(g.slug, 1, 1) as slug, count(*) as n, 0 as cert
       from gated g group by substr(g.slug, 1, 1)`
    : "";
  const result = await db.execute({
    args: [3, pageSize, (page - 1) * pageSize],
    sql: `with gated as materialized (
            select e.id as id, e.slug as slug, e.renderable_track_count as track_count,
                   (e.certified_finding_count > 0) as certified
            from ${table} e not indexed
            where (e.certified_finding_count > 0 or e.renderable_track_count >= ?)
          )
          select 'total' as kind, '' as id, '' as slug, (select count(*) from gated) as n, 0 as cert
          union all
          select * from (
            select 'row' as kind, g.id as id, g.slug as slug, g.track_count as n, g.certified as cert
            from gated g order by g.slug asc, g.id asc limit ? offset ?
          )
          ${letterArm}`,
  });
  const rows = result.rows as unknown as ReferenceRow[];
  const total = Number(rows.find((row) => row.kind === "total")?.n ?? 0);

  return {
    items: rows
      .filter((row) => row.kind === "row")
      .sort(bySlugThenId)
      .map((row) => ({
        certified: Number(row.cert) > 0,
        slug: row.slug,
        trackCount: Number(row.n),
      })),
    letters: letterPages(
      rows
        .filter((row) => row.kind === "letter")
        .map((row) => ({ letter: row.slug, n: Number(row.n) }))
        .sort((left, right) => (left.letter < right.letter ? -1 : 1)),
      pageSize,
    ),
    pageCount: Math.max(Math.ceil(total / pageSize), 1),
    total,
  };
}

async function referenceBrowsePage(table: EntityTable, page: number, pageSize: number) {
  const result = await db.execute({
    args: [3, pageSize, (page - 1) * pageSize],
    sql: `with gated as materialized (
            select e.id as id, e.slug as slug, e.name as name,
                   e.renderable_track_count as track_count,
                   (e.certified_finding_count > 0) as certified
            from ${table} e not indexed
            where (e.certified_finding_count > 0 or e.renderable_track_count >= ?)
          )
          select 'total' as kind, '' as id, '' as slug, '' as name, 0 as track_count, 0 as certified,
                 (select count(*) from gated) as n
          union all
          select * from (
            select 'row' as kind, g.id as id, g.slug as slug, g.name as name,
                   g.track_count as track_count, g.certified as certified, 0 as n
            from gated g order by g.slug asc, g.id asc limit ? offset ?
          )`,
  });
  const rows = result.rows as unknown as ReferenceRow[];
  const total = Number(rows.find((row) => row.kind === "total")?.n ?? 0);

  return {
    items: rows
      .filter((row) => row.kind === "row")
      .sort(bySlugThenId)
      .map((row) => ({
        certified: Number(row.certified) > 0,
        name: row.name,
        slug: row.slug,
        trackCount: Number(row.track_count),
      })),
    pageCount: Math.max(Math.ceil(total / pageSize), 1),
    total,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute = vi.spyOn(db, "execute");
  batch = vi.spyOn(db, "batch");
});

function armGateCrossingWrite(table: EntityTable, slug: string): () => boolean {
  const prototype = Object.getPrototypeOf(db) as Client;
  const realExecute = prototype.execute.bind(db);
  const realBatch = prototype.batch.bind(db);
  let gateStatements = 0;
  let landed = false;
  const land = async () => {
    if (!landed) {
      landed = true;
      await realExecute({
        args: [slug],
        sql: `update ${table} set renderable_track_count = 0, certified_finding_count = 0
              where slug = ?`,
      });
    }
  };

  execute.mockImplementation((async (statement: InStatement) => {
    if (carriesGate(statementText(statement))) {
      gateStatements += 1;

      if (gateStatements === 2) {
        await land();
      }
    }

    return realExecute(statement);
  }) as Client["execute"]);
  batch.mockImplementation((async (statements: InStatement[], mode?: TransactionMode) => {
    const results = await realBatch(statements, mode);

    if (mode === "read") {
      await land();
    }

    return results;
  }) as Client["batch"]);

  return () => landed;
}

function expectWholePage(
  served: { items: unknown[]; total: number },
  page: number,
  pageSize: number,
) {
  expect(served.items).toHaveLength(
    Math.max(0, Math.min(pageSize, served.total - (page - 1) * pageSize)),
  );
}

const HUBS = [
  {
    list: (page: number) => listAlbumsHubPage(page),
    name: "albums",
    table: "albums" as const,
    withLetters: true,
  },
  {
    list: (page: number) => listLabelsHubPage(page),
    name: "labels",
    table: "labels" as const,
    withLetters: true,
  },
  {
    list: (page: number) => listArtistsHubPage(page),
    name: "artists",
    table: "artists" as const,
    withLetters: true,
  },
];

describe.each(HUBS)("the $name hub on its listing index", (hub) => {
  it("serves every unfiltered page without boundaries exactly as the materialized gated CTE", async () => {
    const rows = entityWorld(1_100);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;

    await seedEntities(hub.table, rows);

    for (let page = 1; page <= 11; page += 1) {
      const expected = await referenceHubPage(hub.table, page, pageSize, hub.withLetters);

      execute.mockClear();

      const served = await hub.list(page);

      expect({
        items: served.items.map((item) => ({
          certified: item.certified,
          slug: item.slug,
          trackCount: item.trackCount,
        })),
        letters: served.letters,
        pageCount: served.pageCount,
        total: served.total,
      }).toEqual(expected);
      expect(expected.items).toHaveLength(pageSize);
      expect(allSql().some((sql) => sql.includes("materialized"))).toBe(false);
    }

    await vi.waitFor(async () => expect(await storedFingerprint(`${hub.name}-hub`)).toBeDefined());
  });

  it("reads a shallow page's total and slice from one read batch", async () => {
    await seedEntities(hub.table, entityWorld(300));
    execute.mockClear();
    batch.mockClear();

    await hub.list(1);

    const batches = readBatches();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.every((sql) => carriesGate(sql))).toBe(true);
    expect(executedSql().filter((sql) => carriesGate(sql))).toEqual([]);
  });

  it("reads a deep page's total, first row, and seek from one read batch", async () => {
    await seedEntities(hub.table, entityWorld(1_100));
    await hub.list(11);
    await vi.waitFor(async () => expect(await storedFingerprint(`${hub.name}-hub`)).toBeDefined());
    execute.mockClear();
    batch.mockClear();

    await hub.list(12);

    const batches = readBatches();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]?.every((sql) => carriesGate(sql))).toBe(true);
    expect(executedSql().filter((sql) => carriesGate(sql))).toEqual([]);
  });

  it("keeps a shallow page whole when a gate-crossing write lands during the render", async () => {
    const rows = entityWorld(300);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;
    const order = gatedOrder(rows);
    const lastPage = Math.ceil(order.length / pageSize);

    await seedEntities(hub.table, rows);
    expect(lastPage).toBeLessThanOrEqual(10);

    const landed = armGateCrossingWrite(hub.table, order[0] ?? "");
    const served = await hub.list(lastPage);

    expect(landed()).toBe(true);
    expectWholePage(served, lastPage, pageSize);
  });

  it("keeps a deep page whole when a gate-crossing write lands during the render", async () => {
    const rows = entityWorld(1_100);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;
    const order = gatedOrder(rows);
    const lastPage = Math.ceil(order.length / pageSize);

    await seedEntities(hub.table, rows);
    await hub.list(11);
    await vi.waitFor(async () => expect(await storedFingerprint(`${hub.name}-hub`)).toBeDefined());

    const landed = armGateCrossingWrite(hub.table, order[0] ?? "");
    const served = await hub.list(lastPage);

    expect(landed()).toBe(true);
    expectWholePage(served, lastPage, pageSize);
  });

  it("serves every deep page off persisted boundaries as the exact slice of the unified order", async () => {
    const rows = entityWorld(1_100);
    const order = gatedOrder(rows);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;
    const pageCount = Math.ceil(order.length / pageSize);

    await seedEntities(hub.table, rows);

    const shallow = await hub.list(1);

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

      expect(executedSql().some((sql) => sql.includes("from hub_page_anchors"))).toBe(true);
      expect(allSql().some((sql) => sql.includes("materialized"))).toBe(false);
    }
  });

  it("keeps a stale boundary set serving and rebuilds it to the exact order", async () => {
    const rows = entityWorld(1_100);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;

    await seedEntities(hub.table, rows);
    await hub.list(11);
    await vi.waitFor(async () => expect(await storedFingerprint(`${hub.name}-hub`)).toBeDefined());

    const builtFingerprint = await storedFingerprint(`${hub.name}-hub`);

    const grown = entityWorld(40, "0-new-");

    await seedEntities(hub.table, grown);

    const order = gatedOrder([...rows, ...grown]);
    const stale = await hub.list(12);

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

describe("the gate-crossing write harness", () => {
  it("tears two independent reads across the write, so a torn page is visible to the tests above", async () => {
    const rows = entityWorld(300);
    const pageSize = CATALOGUE_HUB_DEFAULT_LIMIT;
    const order = gatedOrder(rows);
    const lastPage = Math.ceil(order.length / pageSize);

    await seedEntities("albums", rows);

    const landed = armGateCrossingWrite("albums", order[0] ?? "");
    const [count, slice] = await Promise.all([
      db.execute(catalogueEntityCountQuery(ALBUMS_HUB_QUERY)),
      db.execute(
        catalogueEntityOffsetPageQuery(ALBUMS_HUB_QUERY, pageSize, (lastPage - 1) * pageSize),
      ),
    ]);
    const total = Number(count.rows[0]?.total ?? 0);

    expect(landed()).toBe(true);
    expect(total).toBe(order.length);
    expect(slice.rows).not.toHaveLength(Math.min(pageSize, total - (lastPage - 1) * pageSize));
  });
});

describe("the MCP browse past its shallow pages", () => {
  it("serves every shallow browse page exactly as the materialized gated CTE", async () => {
    const rows = entityWorld(1_100);
    const pageSize = CATALOGUE_BROWSE_PAGE_SIZE;

    await seedEntities("labels", rows);

    for (let page = 1; page <= 10; page += 1) {
      const expected = await referenceBrowsePage("labels", page, pageSize);

      execute.mockClear();

      const served = await listLabelsBrowsePage(page);

      expect({ items: served.items, pageCount: served.pageCount, total: served.total }).toEqual(
        expected,
      );
      expect(expected.items).toHaveLength(pageSize);
      expect(allSql().some((sql) => sql.includes("materialized"))).toBe(false);
    }
  });

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
      expect(allSql().some((sql) => sql.includes("materialized"))).toBe(false);
    }
  });
});

describe("the hub listing index on the real schema", () => {
  const QUERIES = [
    {
      floor: ALBUM_INDEX_MIN_TRACKS,
      index: "albums_hub_listing_idx",
      query: ALBUMS_HUB_QUERY,
      table: "albums" as const,
    },
    {
      floor: LABEL_INDEX_MIN_TRACKS,
      index: "labels_hub_listing_idx",
      query: LABELS_HUB_QUERY,
      table: "labels" as const,
    },
    {
      floor: ARTIST_INDEX_MIN_FINDINGS,
      index: "artists_hub_listing_idx",
      query: ARTISTS_HUB_QUERY,
      table: "artists" as const,
    },
  ];

  type Statement = { args: (number | string)[]; sql: string };

  async function planDetails(statement: Statement) {
    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });

    return plan.rows.map((row) => (typeof row.detail === "string" ? row.detail : "")).join("\n");
  }

  async function tableColumnReads(table: EntityTable, statement: Statement) {
    const root = await db.execute({
      args: [table],
      sql: `select rootpage from sqlite_master where type = 'table' and name = ?`,
    });
    const rootPage = Number(root.rows[0]?.rootpage);
    const program = await db.execute({ args: statement.args, sql: `explain ${statement.sql}` });
    const ops = program.rows.map((row) => ({
      opcode: typeof row.opcode === "string" ? row.opcode : "",
      p1: Number(row.p1),
      p2: Number(row.p2),
    }));
    const tableCursors = new Set(
      ops.filter((op) => op.opcode === "OpenRead" && op.p2 === rootPage).map((op) => op.p1),
    );

    return {
      ops,
      reads: ops.flatMap((op, position) =>
        op.opcode === "Column" && tableCursors.has(op.p1) ? [position] : [],
      ),
    };
  }

  it.each(QUERIES)(
    "spells $index's partial WHERE with the live floor constant",
    async ({ floor, index, table }) => {
      const ddl = await db.execute({
        args: [index],
        sql: `select sql from sqlite_master where type = 'index' and name = ?`,
      });
      const normalize = (value: unknown) =>
        String(value).replaceAll(/["`]/g, "").replaceAll(/\s+/g, " ").toLowerCase();

      expect(normalize(ddl.rows[0]?.sql)).toContain(
        `where ${normalize(hubInclusionWhere(table, floor))}`,
      );
    },
  );

  it.each(QUERIES)(
    "counts the gated total and the A–Z lane off $index or a sibling gate-partial index without reading a table row",
    async ({ index, query, table }) => {
      for (const statement of [
        catalogueEntityCountQuery(query),
        catalogueEntityLetterCountsQuery(query),
      ]) {
        expect(await planDetails(statement)).toMatch(
          new RegExp(`INDEX (${index}|${table}_hub_most_idx|${table}_hub_recent_idx)`),
        );
        expect((await tableColumnReads(table, statement)).reads).toEqual([]);
      }
    },
  );

  it.each(QUERIES)(
    "reads a table row per entry when the floor is bound instead (the tripwire fires)",
    async ({ floor, query, table }) => {
      const bound = {
        args: [floor],
        sql: `select count(*) as total
              from ${query.entity}
              where (${query.alias}.certified_finding_count > 0
                     or ${query.alias}.renderable_track_count >= ?)`,
      };

      expect(await planDetails(bound)).toMatch(
        new RegExp(`INDEX ${table}_hub_(listing|most|recent)_idx`),
      );
      expect((await tableColumnReads(table, bound)).reads.length).toBeGreaterThan(0);
    },
  );

  it.each(QUERIES)(
    "slices a page off $index, reading the table only for the rows it returns",
    async ({ index, query, table }) => {
      const statement = catalogueEntityOffsetPageQuery(
        query,
        CATALOGUE_HUB_DEFAULT_LIMIT,
        CATALOGUE_HUB_DEFAULT_LIMIT * 9,
        `${query.idExpr} as id, ${query.slugExpr} as slug,
         ${query.alias}.renderable_track_count as n,
         (${query.alias}.certified_finding_count > 0) as cert`,
      );
      const details = await planDetails(statement);
      const { ops, reads } = await tableColumnReads(table, statement);
      const offsetCheck = ops.findIndex((op) => op.opcode === "IfPos");

      expect(details).toContain(`USING INDEX ${index}`);
      expect(details).not.toContain("USE TEMP B-TREE");
      expect(offsetCheck).toBeGreaterThanOrEqual(0);
      expect(reads.length).toBeGreaterThan(0);

      expect(Math.min(...reads)).toBeGreaterThan(offsetCheck);
    },
  );

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
