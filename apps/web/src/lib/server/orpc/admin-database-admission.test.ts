import { describe, expect, it } from "vitest";
import { databaseAdmissionFault } from "./admin-database-admission";

describe("database admission faults", () => {
  it("exposes exhausted SQLITE_BUSY retries as the bounded database-busy response", () => {
    expect(databaseAdmissionFault({ code: "SQLITE_BUSY" })).toMatchObject({
      data: { apiCode: "database_busy", apiMessage: "Database admission is busy" },
      message: "Database admission is busy",
      status: 503,
    });
  });
});
