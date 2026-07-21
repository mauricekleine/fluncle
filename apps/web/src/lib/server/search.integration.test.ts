// The search resolver against a REAL libSQL database — the migrations, the FTS5 index and
// its triggers, and `vector_distance_cos` over real `F32_BLOB` vectors. Nothing here is
// mocked except the network (there is no network: the LLM tier is stubbed).
//
// It exists because three of this feature's load-bearing pieces are SQL, not TypeScript, and
// a mocked-DB test would happily pass while every one of them was broken:
//
//   - the FTS5 DDL + the three sync triggers (they must apply on the same engine the deploy
//     applies them on — and if they fail here, `deploy:gate` fails and prod is blocked, which
//     is exactly the guard we want);
//   - the LEFT JOIN that lets an uncertified track be FOUND while never being certified;
//   - the vector scan, with the probe bound as a raw BLOB.
//
// The uncertified rows here are SYNTHETIC — the crawler fills the real catalogue in
// production, but a test must state EXACTLY which unlit rows exist: the code path that
// renders an unlit row and links it OUT to Spotify is proven on a known set, never on
// whatever the crawl happens to have brought in.

import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkTrackToAlbum } from "./albums";
import { createIntegrationDb } from "./integration-db";
import { linkTrackToLabel } from "./labels";
import { searchArchive } from "./search";

// The LLM tier is a network call. Stubbed here so each test states EXACTLY what the model
// returned — including "nothing", which is the degradation the spec demands be proven.
const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

// The one live database, swapped in fresh for each test. `getDb` closes over it, so the REAL
// query functions run REAL SQL against the REAL migrated schema.
let db: Client;

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => db };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

const DIMS = 1024;

/**
 * A unit vector at `angle` radians in the (0,1) plane of the MuQ space. Cosine similarity
 * between two of them is exactly `cos(a − b)`, so the expected neighbour ORDER is arithmetic
 * rather than a guess — which is what makes the vector assertions below real assertions.
 */
function angleVector(angle: number): Float32Array {
  const vector = new Float32Array(DIMS);

  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);

  return vector;
}

type Fixture = {
  album?: string;
  angle?: number;
  artists: string[];
  bpm?: number;
  key?: string;
  label?: string;
  /** A `findings` row is minted when this is set — i.e. this track is a CERTIFIED finding. */
  logId?: string;
  releaseDate?: string;
  title: string;
  trackId: string;
};

async function seed(client: Client, track: Fixture): Promise<void> {
  const embedding = track.angle === undefined ? null : angleVector(track.angle);

  await client.execute({
    args: [
      track.trackId,
      track.title,
      JSON.stringify(track.artists),
      track.album ?? null,
      track.label ?? null,
      track.key ?? null,
      track.bpm ?? null,
      track.releaseDate ?? null,
      `https://open.spotify.com/track/${track.trackId}`,
      180_000,
      embedding ? new Uint8Array(embedding.buffer) : null,
    ],
    sql: `insert into tracks
      (track_id, title, artists_json, album, label, key, bpm, release_date, spotify_url,
       duration_ms, embedding_blob)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  if (track.logId !== undefined) {
    await client.execute({
      args: [track.trackId, track.logId, "2026-07-01T00:00:00.000Z"],
      sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
    });
  }

  // The GRAPH POINTERS, written by the REAL publish-path functions rather than by a hand-
  // rolled insert — so the `labels` / `albums` rows and the `tracks.label_id` / `album_id`
  // edges this fixture stands on are exactly the ones production writes. The entity tier
  // reads THROUGH those pointers; a fixture that only set the raw strings would let a broken
  // join pass.
  await linkTrackToLabel(track.trackId, track.label);
  await linkTrackToAlbum(track.trackId, track.album);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  translateQuery.mockReset();
  translateQuery.mockResolvedValue(null);

  // Three certified findings — their angles fix the sonic order around the 1991 anchor
  // (0.0): Netsky at 0.1 is nearest, the uncertified track at 0.3 next, Andromedik at 1.2
  // furthest.
  await seed(db, {
    album: "Second Nature",
    angle: 0.1,
    artists: ["Netsky", "Bev Lee Harling"],
    bpm: 175.5,
    key: "A minor",
    label: "Hospital Records",
    logId: "012.4.4D",
    releaseDate: "2020-05-01",
    title: "Let's Leave Tomorrow",
    trackId: "certified-netsky",
  });
  await seed(db, {
    album: "Chapter One",
    angle: 0,
    artists: ["1991"],
    bpm: 174,
    key: "F minor",
    label: "1991",
    logId: "024.7.2R",
    releaseDate: "2022-01-01",
    title: "Nine Clouds",
    trackId: "certified-1991",
  });
  await seed(db, {
    album: "Take Me Away (Remixes)",
    angle: 1.2,
    artists: ["Andromedik", "Lexurus"],
    bpm: 174,
    key: "B minor",
    label: "Andromedik",
    logId: "038.8.7K",
    releaseDate: "2026-04-24",
    title: "Take Me Away - Lexurus Remix",
    trackId: "certified-andromedik",
  });

  // …and one UNCERTIFIED track. A `tracks` row with no `findings` row: a light Fluncle's
  // instruments measured from a distance and never went to. It has no coordinate, so search
  // must find it and the client must link it OUT. It sits on a label AND a record Fluncle
  // HAS certified something on, so both entities carry it — which is the whole reason the
  // graph pages exist.
  await seed(db, {
    album: "Second Nature",
    angle: 0.3,
    artists: ["Netsky"],
    bpm: 172,
    key: "A minor",
    label: "Hospital Records",
    releaseDate: "2019-03-03",
    title: "Rio",
    trackId: "uncertified-netsky",
  });

  await db.execute({
    args: [],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
          values ('a1', 'Netsky', 'netsky', '2026-07-01', '2026-07-01')`,
  });
});

