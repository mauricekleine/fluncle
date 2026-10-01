import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, rowCount, seedCatalogueTrack } from "./integration-db";
import { readJson, warmOrpcRouter } from "./orpc-test-kit";

let db: Client;

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();

  return {
    ...actual,
    getPublicSession: async () => undefined,
  };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
  };
});

const fetchTrackMetadata = vi.fn();
const searchTrackCandidates = vi.fn();
const findSpotifyTrackByIsrc = vi.fn();
const getDeezerSubmissionTrack = vi.fn();

vi.mock("./deezer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deezer")>()),
  getDeezerSubmissionTrack: (...args: unknown[]) => getDeezerSubmissionTrack(...args),
}));

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return {
    ...actual,
    fetchTrackMetadata: (...args: unknown[]) => fetchTrackMetadata(...args),
    findSpotifyTrackByIsrc: (...args: unknown[]) => findSpotifyTrackByIsrc(...args),
    searchTrackCandidates: (...args: unknown[]) => searchTrackCandidates(...args),
  };
});

const addContactToSegment = vi.fn();

vi.mock("./resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resend")>();

  return {
    ...actual,
    addContactToSegment: (...args: unknown[]) => addContactToSegment(...args),
  };
});

const BASE = "https://www.fluncle.com/api/v1";
const VALID_TRACK_ID = "abcdefghij0123456789AB";
const VALID_SPOTIFY_URL = `https://open.spotify.com/track/${VALID_TRACK_ID}`;

function trackMetadata(trackId: string) {
  return {
    album: "Some Album",
    albumImageUrl: "https://img.example/cover.jpg",
    artists: ["Some Artist"],
    durationMs: 270_000,
    isrc: "GBTEST2600001",
    spotifyArtistIds: ["artist-1"],
    spotifyUri: `spotify:track:${trackId}`,
    spotifyUrl: `https://open.spotify.com/track/${trackId}`,
    title: "Some Banger",
    trackId,
  };
}

function writeReq(
  path: string,
  body: unknown,
  headers: { ip?: string; origin?: string; ua?: string } = {},
): Request {
  const h: Record<string, string> = { "Content-Type": "application/json" };

  if (headers.ip) {
    h["cf-connecting-ip"] = headers.ip;
  }

  if (headers.ua) {
    h["user-agent"] = headers.ua;
  }

  if (headers.origin) {
    h.Origin = headers.origin;
  }

  return new Request(`${BASE}${path}`, { body: JSON.stringify(body), headers: h, method: "POST" });
}

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    artists: ["Some Artist"],
    source: "web",
    spotifyTrackId: VALID_TRACK_ID,
    spotifyUrl: VALID_SPOTIFY_URL,
    title: "Some Banger",
    ...overrides,
  };
}

warmOrpcRouter();

beforeEach(async () => {
  db = await createIntegrationDb();
  fetchTrackMetadata.mockReset();
  fetchTrackMetadata.mockImplementation((trackId: string) =>
    Promise.resolve(trackMetadata(trackId)),
  );
  searchTrackCandidates.mockReset();
  findSpotifyTrackByIsrc.mockReset();
  findSpotifyTrackByIsrc.mockResolvedValue({
    match: { trackId: VALID_TRACK_ID },
    rateLimited: false,
  });
  searchTrackCandidates.mockResolvedValue([
    {
      artists: ["Some Artist"],
      durationMs: 270_000,
      id: VALID_TRACK_ID,
      spotifyUrl: VALID_SPOTIFY_URL,
      title: "Some Banger",
    },
  ]);
  getDeezerSubmissionTrack.mockReset();
  getDeezerSubmissionTrack.mockResolvedValue({
    artists: ["Some Artist"],
    durationMs: 270_000,
    isrc: "GBTEST2600001",
    title: "Some Banger",
  });
  addContactToSegment.mockReset();
  addContactToSegment.mockResolvedValue(undefined);
});

afterEach(() => {
  db.close();
});

