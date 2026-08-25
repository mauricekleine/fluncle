import { describe, expect, it } from "vitest";
import {
  canonicalSqlShape,
  classifyDatabaseAccess,
  DATABASE_OPERATION_ID_MAX_LENGTH,
  isDatabaseOperationId,
  normalizeDatabaseOperationId,
  normalizeDatabaseRelease,
} from "./database-observability";

describe("database observability vocabulary", () => {
  it("keeps operation IDs in the closed bounded grammar", () => {
    expect(isDatabaseOperationId("catalogue.crawl")).toBe(true);
    expect(isDatabaseOperationId("CatalogUE.crawl")).toBe(false);
    expect(isDatabaseOperationId("catalogue/crawl")).toBe(false);
    expect(isDatabaseOperationId(`a${"b".repeat(DATABASE_OPERATION_ID_MAX_LENGTH)}`)).toBe(false);
  });

  it("redacts comments, literals, and bind names from the fallback shape", () => {
    const first = canonicalSqlShape(
      "/* private */ SELECT * FROM tracks WHERE id = 'synthetic-001' AND bpm > :minimum",
    );
    const second = canonicalSqlShape(
      "SELECT * FROM tracks WHERE id = 'synthetic-999' AND bpm > :another_name",
    );

    expect(first).toBe(second);
    expect(first).not.toContain("private");
    expect(first).not.toContain("synthetic");
    expect(first).not.toContain("minimum");
  });

  it("falls back deterministically without preserving an invalid candidate", () => {
    const first = normalizeDatabaseOperationId("unsafe host value", "select ?", "read");
    const second = normalizeDatabaseOperationId(undefined, "select ?", "read");

    expect(first).toBe(second);
    expect(first).toMatch(/^db\.read\.[a-z0-9]+$/);
    expect(first).not.toContain("unsafe");
    expect(first.length).toBeLessThanOrEqual(DATABASE_OPERATION_ID_MAX_LENGTH);
  });

  it("classifies uncertain statements as writes and never downgrades a CTE write", () => {
    expect(classifyDatabaseAccess("select 1")).toBe("read");
    expect(classifyDatabaseAccess("with row as (select 1) select * from row")).toBe("read");
    expect(classifyDatabaseAccess("with row as (select 1) update tracks set bpm = 1")).toBe(
      "write",
    );
    expect(classifyDatabaseAccess("pragma foreign_keys = on")).toBe("write");
  });

  it("accepts only bounded public release identifiers", () => {
    expect(normalizeDatabaseRelease("abc123")).toBe("abc123");
    expect(normalizeDatabaseRelease("feature/turso")).toBe("unknown");
    expect(normalizeDatabaseRelease("https://private.invalid")).toBe("unknown");
    expect(normalizeDatabaseRelease("x".repeat(65))).toBe("unknown");
  });
});
