import { afterEach, describe, expect, it, vi } from "vitest";

const readOptionalEnv = vi.hoisted(() => vi.fn<(key: string) => Promise<string | undefined>>());

vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  readOptionalEnv,
}));

import { SEARCH_LIMIT, searchArchiveRateLimit } from "./search";

afterEach(() => readOptionalEnv.mockReset());

function environment(values: Record<string, string | undefined>): void {
  readOptionalEnv.mockImplementation(async (key: string) => values[key]);
}

describe("searchArchiveRateLimit", () => {
  it("never lets a binding raise the production budget", async () => {
    environment({
      SEARCH_ARCHIVE_RATE_LIMIT: "100000",
      TURSO_DATABASE_URL: "libsql://example.invalid",
    });
    await expect(searchArchiveRateLimit()).resolves.toBe(SEARCH_LIMIT);

    environment({
      FLUNCLE_E2E: "1",
      SEARCH_ARCHIVE_RATE_LIMIT: "100000",
      TURSO_DATABASE_URL: "libsql://example.invalid",
    });
    await expect(searchArchiveRateLimit()).resolves.toBe(SEARCH_LIMIT);

    environment({
      SEARCH_ARCHIVE_RATE_LIMIT: "100000",
      TURSO_DATABASE_URL: "http://127.0.0.1:9440",
    });
    await expect(searchArchiveRateLimit()).resolves.toBe(SEARCH_LIMIT);
  });

  it("honours the override inside the e2e stack: the flag and a loopback database", async () => {
    environment({
      FLUNCLE_E2E: "1",
      SEARCH_ARCHIVE_RATE_LIMIT: "100000",
      TURSO_DATABASE_URL: "http://127.0.0.1:9440",
    });
    await expect(searchArchiveRateLimit()).resolves.toBe(100_000);

    for (const junk of [undefined, "", "0", "-5", "2.5", "lots"]) {
      environment({
        FLUNCLE_E2E: "1",
        SEARCH_ARCHIVE_RATE_LIMIT: junk,
        TURSO_DATABASE_URL: "http://localhost:9440",
      });
      await expect(searchArchiveRateLimit()).resolves.toBe(SEARCH_LIMIT);
    }
  });
});
