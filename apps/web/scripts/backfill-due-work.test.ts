import { describe, expect, it } from "vitest";

import { DUE_WORK_REGISTERED_KINDS } from "../src/lib/server/due-work-registry";
import { DUE_WORK_BACKFILLS, isLocalDueWorkDatabaseUrl } from "./backfill-due-work";

describe("due-work backfill entrypoint", () => {
  it("runs the complete registered inventory without duplicate identities", () => {
    expect(DUE_WORK_BACKFILLS.map((definition) => definition.workKind)).toEqual(
      DUE_WORK_REGISTERED_KINDS,
    );
    expect(
      new Set(
        DUE_WORK_BACKFILLS.map((definition) => `${definition.subjectType}:${definition.workKind}`),
      ).size,
    ).toBe(DUE_WORK_BACKFILLS.length);
  });

  it("accepts only local configured database URLs", () => {
    expect(isLocalDueWorkDatabaseUrl(":memory:")).toBe(true);
    expect(isLocalDueWorkDatabaseUrl("file:.dev/local.db")).toBe(true);
    expect(isLocalDueWorkDatabaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalDueWorkDatabaseUrl("http://localhost:8080")).toBe(true);
    expect(isLocalDueWorkDatabaseUrl("libsql://database.example.invalid")).toBe(false);
    expect(isLocalDueWorkDatabaseUrl("https://127.0.0.1.example.invalid")).toBe(false);
  });
});
