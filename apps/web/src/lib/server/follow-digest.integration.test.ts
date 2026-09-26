import { type Client } from "@libsql/client";
import { LONG_FORM_MS } from "../catalogue-eligibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIntegrationDb,
  rowCount,
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedUser,
} from "./integration-db";

let db: Client;
const sendEmail = vi.fn(
  async (_params: Parameters<typeof import("./resend").sendFollowDigestEmail>[0]) => ({
    id: "resend-test",
  }),
);

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resend")>();
  return {
    ...actual,
    readResendSender: async () => "Fluncle <test@example.com>",
    sendFollowDigestEmail: (params: Parameters<typeof actual.sendFollowDigestEmail>[0]) =>
      sendEmail(params),
  };
});

beforeEach(async () => {
  db = await createIntegrationDb();
  sendEmail.mockReset();
  sendEmail.mockImplementation(async () => ({ id: "resend-test" }));
});

afterEach(() => db.close());

async function watch(
  userId: string,
  kind: "artist" | "label",
  entityId: string,
  id: string,
  createdAt = "2026-09-01T00:00:00.000Z",
) {
  await db.execute({
    args: [id, userId, kind, entityId, createdAt],
    sql: `insert into user_watches (id, user_id, kind, entity_id, created_at) values (?, ?, ?, ?, ?)`,
  });
}

async function track(
  id: string,
  releaseDate: string,
  options: { albumId?: string; artistId?: string; labelId?: string },
) {
  await seedCatalogueTrack(db, { artists: ["Artist A"], title: `Track ${id}`, trackId: id });
  await db.execute({
    args: [
      releaseDate,
      options.albumId ?? null,
      options.labelId ?? null,
      `https://i.scdn.co/image/${id}`,
      id,
    ],
    sql: `update tracks set release_date = ?, album_id = ?, label_id = ?, album_image_url = ? where track_id = ?`,
  });
  if (options.artistId) {
    await db.execute({
      args: [id, options.artistId],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
    });
  }
}