describe("submit_track through handleOrpc (real validation + rate limiter + DB)", () => {
  it("returns a stable 503 with the hold deadline if Spotify defers metadata", async () => {
    const { SpotifyDeferredError } = await import("./spotify");
    const { handleOrpc } = await import("./orpc");
    fetchTrackMetadata.mockRejectedValueOnce(
      new SpotifyDeferredError("quota_hold", "2026-10-02T09:00:00.000Z"),
    );
    const response = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "1.1.1.1" }),
    );
    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: "spotify_deferred",
      ok: false,
      until: "2026-10-02T09:00:00.000Z",
    });
    expect(await rowCount(db, "submissions")).toBe(0);
  });
  it("resolves a Deezer selection only after submission and stores Spotify's verified metadata", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.8" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(getDeezerSubmissionTrack).toHaveBeenCalledWith("3263968181");
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledWith("GBTEST2600001", "essential");
    expect(fetchTrackMetadata).toHaveBeenCalledOnce();
    const rows = await db.execute("select spotify_track_id from submissions");
    expect(rows.rows[0]?.spotify_track_id).toBe(VALID_TRACK_ID);
  });

  it("returns the Spotify deferred deadline during Deezer metadata verification", async () => {
    const { SpotifyDeferredError } = await import("./spotify");
    fetchTrackMetadata.mockRejectedValueOnce(
      new SpotifyDeferredError("quota_hold", "2026-10-02T09:00:00.000Z"),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.28" },
      ),
    );

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: "spotify_deferred",
      until: "2026-10-02T09:00:00.000Z",
    });
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledWith("GBTEST2600001", "essential");
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("accepts the legacy numeric selected id when the Spotify URL is empty", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          spotifyTrackId: "3263968181",
          spotifyUrl: "",
        }),
        { ip: "1.1.1.18" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(getDeezerSubmissionTrack).toHaveBeenCalledWith("3263968181");
    expect(await rowCount(db, "submissions")).toBe(1);
  });

  it("accepts the legacy catalogue selected id when the Spotify URL is empty", async () => {
    await seedCatalogueTrack(db, {
      artists: ["Some Artist"],
      title: "Some Banger",
      trackId: "mb_test",
    });
    await db.execute({
      args: ["GBTEST2600001", "mb_test"],
      sql: "update tracks set spotify_uri = null, spotify_url = null, isrc = ? where track_id = ?",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          spotifyTrackId: "mb_test",
          spotifyUrl: "",
        }),
        { ip: "1.1.1.19" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledWith("GBTEST2600001", "essential");
  });

  it("accepts a remastered suffix when ISRC and duration identify the recording", async () => {
    getDeezerSubmissionTrack.mockResolvedValueOnce({
      artists: ["Some Artist"],
      durationMs: 270_000,
      isrc: "GB-TEST-26-00001",
      title: "Some Banger (Remastered)",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.20" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledWith("GBTEST2600001", "essential");
    expect(fetchTrackMetadata).toHaveBeenCalledTimes(1);
  });

  it("rejects an ISRC match when duration differs by more than three seconds", async () => {
    getDeezerSubmissionTrack.mockResolvedValueOnce({
      artists: ["Some Artist"],
      durationMs: 273_001,
      isrc: "GBTEST2600001",
      title: "Some Banger",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.23" },
      ),
    );

    expect(response?.status).toBe(400);
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("turns a Deezer fetch failure into a stable retryable response", async () => {
    getDeezerSubmissionTrack.mockRejectedValueOnce(new Error("network"));
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.21" },
      ),
    );

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ code: "submission_unavailable" });
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("turns Spotify quota on the direct id path into a retryable response", async () => {
    fetchTrackMetadata.mockRejectedValueOnce(
      Object.assign(new Error("QUOTA_EXCEEDED"), { retryAfterMs: 1000 }),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "1.1.1.22" }),
    );

    expect(response?.status).toBe(429);
    expect(await readJson(response)).toMatchObject({ code: "spotify_rate_limited" });
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("accepts a co-credited recording after ISRC and duration verification", async () => {
    fetchTrackMetadata.mockResolvedValueOnce({
      ...trackMetadata(VALID_TRACK_ID),
      artists: ["Some Artist", "Guest Artist"],
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.12" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(fetchTrackMetadata).toHaveBeenCalledWith(VALID_TRACK_ID, "essential");
    expect(
      (await db.execute("select spotify_track_id from submissions")).rows[0]?.spotify_track_id,
    ).toBe(VALID_TRACK_ID);
  });

  it("resolves an unanchored catalogue candidate by its stored ISRC", async () => {
    await seedCatalogueTrack(db, {
      artists: ["Some Artist"],
      title: "Some Banger",
      trackId: "local-track",
    });
    await db.execute({
      args: ["GBTEST2600001", "local-track"],
      sql: "update tracks set spotify_uri = null, spotify_url = null, isrc = ? where track_id = ?",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          catalogueTrackId: "local-track",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.9" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(findSpotifyTrackByIsrc).toHaveBeenCalledWith("GBTEST2600001", "essential");
    expect(
      (await db.execute("select spotify_track_id from submissions")).rows[0]?.spotify_track_id,
    ).toBe(VALID_TRACK_ID);
  });

  it("submits an anchored catalogue track without an ISRC through its stored Spotify id", async () => {
    await seedCatalogueTrack(db, {
      artists: ["Some Artist"],
      title: "Some Banger",
      trackId: "local-track",
    });
    await db.execute({
      args: [`spotify:track:${VALID_TRACK_ID}`, "local-track"],
      sql: "update tracks set spotify_uri = ?, isrc = null where track_id = ?",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          catalogueTrackId: "local-track",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.24" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(findSpotifyTrackByIsrc).not.toHaveBeenCalled();
    expect(fetchTrackMetadata).toHaveBeenCalledWith(VALID_TRACK_ID, "essential");
    expect(
      (await db.execute("select spotify_track_id from submissions")).rows[0]?.spotify_track_id,
    ).toBe(VALID_TRACK_ID);
  });

  it("rejects a nonexistent Spotify track id as invalid input", async () => {
    fetchTrackMetadata.mockRejectedValueOnce(
      new Error("Spotify API request failed: 404 Not Found"),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "1.1.1.25" }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      code: "invalid_request",
      message: "Invalid selected track id",
    });
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("rejects a mismatched ISRC result before writing a submission", async () => {
    fetchTrackMetadata.mockResolvedValueOnce({
      ...trackMetadata(VALID_TRACK_ID),
      title: "Different Track",
    });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.10" },
      ),
    );

    expect(response?.status).toBe(400);
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("reports Spotify throttling without misclassifying the selected candidate", async () => {
    findSpotifyTrackByIsrc.mockResolvedValueOnce({ rateLimited: true });
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.11" },
      ),
    );

    expect(response?.status).toBe(429);
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("reports throttling when metadata verification is rate limited", async () => {
    fetchTrackMetadata.mockRejectedValueOnce(
      Object.assign(new Error("Spotify API request failed"), { retryAfterMs: 1000 }),
    );
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/submissions",
        validSubmission({
          deezerTrackId: "3263968181",
          spotifyTrackId: undefined,
          spotifyUrl: undefined,
        }),
        { ip: "1.1.1.13" },
      ),
    );

    expect(response?.status).toBe(429);
    expect(await rowCount(db, "submissions")).toBe(0);
  });

  it("accepts a valid submission AND lands the row (queried back from the DB)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "1.1.1.1" }),
    );

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { ok: boolean; submission: { id: string } };
    expect(body.ok).toBe(true);

    const rows = await db.execute({
      args: [body.submission.id],
      sql: `select spotify_track_id, status, source, user_id from submissions where id = ?`,
    });
    expect(rows.rows[0]).toMatchObject({
      source: "web",
      spotify_track_id: VALID_TRACK_ID,
      status: "pending",
      user_id: null,
    });

    expect(fetchTrackMetadata).toHaveBeenCalledWith(VALID_TRACK_ID, "essential");
  });

  it("rejects a malformed submission with the contract fault frame AND lands NO row", async () => {
    const { handleOrpc } = await import("./orpc");

    const response = await handleOrpc(
      writeReq("/submissions", validSubmission({ spotifyTrackId: "abcdefghij0123456789A" }), {
        ip: "1.1.1.1",
      }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_request",
      message: "Invalid selected track id",
      ok: false,
    });
    expect(await rowCount(db, "submissions")).toBe(0);

    expect(fetchTrackMetadata).not.toHaveBeenCalled();
  });

  it("rejects a tripped honeypot (bot trap) with no row and no Spotify call", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/submissions", validSubmission({ honeypot: "i am a bot" }), { ip: "1.1.1.1" }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_request");
    expect(await rowCount(db, "submissions")).toBe(0);
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
  });

  it("enforces the 5/hour limit per IP: the 6th from one IP is 429, a different IP still passes", async () => {
    const { handleOrpc } = await import("./orpc");

    for (let i = 0; i < 5; i++) {
      const ok = await handleOrpc(writeReq("/submissions", validSubmission(), { ip: "9.9.9.1" }));
      expect(ok?.status).toBe(200);
    }

    const limited = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "9.9.9.1" }),
    );
    expect(limited?.status).toBe(429);
    expect(await readJson(limited)).toEqual({
      code: "rate_limited",
      message: "Too many submissions from this connection. Try again later.",
      ok: false,
    });

    const otherIp = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "9.9.9.2" }),
    );
    expect(otherIp?.status).toBe(200);

    expect(await rowCount(db, "submissions")).toBe(6);
  });

  it("keys the limiter on the IP alone — rotating the User-Agent does NOT buy a fresh allowance", async () => {
    const { handleOrpc } = await import("./orpc");

    for (let i = 0; i < 5; i++) {
      const ok = await handleOrpc(
        writeReq("/submissions", validSubmission(), { ip: "8.8.8.8", ua: "UA-1" }),
      );
      expect(ok?.status).toBe(200);
    }

    const rotated = await handleOrpc(
      writeReq("/submissions", validSubmission(), { ip: "8.8.8.8", ua: "UA-2" }),
    );
    expect(rotated?.status).toBe(429);
    expect(await rowCount(db, "submissions")).toBe(5);
  });

  it("has NO dedupe — two identical valid submissions both land (no idempotency at this layer)", async () => {
    const { handleOrpc } = await import("./orpc");

    const first = await handleOrpc(writeReq("/submissions", validSubmission(), { ip: "7.7.7.7" }));
    const second = await handleOrpc(writeReq("/submissions", validSubmission(), { ip: "7.7.7.7" }));

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(await rowCount(db, "submissions")).toBe(2);
  });

  it("does NOT enforce origin/CSRF: a cross-origin, token-less POST still succeeds (public-unauth posture)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/submissions", validSubmission(), {
        ip: "6.6.6.6",
        origin: "https://evil.example.com",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await rowCount(db, "submissions")).toBe(1);
  });
});

