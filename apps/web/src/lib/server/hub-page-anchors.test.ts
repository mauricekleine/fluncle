import { createClient } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { describe, expect, it } from "vitest";
import {
  compareHubOrderKeys,
  type HubOrderedPageShape,
  type HubPageAnchor,
  HUB_SHALLOW_MAX_OFFSET,
  hubAnchorExtractionQuery,
  hubAnchorShardSuffixBetween,
  hubLeafPageStart,
  hubLeafSamplesFromRows,
  hubPageAnchorsFromRows,
  hubSeekPageQuery,
  isShallowHubPage,
  nearestHubPageAnchor,
  parseHubAnchorLeafMeta,
  persistedAnchorDecision,
  scheduleHubPageAnchorRefresh,
  serializeHubAnchorLeafMeta,
} from "./hub-page-anchors";
import {
  type CatalogueEntityPageQuery,
  ENTITY_HUB_ORDER_BY,
  catalogueEntityAnchorExtractionQuery,
  catalogueEntityOffsetPageQuery,
  catalogueEntitySeekPageQuery,
} from "./labels";
import {
  TRACKS_HUB_ORDER_BY,
  tracksHubAnchorExtractionQuery,
  tracksHubClauseKey,
  tracksHubIdPageQuery,
  tracksHubSeekIdPageQuery,
} from "./tracks-hub";

const ENTITY_QUERY: CatalogueEntityPageQuery = {
  alias: "e",
  entity: "entities e",
  floor: 3,
  hub: "labels",
  idExpr: "e.id",
  nameExpr: "e.name",
  slugExpr: "e.slug",
};

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function dateShape(pageSize: number): HubOrderedPageShape {
  return {
    clauses: [],
    from: "items",
    idExpr: "items.id",
    keyAlias: "rd",
    keyExpr: "items.rd",
    orderBy: "items.rd desc, items.id desc",
    pageSize,
    projection: "items.id as id",
    seekAfter: (anchor) =>
      anchor.key === null
        ? { args: [anchor.id], sql: "items.rd is null and items.id < ?" }
        : {
            args: [anchor.key, anchor.key, anchor.id],
            sql: `(items.rd < ? or (items.rd = ? and items.id < ?) or items.rd is null)`,
          },
  };
}

describe("anchor selection math", () => {
  const anchors: HubPageAnchor[] = [
    { id: "a", key: "2025-01-01", page: 2 },
    { id: "b", key: "2024-01-01", page: 5 },
    { id: "c", key: "2023-01-01", page: 8 },
  ];

  it("has no boundary on page 1 and picks the largest boundary at or before N", () => {
    expect(nearestHubPageAnchor(1, anchors)).toBeUndefined();
    expect(nearestHubPageAnchor(5, anchors)?.id).toBe("b");
    expect(nearestHubPageAnchor(7, anchors)?.id).toBe("b");
  });

  it("turns distance from that boundary into a row remainder, including past the built tail", () => {
    expect(hubSeekPageQuery(dateShape(48), 1, anchors).remainder).toBe(0);
    expect(hubSeekPageQuery(dateShape(48), 5, anchors).remainder).toBe(0);
    expect(hubSeekPageQuery(dateShape(48), 7, anchors).remainder).toBe(96);
    expect(hubSeekPageQuery(dateShape(48), 10, anchors).remainder).toBe(96);
  });
});

