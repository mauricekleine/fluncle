// The screenshot seed's LOCAL-ONLY guard.
//
// This is the one thing about `screenshot-seed.ts` worth a test: it is a destructive
// writer an operator runs by hand during a capture session, when `.dev.vars` may still be
// pointed anywhere. The guard is the only thing between "re-seed the simulator" and
// "write fourteen synthetic findings into production", so a synthetic failure has to make
// it fire — an untested tripwire is not a tripwire.

import { describe, expect, it } from "vitest";

import { assertLocalDatabaseUrl, NonLocalDatabaseError } from "./screenshot-seed";

describe("assertLocalDatabaseUrl", () => {
  it("allows the per-worktree local libSQL server", () => {
    expect(() => assertLocalDatabaseUrl("http://127.0.0.1:8432")).not.toThrow();
    expect(() => assertLocalDatabaseUrl("http://localhost:8432")).not.toThrow();
    expect(() => assertLocalDatabaseUrl("libsql://localhost:8080")).not.toThrow();
  });

  it("allows a local SQLite file and the in-memory database", () => {
    expect(() => assertLocalDatabaseUrl("file:.dev/local.db")).not.toThrow();
    expect(() => assertLocalDatabaseUrl(":memory:")).not.toThrow();
    expect(() => assertLocalDatabaseUrl("./.dev/local.db")).not.toThrow();
  });

  it("refuses hosted Turso by name, on every scheme it can arrive as", () => {
    for (const url of [
      "libsql://fluncle-prod-mauricekleine.turso.io",
      "https://fluncle-dev-mauricekleine.turso.io",
      "LIBSQL://FLUNCLE-PROD.TURSO.IO",
    ]) {
      expect(() => assertLocalDatabaseUrl(url)).toThrow(NonLocalDatabaseError);
      expect(() => assertLocalDatabaseUrl(url)).toThrow(/hosted Turso/);
    }
  });

  it("refuses any non-loopback host, not just the ones we can name", () => {
    for (const url of ["http://10.0.0.4:8080", "https://db.example.com", "libsql://192.168.1.9"]) {
      expect(() => assertLocalDatabaseUrl(url)).toThrow(NonLocalDatabaseError);
    }
  });

  it("refuses an empty URL rather than falling through to a default", () => {
    expect(() => assertLocalDatabaseUrl("   ")).toThrow(NonLocalDatabaseError);
  });
});