describe("subscribe_newsletter through handleOrpc (real validation + rate limiter)", () => {
  it("accepts a valid email — bare { ok: true } — and hands the lower-cased address to Resend", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/newsletter", { email: "  Raver@Example.com " }, { ip: "1.2.3.4" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(addContactToSegment).toHaveBeenCalledWith("raver@example.com");

    const counters = await db.execute({
      args: ["subscribe_newsletter"],
      sql: `select count(*) as n from rate_limit_counters where action = ?`,
    });
    expect(Number(counters.rows[0]?.n)).toBe(1);
  });

  it("rejects an invalid email with invalid_email/400 and never touches Resend", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/newsletter", { email: "nope" }, { ip: "1.2.3.4" }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response)).toEqual({
      code: "invalid_email",
      message: "Enter a valid email address.",
      ok: false,
    });
    expect(addContactToSegment).not.toHaveBeenCalled();
  });

  it("rejects a tripped honeypot with invalid_request/400 and never touches Resend", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq("/newsletter", { email: "raver@example.com", honeypot: "bot" }, { ip: "1.2.3.4" }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_request");
    expect(addContactToSegment).not.toHaveBeenCalled();
  });

  it("enforces the 5/hour limit per IP: the 6th subscribe from one IP is 429", async () => {
    const { handleOrpc } = await import("./orpc");

    for (let i = 0; i < 5; i++) {
      const ok = await handleOrpc(
        writeReq("/newsletter", { email: "raver@example.com" }, { ip: "5.5.5.5" }),
      );
      expect(ok?.status).toBe(200);
    }

    const limited = await handleOrpc(
      writeReq("/newsletter", { email: "raver@example.com" }, { ip: "5.5.5.5" }),
    );
    expect(limited?.status).toBe(429);
    expect(await readJson(limited)).toEqual({
      code: "rate_limited",
      message: "Too many tries from this connection. Try again later.",
      ok: false,
    });

    expect(addContactToSegment).toHaveBeenCalledTimes(5);
  });

  it("keys on the IP alone — a fresh IP subscribes even after another IP is capped", async () => {
    const { handleOrpc } = await import("./orpc");

    for (let i = 0; i < 5; i++) {
      await handleOrpc(writeReq("/newsletter", { email: "a@example.com" }, { ip: "4.4.4.1" }));
    }
    const capped = await handleOrpc(
      writeReq("/newsletter", { email: "a@example.com" }, { ip: "4.4.4.1" }),
    );
    expect(capped?.status).toBe(429);

    const freshIp = await handleOrpc(
      writeReq("/newsletter", { email: "b@example.com" }, { ip: "4.4.4.2" }),
    );
    expect(freshIp?.status).toBe(200);
  });

  it("does NOT enforce origin/CSRF: a cross-origin, token-less subscribe still succeeds", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      writeReq(
        "/newsletter",
        { email: "raver@example.com" },
        { ip: "3.3.3.3", origin: "https://evil.example.com" },
      ),
    );

    expect(response?.status).toBe(200);
    expect(addContactToSegment).toHaveBeenCalledWith("raver@example.com");
  });
});
