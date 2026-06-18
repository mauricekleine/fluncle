import { describe, expect, it } from "vitest";
import { accountDeletionStatements } from "./account-data";

describe("account deletion retention", () => {
  it("removes Better Auth credentials and verification rows", () => {
    const statements = accountDeletionStatements({
      email: "listener@example.com",
      requestId: "delete_1",
      requestedAt: "2026-01-01T00:00:00.000Z",
      summary: { credentials: "deleted", verifications: "deleted" },
      userId: "user_123",
    });
    const sql = statements.map((statement) => statement.sql).join("\n");

    expect(sql).toContain("delete from account where user_id = ?");
    expect(sql).toContain("delete from verification where identifier in (?, ?)");
    expect(statements.find((statement) => statement.sql.includes("verification"))?.args).toEqual([
      "user_123",
      "listener@example.com",
    ]);
  });
});
