// Integration test for persistResolution's upsert semantics against a real in-memory
// libSQL engine (vitest env = node) — the only way to validate the WHERE-clause guarantee
// that a re-resolve NEVER overwrites an operator-owned row. `getDb` is mocked to hand back
// the per-test in-memory client.
import { type Client, createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { persistResolution } from "./artist-resolution";

type SocialRow = { source: string; status: string; url: string };

async function seedSocial(
  db: Client,
  row: { platform: string; source: string; status: string; url: string },
): Promise<void> {
  await db.execute({
    args: [`s-${row.platform}`, "a1", row.platform, row.url, row.source, row.status, "t0", "t0"],
    sql: `insert into artist_socials (id, artist_id, platform, url, source, status, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function readSocial(db: Client, platform: string): Promise<SocialRow | undefined> {
  const result = await db.execute({
    args: ["a1", platform],
    sql: `select url, source, status from artist_socials where artist_id = ? and platform = ?`,
  });

  return result.rows[0] as SocialRow | undefined;
}

describe("persistResolution — operator rows are immune to a re-resolve", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    holder.db = db;

    await db.execute(
      `create table artists (id text primary key, mbid text, wikidata_qid text, resolved_at text, updated_at text)`,
    );
    await db.execute(
      `create table artist_socials (id text primary key, artist_id text, platform text, url text,
        source text, status text, created_at text, updated_at text, unique(artist_id, platform))`,
    );
    await db.execute({ args: ["a1"], sql: `insert into artists (id) values (?)` });
  });

  it("never overwrites an operator-ADDED link (source, url, status all preserved)", async () => {
    await seedSocial(db, {
      platform: "instagram",
      source: "operator",
      status: "candidate",
      url: "https://www.instagram.com/operator-set",
    });

    await persistResolution(
      "a1",
      "mb1",
      null,
      [
        {
          platform: "instagram",
          source: "musicbrainz",
          url: "https://www.instagram.com/mb-version",
        },
      ],
      "auto",
      [],
    );

    expect(await readSocial(db, "instagram")).toEqual({
      source: "operator",
      status: "candidate",
      url: "https://www.instagram.com/operator-set",
    });
  });

  it("never overwrites a CONFIRMED link, even when MB brings a fresh URL", async () => {
    await seedSocial(db, {
      platform: "soundcloud",
      source: "musicbrainz",
      status: "confirmed",
      url: "https://soundcloud.com/confirmed",
    });

    await persistResolution(
      "a1",
      "mb1",
      null,
      [{ platform: "soundcloud", source: "musicbrainz", url: "https://soundcloud.com/fresh" }],
      "auto",
      [],
    );

    const row = await readSocial(db, "soundcloud");
    expect(row?.url).toBe("https://soundcloud.com/confirmed");
    expect(row?.status).toBe("confirmed");
  });

  it("DOES refresh a machine auto/candidate row on re-resolve", async () => {
    await seedSocial(db, {
      platform: "twitter",
      source: "musicbrainz",
      status: "auto",
      url: "https://twitter.com/old",
    });

    await persistResolution(
      "a1",
      "mb1",
      null,
      [{ platform: "twitter", source: "musicbrainz", url: "https://twitter.com/new" }],
      "auto",
      [],
    );

    expect((await readSocial(db, "twitter"))?.url).toBe("https://twitter.com/new");
  });

  it("promotes a firecrawl CANDIDATE to musicbrainz/auto when MB later covers it", async () => {
    await seedSocial(db, {
      platform: "bandcamp",
      source: "firecrawl",
      status: "candidate",
      url: "https://old.bandcamp.com",
    });

    await persistResolution(
      "a1",
      "mb1",
      null,
      [{ platform: "bandcamp", source: "musicbrainz", url: "https://new.bandcamp.com" }],
      "auto",
      [],
    );

    expect(await readSocial(db, "bandcamp")).toEqual({
      source: "musicbrainz",
      status: "auto",
      url: "https://new.bandcamp.com",
    });
  });

  it("the Firecrawl gap-fill never overwrites an existing platform (operator or machine)", async () => {
    await seedSocial(db, {
      platform: "youtube",
      source: "operator",
      status: "confirmed",
      url: "https://www.youtube.com/@operator",
    });

    await persistResolution("a1", "mb1", null, [], "auto", [
      { platform: "youtube", source: "firecrawl", url: "https://www.youtube.com/channel/UCfc" },
    ]);

    expect(await readSocial(db, "youtube")).toEqual({
      source: "operator",
      status: "confirmed",
      url: "https://www.youtube.com/@operator",
    });
  });
});
