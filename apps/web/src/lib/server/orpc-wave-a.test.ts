import { beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";

// Wave A — the five public-unauthenticated ops fanned out off the pilot's
// per-domain pattern. As in orpc.test.ts, the underlying server helpers are
// mocked: each handler's job is to shape the contract response + the error
// framing, not to touch Turso/Spotify/Loops. These assertions pin the body the
// live route emitted, now served by oRPC — byte-for-byte.

const listMixtapes = vi.fn();

vi.mock("./mixtapes", () => ({
  listMixtapes: (...args: unknown[]) => listMixtapes(...args),
}));

const searchTrackCandidates = vi.fn();

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return {
    ...actual,
    searchTrackCandidates: (...args: unknown[]) => searchTrackCandidates(...args),
  };
});

// stories rides on listTracks (with hasVideo: true); decodeTrackCursor is the
// real re-exported impl so the cursor decode behaves exactly as production.
const listTracks = vi.fn();

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    listTracks: (...args: unknown[]) => listTracks(...args),
  };
});

const createSubmission = vi.fn();

vi.mock("./submissions", () => ({
  createSubmission: (...args: unknown[]) => createSubmission(...args),
}));

const subscribeToNewsletter = vi.fn();

vi.mock("./newsletter", () => ({
  subscribeToNewsletter: (...args: unknown[]) => subscribeToNewsletter(...args),
}));

// The shared limiter touches Turso; these handler-shape tests don't (the limiter
// has its own focused coverage in rate-limit.test.ts). No-op it so the response
// framing is what's under test, not the rate-limit DB round-trip.
vi.mock("./rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rate-limit")>();

  return {
    ...actual,
    assertRateLimit: async () => undefined,
  };
});

beforeEach(async () => {
  listMixtapes.mockReset();
  searchTrackCandidates.mockReset();
  listTracks.mockReset();
  createSubmission.mockReset();
  subscribeToNewsletter.mockReset();
  // Clear the search handler's recent-query cache so an entry from one test
  // never serves another (the cache is exercised on its own elsewhere).
  const { __resetSearchCache } = await import("./orpc/search");
  __resetSearchCache();
});

function get(url: string): Request {
  return new Request(url, { method: "GET" });
}

function post(url: string, body: string): Request {
  return new Request(url, {
    body,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function postJson(url: string, body: unknown): Request {
  return post(url, JSON.stringify(body));
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

// ── list_mixtapes ────────────────────────────────────────────────────────────

describe("oRPC public read — GET /mixtapes (list_mixtapes)", () => {
  it("serves { ok: true, mixtapes } — the live envelope", async () => {
    listMixtapes.mockResolvedValueOnce([MIXTAPE]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/mixtapes"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ mixtapes: [MIXTAPE], ok: true });
    expect(listMixtapes).toHaveBeenCalledWith();
  });

  it("serves the same handler on the bare /api alias", async () => {
    listMixtapes.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/mixtapes"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ mixtapes: [], ok: true });
  });

  it("500s an unexpected fault as { code: 'error', message, ok: false }", async () => {
    listMixtapes.mockRejectedValueOnce(new Error("turso fell over"));

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/mixtapes"));

    expect(response?.status).toBe(500);
    expect(await readJson(response)).toEqual({
      code: "error",
      message: "turso fell over",
      ok: false,
    });
  });
});

// ── search_tracks ────────────────────────────────────────────────────────────

describe("oRPC public read — GET /search (search_tracks)", () => {
  const RESULT = {
    artists: ["Some Artist"],
    id: "abc",
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Some Banger",
  };

  it("serves { ok: true, results } for a valid query", async () => {
    searchTrackCandidates.mockResolvedValueOnce([RESULT]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/search?q=amen"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, results: [RESULT] });
    expect(searchTrackCandidates).toHaveBeenCalledWith("amen");
  });

  it("trims the query before the length check and the search", async () => {
    searchTrackCandidates.mockResolvedValueOnce([]);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/search?q=%20%20amen%20%20"));

    expect(searchTrackCandidates).toHaveBeenCalledWith("amen");
  });

  it("400s a too-short query with the custom invalid_query code (byte parity)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/search?q=a"));

    expect(response?.status).toBe(400);
    // Parity with the live route's jsonError(400, "invalid_query", …) — the code
    // is the custom `invalid_query`, NOT the rails' generic `invalid_request`.
    expect(await readJson(response)).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });
    expect(searchTrackCandidates).not.toHaveBeenCalled();
  });

  it("400s a missing query the same way (q absent → empty string)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/search"));

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });
  });
});

// ── list_stories ─────────────────────────────────────────────────────────────

