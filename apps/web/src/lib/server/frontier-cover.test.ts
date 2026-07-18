import { decode as decodeJpeg } from "jpeg-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The in-Worker Frontier-cover orchestration (E2): raster → jpeg-js encode → assert the Spotify
// byte ceiling → upload. The raster seam is INJECTED (the workers-og + resvg wasm legs cannot
// load under vitest), but the JPEG encode is the REAL jpeg-js — pure JS — so the encode leg,
// the quality ladder, and the ceiling gate are all proven here, not just mocked around. Only
// the satori/resvg raster itself remains prod-only.

vi.mock("./log", () => ({ logEvent: vi.fn() }));
vi.mock("./frontier-playlist", () => ({
  listFrontierCoverTargets: vi.fn(),
  putFrontierCover: vi.fn(),
}));

const { listFrontierCoverTargets, putFrontierCover } = await import("./frontier-playlist");
const { renderFrontierCoverJpeg, uploadFrontierCoverForUser, uploadFrontierCovers } =
  await import("./frontier-cover");

/** Synthetic RGBA pixels: a flat dark field (compresses tiny — the happy path). */
function darkRaster(size: number) {
  const pixels = new Uint8Array(size * size * 4);

  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 9;
    pixels[i + 1] = 10;
    pixels[i + 2] = 11;
    pixels[i + 3] = 255;
  }

  return { height: size, pixels, width: size };
}

/** Deterministic noise (an LCG): JPEG's worst case, to blow the byte ceiling in the ladder test. */
function noiseRaster(size: number) {
  const pixels = new Uint8Array(size * size * 4);
  let seed = 0x2f6e2b1;

  for (let i = 0; i < pixels.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = seed & 0xff;
  }

  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = 255;
  }

  return { height: size, pixels, width: size };
}

beforeEach(() => {
  vi.mocked(listFrontierCoverTargets).mockReset();
  vi.mocked(putFrontierCover).mockReset();
});

describe("renderFrontierCoverJpeg", () => {
  it("encodes the raster to a real Base64 JPEG under the ceiling (the whole leg, in-process)", async () => {
    const rasterize = vi.fn(async (_html: string) => darkRaster(64));

    const result = await renderFrontierCoverJpeg({ crewNumber: 42, rasterize });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("unreachable");
    }

    // The Base64 decodes to real JPEG bytes (SOI marker) at the raster's dimensions.
    const bytes = Buffer.from(result.jpegBase64, "base64");
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    const decoded = decodeJpeg(bytes);
    expect({ height: decoded.height, width: decoded.width }).toEqual({ height: 64, width: 64 });
    // The markup fed to the raster is the Satori twin.
    expect(rasterize.mock.calls[0]?.[0]).toContain("FRONTIER");
  });

  it("refuses when even the quality ladder's floor blows the 192KB Spotify ceiling (loud)", async () => {
    // 1024² full-spectrum noise stays far above 192KB even at quality 60.
    const rasterize = vi.fn(async () => noiseRaster(1024));

    const result = await renderFrontierCoverJpeg({ crewNumber: 1, rasterize });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/^cover_too_large_/);
  });

  it("a raster throw degrades to { ok: false } with the message as the reason", async () => {
    const rasterize = async () => {
      throw new Error("resvg boom");
    };

    const result = await renderFrontierCoverJpeg({ crewNumber: 1, rasterize });

    expect(result).toEqual({ ok: false, reason: "resvg boom" });
  });
});

describe("uploadFrontierCoverForUser (the mint fire's engine)", () => {
  it("renders then hands the JPEG to putFrontierCover on success", async () => {
    vi.mocked(putFrontierCover).mockResolvedValue({ uploaded: true });
    const render = vi.fn(async () => ({ jpegBase64: "B64", ok: true as const }));

    const result = await uploadFrontierCoverForUser(
      { crewNumber: 42, playlistId: "pl-1", userId: "u1" },
      render,
    );

    expect(result).toEqual({ uploaded: true });
    expect(render).toHaveBeenCalledWith(42);
    expect(putFrontierCover).toHaveBeenCalledWith("u1", "pl-1", "B64");
  });

  it("a render miss abstains WITHOUT touching Spotify (best-effort, retried by the backfill)", async () => {
    const render = vi.fn(async () => ({ ok: false as const, reason: "resvg boom" }));

    const result = await uploadFrontierCoverForUser(
      { crewNumber: 42, playlistId: "pl-1", userId: "u1" },
      render,
    );

    expect(result).toEqual({ reason: "resvg boom", uploaded: false });
    expect(putFrontierCover).not.toHaveBeenCalled();
  });
});

describe("uploadFrontierCovers (the retry drain)", () => {
  it("tallies uploaded / missing-scope / failed across the worklist", async () => {
    vi.mocked(listFrontierCoverTargets).mockResolvedValue([
      { crewNumber: 1, handle: "a", playlistId: "p1", userId: "u1" },
      { crewNumber: 2, handle: "b", playlistId: "p2", userId: "u2" },
      { crewNumber: null, handle: null, playlistId: "p3", userId: "u3" },
    ]);
    vi.mocked(putFrontierCover)
      .mockResolvedValueOnce({ uploaded: true })
      .mockResolvedValueOnce({ reason: "missing_scope", uploaded: false })
      .mockResolvedValueOnce({ reason: "spotify_500: down", uploaded: false });
    const render = vi.fn(async () => ({ jpegBase64: "B64", ok: true as const }));

    const result = await uploadFrontierCovers(50, render);

    expect(result).toEqual({
      failed: 1,
      missingScope: 1,
      ok: true,
      rendered: 3,
      targets: 3,
      uploaded: 1,
    });
  });

  it("counts a render miss as failed and never reaches Spotify for it", async () => {
    vi.mocked(listFrontierCoverTargets).mockResolvedValue([
      { crewNumber: 1, handle: "a", playlistId: "p1", userId: "u1" },
    ]);
    const render = vi.fn(async () => ({ ok: false as const, reason: "boom" }));

    const result = await uploadFrontierCovers(50, render);

    expect(result).toMatchObject({ failed: 1, rendered: 0, targets: 1, uploaded: 0 });
    expect(putFrontierCover).not.toHaveBeenCalled();
  });
});