describe("seek SQL compilation", () => {
  it("derives the date-desc extraction modulo from the page-size constant", () => {
    const query = tracksHubAnchorExtractionQuery({});

    expect(query.sql).toContain("select rn, id, rd");
    expect(query.sql).toContain("where (rn % 48) = 0");
    expect(query.sql).toContain(`row_number() over (order by ${TRACKS_HUB_ORDER_BY})`);
  });

  it("keeps empty-string dates in the ordinary TEXT branch and includes the later NULL zone", () => {
    const query = tracksHubSeekIdPageQuery({}, 12, [{ id: "empty-boundary", key: "", page: 12 }]);

    expect(query.sql).toContain("tracks.release_date < ?");
    expect(query.sql).toContain("tracks.release_date = ?");
    expect(query.sql).toContain("or tracks.release_date is null");
    expect(query.args.slice(0, 3)).toEqual(["", "", "empty-boundary"]);
  });

  it("uses the null-zone predicate for an anchor whose date is actually NULL", () => {
    const query = tracksHubSeekIdPageQuery({}, 12, [{ id: "null-boundary", key: null, page: 12 }]);

    expect(query.sql).toContain("tracks.release_date is null and tracks.track_id < ?");
    expect(query.sql).not.toContain("tracks.release_date < ?");
    expect(query.args.slice(0, 1)).toEqual(["null-boundary"]);
  });

  it("compiles the slug/id ascending seek as one gated-CTE consumer with no UNION", () => {
    const query = catalogueEntitySeekPageQuery(ENTITY_QUERY, 50, 12, [
      { id: "entity-500", key: "metalheadz", page: 12 },
    ]);

    expect(query.sql).toContain("from gated g");
    expect(query.sql).toContain("(g.slug > ? or (g.slug = ? and g.id > ?))");
    expect(query.sql.toLowerCase()).not.toContain("union all");
    expect(query.args.slice(1, 4)).toEqual(["metalheadz", "metalheadz", "entity-500"]);
  });

  it("uses one literal order spelling in every extraction, offset, and seek statement", () => {
    const trackQueries = [
      tracksHubAnchorExtractionQuery({}).sql,
      tracksHubIdPageQuery({}, 48, 0).sql,
      tracksHubSeekIdPageQuery({}, 12, [{ id: "track-500", key: "2024-01-01", page: 12 }]).sql,
    ];
    const entityQueries = [
      catalogueEntityAnchorExtractionQuery(ENTITY_QUERY, 50).sql,
      catalogueEntityOffsetPageQuery(ENTITY_QUERY, 50, 0).sql,
      catalogueEntitySeekPageQuery(ENTITY_QUERY, 50, 12, [
        { id: "entity-500", key: "metalheadz", page: 12 },
      ]).sql,
    ];

    expect(trackQueries.map((sql) => occurrences(sql, TRACKS_HUB_ORDER_BY))).toEqual([1, 1, 1]);
    expect(entityQueries.map((sql) => occurrences(sql, ENTITY_HUB_ORDER_BY))).toEqual([1, 1, 1]);
  });
});

describe("serving ladder", () => {
  const stored = {
    anchors: [{ id: "a", key: "2025-01-01", page: 2 }],
    computedAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "100:a",
  };

  it("keeps offsets through the documented few-hundred-row threshold", () => {
    expect(HUB_SHALLOW_MAX_OFFSET).toBe(450);
    expect(isShallowHubPage(10, 48)).toBe(true);
    expect(isShallowHubPage(10, 50)).toBe(true);
    expect(isShallowHubPage(11, 48)).toBe(false);
    expect(isShallowHubPage(11, 50)).toBe(false);
    expect(persistedAnchorDecision(10, 48, undefined, "100:a")).toEqual({
      mode: "offset",
      reason: "shallow",
      refresh: false,
    });
  });

  it("falls back and builds when missing, seeks when fresh, and seeks plus refreshes when stale", () => {
    expect(persistedAnchorDecision(11, 48, undefined, "100:a")).toEqual({
      mode: "offset",
      reason: "missing",
      refresh: true,
    });
    expect(persistedAnchorDecision(11, 48, stored, "100:a")).toEqual({
      mode: "seek",
      reason: "fresh",
      refresh: false,
    });
    expect(persistedAnchorDecision(11, 48, stored, "101:b")).toEqual({
      mode: "seek",
      reason: "stale",
      refresh: true,
    });
  });

  it("never lets a synchronous refresh failure escape into the serving request", async () => {
    expect(() =>
      scheduleHubPageAnchorRefresh("sync-failure-test", () => {
        throw new Error("refresh failed");
      }),
    ).not.toThrow();

    await Promise.resolve();
  });
});

