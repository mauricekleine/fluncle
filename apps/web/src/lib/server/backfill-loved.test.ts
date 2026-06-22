import { beforeEach, describe, expect, it, vi } from "vitest";

// The admin-board reader that surfaces the Last.fm loved-status: which findings
// carry a `backfill_lastfm_done_at` (the same stamp a successful `track.love`
// writes). The board turns this Set into the LFM heart, so the indicator tracks
// the real loved-status instead of a hardcoded "not wired yet".

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listLastfmLovedForTracks", () => {
  it("returns the empty set without querying when given no trackIds", async () => {
    const { listLastfmLovedForTracks } = await import("./backfill");
    const loved = await listLastfmLovedForTracks([]);

    expect(loved.size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("queries done_at and returns only the loved trackIds as a Set", async () => {
    execute.mockResolvedValueOnce({ rows: [{ track_id: "a" }, { track_id: "c" }] });

    const { listLastfmLovedForTracks } = await import("./backfill");
    const loved = await listLastfmLovedForTracks(["a", "b", "c"]);

    expect(loved.has("a")).toBe(true);
    expect(loved.has("c")).toBe(true);
    expect(loved.has("b")).toBe(false);

    const call = execute.mock.calls[0]?.[0] as { args: unknown[]; sql: string };

    expect(call.sql).toContain("backfill_lastfm_done_at is not null");
    expect(call.args).toEqual(["a", "b", "c"]);
  });
});
