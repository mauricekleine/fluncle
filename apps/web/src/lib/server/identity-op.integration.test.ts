// `get_track`'s IDENTITY PROJECTION, driven END TO END through the REAL `handleOrpc(Request)`
// dispatcher (RFC dnb-identity-graph, Unit 2).
//
// The envelope's CONTENT is proven next door (identity-envelope.integration.test.ts). What only a
// dispatcher test can prove is the TRANSPORT, and each claim here is one that was easy to get
// wrong:
//
//   - the contract's output union accepts the envelope, so the widened schema really validates;
//   - the plain `GET /tracks/{idOrLogId}` read is BYTE-UNCHANGED and still unmetered — every
//     existing caller (the CLI, MCP, the app, the newsletter agent) reads through this op;
//   - the key is EXCLUSIVE, and every malformed key is a 422 thrown IN-HANDLER (oRPC's own schema
//     rejection emits 400, which is why the input schema stays tolerant optional strings);
//   - an unknown key is a 404 that does NOT invite a submission;
//   - the dial is charged on the identity reads and on nothing else;
//   - a pasted Spotify or Deezer link resolves through EVERY spelling the archive stores;
//   - a batch answers in the single-key SHAPE and spends one unit of allowance PER KEY.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();

  return { ...actual, getPublicSession: async () => undefined };
});

import { createIntegrationDb } from "./integration-db";
import { readJson } from "./orpc-test-kit";

let db: Client;