describe("oRPC public read — GET /stories (list_stories)", () => {
  const PAGE = {
    nextCursor: "eyJhZGRlZEF0IjoiMjAyNi0wMS0wMSJ9",
    totalCount: 7,
    tracks: [TRACK],
  };

  it("serves the TrackListPage as the body (no ok envelope)", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get("https://www.fluncle.com/api/v1/stories"));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual(PAGE);
  });

  it("defaults the limit and passes hasVideo: true", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/stories"));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      hasVideo: true,
      limit: 16,
    });
  });

  it("clamps the limit to 48 and decodes the cursor", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { encodeTrackCursor } = await import("./tracks");
    const cursor = encodeTrackCursor({ addedAt: "2026-01-01T00:00:00.000Z", trackId: "abc" });

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get(`https://www.fluncle.com/api/v1/stories?limit=100&cursor=${cursor}`));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: { addedAt: "2026-01-01T00:00:00.000Z", trackId: "abc" },
      hasVideo: true,
      limit: 48,
    });
  });

  it("ignores a non-integer limit (degrades to the default like the live route)", async () => {
    listTracks.mockResolvedValueOnce(PAGE);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(get("https://www.fluncle.com/api/v1/stories?limit=abc"));

    expect(listTracks).toHaveBeenCalledWith({
      cursor: undefined,
      hasVideo: true,
      limit: 16,
    });
  });
});

// ── submit_track ─────────────────────────────────────────────────────────────

describe("oRPC public write — POST /submissions (submit_track)", () => {
  const SUBMISSION = {
    artists: ["Some Artist"],
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "sub-1",
    source: "web" as const,
    spotifyTrackId: "abc",
    spotifyUrl: "https://open.spotify.com/track/abc",
    status: "pending" as const,
    title: "Some Banger",
  };

  const BODY = {
    artists: ["Some Artist"],
    source: "web",
    spotifyTrackId: "0123456789abcdefghijkl",
    spotifyUrl: "https://open.spotify.com/track/0123456789abcdefghijkl",
    title: "Some Banger",
  };

  it("serves { ok: true, submission } on a valid submission", async () => {
    createSubmission.mockResolvedValueOnce(SUBMISSION);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(postJson("https://www.fluncle.com/api/v1/submissions", BODY));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, submission: SUBMISSION });
    // The parsed body is handed through to createSubmission untouched (the loose
    // contract input preserves it field-for-field, including unknown keys).
    expect(createSubmission).toHaveBeenCalledTimes(1);
    expect(createSubmission.mock.calls[0][0]).toEqual(BODY);
  });

  it("preserves the honeypot key through the loose contract input", async () => {
    createSubmission.mockResolvedValueOnce(SUBMISSION);

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(
      postJson("https://www.fluncle.com/api/v1/submissions", { ...BODY, honeypot: "" }),
    );

    expect(createSubmission.mock.calls[0][0]).toEqual({ ...BODY, honeypot: "" });
  });

  it("carries the validation ApiError code/status (invalid_request/400) byte-for-byte", async () => {
    const { ApiError } = await import("./spotify");
    createSubmission.mockRejectedValueOnce(
      new ApiError("invalid_request", "Text fields must be 500 characters or less", 400),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      postJson("https://www.fluncle.com/api/v1/submissions", { ...BODY, note: "x".repeat(501) }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_request",
      message: "Text fields must be 500 characters or less",
      ok: false,
    });
  });

  it("carries the rate_limited ApiError (429) byte-for-byte", async () => {
    const { ApiError } = await import("./spotify");
    createSubmission.mockRejectedValueOnce(
      new ApiError(
        "rate_limited",
        "Too many submissions from this connection. Try again later.",
        429,
      ),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(postJson("https://www.fluncle.com/api/v1/submissions", BODY));

    expect(response?.status).toBe(429);
    expect(await readJson(response)).toEqual({
      code: "rate_limited",
      message: "Too many submissions from this connection. Try again later.",
      ok: false,
    });
  });
});

// ── subscribe_newsletter ─────────────────────────────────────────────────────

describe("oRPC public write — POST /newsletter (subscribe_newsletter)", () => {
  it("serves the bare { ok: true } envelope on success", async () => {
    subscribeToNewsletter.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      postJson("https://www.fluncle.com/api/v1/newsletter", { email: "fan@example.com" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(subscribeToNewsletter.mock.calls[0][0]).toEqual({ email: "fan@example.com" });
  });

  it("serves the same handler on the bare /api alias", async () => {
    subscribeToNewsletter.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      postJson("https://www.fluncle.com/api/newsletter", { email: "fan@example.com" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
  });

  it("carries the invalid_email ApiError code/status (400) byte-for-byte", async () => {
    const { ApiError } = await import("./spotify");
    subscribeToNewsletter.mockRejectedValueOnce(
      new ApiError("invalid_email", "Enter a valid email address.", 400),
    );

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      postJson("https://www.fluncle.com/api/v1/newsletter", { email: "nope" }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_email",
      message: "Enter a valid email address.",
      ok: false,
    });
  });
});

// ── OpenAPI doc emits the new operationIds ───────────────────────────────────

describe("oRPC OpenAPI generation — Wave A operationIds", () => {
  it("emits all five Wave A operations", async () => {
    const { generateOpenApiDocument } = await import("./orpc");
    const document = (await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(document.paths["/mixtapes"]?.get?.operationId).toBe("listMixtapes");
    expect(document.paths["/search"]?.get?.operationId).toBe("searchTracks");
    expect(document.paths["/stories"]?.get?.operationId).toBe("listStories");
    expect(document.paths["/submissions"]?.post?.operationId).toBe("submitTrack");
    expect(document.paths["/newsletter"]?.post?.operationId).toBe("subscribeNewsletter");
  });
});