describe("weekly follow digest", () => {
  it("omits long catalogue releases while keeping long findings", async () => {
    const { listFollowDigestReleases } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    for (const id of ["short", "long-catalogue", "long-finding"]) {
      await track(id, "2026-09-24", { artistId: "artist-a" });
    }
    await db.execute({
      args: [LONG_FORM_MS, "long-catalogue", "long-finding"],
      sql: `update tracks set duration_ms = ? where track_id in (?, ?)`,
    });
    await db.execute({
      args: ["long-finding", "001.1.1", "2026-09-24T00:00:00.000Z"],
      sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
    });
    await db.execute(`update tracks set is_catalogue = 0 where track_id = 'long-finding'`);

    const result = await listFollowDigestReleases("one", "2026-09-23", "2026-09-25");
    expect(result.items.map((item) => item.href).sort()).toEqual([
      "https://www.fluncle.com/log/001.1.1",
      "https://www.fluncle.com/track/short",
    ]);
  });

  it("skips a recipient deleted during token creation and continues the batch", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    const tokens = await import("./follow-digest-tokens");
    for (const id of ["a", "b"]) {
      await seedUser(db, { email: `${id}@example.com`, emailVerified: true, id });
    }
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("a", "artist", "artist-a", "watch-a");
    await watch("b", "artist", "artist-a", "watch-b");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    const token = vi
      .spyOn(tokens, "createFollowDigestToken")
      .mockRejectedValueOnce(new tokens.FollowDigestRecipientUnavailableError());
    try {
      expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
        sent: 1,
        skipped: 1,
      });
      expect(sendEmail.mock.calls[0]?.[0].to).toBe("b@example.com");
    } finally {
      token.mockRestore();
    }
  });

  it("does not recreate digest state if an account is deleted during delivery", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    sendEmail.mockImplementationOnce(async () => {
      await db.execute("delete from follow_digest_deliveries where user_id = 'one'");
      await db.execute("delete from user_follow_digests where user_id = 'one'");
      await db.execute("update \"user\" set status = 'deleted' where id = 'one'");
      return { id: "resend-one" };
    });
    expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
      sent: 1,
    });
    expect(await rowCount(db, "user_follow_digests")).toBe(0);
  });

  it("counts one sent outcome when recovery runs overlap", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    const now = new Date("2026-09-25T15:00:00.000Z");
    sendEmail.mockRejectedValueOnce(new Error("recipient rejected"));
    await sendFollowDigests({ now });
    await db.execute(
      "update follow_digest_deliveries set status = 'claimed', attempts = 0, claimed_at = '2026-09-25T14:55:00.000Z' where user_id = 'one'",
    );
    sendEmail.mockClear();
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendEmail.mockImplementation(async () => {
      arrivals += 1;
      if (arrivals === 2) {
        release?.();
      }
      await bothArrived;
      return { id: "resend-one" };
    });
    const outcomes = await Promise.all([sendFollowDigests({ now }), sendFollowDigests({ now })]);
    expect(outcomes.map((outcome) => outcome.sent).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(outcomes.map((outcome) => outcome.skipped).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("settles a concurrent failure as sent when Resend confirms delivery", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    sendEmail.mockImplementationOnce(async () => {
      await db.execute(
        "update follow_digest_deliveries set status = 'failed' where user_id = 'one'",
      );
      return { id: "resend-one" };
    });
    expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
      failed: 0,
      sent: 1,
    });
    const row = await db.execute(
      "select status from follow_digest_deliveries where user_id = 'one'",
    );
    expect(row.rows[0]?.status).toBe("sent");
  });

  it("does not report a failed recipient when another run has already settled it", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    sendEmail.mockImplementationOnce(async () => {
      await db.execute("update follow_digest_deliveries set status = 'sent' where user_id = 'one'");
      throw new Error("late rejected response");
    });
    expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
      failed: 0,
      skipped: 1,
    });
  });
  it("persists an immutable claim before sending and reuses its payload after a crash", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    const now = new Date("2026-09-25T15:00:00.000Z");
    let firstPayload: Parameters<typeof sendEmail>[0] | undefined;
    sendEmail.mockImplementationOnce(async (payload) => {
      expect((payload as { from?: string }).from).toBe("Fluncle <test@example.com>");
      const claim = await db.execute(
        "select status, payload_json from follow_digest_deliveries where user_id = 'one'",
      );
      expect(claim.rows[0]?.status).toBe("claimed");
      const stored = claim.rows[0]?.payload_json;
      if (typeof stored !== "string") {
        throw new Error("Expected a stored delivery payload");
      }
      expect(JSON.parse(stored)).toEqual(payload);
      firstPayload = payload;
      throw new Error("worker crashed after Resend accepted the message");
    });
    await expect(sendFollowDigests({ now })).resolves.toMatchObject({ failed: 1, sent: 0 });
    await db.execute(
      "update follow_digest_deliveries set status = 'claimed', claimed_at = '2026-09-25T14:55:00.000Z' where user_id = 'one'",
    );
    await db.execute("update tracks set title = 'A changed title' where track_id = 'release'");
    const retry = await sendFollowDigests({ now });
    expect(retry).toMatchObject({ sent: 1, unknown: 0 });
    expect(sendEmail.mock.calls[1]?.[0]).toEqual(firstPayload);
  });

  it("marks old ambiguous claims unknown without another send", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    const now = new Date("2026-09-25T15:00:00.000Z");
    sendEmail.mockImplementationOnce(async () => {
      throw new Error("network disconnected");
    });
    await sendFollowDigests({ now });
    await db.execute(
      "update follow_digest_deliveries set status = 'claimed', claimed_at = '2026-09-24T14:00:00.000Z' where user_id = 'one'",
    );
    sendEmail.mockClear();
    expect(await sendFollowDigests({ now })).toMatchObject({ sent: 0, unknown: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("continues after one recipient fails and skips that failure later in the week", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    for (const id of ["a", "b"]) {
      await seedUser(db, { email: `${id}@example.com`, emailVerified: true, id });
    }
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("a", "artist", "artist-a", "watch-a");
    await watch("b", "artist", "artist-a", "watch-b");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    sendEmail.mockImplementation(async (payload) => {
      if (payload.to === "a@example.com") {
        throw new Error("recipient rejected");
      }
      return { id: "resend-b" };
    });
    const now = new Date("2026-09-25T15:00:00.000Z");
    expect(await sendFollowDigests({ now })).toMatchObject({ failed: 1, sent: 1 });
    expect(await sendFollowDigests({ now })).toMatchObject({ failed: 0, sent: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("retries transient recipient failures twice with one stored idempotency key", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    const { ResendDeliveryError } = await import("./resend");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    sendEmail
      .mockRejectedValueOnce(new ResendDeliveryError("rate limited", 429))
      .mockRejectedValueOnce(new ResendDeliveryError("server error", 503));
    expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
      failed: 0,
      sent: 1,
    });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(new Set(sendEmail.mock.calls.map(([payload]) => payload.idempotencyKey)).size).toBe(1);
    const state = await db.execute(
      "select attempts, status from follow_digest_deliveries where user_id = 'one'",
    );
    expect(state.rows[0]).toMatchObject({ attempts: 3, status: "sent" });
  });

  it("rechecks the current verified address and follows immediately before claiming", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    for (const id of ["a", "b"]) {
      await seedUser(db, { email: `${id}@example.com`, emailVerified: true, id });
    }
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("a", "artist", "artist-a", "watch-a");
    await watch("b", "artist", "artist-a", "watch-b");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    sendEmail.mockImplementationOnce(async () => {
      await db.execute("update \"user\" set email = 'new-b@example.com' where id = 'b'");
      return { id: "resend-a" };
    });
    expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
      sent: 2,
    });
    expect(sendEmail.mock.calls[1]?.[0].to).toBe("new-b@example.com");
  });

  it("limits release matching to 200 follows and a 28 day interval", async () => {
    const { listFollowDigestReleases } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    for (let i = 0; i < 201; i += 1) {
      const id = `artist-${String(i).padStart(3, "0")}`;
      await seedArtist(db, { id, name: id, slug: id });
      await watch(
        "one",
        "artist",
        id,
        `watch-${i}`,
        new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      );
    }
    await track("old", "2026-08-01", { artistId: "artist-200" });
    await track("outside-cap", "2026-09-24", { artistId: "artist-200" });
    await track("inside-cap", "2026-09-24", { artistId: "artist-000" });
    const result = await listFollowDigestReleases("one", "2020-01-01", "2026-09-25");
    expect(result.items.map((item) => item.title)).toEqual(["Track outside-cap"]);
  });
  it("sends matched album and label releases once, skips future dates, and writes only on send", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedUser(db, { email: "two@example.com", emailVerified: true, id: "two" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await seedLabel(db, { id: "label-a", name: "Label A", slug: "label-a" });
    await seedAlbum(db, { id: "album-a", name: "Album A", slug: "album-a" });
    await watch("one", "artist", "artist-a", "watch-artist");
    await watch("one", "label", "label-a", "watch-label");
    await watch("two", "artist", "artist-a", "watch-two");
    await track("a", "2026-09-24", { albumId: "album-a", artistId: "artist-a" });
    await track("b", "2026-09-24", { albumId: "album-a", artistId: "artist-a" });
    await track("c", "2026-09-23", { labelId: "label-a" });
    await track("future", "2026-10-01", { artistId: "artist-a" });
    await track("old", "2026-09-01", { artistId: "artist-a" });
    await db.execute(`update tracks set dismissed_at = '2026-09-24' where track_id = 'old'`);
    const now = new Date("2026-09-25T15:00:00.000Z");

    const dry = await sendFollowDigests({ dryRun: true, now });
    expect(dry).toMatchObject({ considered: 2, dryRun: true, sent: 0 });
    expect(await rowCount(db, "user_follow_digests")).toBe(0);

    const sent = await sendFollowDigests({ now });
    expect(sent).toMatchObject({ considered: 2, sent: 2, weekKey: "2026-W39" });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]?.[0].html).toContain("Track b");
    expect(sendEmail.mock.calls[0]?.[0].html).toContain("Track c");
    expect(sendEmail.mock.calls[0]?.[0].html).not.toContain("Track a");
    expect(sendEmail.mock.calls[0]?.[0].html).not.toContain("Track future");
    expect(sendEmail.mock.calls[0]?.[0].idempotencyKey).toMatch(
      /^follow-digest\/one\/2026-W39\/[0-9a-f-]+$/,
    );
    expect(sendEmail.mock.calls[0]?.[0].headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(await rowCount(db, "user_follow_digests")).toBe(2);

    const repeat = await sendFollowDigests({ now });
    expect(repeat.sent).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for an empty week or paused switch, and honors unsubscribe", async () => {
    const { sendFollowDigests, setFollowDigestPaused, setFollowDigestSubscription } =
      await import("./follow-digest");
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-artist");
    const now = new Date("2026-09-25T15:00:00.000Z");

    expect(await sendFollowDigests({ now })).toMatchObject({ empty: 1, sent: 0 });
    expect(await rowCount(db, "user_follow_digests")).toBe(0);
    await setFollowDigestPaused(true);
    expect(await sendFollowDigests({ now })).toMatchObject({
      considered: 0,
      paused: true,
      sent: 0,
    });
    await setFollowDigestPaused(false);
    await setFollowDigestSubscription("one", false, now);
    expect(await sendFollowDigests({ now })).toMatchObject({ considered: 0, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends only to verified addresses and leaves live delivery state untouched in test mode", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedUser(db, { email: "unverified@example.com", id: "a" });
    await seedUser(db, { email: "verified@example.com", emailVerified: true, id: "b" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("a", "artist", "artist-a", "watch-a");
    await watch("b", "artist", "artist-a", "watch-b");
    await track("release", "2026-09-24", { artistId: "artist-a" });
    vi.stubEnv("FOLLOW_DIGEST_TEST_RECIPIENT", "test@example.com");
    try {
      expect(await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") })).toMatchObject({
        considered: 1,
        sent: 1,
      });
      expect(sendEmail.mock.calls[0]?.[0].idempotencyKey).toMatch(
        /^follow-digest\/test\/b\/2026-W39\/[0-9a-f-]+$/,
      );
      expect(sendEmail.mock.calls[0]?.[0].to).toBe("test@example.com");
      expect(await rowCount(db, "user_follow_digests")).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("every send attempt re-checks the clock and the recipient", () => {
  async function seedOne() {
    await seedUser(db, { email: "one@example.com", emailVerified: true, id: "one" });
    await seedArtist(db, { id: "artist-a", name: "Artist A", slug: "artist-a" });
    await watch("one", "artist", "artist-a", "watch-a");
    await track("release", "2026-09-24", { artistId: "artist-a" });
  }

  async function strandClaim(claimedAt: string, runAt: Date) {
    const { sendFollowDigests } = await import("./follow-digest");
    sendEmail.mockImplementationOnce(async () => {
      throw new TypeError("network disconnected");
    });
    sendEmail.mockImplementationOnce(async () => {
      throw new TypeError("network disconnected");
    });
    sendEmail.mockImplementationOnce(async () => {
      throw new TypeError("network disconnected");
    });
    await sendFollowDigests({ now: runAt });
    await db.execute({
      args: [claimedAt],
      sql: "update follow_digest_deliveries set status = 'claimed', attempts = 0, claimed_at = ? where user_id = 'one'",
    });
    sendEmail.mockClear();
  }

  it("never re-sends a claim whose idempotency window closes while the batch is running", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedOne();
    await strandClaim("2026-09-24T16:00:00.000Z", new Date("2026-09-24T16:00:00.000Z"));

    const result = await sendFollowDigests({
      clock: () => new Date("2026-09-25T15:30:00.000Z"),
      now: new Date("2026-09-25T14:00:00.000Z"),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, unknown: 1 });
  });

  it("treats a claim within an hour of the 24 h window as already expired", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedOne();
    await strandClaim("2026-09-24T16:00:00.000Z", new Date("2026-09-24T16:00:00.000Z"));

    const at = new Date("2026-09-25T15:10:00.000Z");
    const result = await sendFollowDigests({ clock: () => at, now: at });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, unknown: 1 });
  });

  it("stops retrying the moment the recipient stops being eligible", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    const { ResendDeliveryError } = await import("./resend");
    await seedOne();
    sendEmail.mockImplementationOnce(async () => {
      await db.execute("delete from user_watches where user_id = 'one'");
      throw new ResendDeliveryError("rate limited", 429);
    });

    const result = await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") });
    const state = await db.execute(
      "select status from follow_digest_deliveries where user_id = 'one'",
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: 0 });
    expect(state.rows[0]?.status).not.toBe("sent");
    expect(state.rows[0]?.status).not.toBe("claimed");
  });

  it("stops retrying when the recipient unsubscribes between attempts", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    const { ResendDeliveryError } = await import("./resend");
    await seedOne();
    sendEmail.mockImplementationOnce(async () => {
      await db.execute(
        "insert into user_follow_digests (user_id, unsubscribed_at, updated_at) values ('one', '2026-09-25T15:00:00.000Z', '2026-09-25T15:00:00.000Z')",
      );
      throw new ResendDeliveryError("server error", 503);
    });

    await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") });

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous claim left over from an earlier week", async () => {
    const { sendFollowDigests } = await import("./follow-digest");
    await seedOne();
    await track("older", "2026-09-16", { artistId: "artist-a" });
    await strandClaim("2026-09-18T15:00:00.000Z", new Date("2026-09-18T15:00:00.000Z"));
    await db.execute("delete from user_watches where user_id = 'one'");

    await sendFollowDigests({ now: new Date("2026-09-25T15:00:00.000Z") });

    const prior = await db.execute(
      "select status from follow_digest_deliveries where user_id = 'one' and week_key = '2026-W38'",
    );

    expect(prior.rows[0]?.status).toBe("unknown");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