/** A libSQL cell as a string, without leaning on Object's default stringification. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const BASE = "https://www.fluncle.com/api/v1";

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

function read(path: string, ip = "9.9.9.9"): Request {
  return new Request(`${BASE}${path}`, { headers: { "cf-connecting-ip": ip } });
}

async function seed(): Promise<void> {
  await db.execute({
    args: [],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc,
                              mb_recording_id, spotify_uri, spotify_url,
                              spotify_anchor_verified_by, spotify_anchored_at)
          values ('trk-1', 'Nobody Else', '["Calibre"]', 300000, 'GBABC1234567',
                  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'spotify:track:abc123',
                  'https://open.spotify.com/track/abc123', 'isrc', '2026-07-01T00:00:00.000Z')`,
  });
  await db.execute({
    args: [],
    sql: `insert into findings (track_id, log_id, added_at)
          values ('trk-1', '004.7.2I', '2026-01-01T00:00:00.000Z')`,
  });
  await db.execute({
    args: [],
    sql: `update tracks set is_catalogue = 0 where track_id = 'trk-1'`,
  });
}

describe("the identity projection over the wire", () => {
  it("answers `?identity=1` on the path key with the envelope", async () => {
    await seed();

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(read("/tracks/trk-1?identity=1"));

    expect(response?.status).toBe(200);

    const body = (await readJson(response)) as {
      identity: { meta: { contact: string }; recordings: Array<{ certified: boolean }> };
    };

    expect(body.identity.recordings).toHaveLength(1);
    expect(body.identity.recordings[0]?.certified).toBe(true);
    expect(body.identity.meta.contact).toBe("hey@fluncle.com");
  });

  it("answers `?isrc=` and `?mbid=` off the `-` path placeholder", async () => {
    await seed();

    const { handleOrpc } = await import("./orpc");

    for (const query of ["?isrc=GB-ABC-12-34567", "?mbid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]) {
      const response = await handleOrpc(read(`/tracks/-${query}`));

      expect(response?.status, query).toBe(200);

      const body = (await readJson(response)) as {
        identity: { recordings: Array<{ trackId: string }> };
      };

      expect(body.identity.recordings[0]?.trackId).toBe("trk-1");
    }
  });

  it("leaves the plain read untouched — the finding DTO, no envelope", async () => {
    await seed();

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(read("/tracks/trk-1"));

    expect(response?.status).toBe(200);

    const body = (await readJson(response)) as Record<string, unknown>;

    expect(body).toHaveProperty("track");
    expect(body).not.toHaveProperty("identity");
  });
});

describe("the key rails", () => {
  it("422s when two keys arrive at once", async () => {
    await seed();

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(read("/tracks/trk-1?isrc=GBABC1234567"));

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_key");
  });

  it("422s on a malformed ISRC or MBID", async () => {
    const { handleOrpc } = await import("./orpc");

    const isrc = await handleOrpc(read("/tracks/-?isrc=nope"));
    const mbid = await handleOrpc(read("/tracks/-?mbid=nope"));

    expect(isrc?.status).toBe(422);
    expect(((await readJson(isrc)) as { code: string }).code).toBe("invalid_isrc");
    expect(mbid?.status).toBe(422);
    expect(((await readJson(mbid)) as { code: string }).code).toBe("invalid_mbid");
  });

  it("422s when the placeholder arrives with nothing to look up", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(read("/tracks/-"));

    expect(response?.status).toBe(422);
  });

  it("404s an unknown key WITHOUT inviting a submission", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(read("/tracks/-?isrc=GBZZZ9999999"));

    expect(response?.status).toBe(404);

    const message = ((await readJson(response)) as { message: string }).message.toLowerCase();

    // A machine caller must never be pointed at the crew's triage queue.
    expect(message).not.toContain("submit");
    expect(message).not.toContain("submission");
  });
});

describe("the dial", () => {
  it("charges the identity read and leaves the plain read unmetered", async () => {
    await seed();

    const { handleOrpc } = await import("./orpc");

    await handleOrpc(read("/tracks/trk-1"));
    await handleOrpc(read("/tracks/trk-1"));

    const before = await db.execute(
      `select count(*) as n from rate_limit_counters where action like 'get_track_identity%'`,
    );

    expect(Number(before.rows[0]?.n)).toBe(0);

    await handleOrpc(read("/tracks/trk-1?identity=1"));

    const after = await db.execute(
      `select action, count from rate_limit_counters where action like 'get_track_identity%' order by action`,
    );

    expect(after.rows.map((row) => text(row.action))).toEqual([
      "get_track_identity_burst",
      "get_track_identity_daily",
    ]);
    expect(after.rows.every((row) => Number(row.count) === 1)).toBe(true);
  });

  it("spends one unit PER KEY, so a batch is a saved round trip and not a discount", async () => {
    await seedBatch();

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(read(`/tracks/-?isrc=${BATCH_ISRCS.join(",")}`, "5.5.5.5"));

    expect(response?.status).toBe(200);

    const after = await db.execute(
      `select action, count from rate_limit_counters where action like 'get_track_identity%' order by action`,
    );

    // Three ISRCs in one request, three units off each dial. Charged as one, a caller pacing
    // themselves under the per-minute dial would walk the archive N times faster than the
    // published number says they can.
    expect(after.rows.map((row) => Number(row.count))).toEqual([
      BATCH_ISRCS.length,
      BATCH_ISRCS.length,
    ]);
  });
});

// ── THE PLATFORM-LINK KEYS ─────────────────────────────────────────────────────────────────────
// One Spotify track is spelled three different ways in this archive depending on which road the
// recording arrived by, and a pasted link has to find all three or the answer depends on an
// accident of birth. Each row below is one of those roads.

/** A published finding: the row IS keyed by its Spotify id (publish.ts). */
const SPOTIFY_FINDING_ID = "4cOdK2wGLETKBW3PvgPWqT";
/** The freshness tap's catalogue mint: `sp_<spotify id>` (label-releases.ts). */
const SPOTIFY_TAP_ID = "1AbCdEfGhIjKlMnOpQrStU";
/** A crawler row keyed by its MusicBrainz mint, wearing an anchor's `spotify_uri` (anchor.ts). */
const SPOTIFY_ANCHORED_ID = "7GhIjKlMnOpQrStUvWxYz0";

const DEEZER_ID = "3135556";

