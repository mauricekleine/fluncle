import { type Client, createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { LONG_FORM_MS } from "../catalogue-eligibility";
import { linkTrackToAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { createIntegrationDb } from "./integration-db";
import { resetKeyHistogramCache } from "./key-histogram";
import { linkTrackToLabel } from "./labels";
import {
  compileFilters,
  type EntityMatchMode,
  entityMatchStatement,
  labelNameProbeStatement,
  resolveFilterEntities,
  searchArchive as searchArchiveLive,
  searchLikeTrack,
} from "./search";
import { SEARCH_STYLES } from "../search-styles";
import { resetStyleProbeCache } from "./style-probe";

const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

let db: Client;
let fixtureDirectory: string | undefined;
let fixtureClient: Client | undefined;
let templateDirectory: string | undefined;

async function copyFixture(path: string): Promise<Client> {
  if (!templateDirectory) {
    throw new Error("Search fixture template is not initialized");
  }
  await copyFile(join(templateDirectory, "template.db"), path);
  return createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: `file:${path}` });
}

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => db };
});

function searchArchive(options: { beforeVector?: () => Promise<void>; limit?: number; q: string }) {
  return searchArchiveLive({ ...options, allowBoundedSonicForDiagnostics: true });
}

const DIMS = 1024;

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
      embedding ? 1 : 0,
    ],
    sql: `insert into tracks
      (track_id, title, artists_json, album, label, key, bpm, release_date, spotify_url,
       duration_ms, has_embedding)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  if (embedding) {
    await client.execute({
      args: [track.trackId, new Uint8Array(embedding.buffer)],
      sql: `insert into track_embeddings (track_id, embedding_blob) values (?, ?)`,
    });
  }

  if (track.logId !== undefined) {
    await client.execute({
      args: [track.trackId, track.logId, "2026-07-01T00:00:00.000Z"],
      sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
    });
    await client.execute({
      args: [track.trackId],
      sql: `update tracks set is_catalogue = 0 where track_id = ?`,
    });
  }

  await linkTrackToLabel(track.trackId, track.label);
  await linkTrackToAlbum(track.trackId, track.album);
}

beforeAll(async () => {
  templateDirectory = await mkdtemp(join(tmpdir(), "fluncle-search-template-"));
  db = await createIntegrationDb({ url: `file:${join(templateDirectory, "template.db")}` });
  try {
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
    const checkpoint = await db.execute("pragma wal_checkpoint(TRUNCATE)");
    if (Number(checkpoint.rows[0]?.busy) !== 0) {
      throw new Error("Search fixture template WAL checkpoint is busy");
    }
  } finally {
    db.close();
  }
}, 20_000);

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-search-"));
  fixtureClient = await copyFixture(join(fixtureDirectory, "fixture.db"));
  db = fixtureClient;
  resetKeyHistogramCache();
  translateQuery.mockReset();
  translateQuery.mockResolvedValue(null);
});

afterEach(async () => {
  fixtureClient?.close();
  fixtureClient = undefined;

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

afterAll(async () => {
  if (templateDirectory) {
    await rm(templateDirectory, { force: true, recursive: true });
    templateDirectory = undefined;
  }
});

describe("the FTS5 index", () => {
  it("isolates copied rows and FTS triggers from other fixtures and the template", async () => {
    if (!fixtureDirectory) {
      throw new Error("Search fixture directory is not initialized");
    }
    await db.execute("update tracks set title = 'Changed' where track_id = 'certified-1991'");
    const other = await copyFixture(join(fixtureDirectory, "other.db"));
    try {
      const unchanged = await other.execute(
        "select track_id from tracks_fts where tracks_fts match 'nine'",
      );
      expect(unchanged.rows.map((row) => row.track_id)).toEqual(["certified-1991"]);
      await other.execute("delete from tracks where track_id = 'certified-1991'");
      const changed = await db.execute(
        "select track_id from tracks_fts where tracks_fts match 'changed'",
      );
      expect(changed.rows.map((row) => row.track_id)).toEqual(["certified-1991"]);
    } finally {
      other.close();
    }
  });

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
    expect(result.results[0]).toMatchObject({ durationMs: 180000, previewable: false });
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

describe("tier 1½ — a pasted Spotify link", () => {
  const NINE_CLOUDS_ID = "1A2b3C4d5E6f7G8h9I0jKl";

  beforeEach(async () => {
    await db.execute({
      args: [`spotify:track:${NINE_CLOUDS_ID}`, "certified-1991"],
      sql: `update tracks set spotify_uri = ? where track_id = ?`,
    });
  });

  it("resolves the URL form to the anchored track — locally, with no model call", async () => {
    const result = await searchArchive({ q: `https://open.spotify.com/track/${NINE_CLOUDS_ID}` });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-1991"]);
    expect(result.results[0]?.certified).toBe(true);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("tolerates the share sheet's query string", async () => {
    const result = await searchArchive({
      q: `https://open.spotify.com/track/${NINE_CLOUDS_ID}?si=AbCdEf123`,
    });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-1991"]);
  });

  it("tolerates an intl path segment — the app localises the share URL", async () => {
    const result = await searchArchive({
      q: `https://open.spotify.com/intl-de/track/${NINE_CLOUDS_ID}`,
    });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-1991"]);
  });

  it("resolves the bare spotify:track: URI form", async () => {
    const result = await searchArchive({ q: `spotify:track:${NINE_CLOUDS_ID}` });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-1991"]);
  });

  it("falls through on an id the archive does not hold — an honest miss, never an error", async () => {
    const result = await searchArchive({
      q: "https://open.spotify.com/track/0000000000000000000000",
    });

    expect(result.results).toEqual([]);
  });

  it("carries the catalogue rule — an uncertified anchor resolves unlit, with no coordinate", async () => {
    await db.execute({
      args: ["spotify:track:9Z8y7X6w5V4u3T2s1R0qPo", "uncertified-netsky"],
      sql: `update tracks set spotify_uri = ? where track_id = ?`,
    });

    const result = await searchArchive({ q: "spotify:track:9Z8y7X6w5V4u3T2s1R0qPo" });

    expect(result.results.map((hit) => hit.trackId)).toEqual(["uncertified-netsky"]);
    expect(result.results[0]?.certified).toBe(false);
    expect(result.results[0]?.logId).toBeUndefined();
  });
});