describe("snapshot consistency", () => {
  it("covers adjacent pages from one boundary set exactly once, with empty dates before NULLs", async () => {
    const db = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
    const rows: [string, null | string][] = [
      ["new-b", "2025-01-01"],
      ["new-a", "2025-01-01"],
      ["old", "2020-01-01"],
      ["empty-b", ""],
      ["empty-a", ""],
      ["null-c", null],
      ["null-b", null],
      ["null-a", null],
    ];

    await db.execute("create table items (id text primary key, rd text)");
    await db.batch(
      rows.map(([id, rd]) => ({ args: [id, rd], sql: "insert into items (id, rd) values (?, ?)" })),
      "write",
    );

    const shape = dateShape(2);
    const extracted = await db.execute(hubAnchorExtractionQuery(shape));
    const anchors = hubPageAnchorsFromRows(
      extracted.rows as unknown as Record<string, unknown>[],
      "rd",
      2,
    );
    const pages: string[][] = [];

    for (let page = 1; page <= 4; page += 1) {
      const result = await db.execute(hubSeekPageQuery(shape, page, anchors));
      pages.push((result.rows as unknown as { id: string }[]).map((row) => row.id));
    }

    expect(pages).toEqual([
      ["new-b", "new-a"],
      ["old", "empty-b"],
      ["empty-a", "null-c"],
      ["null-b", "null-a"],
    ]);
    const flattened = pages.flat();
    expect(new Set(flattened).size).toBe(flattened.length);
    expect(flattened).toHaveLength(rows.length);

    const nullBoundaryQuery = hubSeekPageQuery(shape, 4, anchors);
    expect(nullBoundaryQuery.anchor?.key).toBeNull();
    expect(nullBoundaryQuery.sql).toContain("items.rd is null and items.id < ?");

    db.close();
  });
});

