import { beforeEach, describe, expect, it, vi } from "vitest";
import { get, MIXTAPE, readJson, TRACK } from "./orpc-test-kit";

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
const getRandomRadioTrack = vi.fn();
const getRadioEligibleTracks = vi.fn();
const getRadioScheduleFingerprint = vi.fn();
const getRadioScheduleAnchor = vi.fn();
const getTrackByIdOrLogId = vi.fn();

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    getRadioEligibleTracks: (...args: unknown[]) => getRadioEligibleTracks(...args),
    getRadioScheduleAnchor: (...args: unknown[]) => getRadioScheduleAnchor(...args),
    getRadioScheduleFingerprint: (...args: unknown[]) => getRadioScheduleFingerprint(...args),
    getRandomRadioTrack: (...args: unknown[]) => getRandomRadioTrack(...args),
    getRandomTrack: (...args: unknown[]) => getRandomTrack(...args),
    getTrackByIdOrLogId: (...args: unknown[]) => getTrackByIdOrLogId(...args),
    listTracks: (...args: unknown[]) => listTracks(...args),
  };
});

// The radio ops gate the finding's galaxy behind the browse-by-feel launch gate
// (nothing public renders a galaxy until the whole map is named). Mocked so the
// radio reads never touch Turso; defaults to a fully-named map (galaxy passes
// through) and a gate test below flips it closed.
const isGalaxyMapFullyNamed = vi.fn();

vi.mock("./galaxies-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./galaxies-map")>();

  return {
    ...actual,
    isGalaxyMapFullyNamed: (...args: unknown[]) => isGalaxyMapFullyNamed(...args),
  };
});

beforeEach(() => {
  resolveLogPageTarget.mockReset();
  listTracks.mockReset();
  getRandomTrack.mockReset();
  getRandomRadioTrack.mockReset();
  getRadioEligibleTracks.mockReset();
  getRadioScheduleFingerprint.mockReset();
  getRadioScheduleAnchor.mockReset();
  getTrackByIdOrLogId.mockReset();
  isGalaxyMapFullyNamed.mockReset();
  isGalaxyMapFullyNamed.mockResolvedValue(true);
});

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
    expect(await readJson(response)).toEqual({ ok: true, track: TRACK });
    expect(resolveLogPageTarget).toHaveBeenCalledWith("abc");
  });

  it("serves the same handler on the bare /api alias", async () => {
    resolveLogPageTarget.mockResolvedValueOnce({ kind: "track", track: TRACK });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/tracks/abc"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, track: TRACK });
  });

  it("serves a mixtape arm as { ok: true, mixtape }", async () => {
    resolveLogPageTarget.mockResolvedValueOnce({ kind: "mixtape", mixtape: MIXTAPE });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/001.F.1A"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ mixtape: MIXTAPE, ok: true });
  });

  it("404s when nothing resolves — body parity with the legacy jsonError shape", async () => {
    resolveLogPageTarget.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/nope"));

    expect(response?.status).toBe(404);
    // Byte-shape parity with trackNotFoundResponse → jsonError(404, "not_found", …):
    // `{ code: "not_found", message: <string>, ok: false }`, nothing else.
    expect(await readJson(response)).toEqual({
      code: "not_found",
      message: expect.any(String),
      ok: false,
    });
  });

  it("500s an unexpected fault generically — the raw detail never reaches the wire", async () => {
    resolveLogPageTarget.mockRejectedValueOnce(new Error("turso fell over"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/abc"));

    expect(response?.status).toBe(500);
    // The unexpected-fault arm answers generically → jsonError(500, "error", "Internal error").
    const body = await readJson(response);
    expect(body).toEqual({ code: "error", message: "Internal error", ok: false });
    expect(JSON.stringify(body)).not.toContain("turso fell over");
    errSpy.mockRestore();
  });
});

describe("oRPC public read — GET /health (get_health)", () => {
  it("serves the bare { ok: true } envelope with Cache-Control: no-store", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/health"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("serves the same handler on the bare /api alias", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/health"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await readJson(response)).toEqual({ ok: true });
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
    expect(await readJson(response)).toEqual(PAGE);
  });

  it("defaults the limit and includes mixtapes when unwindowed", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      includeMixtapes: true,
      lean: true,
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
      lean: true,
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
      lean: true,
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
      lean: true,
      limit: 16,
      since: undefined,
      until: undefined,
    });
  });

  it("STRIPS the private sourceAudioKey from a captured finding before it world-serves", async () => {
    // The admin capture-queue read surfaces the private R2 key; the PUBLIC feed must not.
    const captured = { ...TRACK, sourceAudioKey: "004.7.2I/abc123.m4a", trackId: "captured" };
    listTracks.mockResolvedValueOnce({ totalCount: 1, tracks: [captured] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks[0]).not.toHaveProperty("sourceAudioKey");
    // The rest of the finding survives — only the private key is removed.
    expect(body.tracks[0]?.trackId).toBe("captured");
  });
});

