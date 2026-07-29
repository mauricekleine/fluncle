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
//   - the dial is charged on the identity reads and on nothing else.

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
});