describe("public search duration boundary", () => {
  it("hides a long catalogue recording from text, filters, links, and sonic seeds while retaining a long finding", async () => {
    const hiddenUri = "spotify:track:9Z8y7X6w5V4u3T2s1R0qPo";
    await db.execute({
      args: [LONG_FORM_MS, hiddenUri, "uncertified-netsky"],
      sql: "update tracks set duration_ms = ?, spotify_uri = ? where track_id = ?",
    });
    await db.execute({
      args: [LONG_FORM_MS, "certified-1991"],
      sql: "update tracks set duration_ms = ? where track_id = ?",
    });

    expect((await searchArchive({ q: "Rio" })).results).toEqual([]);
    expect((await searchArchive({ q: hiddenUri })).results).toEqual([]);
    expect((await searchArchive({ q: "Netsky" })).results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
    ]);
    expect(await searchLikeTrack({ trackId: "uncertified-netsky" })).toBeNull();
    expect((await searchArchive({ q: "024.7.2R" })).results[0]?.trackId).toBe("certified-1991");
    expect((await searchArchive({ q: "clouds" })).results[0]?.trackId).toBe("certified-1991");
  });
});

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

describe("aliases — an artist answers to every name", () => {
  beforeEach(async () => {
    await db.execute({
      args: [],
      sql: `insert into artists (id, name, slug, created_at, updated_at)
            values ('a2', 'Origin', 'origin', '2026-07-01', '2026-07-01')`,
    });

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
    expect(byAlias.results.map((hit) => hit.trackId)).toEqual(byName.results.map((h) => h.trackId));
    expect(byAlias.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("trusts BOTH an `auto` (MusicBrainz) and a `confirmed` (operator) alias", async () => {
    expect((await searchArchive({ q: "Boris Daenen" })).redirect).toBe("/artist/netsky");
    expect((await searchArchive({ q: "Netsky Live" })).redirect).toBe("/artist/netsky");
  });

  it("prefix-matches an alias as a tier-3 jump target, exactly as it does the name", async () => {
    const result = await searchArchive({ q: "boris" });

    expect(result.kind).toBe("token");
    expect(result.entities).toEqual([{ kind: "artist", name: "Netsky", slug: "netsky" }]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("lets the PRIMARY name win a tie against another artist's alias", async () => {
    const result = await searchArchive({ q: "Origin" });

    expect(result.redirect).toBe("/artist/origin");
    expect(result.entities).toEqual([{ kind: "artist", name: "Origin", slug: "origin" }]);
  });

  it("does NOT resolve a `hint` alias — a weak lead is never a public answer", async () => {
    const result = await searchArchive({ q: "Phantom Hint" });

    expect(result.redirect).toBeUndefined();
    expect(result.entities).toEqual([]);
    expect(result.kind).not.toBe("entity");
  });
});

describe("aliases — a label answers to every spelling the operator ruled", () => {
  async function labelId(slug: string): Promise<string> {
    const rows = await db.execute({ args: [slug], sql: `select id from labels where slug = ?` });
    const id = rows.rows[0]?.id;

    if (typeof id !== "string") {
      throw new Error(`fixture: no labels row for ${slug}`);
    }

    return id;
  }

  async function addAlias(
    label: string,
    [id, alias, slug, source, kind, status]: [string, string, string, string, string, string],
  ): Promise<void> {
    await db.execute({
      args: [id, await labelId(label), alias, slug, source, kind, status],
      sql: `insert into label_aliases
              (id, label_id, alias, alias_slug, source, kind, status, created_at)
            values (?, ?, ?, ?, ?, ?, ?, '2026-07-01')`,
    });
  }

  async function compiledSql(filters: Parameters<typeof compileFilters>[0]): Promise<string> {
    const clauses = compileFilters(filters, await resolveFilterEntities(filters));

    return clauses.map((clause) => clause.sql).join(" and ");
  }

  beforeEach(async () => {
    await db.execute({
      args: [],
      sql: `insert into labels (id, name, slug, created_at, updated_at)
            values ('l-crawled', 'Crawled Imprint', 'crawled-imprint', '2026-07-01', '2026-07-01')`,
    });

    await addAlias("hospital-records", [
      "la1",
      "Med School",
      "med-school",
      "operator",
      "name",
      "confirmed",
    ]);
    await addAlias("hospital-records", [
      "la2",
      "Hospitality Sound",
      "hospitality-sound",
      "musicbrainz",
      "hint",
      "confirmed",
    ]);
    await addAlias("hospital-records", [
      "la3",
      "Andromedik",
      "andromedik",
      "operator",
      "name",
      "confirmed",
    ]);
    await addAlias("1991", [
      "la4",
      "Nineteen Ninety One",
      "nineteen-ninety-one",
      "apple",
      "name",
      "candidate",
    ]);
    await db.execute({
      args: [],
      sql: `insert into label_aliases
              (id, label_id, alias, alias_slug, source, kind, status, created_at)
            values ('la5', 'l-crawled', 'Walked Past Records', 'walked-past-records',
                    'operator', 'name', 'confirmed', '2026-07-01')`,
    });
  });

  it("resolves an EXACT confirmed alias to the label page — with the tracks the name gives", async () => {
    const byName = await searchArchive({ q: "Hospital Records" });
    const byAlias = await searchArchive({ q: "Med School" });

    expect(byAlias.kind).toBe("entity");
    expect(byAlias.redirect).toBe("/label/hospital-records");
    expect(byAlias.entities).toEqual([
      { kind: "label", name: "Hospital Records", slug: "hospital-records" },
    ]);
    expect(byAlias.results.map((hit) => hit.trackId)).toEqual(byName.results.map((h) => h.trackId));
    expect(byAlias.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("prefix-matches a confirmed alias as a tier-3 jump target, exactly as it does the name", async () => {
    const result = await searchArchive({ q: "med" });

    expect(result.kind).toBe("token");
    expect(result.entities).toEqual([
      { kind: "label", name: "Hospital Records", slug: "hospital-records" },
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("lets the PRIMARY name win a tie against another label's alias", async () => {
    const result = await searchArchive({ q: "Andromedik" });

    expect(result.redirect).toBe("/label/andromedik");
    expect(result.entities).toEqual([{ kind: "label", name: "Andromedik", slug: "andromedik" }]);
  });

  it("does NOT resolve a `candidate` alias — an unruled guess is never a public answer", async () => {
    const result = await searchArchive({ q: "Nineteen Ninety One" });

    expect(result.redirect).toBeUndefined();
    expect(result.entities).toEqual([]);
    expect(result.kind).not.toBe("entity");
  });

  it("does NOT resolve a `hint` alias, however it is ruled — a weak lead is never an answer", async () => {
    const result = await searchArchive({ q: "Hospitality Sound" });

    expect(result.redirect).toBeUndefined();
    expect(result.entities).toEqual([]);
  });

  it("does NOT resurrect a below-floor label through its alias — the hub gate outranks the fold", async () => {
    const byName = await searchArchive({ q: "Crawled Imprint" });
    const byAlias = await searchArchive({ q: "Walked Past Records" });

    expect(byName.entities).toEqual([]);
    expect(byAlias.entities).toEqual([]);
    expect(byAlias.redirect).toBeUndefined();
  });

  it("leaves the ALBUM read alone — an album has no alias table to fold through", async () => {
    const result = await searchArchive({ q: "second nature" });

    expect(result.redirect).toBe("/album/second-nature");
  });

  it("folds a confirmed alias in the FILTER path, straight to the indexed pointer", async () => {
    expect(await resolveFilterEntities({ label: "Med School" })).toEqual(
      await resolveFilterEntities({ label: "Hospital Records" }),
    );
    expect(await compiledSql({ label: "Med School" })).toBe("tracks.label_id = ?");

    translateQuery.mockResolvedValue({ label: "Med School" });

    const result = await searchArchive({ q: "anything on Med School" });

    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("folds punctuation on the way to the alias too — one question, however it is typed", async () => {
    expect(await resolveFilterEntities({ label: "med-school!" })).toEqual(
      await resolveFilterEntities({ label: "Hospital Records" }),
    );
  });

  it("refuses a `candidate` alias in the filter path — the raw-string fallback stands", async () => {
    expect(await resolveFilterEntities({ label: "Nineteen Ninety One" })).toEqual({});
    expect(await compiledSql({ label: "Nineteen Ninety One" })).toBe("lower(tracks.label) = ?");
  });

  it("holds the count guard on the alias path — a below-floor label resolves no id", async () => {
    expect(await resolveFilterEntities({ label: "Walked Past Records" })).toEqual({});
    expect(await compiledSql({ label: "Walked Past Records" })).toBe("lower(tracks.label) = ?");
  });
});

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
    const andro = await searchArchive({ q: "andro" });

    expect(andro.entities.map((entity) => entity.kind)).toEqual(["label"]);
    expect(andro.entities[0]?.slug).toBe("andromedik");

    const nets = await searchArchive({ q: "net" });

    expect(nets.entities[0]?.kind).toBe("artist");
  });
});

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
    translateQuery.mockResolvedValue({ artist: "Andromedik", key: "A minor" });

    const result = await searchArchive({ q: "Andromedik tracks in A minor" });

    expect(result.kind).toBe("filters");
    expect(result.results).toEqual([]);
    expect(result.degraded).toBe(false);
  });
});

describe("the name filters resolve to indexed ids (and fall back when they cannot)", () => {
  async function seedArtistEntities(
    entities: { name: string; slug: string }[],
    trackIds: string[],
  ): Promise<void> {
    for (const [index, entity] of entities.entries()) {
      await db.execute({
        args: [`ax${index}`, entity.name, entity.slug],
        sql: `insert into artists (id, name, slug, created_at, updated_at)
              values (?, ?, ?, '2026-07-01', '2026-07-01')`,
      });
    }

    await linkTracksToArtistEntities(trackIds);
  }

  async function compiledSql(filters: Parameters<typeof compileFilters>[0]): Promise<string> {
    const clauses = compileFilters(filters, await resolveFilterEntities(filters));

    return clauses.map((clause) => clause.sql).join(" and ");
  }

  it("seeks the artist EDGE, and returns exactly what the substring scan returned", async () => {
    const beforeSql = await compiledSql({ artist: "Netsky" });
    const before = await searchArchive({ q: "Netsky" });

    expect(beforeSql).toContain("lower(tracks.artists_json) like");

    await seedArtistEntities([], ["certified-netsky", "uncertified-netsky"]);

    const afterSql = await compiledSql({ artist: "Netsky" });
    const after = await searchArchive({ q: "Netsky" });

    expect(afterSql).toBe(
      `tracks.track_id in (select track_id from track_artists where artist_id = ?)`,
    );
    expect(after.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
    expect(after.results.map((hit) => hit.trackId)).toEqual(
      before.results.map((hit) => hit.trackId),
    );
  });

  it("finds a track that credits the artist SECOND — an edge is not a lead credit", async () => {
    await seedArtistEntities([{ name: "Lexurus", slug: "lexurus" }], ["certified-andromedik"]);
    translateQuery.mockResolvedValue({ artist: "Lexurus" });

    const result = await searchArchive({ q: "Lexurus tracks" });

    expect(await compiledSql({ artist: "Lexurus" })).toContain("track_artists");
    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-andromedik"]);
  });

  it("KEEPS the substring scan for a name Fluncle holds no artist entity for", async () => {
    translateQuery.mockResolvedValue({ artist: "Bev Lee Harling" });

    const result = await searchArchive({ q: "Bev Lee Harling tracks" });

    expect(await resolveFilterEntities({ artist: "Bev Lee Harling" })).toEqual({});
    expect(await compiledSql({ artist: "Bev Lee Harling" })).toContain(
      "lower(tracks.artists_json) like",
    );
    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-netsky"]);
  });

  it("keeps the substring scan for an artist with no edges", async () => {
    expect(await resolveFilterEntities({ artist: "Netsky" })).toEqual({});

    const result = await searchArchive({ q: "Netsky" });

    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("resolves a trusted AKA to the same artist the primary name resolves to", async () => {
    await seedArtistEntities([{ name: "Lexurus", slug: "lexurus" }], ["certified-andromedik"]);
    await db.execute({
      args: [],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, source, kind, status, created_at)
            values ('aka-lex', 'ax0', 'Lex', 'lex', 'musicbrainz', 'name', 'auto', '2026-07-01')`,
    });

    const byAlias = await resolveFilterEntities({ artist: "Lex" });

    expect(byAlias).toEqual(await resolveFilterEntities({ artist: "Lexurus" }));
    expect(byAlias).toEqual({ artistId: "ax0" });
  });

  it("lets a PRIMARY name outrank another artist's AKA for the same spelling", async () => {
    await seedArtistEntities(
      [
        { name: "Lexurus", slug: "lexurus" },
        { name: "Andromedik", slug: "andromedik" },
      ],
      ["certified-andromedik"],
    );
    await db.execute({
      args: [],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, source, kind, status, created_at)
            values ('aka-clash', 'ax1', 'Lexurus', 'lexurus', 'musicbrainz', 'name', 'auto', '2026-07-01')`,
    });

    expect(await resolveFilterEntities({ artist: "Lexurus" })).toEqual({ artistId: "ax0" });
  });

  it("holds the count guard on the AKA rank — an edgeless artist resolves no id", async () => {
    await db.execute({
      args: [],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, source, kind, status, created_at)
            values ('aka-edgeless', 'a1', 'Boy Wonder', 'boy-wonder', 'musicbrainz', 'name', 'auto', '2026-07-01')`,
    });

    expect(await resolveFilterEntities({ artist: "Boy Wonder" })).toEqual({});
    expect(await compiledSql({ artist: "Boy Wonder" })).toContain(
      "lower(tracks.artists_json) like",
    );
  });

  it("reads the GRAPH on the model's tier too — the emitted name is resolved, not scanned", async () => {
    await seedArtistEntities([], ["certified-netsky", "uncertified-netsky"]);
    await db.execute({
      args: ["uncertified-netsky"],
      sql: `delete from track_artists where track_id = ?`,
    });
    translateQuery.mockResolvedValue({ artist: "Netsky" });

    const result = await searchArchive({ q: "netsky tunes please" });

    expect(result.kind).toBe("filters");
    expect(result.results.map((hit) => hit.trackId)).toEqual(["certified-netsky"]);
  });

  it("narrows the SONIC pre-filter by the same edge — one pass, before any vector is touched", async () => {
    await seedArtistEntities([], ["certified-netsky", "uncertified-netsky"]);
    translateQuery.mockResolvedValue({ artist: "Netsky", soundsLike: "Nine Clouds" });

    const result = await searchArchive({ q: "like Nine Clouds but Netsky" });

    expect(result.kind).toBe("sonic");
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("filters the LABEL by its indexed pointer, with the same rows the string gave", async () => {
    translateQuery.mockResolvedValue({ label: "Hospital Records" });

    const result = await searchArchive({ q: "anything on Hospital Records" });

    expect(await compiledSql({ label: "Hospital Records" })).toBe("tracks.label_id = ?");
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("folds punctuation on the way to the label id — one question, however it is typed", async () => {
    expect(await resolveFilterEntities({ label: "Hospital-Records!" })).toEqual(
      await resolveFilterEntities({ label: "hospital records" }),
    );
  });

  it("filters the ALBUM by its indexed pointer", async () => {
    translateQuery.mockResolvedValue({ album: "Second Nature" });

    const result = await searchArchive({ q: "the record called Second Nature" });

    expect(await compiledSql({ album: "Second Nature" })).toBe("tracks.album_id = ?");
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });

  it("keeps the raw-string compare for an imprint with nothing pointing at it", async () => {
    await db.execute({
      args: [],
      sql: `insert into labels (id, name, slug, created_at, updated_at)
            values ('l-stub', 'Walked Past', 'walked-past', '2026-07-01', '2026-07-01')`,
    });

    expect(await resolveFilterEntities({ label: "Walked Past" })).toEqual({});
    expect(await compiledSql({ label: "Walked Past" })).toBe("lower(tracks.label) = ?");
  });

  it("compares the KEY column bare, against the spellings the archive stores", async () => {
    const sql = await compiledSql({ key: "a minor" });

    expect(sql).not.toContain("lower(");
    expect(sql).toContain("tracks.key in (");

    translateQuery.mockResolvedValue({ key: "a minor" });

    const result = await searchArchive({ q: "anything in a MINOR" });

    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);
  });
});

describe("the sonic tier — anchored on a real track, ranked in SQL", () => {
  it("answers a sonic phrase WITHOUT a model — the headline query has no vendor dependency", async () => {
    const result = await searchArchive({ q: "tracks that sound like Nine Clouds" });

    expect(result.kind).toBe("sonic");
    expect(translateQuery).not.toHaveBeenCalled();
    expect(result.anchor?.trackId).toBe("certified-1991");
    expect(result.anchor?.logId).toBe("024.7.2R");
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

describe("tier 2 — a galaxy and a mixtape are jump nodes", () => {
  beforeEach(async () => {
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
    expect(result.results).toEqual([]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("never resolves a retired or an unnamed galaxy", async () => {
    expect((await searchArchive({ q: "Faded Sector" })).entities).toEqual([]);
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

describe("the entity reads — index-served, and exactly the lower() compare they replace", () => {
  function referenceStatement(
    kind: "album" | "artist" | "label",
    query: string,
    mode: EntityMatchMode,
  ) {
    const needle = query.trim().toLowerCase();
    const predicate = mode === "exact" ? "= ?" : "like ? || '%'";

    if (kind === "album") {
      return {
        args: [needle, 3, 10],
        sql: `select albums.name as name, albums.slug as slug
              from albums not indexed
              where (lower(albums.name) ${predicate})
                and (albums.certified_finding_count > 0 or albums.renderable_track_count >= ?)
              order by length(albums.name) asc, albums.name asc
              limit ?`,
      };
    }

    if (kind === "artist") {
      return {
        args: [needle, needle, needle, 10],
        sql: `select artists.name as name, artists.slug as slug,
                case when lower(artists.name) ${predicate} then 0 else 1 end as name_rank
              from artists not indexed
              where lower(artists.name) ${predicate}
                 or exists (select 1 from artist_aliases
                            where artist_aliases.artist_id = artists.id
                              and artist_aliases.kind = 'name'
                              and artist_aliases.status in ('auto', 'confirmed')
                              and lower(artist_aliases.alias) ${predicate})
              order by name_rank asc, length(artists.name) asc, artists.name asc
              limit ?`,
      };
    }

    return {
      args: [needle, needle, needle, 3, 10],
      sql: `select labels.name as name, labels.slug as slug,
              case when lower(labels.name) ${predicate} then 0 else 1 end as name_rank
            from labels not indexed
            where (lower(labels.name) ${predicate}
                   or exists (select 1 from label_aliases
                              where label_aliases.label_id = labels.id
                                and label_aliases.kind = 'name'
                                and label_aliases.status = 'confirmed'
                                and lower(label_aliases.alias) ${predicate}))
              and (labels.certified_finding_count > 0 or labels.renderable_track_count >= ?)
            order by name_rank asc, length(labels.name) asc, labels.name asc
            limit ?`,
    };
  }

  function rowsOf(result: { rows: unknown[] }): { name: string; slug: string }[] {
    return (result.rows as unknown as { name: string; slug: string }[]).map((row) => ({
      name: row.name,
      slug: row.slug,
    }));
  }

  async function planRows(statement: { args: (number | string)[]; sql: string } | undefined) {
    if (!statement) {
      throw new Error("expected a statement for a non-blank query");
    }

    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });

    return (plan.rows as unknown as { detail: string; id: number; parent: number }[]).map(
      (row) => ({
        detail: String(row.detail),
        id: Number(row.id),
        parent: Number(row.parent),
      }),
    );
  }

  beforeEach(async () => {
    const now = "2026-07-01";
    const artists: [string, string, string][] = [
      ["a2", "Origin", "origin"],
      ["a3", "NETSKY TWO", "netsky-two"],
      ["a4", "Net_Sky", "net-sky"],
      ["a5", "Net%Work", "net-work"],
      ["a6", "Ëlectron", "electron"],
      ["a7", "ëlectron dub", "electron-dub"],
    ];

    for (const [id, name, slug] of artists) {
      await db.execute({
        args: [id, name, slug, now, now],
        sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      });
    }

    const artistAliases: [string, string, string, string, string][] = [
      ["aa1", "a1", "Boris Daenen", "name", "auto"],
      ["aa2", "a1", "Origin", "name", "auto"],
      ["aa3", "a1", "Netsky Hint", "hint", "auto"],
      ["aa4", "a6", "Electron", "name", "confirmed"],
    ];

    for (const [id, artistId, alias, kind, status] of artistAliases) {
      await db.execute({
        args: [id, artistId, alias, alias.toLowerCase().replaceAll(" ", "-"), kind, status, now],
        sql: `insert into artist_aliases
                (id, artist_id, alias, alias_slug, source, kind, status, created_at)
              values (?, ?, ?, ?, 'musicbrainz', ?, ?, ?)`,
      });
    }

    const hospital = await db.execute(`select id from labels where slug = 'hospital-records'`);
    const hospitalId = hospital.rows[0]?.id;

    if (typeof hospitalId !== "string") {
      throw new Error("fixture: no labels row for hospital-records");
    }

    await db.execute({
      args: [now, now],
      sql: `insert into labels (id, name, slug, created_at, updated_at)
            values ('l-crawled', 'Crawled Imprint', 'crawled-imprint', ?, ?)`,
    });

    const labelAliases: [string, string, string, string, string][] = [
      ["la1", hospitalId, "Med School", "name", "confirmed"],
      ["la2", hospitalId, "Andromedik", "name", "confirmed"],
      ["la3", hospitalId, "Hospitality Sound", "name", "candidate"],
      ["la4", "l-crawled", "Walked Past Records", "name", "confirmed"],
    ];

    for (const [id, labelId, alias, kind, status] of labelAliases) {
      await db.execute({
        args: [id, labelId, alias, alias.toLowerCase().replaceAll(" ", "-"), kind, status, now],
        sql: `insert into label_aliases
                (id, label_id, alias, alias_slug, source, kind, status, created_at)
              values (?, ?, ?, ?, 'operator', ?, ?, ?)`,
      });
    }

    const albums: [string, string, string, number, number][] = [
      ["al1", "Dub Plate", "dub-plate-b", 3, 0],
      ["al2", "Dub Plate", "dub-plate-a", 4, 0],
      ["al3", "DUB PLATE", "dub-plate-c", 0, 1],
      ["al4", "Net_Sky Sessions", "net-sky-sessions", 3, 0],
      ["al5", "Net%Work Dub", "net-work-dub", 5, 0],
      ["al6", "Ëlectron", "electron-album", 3, 0],
      ["al7", "ëlectron dub", "electron-dub-album", 3, 0],
      ["al8", "Thin Record", "thin-record", 1, 0],
    ];

    for (const [id, name, slug, renderable, certified] of albums) {
      await db.execute({
        args: [id, name, slug, now, now, renderable, certified],
        sql: `insert into albums
                (id, name, slug, created_at, updated_at, renderable_track_count,
                 certified_finding_count)
              values (?, ?, ?, ?, ?, ?, ?)`,
      });
    }

    const moreLabels: [string, string, string, number][] = [
      ["l-shout", "HOSPITAL RECORDS", "hospital-records-shout", 0],
      ["l-dub-b", "Dub Imprint", "dub-imprint-b", 3],
      ["l-dub-a", "Dub Imprint", "dub-imprint-a", 3],
    ];

    for (const [id, name, slug, renderable] of moreLabels) {
      await db.execute({
        args: [id, name, slug, now, now, renderable],
        sql: `insert into labels (id, name, slug, created_at, updated_at, renderable_track_count)
              values (?, ?, ?, ?, ?, ?)`,
      });
    }
  });

  const NEEDLES = [
    "Netsky",
    "NETSKY",
    "nets",
    "net_",
    "net%",
    "n",
    "boris",
    "Boris Daenen",
    "origin",
    "netsky hint",
    "ëlectron",
    "ËLECTRON",
    "electron",
    "hospital",
    "Hospital Records",
    "med",
    "andromedik",
    "hospitality",
    "1991",
    "walked",
    "crawled",
    "dub plate",
    "dub imprint",
    "DUB",
    "dub p",
    "thin record",
    "ëlectron dub",
    "second nature",
    "zzz",
  ];

  it("answers exactly what the lower() + correlated-exists reference answers", async () => {
    for (const kind of ["album", "artist", "label"] as const) {
      for (const mode of ["exact", "prefix"] as const) {
        for (const needle of NEEDLES) {
          const statement = entityMatchStatement(kind, needle, mode, 10);

          if (!statement) {
            throw new Error(`expected a statement for ${needle}`);
          }

          const expected = rowsOf(await db.execute(referenceStatement(kind, needle, mode)));
          const actual = rowsOf(await db.execute(statement));

          expect({ kind, mode, needle, rows: actual }).toEqual({
            kind,
            mode,
            needle,
            rows: expected,
          });
        }
      }
    }

    expect(rowsOf(await db.execute(referenceStatement("artist", "net_", "prefix")))).toEqual([
      { name: "Netsky", slug: "netsky" },
      { name: "Net_Sky", slug: "net-sky" },
      { name: "Net%Work", slug: "net-work" },
      { name: "NETSKY TWO", slug: "netsky-two" },
    ]);
    expect(rowsOf(await db.execute(referenceStatement("label", "med", "prefix")))).toEqual([
      { name: "Hospital Records", slug: "hospital-records" },
    ]);
    expect(rowsOf(await db.execute(referenceStatement("label", "dub imprint", "exact")))).toEqual([
      { name: "Dub Imprint", slug: "dub-imprint-b" },
      { name: "Dub Imprint", slug: "dub-imprint-a" },
    ]);
    expect(rowsOf(await db.execute(referenceStatement("album", "dub plate", "exact")))).toEqual([
      { name: "DUB PLATE", slug: "dub-plate-c" },
      { name: "Dub Plate", slug: "dub-plate-b" },
      { name: "Dub Plate", slug: "dub-plate-a" },
    ]);
  });

  it("probes an exact label name exactly as the lower() compare did, and lands on the same row", async () => {
    for (const query of NEEDLES) {
      const needle = query.trim().toLowerCase();
      const expected = await db.execute({
        args: [needle],
        sql: `select name from labels not indexed where lower(name) = ? limit 1`,
      });
      const actual = await db.execute(labelNameProbeStatement(needle));

      expect({ needle, rows: actual.rows.map((row) => row.name) }).toEqual({
        needle,
        rows: expected.rows.map((row) => row.name),
      });
    }

    const shouted = await db.execute(labelNameProbeStatement("hospital records"));

    expect(shouted.rows.map((row) => row.name)).toEqual(["Hospital Records"]);
  });

  it("serves the album name through albums_name_nocase_idx: a seek for exact, a range for prefix", async () => {
    const exact = (await planRows(entityMatchStatement("album", "Dub Plate", "exact")))
      .map((row) => row.detail)
      .join("\n");
    const prefix = (await planRows(entityMatchStatement("album", "dub", "prefix")))
      .map((row) => row.detail)
      .join("\n");

    expect(exact).toContain("SEARCH albums USING INDEX albums_name_nocase_idx (name=?)");
    expect(prefix).toContain(
      "SEARCH albums USING INDEX albums_name_nocase_idx (name>? AND name<?)",
    );
    expect(`${exact}\n${prefix}`).not.toContain("SCAN albums");
  });

  it("serves the label name through labels_name_nocase_idx beside the alias list", async () => {
    for (const mode of ["exact", "prefix"] as const) {
      const details = (await planRows(entityMatchStatement("label", "Hospital", mode)))
        .map((row) => row.detail)
        .join("\n");

      expect(details).toContain("MULTI-INDEX OR");
      expect(details).toContain("INDEX labels_name_nocase_idx");
      expect(details).not.toContain("SCAN labels");
    }

    const probe = (await planRows(labelNameProbeStatement("hospital records")))
      .map((row) => row.detail)
      .join("\n");

    expect(probe).toContain("SEARCH labels USING COVERING INDEX labels_name_nocase_idx (name=?)");
    expect(probe).not.toContain("USE TEMP B-TREE");
  });

  it("serves the artist name through artists_name_nocase_idx with the aliases as one list", async () => {
    for (const mode of ["exact", "prefix"] as const) {
      const details = (await planRows(entityMatchStatement("artist", "Netsky", mode)))
        .map((row) => row.detail)
        .join("\n");

      expect(details).toContain("MULTI-INDEX OR");
      expect(details).toContain("USING INDEX artists_name_nocase_idx");
      expect(details).toContain("LIST SUBQUERY");
      expect(details).not.toContain("CORRELATED");
    }
  });

  it("reads the label aliases once per statement, never once per label row", async () => {
    for (const mode of ["exact", "prefix"] as const) {
      const rows = await planRows(entityMatchStatement("label", "Hospital", mode));
      const aliasRead = rows.find((row) => row.detail.includes("label_aliases"));
      const aliasParent = rows.find((row) => row.id === aliasRead?.parent);

      expect(aliasRead).toBeDefined();
      expect(aliasParent?.detail).toMatch(/^LIST SUBQUERY/);
    }
  });
});

describe("the entity gate follows the shared hub floor (not certified-only)", () => {
  beforeEach(async () => {
    for (const n of [1, 2, 3]) {
      await seed(db, {
        artists: [`Sunk`],
        label: "Sofa Sound",
        title: `Sofa Cut ${n}`,
        trackId: `sofa-${n}`,
      });
    }

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
    expect(result.results.map((hit) => hit.trackId).sort()).toEqual(["sofa-1", "sofa-2", "sofa-3"]);
  });

  it("does NOT offer a below-floor label — it stays the filter chip it always was", async () => {
    const result = await searchArchive({ q: "Lone Imprint" });

    expect(result.entities).toEqual([]);
    expect(result.redirect).toBeUndefined();
    expect(result.filters).toEqual({ label: "Lone Imprint" });
  });
});

describe("the compound sonic tier — sound like several artists", () => {
  beforeEach(async () => {
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
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-1991",
      "certified-netsky",
      "uncertified-netsky",
      "certified-andromedik",
    ]);
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

    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
    ]);

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

    expect(sql).toContain("vector_distance_cos(emb.embedding_blob, ?)");
    expect(sql).toContain("join track_embeddings emb on emb.track_id = tracks.track_id");
    expect(sql).toContain("tracks.key in");
    expect(sql).not.toContain("lower(tracks.key)");
    expect(sql).toContain("order by dist asc");
    expect(sql).not.toContain("union all");
    expect((sql.match(/vector_distance_cos/g) ?? []).length).toBe(1);

    spy.mockRestore();
  });

  it("resolves an artist through a trusted AKA when nothing claims the name directly", async () => {
    await db.execute({
      args: ["al-1", "a-koven", "Kovenn", "kovenn"],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, kind, source, status, created_at)
            values (?, ?, ?, ?, 'name', 'musicbrainz', 'auto', '2026-07-01')`,
    });
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["Kovenn"] });

    const result = await searchArchive({ q: "artists that sound like Kovenn" });

    expect(result.kind).toBe("sonic");
    expect(result.filters?.soundsLikeArtists).toEqual(["Koven"]);
  });

  it("refuses an unlisted artist through BOTH its name and its trusted AKA", async () => {
    await db.execute({
      args: ["al-unlisted", "a-koven", "Kovenn", "kovenn"],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, kind, source, status, created_at)
            values (?, ?, ?, ?, 'name', 'musicbrainz', 'auto', '2026-07-01')`,
    });
    await db.execute(
      `update artists set mbid = '11111111-1111-4111-8111-111111111111' where id = 'a-koven'`,
    );
    await db.execute(
      `insert into artist_rules
         (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
       values ('arl_koven', '11111111-1111-4111-8111-111111111111', 'Koven', 'unlisted', null,
               'operator', '2026-07-01', '2026-07-01')`,
    );

    for (const typed of ["Koven", "koven", "Kovenn"]) {
      translateQuery.mockResolvedValue({ soundsLikeArtists: [typed] });

      const result = await searchArchive({ q: `artists that sound like ${typed}` });

      expect(result.kind, typed).not.toBe("sonic");
      expect(result.filters?.soundsLikeArtists ?? [], typed).not.toContain("Koven");
    }
  });

  it("lets a primary name beat another artist's AKA on the same spelling", async () => {
    await db.execute({
      args: ["al-2", "a-maduk", "Koven", "koven"],
      sql: `insert into artist_aliases (id, artist_id, alias, alias_slug, kind, source, status, created_at)
            values (?, ?, ?, ?, 'name', 'musicbrainz', 'auto', '2026-07-01')`,
    });
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["Koven"] });

    const result = await searchArchive({ q: "artists that sound like Koven" });

    expect(result.kind).toBe("sonic");
    expect(result.filters?.soundsLikeArtists).toEqual(["Koven"]);
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "certified-1991",
      "certified-netsky",
      "uncertified-netsky",
      "certified-andromedik",
    ]);
  });

  it("seeks the rank-0 name/slug instead of scanning every artist", async () => {
    const spy = vi.spyOn(db, "execute");
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["Koven"] });

    await searchArchive({ q: "artists that sound like Koven" });

    const centroidReads = spy.mock.calls
      .map((call) => call[0])
      .filter(
        (arg) =>
          typeof arg === "object" &&
          arg !== null &&
          typeof (arg as { sql?: unknown }).sql === "string" &&
          (arg as { sql: string }).sql.includes("ac.centroid_blob"),
      ) as Array<{ args: unknown[]; sql: string }>;

    spy.mockRestore();

    expect(centroidReads).toHaveLength(1);
    const resolve = centroidReads[0];
    const sql = resolve?.sql ?? "";

    expect(sql).toContain("artists.name = ? collate nocase");
    expect(sql).not.toContain("lower(artists.name)");
    expect(sql).not.toContain("artist_aliases");

    const plan = await db.execute({
      args: (resolve?.args ?? []) as string[],
      sql: `explain query plan ${sql}`,
    });
    const details = plan.rows
      .map((row) => (typeof row["detail"] === "string" ? row["detail"] : ""))
      .join("\n");

    expect(details).not.toMatch(/SCAN artists\b/);
  });

  it("DECLINES when no named artist resolves to a centroid — never invents a vibe", async () => {
    translateQuery.mockResolvedValue({ soundsLikeArtists: ["Nobody At All"] });

    const result = await searchArchive({ q: "artists that sound like Nobody At All" });

    expect(result.kind).not.toBe("sonic");
  });
});

describe("the LLM is down — search degrades, it never breaks", () => {
  it("falls back to full text when the model cannot be reached", async () => {
    translateQuery.mockResolvedValue(null);

    const result = await searchArchive({ q: "Andromedik tracks in A minor" });

    expect(result.degraded).toBe(true);
    expect(result.kind).toBe("token");
    expect(result.results[0]?.trackId).toBe("certified-andromedik");
  });

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

describe("the style tier — a style word ranks by sound, ahead of a namesake", () => {
  const liquid = SEARCH_STYLES[0];

  async function seedAnchor(slug: string, angle: number): Promise<void> {
    const id = `anchor-${slug}`;

    await db.execute({
      args: [id, slug.replace(/-/g, " "), slug],
      sql: `insert into artists (id, name, slug, created_at, updated_at)
            values (?, ?, ?, '2026-07-01', '2026-07-01')`,
    });
    await db.execute({
      args: [id, new Uint8Array(angleVector(angle).buffer)],
      sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
            values (?, ?, '2026-07-01', 'corpus-1', 4)`,
    });
  }

  beforeEach(() => {
    resetStyleProbeCache();
  });

  async function seedAllAnchors(centre: number): Promise<void> {
    const count = liquid.anchors.length;

    for (const [index, slug] of liquid.anchors.entries()) {
      await seedAnchor(slug, centre + (index - (count - 1) / 2) * 0.01);
    }
  }

  it("ranks the archive by the anchors' mean probe and echoes the anchors that weighed in", async () => {
    await seedAllAnchors(0.3);

    const result = await searchArchive({ q: "liquid" });

    expect(result.kind).toBe("sonic");
    expect(result.degraded).toBe(false);
    expect(result.redirect).toBeUndefined();
    expect(result.filters?.sound).toBe("liquid");
    expect(result.filters?.soundsLikeArtists).toEqual(
      liquid.anchors.map((slug) => slug.replace(/-/g, " ")),
    );
    expect(result.results.map((hit) => hit.trackId)).toEqual([
      "uncertified-netsky",
      "certified-netsky",
      "certified-1991",
      "certified-andromedik",
    ]);
    expect(translateQuery).not.toHaveBeenCalled();
  });

  it("reads the filler around a style word, and keeps a namesake as an entity row", async () => {
    await seedAllAnchors(0.3);
    await db.execute({
      args: [],
      sql: `insert into artists (id, name, slug, created_at, updated_at)
            values ('a-liquid', 'Liquid', 'liquid-artist', '2026-07-01', '2026-07-01')`,
    });

    const result = await searchArchive({ q: "some liquid dnb" });

    expect(result.kind).toBe("sonic");
    expect(result.filters?.sound).toBe("liquid");

    const named = await searchArchive({ q: "Liquid" });

    expect(named.kind).toBe("sonic");
    expect(named.redirect).toBeUndefined();
    expect(named.entities.map((entity) => `${entity.kind}:${entity.name}`)).toEqual([
      "artist:Liquid",
    ]);
  });

  it("resolves every anchor in ONE slug-keyed statement, never one read per anchor", async () => {
    await seedAllAnchors(0.2);
    const spy = vi.spyOn(db, "execute");

    await searchArchive({ q: "liquid" });

    const anchorReads = spy.mock.calls
      .map((call) => call[0])
      .filter(
        (arg) =>
          typeof arg === "object" &&
          arg !== null &&
          typeof (arg as { sql?: unknown }).sql === "string" &&
          (arg as { sql: string }).sql.includes("artist_centroids ac") &&
          (arg as { sql: string }).sql.includes("artists.slug in"),
      );

    expect(anchorReads).toHaveLength(1);
  });

  it("reads by name, flagged, when no anchor has a centroid", async () => {
    const result = await searchArchive({ q: "liquid" });

    expect(result.kind).not.toBe("sonic");
    expect(result.degraded).toBe(true);
    expect(result.filters?.sound).toBeUndefined();
  });

  it("never serves an unmeasured probe: one missing anchor degrades the whole style", async () => {
    for (const slug of liquid.anchors.slice(1)) {
      await seedAnchor(slug, 0.3);
    }

    const result = await searchArchive({ q: "liquid" });

    expect(result.degraded).toBe(true);
    expect(result.kind).not.toBe("sonic");
    expect(result.filters?.soundsLikeArtists).toBeUndefined();
  });

  it("never serves an unmeasured probe: an unlisted anchor degrades the whole style", async () => {
    await seedAllAnchors(0.3);
    const unlisted = liquid.anchors[0] ?? "";

    await db.execute({
      args: ["22222222-2222-4222-8222-222222222222", `anchor-${unlisted}`],
      sql: `update artists set mbid = ? where id = ?`,
    });
    await db.execute(
      `insert into artist_rules
         (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
       values ('arl_anchor', '22222222-2222-4222-8222-222222222222', 'Anchor', 'unlisted', null,
               'operator', '2026-07-01', '2026-07-01')`,
    );

    const result = await searchArchive({ q: "liquid" });

    expect(result.degraded).toBe(true);
    expect(result.kind).not.toBe("sonic");
  });

  it("leaves a sentence with a style word inside it to the tiers that read sentences", async () => {
    await seedAllAnchors(0.3);

    const result = await searchArchive({ q: "dark liquid with vocals" });

    expect(result.filters?.sound).toBeUndefined();
    expect(translateQuery).toHaveBeenCalled();
  });
});

describe("the sonic view of one track — its own sound, else its lead artist's", () => {
  it("ranks by the track's own vector and leaves the seed out of its own list", async () => {
    const result = await searchLikeTrack({
      allowBoundedSonicForDiagnostics: true,
      trackId: "certified-1991",
    });

    expect(result?.anchor?.trackId).toBe("certified-1991");
    expect(result?.filters).toBeUndefined();
    expect(result?.results.map((hit) => hit.trackId)).toEqual([
      "certified-netsky",
      "uncertified-netsky",
      "certified-andromedik",
    ]);
  });

  it("falls back to the lead artist's centroid for a track with no embedding, and says so", async () => {
    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, spotify_url, duration_ms, has_embedding)
            values ('unembedded', 'Quiet One', '["Koven"]', null, 180000, 0)`,
    });
    await db.execute({
      args: [],
      sql: `insert into artists (id, name, slug, created_at, updated_at)
            values ('a-koven', 'Koven', 'koven', '2026-07-01', '2026-07-01')`,
    });
    await db.execute({
      args: [new Uint8Array(angleVector(1.15).buffer)],
      sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
            values ('a-koven', ?, '2026-07-01', 'corpus-1', 4)`,
    });
    await db.execute({
      args: [],
      sql: `insert into track_artists (track_id, artist_id, position) values ('unembedded', 'a-koven', 1)`,
    });

    const result = await searchLikeTrack({
      allowBoundedSonicForDiagnostics: true,
      trackId: "unembedded",
    });

    expect(result?.anchor?.similar).toBe(true);
    expect(result?.filters?.soundsLikeArtists).toEqual(["Koven"]);
    expect(result?.results[0]?.trackId).toBe("certified-andromedik");
  });

  it("counts only a LISTED performer's centroid as a sound, in the row flag and the view alike", async () => {
    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, spotify_url, duration_ms, has_embedding)
            values ('hidden-lead', 'Hidden Lead', '["Ghost"]', null, 180000, 0)`,
    });
    await db.execute({
      args: [],
      sql: `insert into artists (id, name, slug, mbid, created_at, updated_at)
            values ('a-ghost', 'Ghost', 'ghost', '33333333-3333-4333-8333-333333333333',
                    '2026-07-01', '2026-07-01')`,
    });
    await db.execute({
      args: [new Uint8Array(angleVector(0.2).buffer)],
      sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
            values ('a-ghost', ?, '2026-07-01', 'corpus-1', 4)`,
    });
    await db.execute({
      args: [],
      sql: `insert into track_artists (track_id, artist_id, position) values ('hidden-lead', 'a-ghost', 1)`,
    });
    await db.execute(
      `insert into artist_rules
         (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
       values ('arl_ghost', '33333333-3333-4333-8333-333333333333', 'Ghost', 'unlisted', null,
               'operator', '2026-07-01', '2026-07-01')`,
    );

    const viewed = await searchLikeTrack({
      allowBoundedSonicForDiagnostics: true,
      trackId: "hidden-lead",
    });

    expect(viewed?.results).toEqual([]);
    expect(viewed?.anchor?.similar).toBe(false);
  });

  it("answers the seed alone when the track has neither, and nothing for an unknown id", async () => {
    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, spotify_url, duration_ms, has_embedding)
            values ('silent', 'No Read', '["Nobody"]', null, 180000, 0)`,
    });

    const alone = await searchLikeTrack({
      allowBoundedSonicForDiagnostics: true,
      trackId: "silent",
    });

    expect(alone?.anchor?.trackId).toBe("silent");
    expect(alone?.anchor?.similar).toBe(false);
    expect(alone?.results).toEqual([]);
    expect(await searchLikeTrack({ trackId: "no-such-track" })).toBeNull();
  });

  it("degrades honestly when the ranking engine is off (the public default without Sonar)", async () => {
    const result = await searchLikeTrack({ trackId: "certified-1991" });

    expect(result?.degraded).toBe(true);
    expect(result?.results).toEqual([]);
  });
});

describe("the vector gate — no sonic work runs before the budget's verdict", () => {
  const refused = async () => {
    throw new Error("over the per-IP budget");
  };

  function vectorScans(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((call) => {
      const arg = call[0];

      const sql =
        typeof arg === "object" && arg !== null ? (arg as { sql?: unknown }).sql : undefined;

      return typeof sql === "string" && sql.includes("vector_distance_cos");
    }).length;
  }

  it("refuses a style word before its ranking scan", async () => {
    for (const slug of SEARCH_STYLES[0].anchors) {
      await db.execute({
        args: [`gate-${slug}`, slug, slug],
        sql: `insert into artists (id, name, slug, created_at, updated_at)
              values (?, ?, ?, '2026-07-01', '2026-07-01')`,
      });
      await db.execute({
        args: [`gate-${slug}`, new Uint8Array(angleVector(0.3).buffer)],
        sql: `insert into artist_centroids (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
              values (?, ?, '2026-07-01', 'corpus-1', 4)`,
      });
    }
    resetStyleProbeCache();
    const spy = vi.spyOn(db, "execute");

    await expect(searchArchive({ beforeVector: refused, q: "liquid" })).rejects.toThrow(
      "over the per-IP budget",
    );
    expect(vectorScans(spy)).toBe(0);
  });

  it("refuses a sonic phrase before its ranking scan", async () => {
    const spy = vi.spyOn(db, "execute");

    await expect(
      searchArchive({ beforeVector: refused, q: "tracks that sound like Nine Clouds" }),
    ).rejects.toThrow("over the per-IP budget");
    expect(vectorScans(spy)).toBe(0);
  });

  it("refuses the sonic view of one track before its ranking scan", async () => {
    const spy = vi.spyOn(db, "execute");

    await expect(
      searchLikeTrack({
        allowBoundedSonicForDiagnostics: true,
        beforeVector: refused,
        trackId: "certified-1991",
      }),
    ).rejects.toThrow("over the per-IP budget");
    expect(vectorScans(spy)).toBe(0);
  });

  it("lets the cheap name tiers answer without waiting on it", async () => {
    const result = await searchArchive({ beforeVector: refused, q: "Netsky" });

    expect(result.kind).toBe("entity");
  });
});