afterEach(() => {
  db.close();
});

// ── The index itself ─────────────────────────────────────────────────────────────────

describe("the FTS5 index", () => {
  it("is populated by the insert trigger — the app never writes to it", async () => {
    const rows = await db.execute("select count(*) as n from tracks_fts");

    expect(Number(rows.rows[0]?.n)).toBe(4);
  });

  it("follows a title change through the update trigger", async () => {
    await db.execute({
      args: ["certified-1991"],
      sql: `update tracks set title = 'Ten Clouds' where track_id = ?`,
    });

    const stale = await searchArchive({ q: "nine" });
    const fresh = await searchArchive({ q: "ten" });

    expect(stale.results).toHaveLength(0);
    expect(fresh.results.map((hit) => hit.trackId)).toEqual(["certified-1991"]);
  });

  it("drops a row through the delete trigger", async () => {
    await db.execute({ args: ["certified-1991"], sql: `delete from tracks where track_id = ?` });

    expect((await searchArchive({ q: "clouds" })).results).toHaveLength(0);
  });
});

// ── Tier 1 · the coordinate ──────────────────────────────────────────────────────────

describe("tier 1 — a coordinate", () => {
  it("resolves straight to the finding's page, with no candidate scan", async () => {
    const result = await searchArchive({ q: "024.7.2R" });

    expect(result.kind).toBe("coordinate");
    expect(result.redirect).toBe("/log/024.7.2R");
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("hands back the FINDING it named, not a rendering of the URL", async () => {
    const result = await searchArchive({ q: "024.7.2R" });

    expect(result.results.map((hit) => hit.title)).toEqual(["Nine Clouds"]);
    expect(result.results[0]?.certified).toBe(true);
  });

  it("accepts the fluncle:// form", async () => {
    expect((await searchArchive({ q: "fluncle://024.7.2R" })).redirect).toBe("/log/024.7.2R");
  });

  it("returns an honest nothing for a coordinate that names no finding", async () => {
    const result = await searchArchive({ q: "999.9.9Z" });

    expect(result.kind).toBe("coordinate");
    expect(result.redirect).toBeUndefined();
    expect(result.results).toHaveLength(0);
  });
});

// ── Tier 2 · the exact entity ────────────────────────────────────────────────────────

// An artist, a label, and an album are ONE affordance — the thing you searched for, offered as
// a destination, with its tracks under it. The label and the album used to come back as a bare
// filter chip (their pages did not exist when search shipped); they are first-class here now,
// and these three tests are the same test three times ON PURPOSE.
describe("tier 2 — an exact entity name", () => {
  it("jumps to the artist page, offers the artist, and lists their tracks under it", async () => {
    const result = await searchArchive({ q: "Netsky" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBe("/artist/netsky");
    expect(result.entities).toEqual([{ kind: "artist", name: "Netsky", slug: "netsky" }]);
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("jumps to the label page, offers the label, and lists its tracks under it", async () => {
    const result = await searchArchive({ q: "hospital records" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBe("/label/hospital-records");
    expect(result.entities).toEqual([
      { kind: "label", name: "Hospital Records", slug: "hospital-records" },
    ]);
    // No filter chip: the entity IS the answer, exactly as it is for the artist.
    expect(result.filters).toBeUndefined();
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("jumps to the album page, offers the album, and lists its tracks under it", async () => {
    const result = await searchArchive({ q: "second nature" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBe("/album/second-nature");
    expect(result.entities).toEqual([
      { kind: "album", name: "Second Nature", slug: "second-nature" },
    ]);
    expect(result.filters).toBeUndefined();
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  // The guard that keeps search from offering an empty page: the catalogue crawler mints a
  // `labels` row for every imprint it walks past, and one Fluncle has certified NOTHING on has
  // nothing to show. It stays the filter it always was — never a dead link.
  it("declines to jump to a label with no certified finding on it", async () => {
    await db.execute({
      args: [],
      sql: `insert into labels (id, name, slug, created_at, updated_at)
            values ('l-crawled', 'Crawled Imprint', 'crawled-imprint', '2026-07-01', '2026-07-01')`,
    });

    const result = await searchArchive({ q: "Crawled Imprint" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBeUndefined();
    expect(result.entities).toEqual([]);
    expect(result.filters).toEqual({ label: "Crawled Imprint" });
  });
});

// ── Aliases · an artist answers to every name ────────────────────────────────────────

// The MusicBrainz-harvested AKAs (`artist-resolution.ts`) that solve DnB's many-names problem
// were invisible to search — a crew member typing a producer's other name found nothing. They
// now resolve through the SAME entity path the primary name does, in the deterministic tiers
// (exact in tier 2, prefix in tier 3), in front of the model — so an AKA is a jump target
// exactly as the real name is, and it keeps working when the LLM is down.
describe("aliases — an artist answers to every name", () => {
  beforeEach(async () => {
    // A second artist whose PRIMARY name collides with one of Netsky's aliases (the tie case).
    await db.execute({
      args: [],
      sql: `insert into artists (id, name, slug, created_at, updated_at)
            values ('a2', 'Origin', 'origin', '2026-07-01', '2026-07-01')`,
    });

    // Netsky's AKAs. One MB-curated (`auto`), one operator-ruled (`confirmed`) — both trusted,
    // exactly as they feed the public `alternateName`. One `hint` (a weak MB "Search hint" lead,
    // never public) that must NOT resolve. One that is ALSO Origin's primary name (the tie).
    const aliasRows: [string, string, string, string, string, string][] = [
      ["aa1", "Boris Daenen", "boris-daenen", "musicbrainz", "name", "auto"],
      ["aa2", "Netsky Live", "netsky-live", "operator", "name", "confirmed"],
      ["aa3", "Phantom Hint", "phantom-hint", "musicbrainz", "hint", "auto"],
      ["aa4", "Origin", "origin", "musicbrainz", "name", "auto"],
    ];

    for (const [id, alias, slug, source, kind, status] of aliasRows) {
      await db.execute({
        args: [id, alias, slug, source, kind, status],
        sql: `insert into artist_aliases
                (id, artist_id, alias, alias_slug, source, kind, status, created_at)
              values (?, 'a1', ?, ?, ?, ?, ?, '2026-07-01')`,
      });
    }
  });

  it("resolves an EXACT alias to the artist page — with the same findings the name gives", async () => {
    const byName = await searchArchive({ q: "Netsky" });
    const byAlias = await searchArchive({ q: "Boris Daenen" });

    expect(byAlias.kind).toBe("entity");
    expect(byAlias.redirect).toBe("/artist/netsky");
    expect(byAlias.entities).toEqual([{ kind: "artist", name: "Netsky", slug: "netsky" }]);
    // The alias lands on the canonical artist, so it lists exactly what the real name lists.
    expect(byAlias.results.map((hit) => hit.trackId)).toEqual(byName.results.map((h) => h.trackId));
    expect(byAlias.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("trusts BOTH an `auto` (MusicBrainz) and a `confirmed` (operator) alias", async () => {
    // For an artist, `auto` is a DIRECT MB statement of identity — trusted exactly as an
    // operator-`confirmed` alias is (there is no weaker `candidate` tier). Both resolve.
    expect((await searchArchive({ q: "Boris Daenen" })).redirect).toBe("/artist/netsky");
    expect((await searchArchive({ q: "Netsky Live" })).redirect).toBe("/artist/netsky");
  });

  it("prefix-matches an alias as a tier-3 jump target, exactly as it does the name", async () => {
    // "boris" is a bare token that is nobody's exact name — it falls to tier 3, where the prefix
    // jump lives. The AKA surfaces the artist beside the (here empty) row set.
    const result = await searchArchive({ q: "boris" });

    expect(result.kind).toBe("token");
    expect(result.entities).toEqual([{ kind: "artist", name: "Netsky", slug: "netsky" }]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("lets the PRIMARY name win a tie against another artist's alias", async () => {
    // "Origin" is Origin's real name AND Netsky's AKA. A name the query names DIRECTLY must beat
    // one it only reaches through an alias — so this lands on Origin, never on Netsky.
    const result = await searchArchive({ q: "Origin" });

    expect(result.redirect).toBe("/artist/origin");
    expect(result.entities).toEqual([{ kind: "artist", name: "Origin", slug: "origin" }]);
  });

  it("does NOT resolve a `hint` alias — a weak lead is never a public answer", async () => {
    // A MB "Search hint" is kept for the record but never rendered publicly, so it never
    // resolves a search either. "Phantom Hint" names no artist here; it falls through.
    const result = await searchArchive({ q: "Phantom Hint" });

    expect(result.redirect).toBeUndefined();
    expect(result.entities).toEqual([]);
    expect(result.kind).not.toBe("entity");
  });
});

// ── Tier 3 · the bare token ──────────────────────────────────────────────────────────

describe("tier 3 — a bare token", () => {
  it("finds by title through FTS5, without reaching the model", async () => {
    const result = await searchArchive({ q: "clouds" });

    expect(result.kind).toBe("token");
    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-1991"]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("prefix-matches mid-word, which is what makes it a type-ahead", async () => {
    const result = await searchArchive({ q: "andro" });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-andromedik"]);
  });

  it("offers the artist as a jump target beside the rows", async () => {
    // "netsky" is an EXACT artist name, so tier 2 claims it; "nets" is not, so it falls to
    // tier 3 — which is where the prefix jump lives.
    const result = await searchArchive({ q: "nets" });

    expect(result.kind).toBe("token");
    expect(result.entities).toEqual([{ kind: "artist", name: "Netsky", slug: "netsky" }]);
  });

  it("offers the label and the album as jump targets too — one affordance, three kinds", async () => {
    expect((await searchArchive({ q: "hospi" })).entities).toEqual([
      { kind: "label", name: "Hospital Records", slug: "hospital-records" },
    ]);
    expect((await searchArchive({ q: "second" })).entities).toEqual([
      { kind: "album", name: "Second Nature", slug: "second-nature" },
    ]);
  });

  it("orders the jump targets artist → label → album (a name is most often a person)", async () => {
    // "andro" prefixes the Andromedik LABEL (the artist's own imprint); "net" prefixes the
    // Netsky artist. Ask for both at once and the artist leads.
    const andro = await searchArchive({ q: "andro" });

    expect(andro.entities.map((entity) => entity.kind)).toEqual(["label"]);
    expect(andro.entities[0]?.slug).toBe("andromedik");

    const nets = await searchArchive({ q: "net" });

    expect(nets.entities[0]?.kind).toBe("artist");
  });
});

// ── The catalogue rule ───────────────────────────────────────────────────────────────

describe("the catalogue rule — findings are named, the rest is not", () => {
  it("finds an uncertified track, gives it NO coordinate, and links it OUT", async () => {
    const result = await searchArchive({ q: "rio" });
    const hit = result.results[0];

    expect(hit?.trackId).toBe("uncertified-netsky");
    expect(hit?.certified).toBe(false);
    expect(hit?.logId).toBeUndefined();
    expect(hit?.spotifyUrl).toBe("https://open.spotify.com/track/uncertified-netsky");
  });

  it("puts certified rows first — bm25 is corpus-relative, so the tiers cannot be blended", async () => {
    const result = await searchArchive({ q: "netsky" });

    // Tier 2 claims the exact name and redirects; the label filter shows the ordering.
    const byLabel = await searchArchive({ q: "Hospital Records" });

    expect(byLabel.results.map((hit) => hit.certified)).toEqual([true, false]);
    expect(result.redirect).toBe("/artist/netsky");
  });

  it("never leaks a coordinate onto a track Fluncle did not certify", async () => {
    const result = await searchArchive({ q: "Hospital Records" });

    for (const hit of result.results) {
      expect(hit.certified).toBe(hit.logId !== undefined);
    }
  });
});

// ── Tier 4 · the filters ─────────────────────────────────────────────────────────────

describe("tier 4 — language becomes filters, and SQL does the retrieval", () => {
  it("executes an artist + key filter", async () => {
    translateQuery.mockResolvedValue({ artist: "Netsky", key: "A minor" });

    const result = await searchArchive({ q: "Netsky tracks in A minor" });

    expect(result.kind).toBe("filters");
    expect(result.filters).toEqual({ artist: "Netsky", key: "A minor" });
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("asks one question of Bb minor and A# minor (the enharmonic fold)", async () => {
    await db.execute({
      args: ["certified-andromedik"],
      sql: `update tracks set key = 'A# minor' where track_id = ?`,
    });
    translateQuery.mockResolvedValue({ key: "Bb minor" });

    const result = await searchArchive({ q: "anything in Bb minor" });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-andromedik"]);
  });

  it("executes a BPM range", async () => {
    translateQuery.mockResolvedValue({ bpmMax: 173, bpmMin: 170 });

    const result = await searchArchive({ q: "tracks between 170 and 173 bpm" });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["uncertified-netsky"]);
  });

  it("executes a year bound", async () => {
    translateQuery.mockResolvedValue({ yearMin: 2025 });

    const result = await searchArchive({ q: "anything from 2025 onwards" });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-andromedik"]);
  });

  it("returns an HONEST empty when real columns simply do not match", async () => {
    // The archive's one Andromedik track is in B minor. The right answer is "nothing", not a
    // consolation prize of fuzzy text hits.
    translateQuery.mockResolvedValue({ artist: "Andromedik", key: "A minor" });

    const result = await searchArchive({ q: "Andromedik tracks in A minor" });

    expect(result.kind).toBe("filters");
    expect(result.results).toEqual([]);
    expect(result.degraded).toBe(false);
  });
});

// ── The sonic tier ───────────────────────────────────────────────────────────────────

describe("the sonic tier — anchored on a real track, ranked in SQL", () => {
  it("answers a sonic phrase WITHOUT a model — the headline query has no vendor dependency", async () => {
    const result = await searchArchive({ q: "tracks that sound like Nine Clouds" });

    expect(result.kind).toBe("sonic");
    expect(translateQuery).not.toHaveBeenCalled();
    expect(result.anchor?.trackId).toBe("certified-1991");
    expect(result.anchor?.logId).toBe("024.7.2R");
    // The anchor itself is excluded; the nearest vector leads, the distant one trails.
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
      "certified-andromedik",
    ]);
  });

  it("reads every ordinary phrasing of the same question", async () => {
    for (const query of [
      "sounds like Nine Clouds",
      "similar to Nine Clouds",
      "songs that sound like Nine Clouds",
      "like Nine Clouds",
    ]) {
      const result = await searchArchive({ q: query });

      expect(result.kind, query).toBe("sonic");
      expect(result.anchor?.trackId, query).toBe("certified-1991");
    }
  });

  it("still takes the model's `soundsLike` for a phrasing the regex cannot see", async () => {
    translateQuery.mockResolvedValue({ soundsLike: "Nine Clouds" });

    const result = await searchArchive({ q: "give me more of that Nine Clouds energy" });

    expect(result.kind).toBe("sonic");
    expect(translateQuery).toHaveBeenCalled();
    expect(result.anchor?.trackId).toBe("certified-1991");
  });

  it("reaches uncertified tracks too — the depth behind the findings is the point", async () => {
    const result = await searchArchive({ q: "sounds like Nine Clouds" });

    expect(result.results.some((hit) => !hit.certified)).toBe(true);
  });

  // The COMPOUND query is where the model earns its place on this tier: the reference is only
  // half the question, and the other half becomes the btree pre-filter in FRONT of the vector
  // scan (100k: 1,883 ms → 207 ms, measured). The regex declines it on purpose.
  it("hands a compound query to the model, and turns its filters into the btree pre-filter", async () => {
    translateQuery.mockResolvedValue({ label: "Hospital Records", soundsLike: "Nine Clouds" });

    const result = await searchArchive({ q: "sounds like Nine Clouds but on Hospital Records" });

    expect(translateQuery).toHaveBeenCalled();
    expect(result.kind).toBe("sonic");
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("DECLINES rather than inventing a vibe when the reference names no real track", async () => {
    translateQuery.mockResolvedValue({ soundsLike: "A Track That Does Not Exist" });

    const result = await searchArchive({ q: "sounds like A Track That Does Not Exist" });

    expect(result.kind).not.toBe("sonic");
    expect(result.anchor).toBeUndefined();
  });
});

// ── Tier 2 · a galaxy and a mixtape are jump nodes too ───────────────────────────────

// Beyond the artist/label/album graph, search resolves a NAMED galaxy (`/galaxies/<slug>`) and a
// PUBLISHED mixtape by its TITLE — whose page IS its log page (`/log/<F-logId>`). Both are archive-
// sized reads and both are a pure jump: the row carries its own `url` so a consumer never has to
// special-case the plural galaxy segment or the mixtape's log route.
describe("tier 2 — a galaxy and a mixtape are jump nodes", () => {
  beforeEach(async () => {
    // A named, non-retired galaxy (public) + a retired one and an unnamed one (both admin-only).
    await db.execute({
      args: [],
      sql: `insert into galaxies (id, handle, name, slug, centroid_json, created_at, updated_at)
            values ('g-named', 'gx-01', 'Amber Drift', 'amber-drift', '[]', '2026-07-01', '2026-07-01')`,
    });
    await db.execute({
      args: [],
      sql: `insert into galaxies (id, handle, name, slug, centroid_json, retired_at, created_at, updated_at)
            values ('g-dead', 'gx-02', 'Faded Sector', 'faded-sector', '[]', '2026-07-02', '2026-07-01', '2026-07-01')`,
    });
    await db.execute({
      args: [],
      sql: `insert into galaxies (id, handle, centroid_json, created_at, updated_at)
            values ('g-unnamed', 'gx-03', '[]', '2026-07-01', '2026-07-01')`,
    });

    // A published mixtape (minted, log_id set) + a distributing one (unminted) that must NOT resolve.
    await db.execute({
      args: [],
      sql: `insert into mixtapes (id, title, log_id, status, created_at, updated_at)
            values ('m-pub', 'Summer Voyage', '005.F.03', 'published', '2026-07-01', '2026-07-01')`,
    });
    await db.execute({
      args: [],
      sql: `insert into mixtapes (id, title, status, created_at, updated_at)
            values ('m-dist', 'Winter Draft', 'distributing', '2026-07-01', '2026-07-01')`,
    });
  });

  it("jumps to a named galaxy's page, carrying the plural-segment url", async () => {
    const result = await searchArchive({ q: "Amber Drift" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBe("/galaxies/amber-drift");
    expect(result.entities).toEqual([
      { kind: "galaxy", name: "Amber Drift", slug: "amber-drift", url: "/galaxies/amber-drift" },
    ]);
    // A pure jump — no column filter maps to a galaxy, so nothing lists under it.
    expect(result.results).toEqual([]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("never resolves a retired or an unnamed galaxy", async () => {
    expect((await searchArchive({ q: "Faded Sector" })).entities).toEqual([]);
    // The unnamed galaxy has no public name to match on at all.
    const named = await searchArchive({ q: "amber" });

    expect(named.entities.map((entity) => entity.slug)).toEqual(["amber-drift"]);
  });

  it("jumps to a published mixtape by title — its page IS its log page", async () => {
    const result = await searchArchive({ q: "Summer Voyage" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBe("/log/005.F.03");
    expect(result.entities[0]).toMatchObject({
      kind: "mixtape",
      name: "Summer Voyage",
      slug: "005.F.03",
      url: "/log/005.F.03",
    });
    // Its cover derives from the Log ID (never stored), same as every mixtape surface.
    expect(result.entities[0]?.imageUrl).toContain("/api/mixtape-cover/005.F.03");
    expect(result.results).toEqual([]);
  });

  it("never resolves a mixtape that is not published yet", async () => {
    const result = await searchArchive({ q: "Winter Draft" });

    expect(result.entities).toEqual([]);
    expect(result.redirect).toBeUndefined();
  });

  it("prefix-matches a galaxy and a mixtape as tier-3 jump targets", async () => {
    const entities = (await searchArchive({ q: "summ" })).entities;

    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      kind: "mixtape",
      name: "Summer Voyage",
      slug: "005.F.03",
      url: "/log/005.F.03",
    });
  });
});

// ── The entity gate follows the shared hub floor ─────────────────────────────────────

// A label/album is offered as a JUMP when it clears the SAME gate the /labels + /albums hubs and the
// API list drive off (`HUB_INCLUSION_HAVING`): a certified finding OR a page over the thin-content
// floor. So a catalogue-only label with enough renderable tracks is a real destination now — while a
// below-floor imprint still declines the jump and falls back to the filter chip it always was.
describe("the entity gate follows the shared hub floor (not certified-only)", () => {
  beforeEach(async () => {
    // A catalogue-only label with THREE uncertified tracks — no finding, but it clears the floor
    // (LABEL_INDEX_MIN_TRACKS = 3), so its `/label/<slug>` page exists and search should offer it.
    for (const n of [1, 2, 3]) {
      await seed(db, {
        artists: [`Sunk`],
        label: "Sofa Sound",
        title: `Sofa Cut ${n}`,
        trackId: `sofa-${n}`,
      });
    }

    // A below-floor imprint — ONE uncertified track — that must still decline the jump.
    await seed(db, {
      artists: ["Lonely"],
      label: "Lone Imprint",
      title: "Only One",
      trackId: "lone-1",
    });
  });

  it("OFFERS a catalogue-only label that clears the floor — no certified finding needed", async () => {
    const result = await searchArchive({ q: "Sofa Sound" });

    expect(result.kind).toBe("entity");
    expect(result.redirect).toBe("/label/sofa-sound");
    expect(result.entities.map((entity) => entity.slug)).toEqual(["sofa-sound"]);
    // The three uncertified rows list under it, exactly as the hub would show them.
    expect(result.results.map((hit) => hit.trackId).sort()).toEqual(["sofa-1", "sofa-2", "sofa-3"]);
  });

  it("does NOT offer a below-floor label — it stays the filter chip it always was", async () => {
    const result = await searchArchive({ q: "Lone Imprint" });

    expect(result.entities).toEqual([]);
    expect(result.redirect).toBeUndefined();
    expect(result.filters).toEqual({ label: "Lone Imprint" });
  });
});

// ── The compound sonic tier · sound like several artists ─────────────────────────────

// `soundsLikeArtists` — the compound query "songs by artists that sound like Koven and Maduk in A
// minor". The server resolves each name/slug to an artist, averages their stored `artist_centroids`
// into ONE probe, ranks TRACKS by it, and every OTHER filter is the btree pre-filter in FRONT of the
// scan. Anchored on real centroids: an unresolved name does not weigh in, and a probe of nothing
// declines. The LLM only ever EMITS the filter — a hand-built one works with the model down.
describe("the compound sonic tier — sound like several artists", () => {
  beforeEach(async () => {
    // Two artists with stored centroids. Koven sits at 0.05 (nearest 1991@0.0, then netsky@0.1);
    // Maduk sits at 1.15 (near andromedik@1.2). The centroid is the artist's position in MuQ space.
    for (const artist of [
      { angle: 0.05, id: "a-koven", name: "Koven", slug: "koven" },
      { angle: 1.15, id: "a-maduk", name: "Maduk", slug: "maduk" },
    ]) {
      await db.execute({
        args: [artist.id, artist.name, artist.slug],
        sql: `insert into artists (id, name, slug, created_at, updated_at)
              values (?, ?, ?, '2026-07-01', '2026-07-01')`,
      });
      const vector = angleVector(artist.angle);

      await db.execute({
        args: [artist.id, new Uint8Array(vector.buffer)],
        sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
              values (?, ?, '2026-07-01', 'corpus-1', 4)`,
      });
    }
  });

  it("ranks tracks by the artist's centroid, echoes the resolved name, and carries no anchor", async () => {
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["Koven"] });

    const result = await searchArchive({ q: "songs by artists that sound like Koven" });

    expect(result.kind).toBe("sonic");
    expect(result.anchor).toBeUndefined();
    // Pure distance to Koven's centroid (0.05): 1991 (0.0) → netsky (0.1) → uncertified (0.3) →
    // andromedik (1.2). Every embedded track ranks; none is excluded (there is no anchor track).
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-1991",
      "certified-netsky",
      "uncertified-netsky",
      "certified-andromedik",
    ]);
    // The transparency echo is the RESOLVED name, so the reader sees what the vibe was built from.
    expect(result.filters?.soundsLikeArtists).toEqual(["Koven"]);
  });

  it("resolves a SLUG too, and averages several artists into one probe (equal weight each)", async () => {
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["koven", "Maduk"] });

    const result = await searchArchive({ q: "acts like koven and Maduk" });

    expect(result.kind).toBe("sonic");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.filters?.soundsLikeArtists).toEqual(["Koven", "Maduk"]);
  });

  it("applies every other filter as a btree pre-filter BEFORE the vector scan (one pass)", async () => {
    translateQuery.mockResolvedValue({ key: "A minor", soundsLikeArtists: ["Koven"] });
    const spy = vi.spyOn(db, "execute");

    const result = await searchArchive({ q: "artists that sound like Koven in A minor" });

    // Only the A-minor tracks survive the pre-filter, still ordered by distance to Koven's centroid:
    // certified-netsky (0.1) then uncertified-netsky (0.3). andromedik/1991 are filtered out by key.
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);

    // Pin the ratified SQL SHAPE: one exact vector pass, the btree pre-filter in the SAME statement,
    // ordered by distance — never a union-all fan-out (the CTE-flattening trap), never an ANN index.
    const scan = spy.mock.calls
      .map((call) => call[0])
      .find(
        (arg) =>
          typeof arg === "object" &&
          arg !== null &&
          typeof (arg as { sql?: unknown }).sql === "string" &&
          (arg as { sql: string }).sql.includes("vector_distance_cos"),
      ) as { sql: string } | undefined;

    expect(scan).toBeDefined();
    const sql = scan?.sql ?? "";

    expect(sql).toContain("vector_distance_cos(tracks.embedding_blob, ?)");
    expect(sql).toContain("lower(tracks.key) in"); // the btree pre-filter, in the same statement
    expect(sql).toContain("order by dist asc");
    expect(sql).not.toContain("union all"); // one pass, no fan-out
    expect((sql.match(/vector_distance_cos/g) ?? []).length).toBe(1);

    spy.mockRestore();
  });

  it("DECLINES when no named artist resolves to a centroid — never invents a vibe", async () => {
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["Nobody At All"] });

    const result = await searchArchive({ q: "artists that sound like Nobody At All" });

    // The probe is nothing, so the compound tier declines and the query falls through — never a
    // sonic result built from an artist that does not exist.
    expect(result.kind).not.toBe("sonic");
  });
});

// ── THE DEGRADATION ──────────────────────────────────────────────────────────────────

describe("the LLM is down — search degrades, it never breaks", () => {
  it("falls back to full text when the model cannot be reached", async () => {
    // What `translateQuery` returns when the key is missing, the vendor 500s, or the 3s
    // deadline blows: null. Every failure mode collapses to this one answer.
    translateQuery.mockResolvedValue(null);

    const result = await searchArchive({ q: "Andromedik tracks in A minor" });

    expect(result.degraded).toBe(true);
    expect(result.kind).toBe("token");
    // bm25 ranks by rarity: "andromedik" is the one distinctive word in that sentence, so it
    // carries the query. A worse answer than the filters would have given — and a far better
    // one than an empty page.
    expect(result.results[0]?.trackId).toBe("certified-andromedik");
  });

  // The sonic tier is DELIBERATELY not among the casualties: it is a regex, so a vendor
  // outage cannot take the one feature nobody else has offline.
  it("keeps SONIC search fully working with the model down", async () => {
    translateQuery.mockResolvedValue(null);

    const result = await searchArchive({ q: "tracks that sound like Nine Clouds" });

    expect(result.kind).toBe("sonic");
    expect(result.degraded).toBe(false);
    expect(result.anchor?.trackId).toBe("certified-1991");
  });

  it("keeps every deterministic tier working with no model at all", async () => {
    translateQuery.mockRejectedValue(new Error("vendor is on fire"));

    expect((await searchArchive({ q: "024.7.2R" })).redirect).toBe("/log/024.7.2R");
    expect((await searchArchive({ q: "Netsky" })).redirect).toBe("/artist/netsky");
    expect((await searchArchive({ q: "clouds" })).results).toHaveLength(1);
    expect((await searchArchive({ q: "sounds like Nine Clouds" })).kind).toBe("sonic");
  });
});
