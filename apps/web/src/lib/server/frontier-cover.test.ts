import { beforeEach, describe, expect, it, vi } from "vitest";

// The in-Worker Frontier-cover orchestration (E2): raster → stage-to-R2 → Cloudflare-Images JPEG
// → assert the Spotify byte ceiling → upload → clean up. Every prod-only seam (the WASM raster,
// the R2 bucket, the /cdn-cgi/image transform, the Spotify PUT) is INJECTED or mocked, so this
// pins the deterministic orchestration — the byte-ceiling gate, the best-effort degradation, the
// staging cleanup, the per-target tally — without a Workers runtime or Cloudflare Images.

vi.mock("./log", () => ({ logEvent: vi.fn() }));
vi.mock("./frontier-playlist", () => ({
  listFrontierCoverTargets: vi.fn(),
  putFrontierCover: vi.fn(),
}));

const { listFrontierCoverTargets, putFrontierCover } = await import("./frontier-playlist");
const { renderFrontierCoverJpeg, uploadFrontierCoverForUser, uploadFrontierCovers } =
  await import("./frontier-cover");

function fakeBucket() {
  return {
    delete: vi.fn(async (_key: string) => undefined),
    put: vi.fn(async (_key: string, _value: unknown, _options?: unknown) => undefined),
  };
}

/** A rasteriser stub — a tiny PNG stand-in, so `workers-og` never loads under vitest. */
const rasterize = async () => new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.mocked(listFrontierCoverTargets).mockReset();
  vi.mocked(putFrontierCover).mockReset();
});

describe("renderFrontierCoverJpeg", () => {
  it("stages the PNG, transforms to JPEG, base64-encodes it, and evicts the staging object", async () => {
    const bucket = fakeBucket();
    const jpeg = new Uint8Array([9, 8, 7, 6]);
    const transformFetch = vi.fn(
      async (_url: string, _init: { cf: { image: RequestInitCfPropertiesImage } }) =>
        new Response(jpeg, { status: 200 }),
    );

    const result = await renderFrontierCoverJpeg({
      bucket,
      crewNumber: 42,
      rasterize,
      transformFetch,
    });

    expect(result).toEqual({ jpegBase64: Buffer.from(jpeg).toString("base64"), ok: true });
    // Staged under a unique staging key, then evicted.
    expect(bucket.put).toHaveBeenCalledOnce();
    const stagedKey = bucket.put.mock.calls[0]?.[0] as string;
    expect(stagedKey).toMatch(/^frontier-covers\/staging\/.+\.png$/);
    expect(bucket.delete).toHaveBeenCalledWith(stagedKey);
    // Converted via the in-Worker `cf.image` transform of the staged found.fluncle.com source —
    // NEVER a `/cdn-cgi/image/…` URL (a Worker subrequest to its own zone bypasses the edge
    // interception of that path and 404s against R2; see the module header).
    const sourceUrl = transformFetch.mock.calls[0]?.[0] as string;
    const init = transformFetch.mock.calls[0]?.[1];
    expect(sourceUrl).toContain(stagedKey);
    expect(sourceUrl).not.toContain("/cdn-cgi/");
    expect(init?.cf.image).toMatchObject({ fit: "cover", format: "jpeg", quality: 80 });
  });

  it("refuses a render over the 192KB Spotify ceiling (loud, never pushes it)", async () => {
    const bucket = fakeBucket();
    const tooBig = new Uint8Array(200 * 1024);
    const transformFetch = vi.fn(async () => new Response(tooBig, { status: 200 }));

    const result = await renderFrontierCoverJpeg({
      bucket,
      crewNumber: 1,
      rasterize,
      transformFetch,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/^cover_too_large_/);
    // Still cleaned up.
    expect(bucket.delete).toHaveBeenCalledOnce();
  });

  it("surfaces a transform HTTP failure as a best-effort reason (never throws)", async () => {
    const bucket = fakeBucket();
    const transformFetch = vi.fn(async () => new Response("nope", { status: 502 }));

    const result = await renderFrontierCoverJpeg({
      bucket,
      crewNumber: 1,
      rasterize,
      transformFetch,
    });

    expect(result).toEqual({ ok: false, reason: "transform_502" });
    expect(bucket.delete).toHaveBeenCalledOnce();
  });

  it("a raster throw degrades to { ok: false } and STILL evicts the staging object", async () => {
    const bucket = fakeBucket();
    const throwingRaster = async () => {
      throw new Error("resvg boom");
    };

    // No transformFetch needed — the raster throws before any transform.
    const result = await renderFrontierCoverJpeg({
      bucket,
      crewNumber: 1,
      rasterize: throwingRaster,
    });

    expect(result).toEqual({ ok: false, reason: "resvg boom" });
    expect(bucket.delete).toHaveBeenCalledOnce();
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
