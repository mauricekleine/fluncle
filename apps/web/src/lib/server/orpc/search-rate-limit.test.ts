import { afterEach, describe, expect, it, vi } from "vitest";

const readOptionalEnv = vi.hoisted(() => vi.fn<(key: string) => Promise<string | undefined>>());

vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  readOptionalEnv,
}));

import { SEARCH_LIMIT, searchArchiveRateLimit } from "./search";

afterEach(() => readOptionalEnv.mockReset());

describe("searchArchiveRateLimit", () => {
  it("is the default budget unless a deployment sets a positive whole number", async () => {
    for (const unset of [undefined, "", "0", "-5", "2.5", "lots"]) {
      readOptionalEnv.mockResolvedValue(unset);
      await expect(searchArchiveRateLimit()).resolves.toBe(SEARCH_LIMIT);
    }

    readOptionalEnv.mockResolvedValue("100000");
    await expect(searchArchiveRateLimit()).resolves.toBe(100_000);
    expect(readOptionalEnv).toHaveBeenCalledWith("SEARCH_ARCHIVE_RATE_LIMIT");
  });
});
