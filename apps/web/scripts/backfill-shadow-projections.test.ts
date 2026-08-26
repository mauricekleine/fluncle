import { describe, expect, it } from "vitest";

import { isLocalShadowProjectionDatabaseUrl } from "./backfill-shadow-projections";

describe("shadow projection backfill entrypoint", () => {
  it("accepts only in-memory, file, and loopback databases", () => {
    expect(isLocalShadowProjectionDatabaseUrl(":memory:")).toBe(true);
    expect(isLocalShadowProjectionDatabaseUrl("file:.dev/local.db")).toBe(true);
    expect(isLocalShadowProjectionDatabaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalShadowProjectionDatabaseUrl("http://localhost:8080")).toBe(true);
    expect(isLocalShadowProjectionDatabaseUrl("libsql://hosted.example.invalid")).toBe(false);
    expect(isLocalShadowProjectionDatabaseUrl("https://localhost.example.invalid")).toBe(false);
  });
});