describe("leaf runs", () => {
  it("orders keys date-desc, id-desc, NULL dates last, as the serving index does", () => {
    const newer = { id: "a", key: "2026-01-01" };
    const older = { id: "z", key: "2025-01-01" };
    const tie = { id: "b", key: "2026-01-01" };
    const nullA = { id: "a", key: null };
    const nullB = { id: "b", key: null };
    expect(compareHubOrderKeys(newer, older)).toBeLessThan(0);
    expect(compareHubOrderKeys(older, newer)).toBeGreaterThan(0);
    expect(compareHubOrderKeys(tie, newer)).toBeLessThan(0);
    expect(compareHubOrderKeys(older, nullA)).toBeLessThan(0);
    expect(compareHubOrderKeys(nullA, older)).toBeGreaterThan(0);
    expect(compareHubOrderKeys(nullB, nullA)).toBeLessThan(0);
    expect(compareHubOrderKeys(nullA, { ...nullA })).toBe(0);
  });

  it("round-trips leaf metadata and rejects every malformed field", () => {
    const meta = {
      after: { id: "x", key: "2026-01-01" },
      base: 100,
      n: 100,
      nn: 90,
      v: 1 as const,
    };
    expect(parseHubAnchorLeafMeta(serializeHubAnchorLeafMeta(meta))).toEqual(meta);
    expect(parseHubAnchorLeafMeta(serializeHubAnchorLeafMeta({ ...meta, after: null }))).toEqual({
      ...meta,
      after: null,
    });
    for (const malformed of [
      "250:first:0",
      "",
      "[]",
      JSON.stringify({ ...meta, v: 2 }),
      JSON.stringify({ ...meta, n: -1 }),
      JSON.stringify({ ...meta, nn: 101 }),
      JSON.stringify({ ...meta, base: "0" }),
      JSON.stringify({ ...meta, after: { id: "", key: null } }),
      JSON.stringify({ ...meta, after: { id: "x", key: null }, nn: 1 }),
    ]) {
      expect(parseHubAnchorLeafMeta(malformed)).toBeUndefined();
    }
  });

  it("samples the rows whose rank is a page-size multiple, numbered by the page they open", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `r${index}`, key: "2026" }));
    expect(hubLeafSamplesFromRows(rows, 5, 4)).toEqual([
      { id: "r2", key: "2026", page: 3 },
      { id: "r6", key: "2026", page: 4 },
    ]);
  });

  it("resolves a page start behind the nearest earlier boundary with a sub-page offset", () => {
    const leaf = {
      anchors: [
        { id: "b1", key: "2026", page: 3 },
        { id: "b2", key: "2026", page: 4 },
      ],
      meta: { after: { id: "a", key: "2027" }, base: 5, n: 12, nn: 12, v: 1 as const },
      prefix: 7,
    };
    // Boundary positions inside the run stay 2 and 6 whatever the current prefix is.
    expect(hubLeafPageStart(7, leaf, 4)).toEqual({
      after: leaf.meta.after,
      offset: 0,
      phase: "non_null",
    });
    expect(hubLeafPageStart(9, leaf, 4)).toEqual({
      after: leaf.meta.after,
      offset: 2,
      phase: "non_null",
    });
    expect(hubLeafPageStart(10, leaf, 4)).toEqual({
      after: { id: "b1", key: "2026" },
      offset: 0,
      phase: "non_null",
    });
    expect(hubLeafPageStart(16, leaf, 4)).toEqual({
      after: { id: "b2", key: "2026" },
      offset: 2,
      phase: "non_null",
    });
    expect(hubLeafPageStart(19, leaf, 4)).toBeUndefined();
    expect(hubLeafPageStart(6, leaf, 4)).toBeUndefined();
  });

  it("seeks inside the NULL zone when the page starts in a run's NULL tail", () => {
    const transition = {
      anchors: [{ id: "n1", key: null, page: 3 }],
      meta: { after: { id: "a", key: "2027" }, base: 0, n: 12, nn: 5, v: 1 as const },
      prefix: 0,
    };
    // Rows 5.. are NULL-dated; the run opened the NULL zone, so it starts at offset (start - nn).
    expect(hubLeafPageStart(6, transition, 4)).toEqual({ after: null, offset: 1, phase: "null" });
    // Behind the NULL boundary row at position 7 the seek runs on `track_id` alone.
    expect(hubLeafPageStart(9, transition, 4)).toEqual({
      after: { id: "n1", key: null },
      offset: 1,
      phase: "null",
    });
    const nullRun = {
      anchors: [],
      meta: { after: { id: "n9", key: null }, base: 20, n: 3, nn: 0, v: 1 as const },
      prefix: 20,
    };
    expect(hubLeafPageStart(21, nullRun, 4)).toEqual({
      after: nullRun.meta.after,
      offset: 1,
      phase: "null",
    });
    const head = {
      anchors: [],
      meta: { after: null, base: 0, n: 3, nn: 3, v: 1 as const },
      prefix: 0,
    };
    expect(hubLeafPageStart(0, head, 4)).toEqual({ after: null, offset: 0, phase: "non_null" });
  });

  it("mints split suffixes that sort strictly between their neighbours", () => {
    const between = (lower: string, upper: string | undefined) => {
      const suffix = hubAnchorShardSuffixBetween(lower, upper);
      expect(suffix > lower).toBe(true);
      if (upper !== undefined) {
        expect(suffix < upper).toBe(true);
      }
      return suffix;
    };
    expect(between("0000000005", "0000000006")).toBe("0000000005.5");
    expect(between("0000000005", undefined)).toBe("0000000005.5");
    expect(between("0000000005.5", "0000000006")).toBe("0000000005.7");
    expect(between("0000000005", "0000000005.5")).toBe("0000000005.2");
    expect(between("0000000005.5", "0000000005.6")).toBe("0000000005.55");
    expect(between("0000000005.9", undefined)).toBe("0000000005.95");
    let lower = "0000000000";
    for (let round = 0; round < 40; round += 1) {
      lower = between(lower, "0000000001");
    }
    expect(() => hubAnchorShardSuffixBetween("0000000005.5", "0000000005.5")).toThrow();
    expect(() => hubAnchorShardSuffixBetween("junk", undefined)).toThrow();
  });
});

describe("filtered anchor memo key", () => {
  it("is the exact compiled clause set: equivalent filters share it and distinct args do not", () => {
    expect(tracksHubClauseKey({ bpmMin: 170 })).toBe(tracksHubClauseKey({ bpmMin: 170 }));
    expect(tracksHubClauseKey({})).toBe(tracksHubClauseKey({ bpmMin: undefined }));
    expect(tracksHubClauseKey({ bpmMin: 170 })).not.toBe(tracksHubClauseKey({ bpmMin: 171 }));
    expect(tracksHubClauseKey({ label: "Hospital" }, { labelId: "a" })).not.toBe(
      tracksHubClauseKey({ label: "Hospital" }, { labelId: "b" }),
    );
  });
});
