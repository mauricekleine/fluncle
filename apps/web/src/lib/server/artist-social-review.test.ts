// Integration tests for the per-link review writes + the fresh-links queue read, driven against a
// real in-memory libSQL engine (vitest env = node). `getDb` is mocked to hand back the per-test
// client. These pin the behaviours that move review from the artist down to the link:
//   - an operator add is born reviewed,
//   - reviewArtistSocial marks ONE link reviewed and promotes a candidate,
//   - reviewArtist bulk-stamps the whole list,
//   - listArtistReviewRows counts UNREVIEWED links per artist (the /admin attention read).
import { type Client, createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const {
  addArtistSocial,
  InvalidArtistSocialError,
  listArtistReviewRows,
  reviewArtist,
  reviewArtistSocial,
  updateArtistSocial,
} = await import("./artists");

async function seedSocial(
  db: Client,
  row: {
    createdAt?: string;
    id: string;
    platform: string;
    reviewedAt?: string | null;
    source?: string;
    status?: string;
  },
): Promise<void> {
  await db.execute({
    args: [
      row.id,
      "a1",
      row.platform,
      `https://example.com/${row.platform}`,
      row.source ?? "musicbrainz",
      row.status ?? "auto",
      row.reviewedAt ?? null,
      row.createdAt ?? "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ],
    sql: `insert into artist_socials
            (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function readSocial(
  db: Client,
  id: string,
): Promise<{ reviewed_at: string | null; status: string } | undefined> {
  const result = await db.execute({
    args: [id],
    sql: `select status, reviewed_at from artist_socials where id = ?`,
  });

  return result.rows[0] as { reviewed_at: string | null; status: string } | undefined;
}

describe("per-link review writes + the fresh-links queue", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    holder.db = db;

    await db.execute(
      `create table artists (id text primary key, name text, slug text, spotify_url text,
        reviewed_at text, updated_at text)`,
    );
    await db.execute(
      `create table artist_socials (id text primary key, artist_id text, platform text, url text,
        source text, status text, reviewed_at text, created_at text, updated_at text,
        unique(artist_id, platform))`,
    );
    await db.execute({
      args: ["a1", "Artist One", "artist-one"],
      sql: `insert into artists (id, name, slug) values (?, ?, ?)`,
    });
  });

  it("addArtistSocial is born reviewed (never lands in the fresh-links queue)", async () => {
    const social = await addArtistSocial("a1", "instagram", "https://www.instagram.com/one");

    expect(social.reviewedAt).not.toBeNull();
    expect(social.status).toBe("confirmed");
    expect(await listArtistReviewRows()).toEqual([]);
  });

  it("reviewArtistSocial marks ONE link reviewed and promotes a candidate", async () => {
    await seedSocial(db, {
      id: "s-firecrawl",
      platform: "tiktok",
      source: "firecrawl",
      status: "candidate",
    });
    await seedSocial(db, { id: "s-auto", platform: "youtube", status: "auto" });

    const reviewed = await reviewArtistSocial("s-firecrawl");

    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.status).toBe("confirmed");
    // The other link is untouched — still fresh.
    expect((await readSocial(db, "s-auto"))?.reviewed_at).toBeNull();

    // Only the still-fresh auto link remains in the queue, with pending = 1.
    const rows = await listArtistReviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBe(1);
  });

  it("reviewArtist bulk-stamps every fresh link and promotes candidates", async () => {
    await seedSocial(db, {
      id: "s1",
      platform: "tiktok",
      source: "firecrawl",
      status: "candidate",
    });
    await seedSocial(db, { id: "s2", platform: "youtube", status: "auto" });

    const { confirmed } = await reviewArtist("a1");

    expect(confirmed).toBe(1);
    expect((await readSocial(db, "s1"))?.status).toBe("confirmed");
    expect((await readSocial(db, "s1"))?.reviewed_at).not.toBeNull();
    expect((await readSocial(db, "s2"))?.reviewed_at).not.toBeNull();
    expect(await listArtistReviewRows()).toEqual([]);
  });

  it("updateArtistSocial corrects the URL AND approves it (operator-owned, confirmed, reviewed)", async () => {
    await seedSocial(db, {
      id: "s-firecrawl",
      platform: "instagram",
      reviewedAt: null,
      source: "firecrawl",
      status: "candidate",
    });

    // A pasted profile deep-link normalizes to the profile root on the way in.
    const updated = await updateArtistSocial("s-firecrawl", "https://www.instagram.com/dimension/");

    expect(updated.url).toBe("https://www.instagram.com/dimension");
    expect(updated.source).toBe("operator");
    expect(updated.status).toBe("confirmed");
    expect(updated.reviewedAt).not.toBeNull();
    // The corrected link left the fresh-links queue.
    expect(await listArtistReviewRows()).toEqual([]);
  });

  it("updateArtistSocial rejects a URL whose host is the wrong platform", async () => {
    await seedSocial(db, {
      id: "s-firecrawl",
      platform: "instagram",
      reviewedAt: null,
      source: "firecrawl",
      status: "candidate",
    });

    await expect(
      updateArtistSocial("s-firecrawl", "https://www.youtube.com/@dimension"),
    ).rejects.toBeInstanceOf(InvalidArtistSocialError);

    // The bad edit never landed — the row is still the fresh firecrawl candidate.
    const row = await readSocial(db, "s-firecrawl");
    expect(row?.status).toBe("candidate");
    expect(row?.reviewed_at).toBeNull();
  });

  it("listArtistReviewRows counts only UNREVIEWED links, oldest-first anchor", async () => {
    await seedSocial(db, {
      createdAt: "2026-07-03T00:00:00.000Z",
      id: "fresh-b",
      platform: "tiktok",
      reviewedAt: null,
    });
    await seedSocial(db, {
      createdAt: "2026-07-02T00:00:00.000Z",
      id: "fresh-a",
      platform: "instagram",
      reviewedAt: null,
    });
    await seedSocial(db, {
      createdAt: "2026-07-01T00:00:00.000Z",
      id: "seen",
      platform: "youtube",
      reviewedAt: "2026-07-01T12:00:00.000Z",
    });

    const rows = await listArtistReviewRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBe(2);
    expect(rows[0]?.anchorAt).toBe("2026-07-02T00:00:00.000Z");
  });
});
