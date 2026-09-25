import { beforeEach, describe, expect, it, vi } from "vitest";
import { SENTRY_RELEASE } from "../sentry-config";
import { get, MIXTAPE, readJson, TRACK, warmOrpcRouter } from "./orpc-test-kit";

const resolveLogPageTarget = vi.fn();

vi.mock("./log-resolver", () => ({
  resolveLogPageTarget: (...args: unknown[]) => resolveLogPageTarget(...args),
}));

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

const listTracksHubPage = vi.fn();

vi.mock("./tracks-hub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks-hub")>();

  return {
    ...actual,
    listTracksHubPage: (...args: unknown[]) => listTracksHubPage(...args),
  };
});

const isGalaxyMapFullyNamed = vi.fn();

vi.mock("./galaxies-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./galaxies-map")>();

  return {
    ...actual,
    isGalaxyMapFullyNamed: (...args: unknown[]) => isGalaxyMapFullyNamed(...args),
  };
});

warmOrpcRouter();

beforeEach(() => {
  resolveLogPageTarget.mockReset();
  listTracks.mockReset();
  listTracksHubPage.mockReset();
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

  it("serves nothing off the bare /api prefix — it falls through to TanStack", async () => {
    resolveLogPageTarget.mockResolvedValueOnce({ kind: "track", track: TRACK });

    const { handleOrpc } = await import("./orpc");

    expect(await handleOrpc(get("https://www.fluncle.com/api/tracks/abc"))).toBeNull();
    expect(resolveLogPageTarget).not.toHaveBeenCalled();
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

    const body = await readJson(response);
    expect(body).toEqual({ code: "error", message: "Internal error", ok: false });
    expect(JSON.stringify(body)).not.toContain("turso fell over");
    errSpy.mockRestore();
  });
});

describe("oRPC public read — GET /health (get_health)", () => {
  const expectedSha = SENTRY_RELEASE ?? null;

  it("serves { ok: true, sha } with Cache-Control: no-store", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/health"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await readJson(response)).toEqual({ ok: true, sha: expectedSha });
  });
});