async function seedPlatforms(): Promise<void> {
  await db.execute({
    args: [],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, spotify_uri, deezer_track_id)
          values ('${SPOTIFY_FINDING_ID}', 'Published', '["Calibre"]', 300000,
                  'spotify:track:${SPOTIFY_FINDING_ID}', '${DEEZER_ID}'),
                 ('sp_${SPOTIFY_TAP_ID}', 'Tapped', '["Lenzman"]', 300000, null, null),
                 ('mb_aaaaaaaa-bbbb-cccc-dddd-ffffffffffff', 'Anchored', '["Alix Perez"]', 300000,
                  'spotify:track:${SPOTIFY_ANCHORED_ID}', null)`,
  });
}

describe("the platform-link keys", () => {
  it("resolves a Spotify link through every spelling the archive stores", async () => {
    await seedPlatforms();

    const { handleOrpc } = await import("./orpc");

    const cases: [string, string][] = [
      // The published finding, whose row key IS the Spotify id.
      [`https://open.spotify.com/track/${SPOTIFY_FINDING_ID}?si=abc123`, SPOTIFY_FINDING_ID],
      // The freshness tap's `sp_` mint.
      [`spotify:track:${SPOTIFY_TAP_ID}`, `sp_${SPOTIFY_TAP_ID}`],
      // A crawler row wearing an anchor's `spotify_uri` under a MusicBrainz key.
      [
        `https://open.spotify.com/intl-nl/track/${SPOTIFY_ANCHORED_ID}`,
        "mb_aaaaaaaa-bbbb-cccc-dddd-ffffffffffff",
      ],
      // A bare id, which the API accepts because the query key already names the platform.
      [SPOTIFY_FINDING_ID, SPOTIFY_FINDING_ID],
    ];

    for (const [key, expected] of cases) {
      const response = await handleOrpc(
        read(`/tracks/-?spotify=${encodeURIComponent(key)}`, "6.6.6.6"),
      );

      expect(response?.status, key).toBe(200);

      const body = (await readJson(response)) as {
        identity: { recordings: Array<{ trackId: string }> };
      };

      expect(body.identity.recordings[0]?.trackId, key).toBe(expected);
    }
  });

  it("resolves a Deezer link, locale segment and tracking tail and all", async () => {
    await seedPlatforms();

    const { handleOrpc } = await import("./orpc");

    for (const key of [
      `https://www.deezer.com/nl/track/${DEEZER_ID}?utm_source=share`,
      `deezer.com/track/${DEEZER_ID}`,
      DEEZER_ID,
    ]) {
      const response = await handleOrpc(
        read(`/tracks/-?deezer=${encodeURIComponent(key)}`, "7.7.7.7"),
      );

      expect(response?.status, key).toBe(200);

      const body = (await readJson(response)) as {
        identity: { recordings: Array<{ trackId: string }> };
      };

      expect(body.identity.recordings[0]?.trackId, key).toBe(SPOTIFY_FINDING_ID);
    }
  });

  it("422s a link that is not a well-formed track key, and 404s one that matches nothing", async () => {
    await seedPlatforms();

    const { handleOrpc } = await import("./orpc");

    const malformed = await handleOrpc(
      read("/tracks/-?spotify=https%3A%2F%2Fexample.com%2Ftrack%2Fnope", "8.8.8.8"),
    );

    expect(malformed?.status).toBe(422);
    expect(((await readJson(malformed)) as { code: string }).code).toBe("invalid_spotify");

    const badDeezer = await handleOrpc(read("/tracks/-?deezer=not-a-number", "8.8.8.8"));

    expect(badDeezer?.status).toBe(422);
    expect(((await readJson(badDeezer)) as { code: string }).code).toBe("invalid_deezer");

    const missing = await handleOrpc(read("/tracks/-?spotify=0000000000000000000000", "8.8.8.8"));

    expect(missing?.status).toBe(404);
  });

  it("keeps the key exclusive across the new query keys too", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      read(`/tracks/-?spotify=${SPOTIFY_FINDING_ID}&deezer=${DEEZER_ID}`, "8.8.8.8"),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_key");
  });
});

// ── THE BATCH ──────────────────────────────────────────────────────────────────────────────────

const BATCH_ISRCS = ["GBABC1234567", "GBABC1234568", "GBABC1234569"];

