import { afterEach, describe, expect, it, vi } from "vitest";
import { takeWaitUntilPromises } from "../../test/cloudflare-workers-stub";
import { purgeTrackEntityPages } from "./entity-cache-purge";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRows: <T extends object>(rows: T[]) => rows,
}));

describe("track entity purge lifecycle", () => {
  afterEach(async () => {
    await Promise.all(takeWaitUntilPromises());
    vi.restoreAllMocks();
    execute.mockReset();
  });

  it("logs failed target lookup without rejecting a request", async () => {
    execute.mockRejectedValue(new Error("database unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(purgeTrackEntityPages("track-1")).toBeUndefined();
    await Promise.all(takeWaitUntilPromises());

    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({
        cause: expect.stringContaining("database unavailable"),
        event: "entity-cache.purge-error",
      }),
    ]);
  });
});
