import { beforeEach, describe, expect, it, vi } from "vitest";

// The artist-avatar backfill: one bounded, cursor-resumable pass that fills
// `artists.image_url` from the largest Spotify image. The DB + Spotify fetch are
// mocked, so a test never hits a real database or the network.

const execute = vi.fn();
const fetchArtistImages = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./spotify", () => ({ fetchArtistImages }));

const { backfillArtistImages } = await import("./backfill-artist-images");

beforeEach(() => {
  execute.mockReset();
  fetchArtistImages.mockReset();
});

describe("backfillArtistImages", () => {
  it("fills the artists Spotify has an image for and skips the rest", async () => {
    // The SELECT of eligible artists, then an UPDATE per filled row.
    execute.mockResolvedValueOnce({
      rows: [
        { id: "a1", spotify_artist_id: "s1" },
        { id: "a2", spotify_artist_id: "s2" },
      ],
    });
    execute.mockResolvedValue({ rows: [] });
    fetchArtistImages.mockResolvedValue(new Map([["s1", "https://i.scdn.co/image/s1"]]));

    const result = await backfillArtistImages(50, false);

    expect(result.filled).toEqual(["a1"]);
    expect(result.skipped).toEqual(["a2"]); // Spotify had no image for s2.
    expect(result.failedCount).toBe(0);
    expect(result.nextCursor).toBeNull(); // page came back short of the cap.
    // One SELECT + one UPDATE (only the filled row is written).
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports the next cursor when the page fills the batch cap", async () => {
    execute.mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, i) => ({
        id: `a${i}`,
        spotify_artist_id: `s${i}`,
      })),
    });
    execute.mockResolvedValue({ rows: [] });
    fetchArtistImages.mockResolvedValue(new Map());

    const result = await backfillArtistImages(50, false);

    expect(result.nextCursor).toBe("a49");
    expect(result.filledCount).toBe(0);
    expect(result.skippedCount).toBe(50);
  });

  it("touches no image data and skips the Spotify call on a dry run", async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: "a1", spotify_artist_id: "s1" }] });

    const result = await backfillArtistImages(50, true);

    expect(result.dryRun).toBe(true);
    expect(result.filled).toEqual(["a1"]);
    expect(fetchArtistImages).not.toHaveBeenCalled();
    // Only the SELECT ran — no UPDATE on a dry run.
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
