import { beforeEach, describe, expect, it, vi } from "vitest";

// The artist-avatar backfill: one bounded, cursor-resumable pass that fills
// `artists.image_url` from the largest Spotify image. The DB + Spotify helper are
// mocked, so a test never hits a real database or the network.

const execute = vi.fn();
const fetchArtistImages = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return {
    ...actual,
    getDb: async () => ({
      batch: (statements: { args?: unknown[]; sql: string }[]) =>
        Promise.all(
          statements.map((statement) =>
            statement.sql.includes("insert into due_work")
              ? Promise.resolve({ rows: [], rowsAffected: 1 })
              : execute(statement),
          ),
        ),
      execute,
    }),
  };
});

vi.mock("./due-work-cutover", () => ({ isDueWorkCutoverEnabled: async () => false }));

vi.mock("./spotify", () => ({ fetchArtistImages }));

const { backfillArtistImages } = await import("./backfill-artist-images");

beforeEach(() => {
  execute.mockReset();
  fetchArtistImages.mockReset();
});

describe("backfillArtistImages", () => {
  it("fills images, terminally stamps genuine misses, and reports exact post-pass depth", async () => {
    // The eligible SELECT, one UPDATE per classified row, then the exact queue count.
    execute.mockResolvedValueOnce({
      rows: [
        { id: "a1", spotify_artist_id: "s1" },
        { id: "a2", spotify_artist_id: "s2" },
      ],
    });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [{ queue_depth: 0 }] });
    fetchArtistImages.mockResolvedValue({
      budgetLimited: false,
      checkedCount: 2,
      checkedIds: ["s1", "s2"],
      failures: new Map(),
      images: new Map([["s1", "https://i.scdn.co/image/s1"]]),
      missingIds: new Set(["s2"]),
      rateLimited: false,
    });

    const result = await backfillArtistImages(50, false);

    expect(result.filled).toEqual(["a1"]);
    expect(result.skipped).toEqual(["a2"]);
    expect(result.checkedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.queueDepth).toBe(0);
    expect(result.nextCursor).toBeNull(); // page came back short of the cap.
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[2]?.[0].sql).toContain("image_state = 'none'");
    expect(execute.mock.calls[2]?.[0].sql).not.toContain("updated_at");
  });

  it("stops the cursor drain on budget deferral and leaves unchecked rows pending", async () => {
    execute.mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, i) => ({
        id: `a${i}`,
        spotify_artist_id: `s${i}`,
      })),
    });
    execute.mockResolvedValueOnce({ rows: [{ queue_depth: 50 }] });
    fetchArtistImages.mockResolvedValue({
      budgetLimited: true,
      checkedCount: 0,
      checkedIds: [],
      failures: new Map(),
      images: new Map(),
      missingIds: new Set(),
      rateLimited: false,
    });

    const result = await backfillArtistImages(50, false);

    expect(result.budgetLimited).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.queueDepth).toBe(50);
    expect(result.filledCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it("does not classify an exhausted 429 as a genuine missing image", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { id: "a1", spotify_artist_id: "s1" },
        { id: "a2", spotify_artist_id: "s2" },
      ],
    });
    execute.mockResolvedValueOnce({ rows: [{ queue_depth: 2 }] });
    fetchArtistImages.mockResolvedValue({
      budgetLimited: false,
      checkedCount: 1,
      checkedIds: ["s1"],
      failures: new Map(),
      images: new Map(),
      missingIds: new Set(),
      rateLimited: true,
    });

    const result = await backfillArtistImages(50, false);

    expect(result.rateLimited).toBe(true);
    expect(result.checkedCount).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.queueDepth).toBe(2);
    expect(result.nextCursor).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("touches no image data and skips the Spotify call on a dry run", async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: "a1", spotify_artist_id: "s1" }] });
    execute.mockResolvedValueOnce({ rows: [{ queue_depth: 1 }] });

    const result = await backfillArtistImages(50, true);

    expect(result.dryRun).toBe(true);
    expect(result.filled).toEqual(["a1"]);
    expect(result.checkedCount).toBe(1);
    expect(result.queueDepth).toBe(1);
    expect(fetchArtistImages).not.toHaveBeenCalled();
    // Selection + exact queue count; no UPDATE on a dry run.
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
