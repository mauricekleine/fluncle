import { beforeEach, describe, expect, it, vi } from "vitest";

// The proof route + the rails seam. `resolveLogPageTarget` is mocked — the
// handler's job is to shape the contract response and the 404, not to touch
// Turso. These assertions pin the behavior the live /api/tracks/{idOrLogId}
// route had, now served by oRPC.
const resolveLogPageTarget = vi.fn();

vi.mock("./log-resolver", () => ({
  resolveLogPageTarget: (...args: unknown[]) => resolveLogPageTarget(...args),
}));

// The tracks server module backs the `list_tracks` + `get_random_track` reads.
// `decodeTrackCursor` is the real implementation re-exported so the handler's
// cursor decode behaves exactly as production; the data fetchers are mocked.
const listTracks = vi.fn();
const getRandomTrack = vi.fn();

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    getRandomTrack: (...args: unknown[]) => getRandomTrack(...args),
    listTracks: (...args: unknown[]) => listTracks(...args),
  };
});

beforeEach(() => {
  resolveLogPageTarget.mockReset();
  listTracks.mockReset();
  getRandomTrack.mockReset();
});

function get(url: string): Request {
  return new Request(url, { method: "GET" });
}

const TRACK = {
  addedAt: "2026-01-01T00:00:00.000Z",
  addedToSpotify: true,
  artists: ["Some Artist"],
  durationMs: 300000,
  enrichmentStatus: "done",
  postedToTelegram: true,
  spotifyUrl: "https://open.spotify.com/track/abc",
  title: "Some Banger",
  trackId: "abc",
};

const MIXTAPE = {
  artists: ["Fluncle"] as ["Fluncle"],
  externalUrls: {},
  memberCount: 0,
  members: [],
  status: "published" as const,
  title: "A Set",
  type: "mixtape" as const,
};

describe("oRPC rails — handleOrpc", () => {
  it("ignores non-/api requests (returns null so they fall through)", async () => {
    const { handleOrpc } = await import("./orpc");

    expect(await handleOrpc(get("https://www.fluncle.com/log"))).toBeNull();
    expect(resolveLogPageTarget).not.toHaveBeenCalled();
  });

  it("falls through (null) for an /api route with no contract yet", async () => {
    const { handleOrpc } = await import("./orpc");

    // /me/profile is the private (`/me`) tier — Wave B, not converted yet — so
    // oRPC must not claim it; it falls through to TanStack.
    expect(await handleOrpc(get("https://www.fluncle.com/api/v1/me/profile"))).toBeNull();
  });
});

describe("oRPC proof route — GET /tracks/{idOrLogId} (get_track)", () => {
  it("serves a finding as { ok: true, track } on the canonical /api/v1 mount", async () => {
    resolveLogPageTarget.mockResolvedValueOnce({ kind: "track", track: TRACK });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/abc"));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, track: TRACK });
    expect(resolveLogPageTarget).toHaveBeenCalledWith("abc");
  });

  it("serves the same handler on the bare /api alias", async () => {
    resolveLogPageTarget.mockResolvedValueOnce({ kind: "track", track: TRACK });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/tracks/abc"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, track: TRACK });
  });

  it("serves a mixtape arm as { ok: true, mixtape }", async () => {
    resolveLogPageTarget.mockResolvedValueOnce({ kind: "mixtape", mixtape: MIXTAPE });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/001.F.1A"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ mixtape: MIXTAPE, ok: true });
  });

  it("404s when nothing resolves — body parity with the legacy jsonError shape", async () => {
    resolveLogPageTarget.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/nope"));

    expect(response?.status).toBe(404);
    // Byte-shape parity with trackNotFoundResponse → jsonError(404, "not_found", …):
    // `{ code: "not_found", message: <string>, ok: false }`, nothing else.
    expect(await response?.json()).toEqual({
      code: "not_found",
      message: expect.any(String),
      ok: false,
    });
  });

  it("500s an unexpected fault as { code: 'error', message, ok: false }", async () => {
    resolveLogPageTarget.mockRejectedValueOnce(new Error("turso fell over"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/abc"));

    expect(response?.status).toBe(500);
    // Parity with apiErrorResponse's generic arm → jsonError(500, "error", message).
    expect(await response?.json()).toEqual({
      code: "error",
      message: "turso fell over",
      ok: false,
    });
  });
});

describe("oRPC public read — GET /health (get_health)", () => {
  it("serves the bare { ok: true } envelope with Cache-Control: no-store", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/health"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toEqual({ ok: true });
  });

  it("serves the same handler on the bare /api alias", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/health"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toEqual({ ok: true });
  });
});

describe("oRPC public read — GET /tracks (list_tracks)", () => {
  const PAGE = {
    nextCursor: "eyJhZGRlZEF0IjoiMjAyNi0wMS0wMSJ9",
    totalCount: 42,
    tracks: [TRACK],
  };

  it("serves the FeedListPage as the body (no ok envelope)", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(PAGE);
  });

  it("defaults the limit and includes mixtapes when unwindowed", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      includeMixtapes: true,
      limit: 16,
      since: undefined,
      until: undefined,
    });
  });

  it("clamps the limit to 48 and parses the query params", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { encodeTrackCursor } = await import("./tracks");
    const cursor = encodeTrackCursor({ addedAt: "2026-01-01T00:00:00.000Z", trackId: "abc" });

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get(`https://www.fluncle.com/api/v1/tracks?limit=100&cursor=${cursor}`));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: { addedAt: "2026-01-01T00:00:00.000Z", trackId: "abc" },
      includeMixtapes: true,
      limit: 48,
      since: undefined,
      until: undefined,
    });
  });

  it("drops mixtapes and normalizes the discovery window when since/until are present", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(
      get("https://www.fluncle.com/api/v1/tracks?since=2026-01-01&until=2026-02-01T00:00:00Z"),
    );

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      includeMixtapes: false,
      limit: 16,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
    });
  });

  it("ignores a non-integer limit and a malformed window (degrades like the live route)", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/tracks?limit=abc&since=not-a-date"));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      includeMixtapes: true,
      limit: 16,
      since: undefined,
      until: undefined,
    });
  });
});

describe("oRPC public read — GET /tracks/random (get_random_track)", () => {
  it("serves { ok: true, track }", async () => {
    getRandomTrack.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/random"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, track: TRACK });
  });

  it("404s an empty archive with the custom track_not_found code (byte parity)", async () => {
    getRandomTrack.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/random"));

    expect(response?.status).toBe(404);
    // Parity with the live route's hand-rolled 404 body — code is the custom
    // `track_not_found`, NOT the rails' generic `not_found` mapping.
    expect(await response?.json()).toEqual({
      code: "track_not_found",
      message: "No tracks found",
      ok: false,
    });
  });
});

describe("oRPC OpenAPI generation", () => {
  it("generates a 3.1 document with the get_track operation", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.info).toEqual({ title: "Fluncle API", version: "1.0.0" });

    const op = document.paths["/tracks/{idOrLogId}"]?.get;

    expect(op?.operationId).toBe("getTrack");
  });
});