async function seedBatch(): Promise<void> {
  await db.execute({
    args: [],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc)
          values ('b-1', 'One', '["Calibre"]', 300000, '${BATCH_ISRCS[0]}'),
                 ('b-2', 'Two', '["Lenzman"]', 300000, '${BATCH_ISRCS[1]}'),
                 ('b-3', 'Three', '["Alix Perez"]', 300000, '${BATCH_ISRCS[2]}')`,
  });
}

describe("the ISRC batch", () => {
  it("answers many keys in the SAME shape one key gets, in the order they were sent", async () => {
    await seedBatch();

    const { handleOrpc } = await import("./orpc");
    // Deliberately out of stored order, to prove the answer follows the REQUEST.
    const asked = [BATCH_ISRCS[2], BATCH_ISRCS[0], BATCH_ISRCS[1]];
    const response = await handleOrpc(read(`/tracks/-?isrc=${asked.join(",")}`, "4.4.4.4"));

    expect(response?.status).toBe(200);

    const body = (await readJson(response)) as {
      identity: {
        recordings: Array<{
          identifiers: { isrc: { value?: string } };
          relation: string;
          trackId: string;
        }>;
      };
    };

    expect(body.identity.recordings.map((recording) => recording.trackId)).toEqual([
      "b-3",
      "b-1",
      "b-2",
    ]);
    // Each answer carries its own ISRC, which is how a caller pairs it back to what it asked.
    expect(body.identity.recordings.map((recording) => recording.identifiers.isrc.value)).toEqual(
      asked,
    );
    // THE RELATION IS PER KEY. Three keys each matching one recording is three CANONICAL answers;
    // computed over the flattened batch they would all read `ambiguous`, which is the envelope's
    // one claim about Fluncle's own opinion, inverted.
    expect(body.identity.recordings.every((recording) => recording.relation === "canonical")).toBe(
      true,
    );
  });

  it("drops a key that matched nothing, and 404s only when none of them matched", async () => {
    await seedBatch();

    const { handleOrpc } = await import("./orpc");

    const partial = await handleOrpc(
      read(`/tracks/-?isrc=${BATCH_ISRCS[0]},GBZZZ9999999`, "4.4.4.4"),
    );

    expect(partial?.status).toBe(200);
    expect(
      ((await readJson(partial)) as { identity: { recordings: unknown[] } }).identity.recordings,
    ).toHaveLength(1);

    const none = await handleOrpc(read("/tracks/-?isrc=GBZZZ9999999,GBZZZ9999998", "4.4.4.4"));

    expect(none?.status).toBe(404);
  });

  it("422s past the ceiling, and 422s the whole batch when one key is malformed", async () => {
    const { handleOrpc } = await import("./orpc");

    const tooMany = await handleOrpc(
      read(`/tracks/-?isrc=${Array.from({ length: 21 }, () => "GBABC1234567").join(",")}`),
    );

    expect(tooMany?.status).toBe(422);
    expect(((await readJson(tooMany)) as { code: string }).code).toBe("invalid_isrc");

    // Nineteen good keys and one typo is not nineteen answers: the caller has to be told.
    const oneBad = await handleOrpc(read("/tracks/-?isrc=GBABC1234567,nope"));

    expect(oneBad?.status).toBe(422);
    expect(((await readJson(oneBad)) as { code: string }).code).toBe("invalid_isrc");
  });

  it("leaves the single-key answer byte-identical", async () => {
    await seedBatch();

    const { handleOrpc } = await import("./orpc");
    const single = await handleOrpc(read(`/tracks/-?isrc=${BATCH_ISRCS[0]}`, "3.3.3.3"));
    const body = (await readJson(single)) as {
      identity: { recordings: Array<{ relation: string; trackId: string }> };
    };

    expect(single?.status).toBe(200);
    expect(body.identity.recordings).toHaveLength(1);
    expect(body.identity.recordings[0]?.trackId).toBe("b-1");
    expect(body.identity.recordings[0]?.relation).toBe("canonical");
  });
});