describe("oRPC public read — GET /findings (list_findings)", () => {
  const PAGE = {
    nextCursor: "eyJhZGRlZEF0IjoiMjAyNi0wMS0wMSJ9",
    totalCount: 42,
    tracks: [TRACK],
  };

  it("serves the FeedListPage as the body (no ok envelope)", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/findings"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual(PAGE);
  });

  it("defaults the limit and includes mixtapes when unwindowed", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/findings"));

    expect(listTracks).toHaveBeenCalledWith({
      countTotal: true,
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
    await handleOrpc(get(`https://www.fluncle.com/api/v1/findings?limit=100&cursor=${cursor}`));

    expect(listTracks).toHaveBeenCalledWith({
      countTotal: false,
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
      get("https://www.fluncle.com/api/v1/findings?since=2026-01-01&until=2026-02-01T00:00:00Z"),
    );

    expect(listTracks).toHaveBeenCalledWith({
      countTotal: true,
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
    await handleOrpc(get("https://www.fluncle.com/api/v1/findings?limit=abc&since=not-a-date"));

    expect(listTracks).toHaveBeenCalledWith({
      countTotal: true,
      cursor: undefined,
      includeMixtapes: true,
      lean: true,
      limit: 16,
      since: undefined,
      until: undefined,
    });
  });

  it("skips the archive count on cursor pages, keeps it on page 1 (the redundant-scan fix)", async () => {
    const { encodeTrackCursor } = await import("./tracks");
    const cursor = encodeTrackCursor({ addedAt: "2026-01-01T00:00:00.000Z", trackId: "abc" });
    const { handleOrpc } = await import("./orpc");

    listTracks.mockResolvedValueOnce(PAGE);
    await handleOrpc(get("https://www.fluncle.com/api/v1/findings"));
    expect(listTracks).toHaveBeenLastCalledWith(expect.objectContaining({ countTotal: true }));

    listTracks.mockResolvedValueOnce(PAGE);
    await handleOrpc(get(`https://www.fluncle.com/api/v1/findings?cursor=${cursor}`));
    expect(listTracks).toHaveBeenLastCalledWith(expect.objectContaining({ countTotal: false }));
  });

  it("STRIPS the private sourceAudioKey from a captured finding before it world-serves", async () => {
    const captured = { ...TRACK, sourceAudioKey: "004.7.2I/abc123.m4a", trackId: "captured" };
    listTracks.mockResolvedValueOnce({ totalCount: 1, tracks: [captured] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/findings"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks[0]).not.toHaveProperty("sourceAudioKey");

    expect(body.tracks[0]?.trackId).toBe("captured");
  });
});

describe("oRPC public read — GET /tracks (list_tracks, the reborn enumerator)", () => {
  const FINDING_ENTRY = {
    artistLinks: [],
    finding: { ...TRACK, artistAvatarUrl: undefined, logId: "012.8.0A" },
    kind: "finding" as const,
    releaseDate: "2026-01-01",
  };
  const HUB_PAGE = { items: [FINDING_ENTRY], page: 1, pageCount: 3, total: 120 };

  it("serves the numbered-page envelope with lean, mapped rows", async () => {
    listTracksHubPage.mockResolvedValueOnce(HUB_PAGE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as {
      ok: true;
      page: number;
      pageCount: number;
      total: number;
      tracks: Array<Record<string, unknown>>;
    };
    expect(body.ok).toBe(true);
    expect(body.page).toBe(1);
    expect(body.pageCount).toBe(3);
    expect(body.total).toBe(120);

    expect(body.tracks[0]?.certified).toBe(true);
    expect(body.tracks[0]?.title).toBe(TRACK.title);
    expect(body.tracks[0]?.logId).toBe("012.8.0A");

    expect(body.tracks[0]?.trackId).toBe(TRACK.trackId);
    expect(body.tracks[0]?.url).toBe("https://www.fluncle.com/log/012.8.0A");
    expect(body.tracks[0]).not.toHaveProperty("note");
    expect(body.tracks[0]).not.toHaveProperty("sourceAudioKey");

    expect(listTracksHubPage).toHaveBeenCalledWith({ certified: undefined }, 1);
  });

  it("gives an uncertified row its trackId + /track destination url, and no coordinate or cover", async () => {
    listTracksHubPage.mockResolvedValueOnce({
      items: [
        {
          artistLinks: [{ name: "Quiet Artist" }],
          kind: "catalogue" as const,
          label: "Quiet Label",
          releaseDate: "2025-05-05",
          track: {
            artistAvatarUrl: undefined,
            artists: ["Quiet Artist"],
            releaseDate: "2025-05-05",
            spotifyUrl: undefined,
            title: "Quiet Tune",
            trackId: "mb_quiet",
          },
        },

        {
          artistLinks: [],
          kind: "catalogue" as const,
          releaseDate: "",
          track: {
            artistAvatarUrl: undefined,
            artists: [],
            releaseDate: "",
            spotifyUrl: undefined,
            title: "Nameless",
            trackId: "mb_nameless",
          },
        },
      ],
      page: 1,
      pageCount: 1,
      total: 2,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { tracks: Array<Record<string, unknown>> };

    expect(body.tracks[0]).toMatchObject({
      certified: false,
      title: "Quiet Tune",
      trackId: "mb_quiet",
      url: "https://www.fluncle.com/track/mb_quiet",
    });

    expect(body.tracks[0]).not.toHaveProperty("logId");
    expect(body.tracks[0]).not.toHaveProperty("coverImageUrl");
    expect(body.tracks[1]).toMatchObject({ certified: false, trackId: "mb_nameless" });
    expect(body.tracks[1]).not.toHaveProperty("url");
  });

  it("folds the tri-state certified param into the hub filter", async () => {
    listTracksHubPage.mockResolvedValue(HUB_PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/tracks?certified=true&page=2"));
    expect(listTracksHubPage).toHaveBeenCalledWith({ certified: true }, 2);

    await handleOrpc(get("https://www.fluncle.com/api/v1/tracks?certified=false"));
    expect(listTracksHubPage).toHaveBeenCalledWith({ certified: false }, 1);
  });

  it("degrades a junk page to 1 (never 400s)", async () => {
    listTracksHubPage.mockResolvedValueOnce(HUB_PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/tracks?page=abc"));

    expect(listTracksHubPage).toHaveBeenCalledWith({ certified: undefined }, 1);
  });

  it("404s a page past the end (never clamps to page 1)", async () => {
    const { CatalogueHubPageOutOfRangeError } = await import("./labels");
    listTracksHubPage.mockRejectedValueOnce(new CatalogueHubPageOutOfRangeError());

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/tracks?page=999"));

    expect(response?.status).toBe(404);
    expect(await readJson(response)).toEqual({
      code: "not_found",
      message: expect.any(String),
      ok: false,
    });
  });
});

describe("oRPC public read — GET /stories (list_stories)", () => {
  it("STRIPS the private sourceAudioKey from every story before it world-serves", async () => {
    const captured = { ...TRACK, sourceAudioKey: "004.7.2I/abc123.m4a", trackId: "captured" };
    listTracks.mockResolvedValueOnce({ totalCount: 1, tracks: [captured] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/stories"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks[0]).not.toHaveProperty("sourceAudioKey");
    expect(body.tracks[0]?.trackId).toBe("captured");

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      hasVideo: true,
      lean: true,
      limit: 16,
    });
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

    expect(getRandomRadioTrack).toHaveBeenCalledTimes(1);
    expect(getRandomTrack).not.toHaveBeenCalled();
  });

  it("STRIPS the private sourceAudioKey from the served track", async () => {
    getRandomRadioTrack.mockResolvedValueOnce({ ...TRACK, sourceAudioKey: "004.7.2I/abc123.m4a" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/random"));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { track: Record<string, unknown> };
    expect(body.track).not.toHaveProperty("sourceAudioKey");
    expect(body.track.trackId).toBe(TRACK.trackId);
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

    expect(body.nowPlaying.offsetMs).toBeGreaterThanOrEqual(4_000);
    expect(body.nowPlaying.offsetMs).toBeLessThanOrEqual(6_000);
    expect(body.nowPlaying.totalLoopDurationMs).toBe(50_000);
    expect(body.nowPlaying.trackCount).toBe(2);
    expect(body.nowPlaying.scheduleVersion).toBe("2:2026-06-10T00:00:00.000Z");
    expect(typeof body.nowPlaying.serverEpochMs).toBe("number");

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

  it("STRIPS the private sourceAudioKey from both hydrated slots", async () => {
    getRadioEligibleTracks.mockResolvedValueOnce([
      { logId: "001.1.1A", observationDurationMs: 20_000, trackId: "track-a" },
      { logId: "002.1.1B", observationDurationMs: 30_000, trackId: "track-b" },
    ]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("2:s");
    getRadioScheduleAnchor.mockResolvedValueOnce({ epochMs: Date.now() - 5_000, version: "2:s" });

    getTrackByIdOrLogId.mockImplementation(async (id: string) =>
      id === "track-a"
        ? { ...CURRENT, sourceAudioKey: "001.1.1A/aaa.m4a" }
        : id === "track-b"
          ? { ...NEXT, sourceAudioKey: "002.1.1B/bbb.m4a" }
          : undefined,
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    const body = (await response?.json()) as {
      nowPlaying: {
        currentTrack: Record<string, unknown>;
        nextTrack?: Record<string, unknown>;
      };
    };
    expect(body.nowPlaying.currentTrack).not.toHaveProperty("sourceAudioKey");
    expect(body.nowPlaying.nextTrack).not.toHaveProperty("sourceAudioKey");
    expect(body.nowPlaying.currentTrack.trackId).toBe("track-a");
  });

  it("strips the galaxy from now-playing until the whole map is named (launch gate)", async () => {
    const PLACED = { ...CURRENT, galaxy: { name: "Nebular", slug: "nebular" } };
    getRadioEligibleTracks.mockResolvedValueOnce([
      { logId: "001.1.1A", observationDurationMs: 20_000, trackId: "track-a" },
    ]);
    getRadioScheduleFingerprint.mockResolvedValueOnce("1:g");
    getRadioScheduleAnchor.mockResolvedValueOnce({ epochMs: Date.now(), version: "1:g" });
    getTrackByIdOrLogId.mockResolvedValue(PLACED);

    isGalaxyMapFullyNamed.mockReset();
    isGalaxyMapFullyNamed.mockResolvedValue(false);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      nowPlaying: { currentTrack: { galaxy?: unknown; trackId: string } };
    };

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

    isGalaxyMapFullyNamed.mockResolvedValue(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/radio/now-playing"));

    const body = (await response?.json()) as {
      nowPlaying: { currentTrack: { galaxy?: { name: string } } };
    };
    expect(body.nowPlaying.currentTrack.galaxy?.name).toBe("Nebular");
  });
});

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

const PUBLIC_OPERATION_IDS = [
  "collectPrivateGalaxyLog",
  "deletePrivateAccount",

  "deletePrivateRecSeed",
  "deletePrivateSavedSet",
  "deletePrivateWatch",
  "deregisterDevice",
  "exportPrivateAccountData",

  "getAlbum",

  "getArtist",
  "getCurrentPrivateUser",
  "getEdition",

  "getGalaxy",

  "getGraphPreview",
  "getHealth",
  "getLabel",
  "getPrivateAccountExport",
  "getPrivateFrontierEdition",
  "getPrivateFrontierPlaylist",
  "getPrivateGalaxyProgress",
  "getPrivateMutationToken",
  "getPrivatePreferences",
  "getRadioNowPlaying",
  "getRandomRadioTrack",
  "getRandomTrack",
  "getReplicaToken",
  "getTrack",
  "listAlbums",
  "listArtists",
  "listEditions",

  "listFindings",
  "listSimilarTracks",
  "listGalaxies",
  "listLabels",
  "listMixOpeners",
  "listMixableArtists",
  "listMixableTracks",
  "listMixtapes",

  "listPlatformStats",
  "listPrivateFrontierEditions",
  "listPrivateGalaxyCollection",
  "listPrivateRecSeeds",
  "listPrivateRecommendations",
  "listPrivateSavedFindings",
  "listPrivateSavedSets",
  "listPrivateSubmissions",
  "listPrivateWatches",

  "listSimilarArtists",

  "listFresh",
  "listSetTracks",
  "listStories",
  "listTracks",
  "mergePrivateGalaxyProgress",
  "mintPrivateFrontierPlaylist",
  "registerDevice",
  "savePrivateFinding",
  "savePrivateRecSeed",
  "savePrivateSet",
  "savePrivateWatch",
  "searchArchive",
  "searchTracks",
  "submitTrack",
  "subscribeNewsletter",
  "unsavePrivateFinding",
  "updatePrivatePreferences",
  "updatePrivateProfile",
  "updatePrivateSavedSet",
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

    expect(document.info.version).toBe("1.0.0");
    expect(document.servers?.[0]?.url).toBe("https://www.fluncle.com/api/v1");

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

    expect(document.paths["/tracks/{idOrLogId}"]?.get?.operationId).toBe("getTrack");
  });

  it("contains ZERO admin ops — no path under /admin leaks onto the public spec", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;
    const { ids, paths } = collectOperationIds(document);

    const adminPaths = paths.filter((path) => path === "/admin" || path.startsWith("/admin/"));
    expect(adminPaths, `admin paths leaked onto the public spec: ${adminPaths.join(", ")}`).toEqual(
      [],
    );

    expect(new Set(ids)).toEqual(new Set(PUBLIC_OPERATION_IDS));
  });

  it("documents the shared Error component as the rails encoder's { code, message, ok: false } envelope", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as GeneratedSpec;

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

        const nonDefault = Object.keys(responses).filter((status) => status !== "default");
        expect(
          nonDefault.length,
          `op "${operation.operationId}" lost its success response`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
