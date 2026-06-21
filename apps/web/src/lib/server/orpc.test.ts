import { beforeEach, describe, expect, it, vi } from "vitest";

// The proof route + the rails seam. `resolveLogPageTarget` is mocked — the
// handler's job is to shape the contract response and the 404, not to touch
// Turso. These assertions pin the behavior the live /api/tracks/{idOrLogId}
// route had, now served by oRPC.
const resolveLogPageTarget = vi.fn();

vi.mock("./log-resolver", () => ({
  resolveLogPageTarget: (...args: unknown[]) => resolveLogPageTarget(...args),
}));

beforeEach(() => {
  resolveLogPageTarget.mockReset();
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

    // /tracks (list) is not converted in Phase 1 — oRPC must not claim it.
    expect(await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"))).toBeNull();
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

  it("404s when nothing resolves", async () => {
    resolveLogPageTarget.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/nope"));

    expect(response?.status).toBe(404);
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