describe("oRPC public read — GET /tracks/random (get_random_track)", () => {
  it("serves { ok: true, track }", async () => {
    getRandomTrack.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/random"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, track: TRACK });
  });

  it("STRIPS the private sourceAudioKey from the served track", async () => {
    getRandomTrack.mockResolvedValueOnce({ ...TRACK, sourceAudioKey: "004.7.2I/abc123.m4a" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/random"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { track: Record<string, unknown> };
    expect(body.track).not.toHaveProperty("sourceAudioKey");
    expect(body.track.trackId).toBe(TRACK.trackId);
  });

  it("404s an empty archive with the custom track_not_found code (byte parity)", async () => {
    getRandomTrack.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks/random"));

    expect(response?.status).toBe(404);
    // Parity with the live route's hand-rolled 404 body — code is the custom
    // `track_not_found`, NOT the rails' generic `not_found` mapping.
    expect(await readJson(response)).toEqual({
      code: "track_not_found",
      message: "No tracks found",
      ok: false,
    });
  });
});

describe("oRPC public read — GET /radio/random (get_random_radio_track)", () => {
  it("serves { ok: true, track } from the radio-eligible query", async () => {
    getRandomRadioTrack.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/random"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, track: TRACK });
    // The radio op reads ONLY the eligibility-filtered query — never the unfiltered
    // random read, so an un-squared / observation-less track can never reach it.
    expect(getRandomRadioTrack).toHaveBeenCalledTimes(1);
    expect(getRandomTrack).not.toHaveBeenCalled();
  });

  it("404s an empty eligible set with the custom track_not_found code", async () => {
    getRandomRadioTrack.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/random"));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "track_not_found",
      message: "No radio-eligible tracks found",
      ok: false,
    });
  });
});

