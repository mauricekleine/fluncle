import { describe, expect, it } from "vitest";

import {
  restaleCatalogueRankByLabelStatement,
  restaleCatalogueRankStatements,
} from "./catalogue-rank-restale";

/** Every `?` the builder emitted, so a chunk's bind list can be checked against its args. */
function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

function ids(count: number, prefix = "t"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

describe("restaleCatalogueRankStatements", () => {
  it("returns no statement for an empty batch, so a caller can spread it unconditionally", () => {
    // Every caller splices the result into an existing write batch with `...`. A builder that
    // returned a statement for zero ids would put an unbound `in ()` into that batch.
    expect(restaleCatalogueRankStatements([])).toEqual([]);
  });

  it("dedupes repeated ids", () => {
    const [statement, ...rest] = restaleCatalogueRankStatements(["a", "b", "a", "b", "a"]);

    expect(rest).toEqual([]);
    expect(statement?.args).toEqual(["a", "b"]);
    expect(placeholderCount(statement?.sql ?? "")).toBe(2);
  });

  it("binds exactly one placeholder per argument in every chunk", () => {
    // The bind list is the whole point of the chunking: a placeholder/arg mismatch is a
    // runtime libSQL error inside somebody else's write batch, far from this file.
    for (const statement of restaleCatalogueRankStatements(ids(451))) {
      expect(placeholderCount(statement.sql)).toBe(statement.args.length);
    }
  });

  it("keeps a chunk at or under 200 ids and covers every id exactly once", () => {
    // 200 is the chunk ceiling that keeps the bind list clear of SQLite's parameter cap.
    const input = ids(451);
    const statements = restaleCatalogueRankStatements(input);

    expect(statements.map((statement) => statement.args.length)).toEqual([200, 200, 51]);
    expect(statements.flatMap((statement) => statement.args)).toEqual(input);
  });

  it("emits a single chunk at exactly the ceiling", () => {
    expect(restaleCatalogueRankStatements(ids(200))).toHaveLength(1);
    expect(restaleCatalogueRankStatements(ids(201))).toHaveLength(2);
  });

  it("nulls the corpus by PRIMARY KEY and adds no `is_catalogue` guard", () => {
    // The header's planner law: with no `sqlite_stat1` on hosted Turso an `is_catalogue = 1`
    // predicate pulls the planner onto `tracks_is_catalogue_idx` and turns each restale into a
    // full catalogue scan. Correctness comes from the selective key, so the guard must stay off.
    const [statement] = restaleCatalogueRankStatements(["track-1"]);

    expect(statement?.sql).toMatch(/set catalogue_rank_corpus = null/);
    expect(statement?.sql).toMatch(/where track_id in \(/);
    expect(statement?.sql).not.toMatch(/is_catalogue/);
  });
});

describe("restaleCatalogueRankByLabelStatement", () => {
  it("seeks the label pointer with the label id as its only bind", () => {
    const statement = restaleCatalogueRankByLabelStatement("label-hospital");

    expect(statement.args).toEqual(["label-hospital"]);
    expect(placeholderCount(statement.sql)).toBe(1);
    expect(statement.sql).toMatch(/set catalogue_rank_corpus = null/);
    expect(statement.sql).toMatch(/where label_id = \?/);
  });

  it("adds no `is_catalogue` guard either", () => {
    // Same planner law as the per-track form: the selective key is `tracks_label_id_idx`.
    expect(restaleCatalogueRankByLabelStatement("label-hospital").sql).not.toMatch(/is_catalogue/);
  });
});
