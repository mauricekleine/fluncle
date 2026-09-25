import { describe, expect, it } from "vitest";

import {
  restaleCatalogueRankByLabelStatement,
  restaleCatalogueRankStatements,
} from "./catalogue-rank-restale";

function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

function ids(count: number, prefix = "t"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

describe("restaleCatalogueRankStatements", () => {
  it("returns no statement for an empty batch, so a caller can spread it unconditionally", () => {
    expect(restaleCatalogueRankStatements([])).toEqual([]);
  });

  it("dedupes repeated ids", () => {
    const [statement, ...rest] = restaleCatalogueRankStatements(["a", "b", "a", "b", "a"]);

    expect(rest).toEqual([]);
    expect(statement?.args).toEqual(["a", "b"]);
    expect(placeholderCount(statement?.sql ?? "")).toBe(2);
  });

  it("binds exactly one placeholder per argument in every chunk", () => {
    for (const statement of restaleCatalogueRankStatements(ids(451))) {
      expect(placeholderCount(statement.sql)).toBe(statement.args.length);
    }
  });

  it("keeps a chunk at or under 200 ids and covers every id exactly once", () => {
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
    expect(restaleCatalogueRankByLabelStatement("label-hospital").sql).not.toMatch(/is_catalogue/);
  });
});