describe("oRPC public read — GET /radio/now-playing (get_radio_now_playing)", () => {
  const CURRENT = { ...TRACK, logId: "001.1.1A", trackId: "track-a" };
  const NEXT = { ...TRACK, logId: "002.1.1B", trackId: "track-b" };

  function wireSchedule() {
    getRadioEligibleTracks.mockResolvedValueOnce([
      { logId: "001.1.1A", observationDurationMs: 20_000, trackId: "track-a" },
      { logId: "002.1.1B", observationDurationMs: 30_000, trackId: "track-b" },
    ]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("2:2026-06-10T00:00:00.000Z");
    // Anchor at "now − 5s" so the modulo lands 5s into the first segment.
    getRadioScheduleAnchor.mockResolvedValueOnce({
      epochMs: Date.now() - 5_000,
      version: "2:2026-06-10T00:00:00.000Z",
    });
    getTrackByIdOrLogId.mockImplementation(async (id: string) =>
      id === "track-a" ? CURRENT : id === "track-b" ? NEXT : undefined,
    );
  }

  it("serves { ok: true, nowPlaying } — the slot + offset on the shared loop", async () => {
    wireSchedule();

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      ok: true;
      nowPlaying: {
        currentTrack: { trackId: string };
        nextTrack?: { trackId: string };
        offsetMs: number;
        scheduleVersion: string;
        serverEpochMs: number;
        totalLoopDurationMs: number;
        trackCount: number;
      };
    };

    expect(body.ok).toBe(true);
    expect(body.nowPlaying.currentTrack.trackId).toBe("track-a");
    expect(body.nowPlaying.nextTrack?.trackId).toBe("track-b");
    // 5s into the 20s first segment, within a coarse tolerance for the Date.now()s.
    expect(body.nowPlaying.offsetMs).toBeGreaterThanOrEqual(4_000);
    expect(body.nowPlaying.offsetMs).toBeLessThanOrEqual(6_000);
    expect(body.nowPlaying.totalLoopDurationMs).toBe(50_000);
    expect(body.nowPlaying.trackCount).toBe(2);
    expect(body.nowPlaying.scheduleVersion).toBe("2:2026-06-10T00:00:00.000Z");
    expect(typeof body.nowPlaying.serverEpochMs).toBe("number");
    // The now-playing read never falls through to the random read.
    expect(getRandomRadioTrack).not.toHaveBeenCalled();
  });

  it("404s an empty schedule with the custom track_not_found code", async () => {
    getRadioEligibleTracks.mockResolvedValueOnce([]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("0:");
    getRadioScheduleAnchor.mockResolvedValueOnce({ epochMs: Date.now(), version: "0:" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({
      code: "track_not_found",
      message: "No radio-eligible tracks found",
      ok: false,
    });
  });

  it("omits a self-referential nextTrack on a single-finding loop", async () => {
    getRadioEligibleTracks.mockResolvedValueOnce([
      { logId: "001.1.1A", observationDurationMs: 20_000, trackId: "track-a" },
    ]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("1:x");
    getRadioScheduleAnchor.mockResolvedValueOnce({ epochMs: Date.now(), version: "1:x" });
    getTrackByIdOrLogId.mockResolvedValue(CURRENT);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    const body = (await response?.json()) as { nowPlaying: { nextTrack?: unknown } };
    expect(body.nowPlaying.nextTrack).toBeUndefined();
  });

  it("strips the galaxy from now-playing until the whole map is named (launch gate)", async () => {
    const PLACED = { ...CURRENT, galaxy: { name: "Nebular", slug: "nebular" } };
    getRadioEligibleTracks.mockResolvedValueOnce([
      { logId: "001.1.1A", observationDurationMs: 20_000, trackId: "track-a" },
    ]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("1:g");
    getRadioScheduleAnchor.mockResolvedValueOnce({ epochMs: Date.now(), version: "1:g" });
    getTrackByIdOrLogId.mockResolvedValue(PLACED);
    // The map is only partially named — the gate is closed.
    isGalaxyMapFullyNamed.mockReset();
    isGalaxyMapFullyNamed.mockResolvedValue(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      nowPlaying: { currentTrack: { galaxy?: unknown; trackId: string } };
    };
    // The finding still serves; only its galaxy is dark until the lens ships.
    expect(body.nowPlaying.currentTrack.trackId).toBe("track-a");
    expect(body.nowPlaying.currentTrack.galaxy).toBeUndefined();
  });

  it("carries the galaxy on now-playing once the map is fully named", async () => {
    const PLACED = { ...CURRENT, galaxy: { name: "Nebular", slug: "nebular" } };
    getRadioEligibleTracks.mockResolvedValueOnce([
      { logId: "001.1.1A", observationDurationMs: 20_000, trackId: "track-a" },
    ]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("1:h");
    getRadioScheduleAnchor.mockResolvedValueOnce({ epochMs: Date.now(), version: "1:h" });
    getTrackByIdOrLogId.mockResolvedValue(PLACED);
    // Default beforeEach state is fully-named, but pin it for the record.
    isGalaxyMapFullyNamed.mockResolvedValue(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    const body = (await response?.json()) as {
      nowPlaying: { currentTrack: { galaxy?: { name: string } } };
    };
    expect(body.nowPlaying.currentTrack.galaxy?.name).toBe("Nebular");
  });
});

// The generated PUBLIC OpenAPI document — the spec served at /api/v1/openapi.json
// (Scalar + Postman read it) since the spec flip retired the static
// public/openapi.json. The load-bearing constraint: it carries EVERY public op and
// ZERO admin ops — admin stays OFF the public spec.
type ErrorSchema = {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, { type?: string; const?: unknown }>;
  required?: string[];
};

type Operation = {
  operationId?: string;
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
};

type GeneratedSpec = {
  openapi: string;
  info: { title: string; version: string; summary?: string; description?: string };
  servers?: { url: string }[];
  components?: { schemas?: Record<string, ErrorSchema> };
  paths: Record<string, Record<string, Operation>>;
};

// Every public op's operationId (the camelCase projection of its verb_noun key),
// derived from the same registry the public coverage net is drawn over. The
// generated public spec must contain exactly these — no more (no admin leak), no
// fewer (no dropped public op).
const PUBLIC_OPERATION_IDS = [
  "collectPrivateGalaxyLog",
  "deletePrivateAccount",
  "deregisterDevice",
  "exportPrivateAccountData",
  // Artist reads — public, no auth required (Unit 4 of the artist-relationship RFC).
  "getArtist",
  "getCurrentPrivateUser",
  "getEdition",
  // Galaxy reads — public, no auth (browse-by-feel RFC).
  "getGalaxy",
  "getHealth",
  "getPrivateAccountExport",
  "getPrivateGalaxyProgress",
  "getPrivateMutationToken",
  "getRadioNowPlaying",
  "getRandomRadioTrack",
  "getRandomTrack",
  "getSimilarFindings",
  "getTrack",
  "listArtists",
  "listEditions",
  "listGalaxies",
  "listMixableTracks",
  "listMixtapes",
  "listPrivateSavedFindings",
  "listPrivateSubmissions",
  "listStories",
  "listTracks",
  "mergePrivateGalaxyProgress",
  "registerDevice",
  "savePrivateFinding",
  "searchTracks",
  "submitTrack",
  "subscribeNewsletter",
  "unsavePrivateFinding",
  "updatePrivateProfile",
];

function collectOperationIds(spec: GeneratedSpec): {
  ids: string[];
  paths: string[];
} {
  const ids: string[] = [];
  const paths: string[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const operation of Object.values(item)) {
      if (operation.operationId !== undefined) {
        ids.push(operation.operationId);
        paths.push(path);
      }
    }
  }

  return { ids, paths };
}

describe("oRPC OpenAPI generation — the public spec (the flip)", () => {
  it("generates a valid OpenAPI 3.1 document with the published info + server", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;

    expect(document.openapi).toMatch(/^3\.1/);
    // Contract values stay exact (the version + server URL are the API's identity).
    expect(document.info.version).toBe("1.0.0");
    expect(document.servers?.[0]?.url).toBe("https://www.fluncle.com/api/v1");
    // The marketing prose (title/summary/description) is relaxed to presence checks
    // so a harmless copy edit doesn't break the spec test — it just has to be there
    // and mention Fluncle.
    expect(document.info.title).toContain("Fluncle");
    expect(typeof document.info.summary).toBe("string");
    expect((document.info.summary ?? "").length).toBeGreaterThan(0);
    expect(document.info.description ?? "").toContain("Fluncle");
  });

  it("contains EVERY public op with its correct operationId", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;
    const { ids } = collectOperationIds(document);

    for (const operationId of PUBLIC_OPERATION_IDS) {
      expect(ids, `public operationId "${operationId}" missing from the generated spec`).toContain(
        operationId,
      );
    }

    // The proof route is still wired (regression guard).
    expect(document.paths["/tracks/{idOrLogId}"]?.get?.operationId).toBe("getTrack");
  });

  it("contains ZERO admin ops — no path under /admin leaks onto the public spec", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;
    const { ids, paths } = collectOperationIds(document);

    // No path under the admin tier.
    const adminPaths = paths.filter((path) => path === "/admin" || path.startsWith("/admin/"));
    expect(adminPaths, `admin paths leaked onto the public spec: ${adminPaths.join(", ")}`).toEqual(
      [],
    );

    // And the op set is EXACTLY the public surface — nothing extra, nothing missing.
    expect(new Set(ids)).toEqual(new Set(PUBLIC_OPERATION_IDS));
  });

  it("documents the shared Error component as the rails encoder's { code, message, ok: false } envelope", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;

    // The shared fault component MUST mirror the rails encoder (orpc.ts
    // `encodeErrorBody` → env.ts `jsonError`) exactly: a string `code`, a string
    // `message`, and `ok` pinned to the literal `false`, with nothing else — so the
    // spec never claims a field the wire doesn't carry.
    const error = document.components?.schemas?.Error;
    expect(error).toBeDefined();
    expect(error?.type).toBe("object");
    expect(error?.additionalProperties).toBe(false);
    expect(new Set(error?.required ?? [])).toEqual(new Set(["code", "message", "ok"]));
    expect(error?.properties?.code?.type).toBe("string");
    expect(error?.properties?.message?.type).toBe("string");
    expect(error?.properties?.ok?.type).toBe("boolean");
    expect(error?.properties?.ok?.const).toBe(false);
  });

  it("attaches the Error envelope as the default response on every public op (sampled)", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;

    // A sampled GET read, a POST write, and the proof route — each must carry the
    // shared fault as its `default` response, $ref-ing the one Error component.
    const sampled: [path: string, method: string][] = [
      ["/tracks/{idOrLogId}", "get"],
      ["/tracks", "get"],
      ["/newsletter", "post"],
    ];

    for (const [path, method] of sampled) {
      const operation = document.paths[path]?.[method];
      expect(
        operation,
        `expected ${method.toUpperCase()} ${path} on the public spec`,
      ).toBeDefined();
      const ref = operation?.responses?.default?.content?.["application/json"]?.schema?.$ref;
      expect(ref, `${method.toUpperCase()} ${path} is missing the default Error response`).toBe(
        "#/components/schemas/Error",
      );
    }

    // And EVERY public operation carries it — no op is documented without its fault
    // shape, and the success responses are left intact alongside it.
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        if (operation.operationId === undefined) {
          continue;
        }
        const responses = operation.responses ?? {};
        expect(
          responses.default?.content?.["application/json"]?.schema?.$ref,
          `op "${operation.operationId}" is missing the default Error response`,
        ).toBe("#/components/schemas/Error");
        // The success response(s) survive — `default` is additive, not a replacement.
        const nonDefault = Object.keys(responses).filter((status) => status !== "default");
        expect(
          nonDefault.length,
          `op "${operation.operationId}" lost its success response`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
