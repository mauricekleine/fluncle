import { type Client } from "@libsql/client";
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
  async (_params: Parameters<typeof import("./resend").sendFollowDigestEmail>[0]) => {},
);

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resend")>();
  return {
    ...actual,
    sendFollowDigestEmail: (params: Parameters<typeof actual.sendFollowDigestEmail>[0]) =>
      sendEmail(params),
  };
});

beforeEach(async () => {
  db = await createIntegrationDb();
  sendEmail.mockClear();
});

afterEach(() => db.close());

async function watch(userId: string, kind: "artist" | "label", entityId: string, id: string) {
  await db.execute({
    args: [id, userId, kind, entityId, "2026-09-01T00:00:00.000Z"],
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
    expect(sendEmail.mock.calls[0]?.[0].idempotencyKey).toBe("follow-digest/one/2026-W39");
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
      expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: "follow-digest/test/b/2026-W39",
        to: "test@example.com",
      });
      expect(await rowCount(db, "user_follow_digests")).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
