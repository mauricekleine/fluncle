// Integration tests for the paginated `/admin/artists` board reads, driven against a real
// in-memory libSQL engine (vitest env = node). `getDb` is mocked to hand back the per-test client.
// These pin the shapes that replaced the former single unbounded whole-archive query:
//   - listArtistsPage keyset-pages by (name, id), searches server-side, and hydrates each artist
//     with its socials (platform-sorted in the isolate) + a GROUPED finding count (log_id not null,
//     once per page, never per output row),
//   - listFreshLinks returns the capped, name-sorted set of artists with unreviewed links plus the
//     TRUE total so overflow past the cap is visible,
//   - listArtistReviewRows is capped at ARTIST_REVIEW_QUEUE_LIMIT (the label-review twin).
import { type Client, createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const {
  ARTIST_REVIEW_QUEUE_LIMIT,
  FRESH_LINKS_LIMIT,
  listArtistReviewRows,
  listArtistsPage,
  listFreshLinks,
} = await import("./artists");

async function seedArtist(
  db: Client,
  row: { id: string; name: string; slug?: string; spotifyUrl?: string | null },
): Promise<void> {
  await db.execute({
    args: [row.id, row.name, row.slug ?? row.id, row.spotifyUrl ?? null],
    sql: `insert into artists (id, name, slug, spotify_url) values (?, ?, ?, ?)`,
  });
}

async function seedSocial(
  db: Client,
  row: {
    artistId: string;
    createdAt?: string;
    id: string;
    platform: string;
    reviewedAt?: string | null;
  },
): Promise<void> {
  await db.execute({
    args: [
      row.id,
      row.artistId,
      row.platform,
      `https://example.com/${row.platform}`,
      "musicbrainz",
      "auto",
      row.reviewedAt ?? null,
      row.createdAt ?? "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ],
    sql: `insert into artist_socials
            (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

// A coordinate-bearing finding (log_id not null) credited to an artist — one row in each of
// track_artists + findings, joined on track_id (the shape hydrateArtistOverview counts by).
async function seedFinding(
  db: Client,
  row: { artistId: string; logId: string | null; trackId: string },
): Promise<void> {
  await db.execute({
    args: [row.trackId, row.artistId],
    sql: `insert into track_artists (track_id, artist_id) values (?, ?)`,
  });
  await db.execute({
    args: [row.trackId, row.logId],
    sql: `insert into findings (track_id, log_id) values (?, ?)`,
  });
}

describe("the paginated /admin/artists board reads", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    holder.db = db;

    await db.execute(
      `create table artists (id text primary key, name text, slug text, spotify_url text)`,
    );
    await db.execute(
      `create table artist_socials (id text primary key, artist_id text, platform text, url text,
        source text, status text, reviewed_at text, created_at text, updated_at text,
        unique(artist_id, platform))`,
    );
    await db.execute(`create table track_artists (track_id text, artist_id text)`);
    await db.execute(`create table findings (track_id text primary key, log_id text)`);
  });

  it("keyset-pages by (name, id) with a next cursor and a stable total", async () => {
    await seedArtist(db, { id: "a", name: "Alpha" });
    await seedArtist(db, { id: "b", name: "Bravo" });
    await seedArtist(db, { id: "c", name: "Charlie" });

    const first = await listArtistsPage({ limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(["Alpha", "Bravo"]);
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await listArtistsPage({
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      limit: 2,
    });
    expect(second.items.map((item) => item.name)).toEqual(["Charlie"]);
    expect(second.totalCount).toBe(3);
    expect(second.nextCursor).toBeNull();
  });

  it("disambiguates equal names by id so no row is skipped or repeated across the page boundary", async () => {
    // Two artists share the exact name — the (name, id) keyset must still walk past both.
    await seedArtist(db, { id: "id-1", name: "Twins" });
    await seedArtist(db, { id: "id-2", name: "Twins" });
    await seedArtist(db, { id: "id-3", name: "Zephyr" });

    const first = await listArtistsPage({ limit: 1 });
    const second = await listArtistsPage({ cursor: first.nextCursor ?? "", limit: 1 });
    const third = await listArtistsPage({ cursor: second.nextCursor ?? "", limit: 1 });

    const ids = [first.items[0]?.id, second.items[0]?.id, third.items[0]?.id];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("searches by literal substring, case-insensitively, and counts the filtered total", async () => {
    await seedArtist(db, { id: "a", name: "Sub Focus" });
    await seedArtist(db, { id: "b", name: "Subtension" });
    await seedArtist(db, { id: "c", name: "Calibre" });

    const page = await listArtistsPage({ search: "SUB" });
    expect(page.items.map((item) => item.name).sort()).toEqual(["Sub Focus", "Subtension"]);
    expect(page.totalCount).toBe(2);
  });

  it("hydrates socials platform-sorted and counts only coordinate-bearing findings", async () => {
    await seedArtist(db, { id: "a", name: "Artist" });
    await seedArtist(db, { id: "b", name: "Bare" }); // socialless + findingless — still lists.

    // Insert socials out of alphabetical order — the isolate sorts them.
    await seedSocial(db, { artistId: "a", id: "s-yt", platform: "youtube" });
    await seedSocial(db, { artistId: "a", id: "s-ig", platform: "instagram" });

    // Two coordinate-bearing findings (counted) + one catalogue row with log_id null (not counted).
    await seedFinding(db, { artistId: "a", logId: "L-1", trackId: "t1" });
    await seedFinding(db, { artistId: "a", logId: "L-2", trackId: "t2" });
    await seedFinding(db, { artistId: "a", logId: null, trackId: "t3" });

    const { items } = await listArtistsPage();
    const artist = items.find((item) => item.id === "a");
    const bare = items.find((item) => item.id === "b");

    expect(artist?.findingCount).toBe(2);
    expect(artist?.socials.map((social) => social.platform)).toEqual(["instagram", "youtube"]);
    expect(bare?.findingCount).toBe(0);
    expect(bare?.socials).toEqual([]);
  });

  it("listFreshLinks caps the set, name-sorts it, and reports the true overflow total", async () => {
    // One more fresh artist than the cap serializes.
    for (let i = 0; i <= FRESH_LINKS_LIMIT; i += 1) {
      const id = `fresh-${String(i).padStart(4, "0")}`;
      await seedArtist(db, { id, name: `Fresh ${String(i).padStart(4, "0")}` });
      await seedSocial(db, {
        artistId: id,
        createdAt: `2026-07-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        id: `${id}-s`,
        platform: "tiktok",
        reviewedAt: null,
      });
    }
    // A reviewed-only artist never appears in the fresh queue.
    await seedArtist(db, { id: "seen", name: "Already Seen" });
    await seedSocial(db, {
      artistId: "seen",
      id: "seen-s",
      platform: "youtube",
      reviewedAt: "2026-07-01T12:00:00.000Z",
    });

    const fresh = await listFreshLinks();
    expect(fresh.artists).toHaveLength(FRESH_LINKS_LIMIT);
    expect(fresh.total).toBe(FRESH_LINKS_LIMIT + 1);
    // Name-sorted, and the reviewed-only artist is absent.
    const names = fresh.artists.map((artist) => artist.name);
    expect(names).toEqual([...names].sort());
    expect(names).not.toContain("Already Seen");
  });

  it("listArtistReviewRows caps at ARTIST_REVIEW_QUEUE_LIMIT, oldest-first", async () => {
    for (let i = 0; i <= ARTIST_REVIEW_QUEUE_LIMIT; i += 1) {
      const id = `a-${String(i).padStart(3, "0")}`;
      await seedArtist(db, { id, name: `Artist ${id}` });
      await seedSocial(db, {
        artistId: id,
        createdAt: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        id: `${id}-s`,
        platform: "tiktok",
        reviewedAt: null,
      });
    }

    const rows = await listArtistReviewRows();
    expect(rows).toHaveLength(ARTIST_REVIEW_QUEUE_LIMIT);
    // Oldest-first: the anchors are non-decreasing across the capped window.
    const anchors = rows.map((row) => row.anchorAt);
    expect(anchors).toEqual([...anchors].sort());
  });
});
