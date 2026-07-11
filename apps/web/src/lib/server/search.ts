// FLUNCLE'S SEARCH — the resolver. The surface that becomes the primary navigation once
// the archive is deep enough that a feed cannot carry it.
//
// ── THE ARCHITECTURE, IN ONE LINE ────────────────────────────────────────────────────
// Deterministic first; the model only on a miss; and the model never touches the data.
//
// A query is resolved by trying four tiers IN ORDER and stopping at the first that answers:
//
//   1. A COORDINATE (`004.7.2I`, `fluncle://004.7.2I`). A regex and one indexed lookup.
//      This is a jump, not a search — it resolves to the `/log` page or to nothing.
//   2. An EXACT ENTITY (an artist / label / album named in full). One indexed lookup. An
//      artist has a page, so it is a jump; a label or an album has none yet, so it becomes
//      the filter it obviously is (every track on that label) rather than a dead link.
//   3. A BARE TOKEN (`netsky`). FTS5 (bm25) + an artist prefix match. ~114 ms at 100k rows,
//      measured on hosted Turso in the scale spike.
//   3½. A SONIC PHRASE (`tracks that sound like Nine Clouds`). A regex, not a model — see the
//      sonic tier below for why the headline query is the LAST one that should depend on a
//      vendor being up.
//   4. ANYTHING ELSE. A small LLM turns the sentence into a `SearchFilters` object, and SQL
//      executes it over the real columns.
//
// Tiers 1–3½ are most of what anyone types, and NONE of them costs a model call. That is the
// point of the ordering: the LLM is never on the hot path of a common query.
//
// ── THE MODEL NEVER TOUCHES THE DATA ─────────────────────────────────────────────────
// Tier 4's model emits FILTERS, never rows. It cannot hallucinate a track, because it never
// sees one and never returns one — SQL does every retrieval. See `search-llm.ts`.
//
// ── AND IF IT IS DOWN, SEARCH STILL WORKS ────────────────────────────────────────────
// `translateQuery` returns `null` when the model is unprovisioned, slow, or failing. Tier 4
// then falls back to the FTS5 path with OR semantics + bm25 — so "Andromedik tracks in A
// minor" still surfaces the Andromedik tracks, marked `degraded: true` so the client can be
// honest about what it did. Search degrades; it never breaks. (`search.test.ts` proves it by
// simulating the model failing.)
//
// ── THE SONIC TIER — the thing no other drum & bass tool has ─────────────────────────
// The model may emit `soundsLike: "<reference>"`. That reference is resolved to a REAL track
// in the archive; the search then rides THAT track's MuQ embedding through
// `vector_distance_cos`. It is anchored on a row that exists, so it cannot invent a vibe.
// The three ratified vector rules (docs/local-database.md) hold here without exception:
// rank in SQL, bind the probe as a raw BLOB, and never build a `libsql_vector_idx`.
//
// ── THE CATALOGUE RULE ───────────────────────────────────────────────────────────────
// `tracks` is the universal music object; `findings` is the certification, 1:1 and present
// only for a track Fluncle certified. So a row with no `findings` row is a track Fluncle has
// not been to. Every read here is a LEFT JOIN (not the `FINDINGS_FROM` inner join every
// finding surface drives through — see `tracks.ts`), because search is the one public
// surface that must see both. The uncertified rows come back with `certified: false`, no
// coordinate, and a Spotify link OUT. They are never named, never labelled, never counted as
// a tier the reader can learn — DESIGN.md's Unlit Rule carries the visual half of the same
// rule. "Finding" stays the only named object in Fluncle's world.

import { type SearchEntity, type SearchFilters, type SearchHit } from "@fluncle/contracts/orpc";
import { parseKey } from "../key-camelot";
import {
  isBareToken,
  keySpellings,
  parseCoordinate,
  parseSonicPhrase,
  toFtsMatch,
  tokenize,
} from "../search-query";
import { getDb, typedRow, typedRows } from "./db";
import { embeddingVectorSql, parseEmbedding, toVectorProbe } from "./embedding";
import { translateQuery } from "./search-llm";

/** How many rows a search returns when the caller does not say. */
const DEFAULT_LIMIT = 12;

/**
 * How many rows the sonic tier's vector scan ranks before the pre-filter is applied. Not a
 * cap on the answer — a cap on the CANDIDATE set, and only in the sense that the exact scan
 * `order by … limit N` already returns the winners and nothing else.
 */
const SONIC_LIMIT = 12;

/** The whole answer: which tier resolved it, what it found, and what it understood. */
export type SearchResult = {
  /** The real track the sonic tier anchored on (`sonic` only). */
  anchor?: SearchHit;
  /** The LLM tier was wanted and could not run; these are full-text results instead. */
  degraded: boolean;
  /** Artists the query named or prefixed — jump targets, above the rows. */
  entities: SearchEntity[];
  /** What the model understood, echoed back (`filters`/`sonic` only). */
  filters?: SearchFilters;
  kind: "coordinate" | "empty" | "entity" | "filters" | "sonic" | "token";
  /** The app route this query simply IS (`coordinate`/`entity`). */
  redirect?: string;
  results: SearchHit[];
};

// ── The row projection ───────────────────────────────────────────────────────────────

// A search row, straight off the wire. `log_id` is the certification: NULL ⇒ `tracks` has a
// row and `findings` does not ⇒ Fluncle never certified this track.
type SearchRow = {
  album: string | null;
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  galaxy_name: string | null;
  key: string | null;
  label: string | null;
  log_id: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

// The columns every tier selects. `galaxy_name` comes through the correlated subquery the
// rest of the app uses (an UNNAMED galaxy has no public name, so a machine handle can never
// leak); it is NULL for an uncertified track by construction — a galaxy is a property of the
// certified archive.
const SEARCH_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album, tracks.album_image_url,
  tracks.bpm, tracks.key, tracks.label, tracks.release_date, tracks.spotify_url, findings.log_id,
  (select name from galaxies where galaxies.id = findings.galaxy_id) as galaxy_name`;

/**
 * THE SEARCH JOIN — and the one place in the app that deliberately does NOT drive through
 * `FINDINGS_FROM`.
 *
 * Every finding surface uses an INNER join, so an uncertified track structurally cannot leak
 * onto it. Search is the exception BY DESIGN: it is the surface where the depth behind the
 * findings is the whole product. So the join is LEFT, and `findings.log_id IS NULL` is what
 * "Fluncle has not been here" means — one nullable column, checked in one place
 * ({@link toHit}), and carried to the client as a single boolean.
 */
const SEARCH_FROM = `tracks left join findings on findings.track_id = tracks.track_id`;

/**
 * Certified rows first, always — and this is not a taste call, it is arithmetic. `bm25()`'s
 * relevance is corpus-relative: a text score computed across a 60-row certified archive and a
 * 41k-row catalogue is not on one scale, so a blended cross-tier relevance list would be
 * meaningless even if we wanted one. Findings lead; the rest is depth behind them.
 */
const CERTIFIED_FIRST = `case when findings.track_id is null then 1 else 0 end asc`;

/** Parse the stored artist array. A malformed cell yields an empty list, never a throw. */
function parseArtists(json: string): string[] {
  try {
    const raw: unknown = JSON.parse(json);

    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** Map a row to the wire shape. `certified` is derived from the coordinate, nowhere else. */
function toHit(row: SearchRow): SearchHit {
  return {
    album: row.album ?? undefined,
    albumImageUrl: row.album_image_url ?? undefined,
    artists: parseArtists(row.artists_json),
    bpm: row.bpm ?? undefined,
    certified: row.log_id !== null,
    galaxy: row.galaxy_name ?? undefined,
    key: row.key ?? undefined,
    label: row.label ?? undefined,
    logId: row.log_id ?? undefined,
    releaseDate: row.release_date ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

/** An empty answer, in the shape every caller already handles. */
function empty(kind: SearchResult["kind"] = "empty"): SearchResult {
  return { degraded: false, entities: [], kind, results: [] };
}

// ── Tier 3 · full text ───────────────────────────────────────────────────────────────

/**
 * The FTS5 read. `match` is built by {@link toFtsMatch}, which rebuilds the expression from
 * scrubbed tokens — the raw query NEVER reaches MATCH, because MATCH is a query language and
 * a bind slot does not make its operators inert.
 *
 * Ranked certified-first, then by bm25 (ascending: fts5 scores better matches lower).
 */
async function ftsSearch(match: string, limit: number): Promise<SearchHit[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [match, limit],
    sql: `select ${SEARCH_SELECT}
          from tracks_fts
          join tracks on tracks.track_id = tracks_fts.track_id
          left join findings on findings.track_id = tracks.track_id
          where tracks_fts match ?
          order by ${CERTIFIED_FIRST}, bm25(tracks_fts) asc, tracks.track_id asc
          limit ?`,
  });

  return typedRows<SearchRow>(result.rows).map(toHit);
}

/**
 * Artists whose name the query PREFIXES — the jump targets above the rows. Cheap (an indexed
 * prefix range on a 67-row table today), and the affordance that makes a search box feel like
 * navigation: type `net`, see Netsky, press enter, land on the artist page.
 */
async function matchArtists(query: string, limit = 3): Promise<SearchEntity[]> {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: [needle, limit],
    sql: `select name, slug, image_url from artists
          where lower(name) like ? || '%'
          order by length(name) asc, name asc
          limit ?`,
  });

  return typedRows<{ image_url: string | null; name: string; slug: string }>(result.rows).map(
    (row) => ({
      imageUrl: row.image_url ?? undefined,
      kind: "artist" as const,
      name: row.name,
      slug: row.slug,
    }),
  );
}

// ── Tier 2 · the exact entity ────────────────────────────────────────────────────────

/**
 * Does the query NAME an entity, in full? An exact (case-insensitive) hit on an artist, a
 * label, or an album.
 *
 * The artist carries a REDIRECT — `/artist/<slug>` exists, so Enter goes to the page. It
 * carries the artist's TRACKS underneath it too: a jump the reader did not want is a dead end
 * if it is all they were offered, and the rows cost one query they were going to want anyway.
 *
 * The label and the album become FILTERS instead of redirects: their pages are the next thing
 * to land (roadmap: "the graph surfaces"), and until they exist a redirect would be a 404. The
 * day they ship, this is the one function that flips.
 */
async function resolveEntity(query: string): Promise<SearchResult | null> {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return null;
  }

  const db = await getDb();
  const artist = typedRow<{ name: string; slug: string }>(
    (
      await db.execute({
        args: [needle],
        sql: `select name, slug from artists where lower(name) = ? limit 1`,
      })
    ).rows,
  );

  if (artist) {
    const [{ results }, entities] = await Promise.all([
      runFilters({ artist: artist.name }, DEFAULT_LIMIT),
      matchArtists(artist.name, 1),
    ]);

    // The artist rides back as an ENTITY (the named jump target, with their portrait), not as
    // a synthetic "go to /artist/netsky" row. A reader should see the artist, never the URL.
    // It is first in the list, so Enter still lands on their page.
    return {
      degraded: false,
      entities,
      kind: "entity",
      redirect: `/artist/${artist.slug}`,
      results,
    };
  }

  const label = typedRow<{ name: string }>(
    (
      await db.execute({
        args: [needle],
        sql: `select name from labels where lower(name) = ? limit 1`,
      })
    ).rows,
  );

  if (label) {
    return {
      ...(await runFilters({ label: label.name }, DEFAULT_LIMIT)),
      filters: { label: label.name },
      kind: "entity",
    };
  }

  const album = typedRow<{ album: string }>(
    (
      await db.execute({
        args: [needle],
        sql: `select album from tracks where lower(album) = ? limit 1`,
      })
    ).rows,
  );

  if (album) {
    return {
      ...(await runFilters({ album: album.album }, DEFAULT_LIMIT)),
      filters: { album: album.album },
      kind: "entity",
    };
  }

  return null;
}

// ── Tier 4 · the filters, executed as SQL ────────────────────────────────────────────

/**
 * One `where` fragment plus the args it binds — assembled in SQL-text order. The args are
 * scalars by TYPE, not by convention: nothing a model or a stranger typed can arrive here as
 * anything but a bound value.
 */
type Clause = { args: (number | string)[]; sql: string };

/**
 * Compile a `SearchFilters` object into `where` clauses. Every value is a BIND ARG; nothing
 * the model emitted is ever interpolated into SQL. (The model is untrusted input with extra
 * steps — it is downstream of a stranger's search box.)
 *
 * `artist` matches the raw `artists_json` text, the same substring shape `searchTracks` in
 * `tracks.ts` uses: good enough to find an artist inside the stored array without unpacking
 * it, and it costs a scan the archive is nowhere near needing an index for.
 *
 * `key` goes through {@link keySpellings}, so "Bb minor" and "A# minor" ask one question.
 * `text` goes through the FTS index (a subquery, so bm25 does not have to survive the join).
 */
function compileFilters(filters: SearchFilters): Clause[] {
  const clauses: Clause[] = [];

  if (filters.artist) {
    clauses.push({
      args: [filters.artist.toLowerCase()],
      sql: `lower(tracks.artists_json) like '%' || ? || '%'`,
    });
  }

  if (filters.label) {
    clauses.push({ args: [filters.label.toLowerCase()], sql: `lower(tracks.label) = ?` });
  }

  if (filters.album) {
    clauses.push({ args: [filters.album.toLowerCase()], sql: `lower(tracks.album) = ?` });
  }

  const parsedKey = parseKey(filters.key);

  if (parsedKey) {
    const spellings = keySpellings(parsedKey);

    clauses.push({
      args: spellings,
      sql: `lower(tracks.key) in (${spellings.map(() => "?").join(", ")})`,
    });
  }

  if (typeof filters.bpmMin === "number") {
    clauses.push({ args: [filters.bpmMin], sql: `tracks.bpm >= ?` });
  }

  if (typeof filters.bpmMax === "number") {
    clauses.push({ args: [filters.bpmMax], sql: `tracks.bpm <= ?` });
  }

  if (typeof filters.yearMin === "number") {
    clauses.push({
      args: [String(filters.yearMin)],
      sql: `substr(tracks.release_date, 1, 4) >= ?`,
    });
  }

  if (typeof filters.yearMax === "number") {
    clauses.push({
      args: [String(filters.yearMax)],
      sql: `substr(tracks.release_date, 1, 4) <= ?`,
    });
  }

  const match = filters.text ? toFtsMatch(filters.text) : null;

  if (match) {
    clauses.push({
      args: [match],
      sql: `tracks.track_id in (select track_id from tracks_fts where tracks_fts match ?)`,
    });
  }

  return clauses;
}

/**
 * Execute a compiled filter set. Certified first, then newest release — an archive read, not
 * a relevance read (there is no text score to rank by once the query became columns).
 *
 * A filter set that compiles to NOTHING (the model returned only `soundsLike`, or only fields
 * we do not filter on) would otherwise return the whole archive, which is not an answer to a
 * question. It returns nothing instead, and the caller degrades.
 */
async function runFilters(filters: SearchFilters, limit: number): Promise<SearchResult> {
  const clauses = compileFilters(filters);

  if (clauses.length === 0) {
    return empty("filters");
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...clauses.flatMap((clause) => clause.args), limit],
    sql: `select ${SEARCH_SELECT}
          from ${SEARCH_FROM}
          where ${clauses.map((clause) => clause.sql).join(" and ")}
          order by ${CERTIFIED_FIRST}, tracks.release_date desc, tracks.track_id asc
          limit ?`,
  });

  return {
    degraded: false,
    entities: [],
    filters,
    kind: "filters",
    results: typedRows<SearchRow>(result.rows).map(toHit),
  };
}

// ── The sonic tier ───────────────────────────────────────────────────────────────────

/**
 * Resolve a free-text track reference to a REAL row that has an embedding. Certified rows
 * win ties (they are the ones Fluncle has actually been to, and the ones a reader means when
 * they name a track). Returns `null` when nothing matches — at which point the sonic tier
 * declines rather than inventing a vibe to search for.
 */
async function resolveAnchor(
  reference: string,
): Promise<{ hit: SearchHit; vector: number[] } | null> {
  const match = toFtsMatch(reference);

  if (!match) {
    return null;
  }

  const db = await getDb();
  const result = await db.execute({
    args: [match],
    sql: `select ${SEARCH_SELECT}, tracks.embedding_json
          from tracks_fts
          join tracks on tracks.track_id = tracks_fts.track_id
          left join findings on findings.track_id = tracks.track_id
          where tracks_fts match ? and tracks.embedding_json is not null
          order by ${CERTIFIED_FIRST}, bm25(tracks_fts) asc, tracks.track_id asc
          limit 1`,
  });

  const row = typedRow<SearchRow & { embedding_json: string | null }>(result.rows);

  if (!row) {
    return null;
  }

  const vector = parseEmbedding(row.embedding_json);

  return vector ? { hit: toHit(row), vector } : null;
}

/**
 * "Tracks that sound like <X>" — the sonic tier.
 *
 * The anchor is a real, embedded row. Its MuQ vector is the probe, and the DATABASE does the
 * ranking: an exact `vector_distance_cos` scan, `order by dist limit N`, which returns the
 * ~12 winners and never the corpus. The three rules from docs/local-database.md, and why each
 * one is load-bearing:
 *
 *   1. RANK IN SQL. Pulling `embedding_json` into the isolate to cosine it there is 21 KB per
 *      candidate — it threw at ~460 rows against local sqld's 10 MiB cap, and on hosted
 *      (which has no cap) it would silently grow toward OOMing the 128 MB Worker.
 *   2. BIND THE PROBE AS A RAW BLOB (`toVectorProbe`), never as a JSON string: 1,883 ms vs
 *      26,700 ms at 100k on hosted. The cliff does NOT reproduce locally, so nothing in dev
 *      will ever warn you.
 *   3. NO `libsql_vector_idx`. It wedged hosted Turso's write path for 20+ minutes and builds
 *      an EMPTY index locally, silently. The exact scan is the ratified shape.
 *
 * ANY OTHER FILTERS THE QUERY CARRIED BECOME THE BTREE PRE-FILTER — "like Nine Clouds, on
 * Hospital Records" narrows the candidate set BEFORE the scan touches a vector, which is the
 * exact lever the spike measured (100k: 1,883 ms → 207 ms behind a key/BPM pre-filter). It is
 * the same `compileFilters` the non-sonic path uses; nothing special is written for it.
 *
 * `where vec is not null` sits INSIDE the subquery for a reason: `vector_distance_cos` THROWS
 * on a NULL, so an un-embedded row must be gone before the ranking sees it.
 *
 * AND THE ORDER IS PURE DISTANCE — no certified-first tier break, unlike every other tier
 * here. That asymmetry is deliberate and it is arithmetic: bm25 is CORPUS-relative (a text
 * score computed across 60 findings and one across 41k catalogue tracks are not on one scale),
 * so a blended text ranking would be meaningless. A cosine distance is not — it is a property
 * of two vectors and nothing else. So sound CAN be ranked honestly across both tiers, and
 * pushing a nearer uncertified track below a further finding would be a lie about the sound.
 * The Unlit Rule keeps the two readable apart on the page; the ranking tells the truth.
 */
async function runSonic(filters: SearchFilters, limit: number): Promise<SearchResult | null> {
  const reference = filters.soundsLike;

  if (!reference) {
    return null;
  }

  const anchor = await resolveAnchor(reference);

  if (!anchor) {
    return null; // nothing to anchor on — decline, never invent
  }

  // Everything EXCEPT the reference itself narrows the candidates (a btree pre-filter in
  // front of the scan). `soundsLike` is the probe, and `text` is the words that made it —
  // neither is a column filter.
  const { soundsLike: _reference, text: _words, ...columnFilters } = filters;
  const clauses = compileFilters(columnFilters);
  const where = [
    ...clauses.map((clause) => clause.sql),
    `tracks.track_id != ?`,
    `${embeddingVectorSql()} is not null`,
  ].join(" and ");

  const db = await getDb();
  const result = await db.execute({
    // SQL-TEXT ORDER: the probe's `?` (in the select list) binds before the where clause's.
    args: [
      toVectorProbe(anchor.vector),
      ...clauses.flatMap((clause) => clause.args),
      anchor.hit.trackId,
      limit,
    ],
    sql: `select ${SEARCH_SELECT}, vector_distance_cos(${embeddingVectorSql()}, ?) as dist
          from ${SEARCH_FROM}
          where ${where}
          order by dist asc, tracks.track_id asc
          limit ?`,
  });

  return {
    anchor: anchor.hit,
    degraded: false,
    entities: [],
    filters,
    kind: "sonic",
    results: typedRows<SearchRow>(result.rows).map(toHit),
  };
}

// ── The resolver ─────────────────────────────────────────────────────────────────────

/**
 * Resolve one query. The four tiers, in order, stopping at the first that answers.
 *
 * Everything about the ORDER is a performance decision and a safety decision at once: the
 * common cases (a coordinate, a name, a word) never reach a model, and the case that does is
 * on a 3-second leash with a full-text fallback behind it.
 */
export async function searchArchive(options: { q: string; limit?: number }): Promise<SearchResult> {
  const q = options.q.trim();
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    50,
  );

  if (q.length === 0) {
    return empty();
  }

  // ── 1 · A coordinate. A jump, not a search: it names exactly one finding.
  //
  // It comes back as a RESULT ROW as well as a redirect — the finding itself, cover and all.
  // A reader who types a coordinate should see the finding they named, not a rendering of the
  // URL they are about to visit. Enter still lands on `/log`, because that row is the first
  // thing in the list and the list is keyboard-first.
  const coordinate = parseCoordinate(q);

  if (coordinate) {
    const db = await getDb();
    const found = typedRow<SearchRow>(
      (
        await db.execute({
          args: [coordinate],
          sql: `select ${SEARCH_SELECT} from ${SEARCH_FROM} where findings.log_id = ? limit 1`,
        })
      ).rows,
    );

    return found
      ? {
          degraded: false,
          entities: [],
          kind: "coordinate",
          redirect: `/log/${found.log_id}`,
          results: [toHit(found)],
        }
      : empty("coordinate");
  }

  // ── 2 · An exact entity name.
  const entity = await resolveEntity(q);

  if (entity) {
    return entity;
  }

  // ── 3 · A bare token. FTS5 + the artist prefix jump.
  if (isBareToken(q)) {
    const match = toFtsMatch(q);
    const [results, entities] = await Promise.all([
      match ? ftsSearch(match, limit) : Promise.resolve([]),
      matchArtists(q),
    ]);

    return { degraded: false, entities, kind: "token", results };
  }

  // ── 3½ · "sounds like <X>". The headline query, and it does NOT get a model in front of it.
  //
  // Sonic search is the thing no other drum & bass tool has, so it is going to be one of the
  // most-typed shapes here — and the rule this whole resolver is built on is that the LLM is
  // never on the hot path of a COMMON query. It is also the feature that must not go down when
  // a vendor does. "Sounds like X" needs a pattern, not understanding, so it gets one
  // (`parseSonicPhrase`): zero latency, zero cost, zero dependency.
  //
  // Tier 4 still owns the phrasings this cannot see, and — the real prize — the COMPOUND
  // query, where the reference is only half the question and the rest becomes the btree
  // pre-filter in front of the scan.
  const sonicPhrase = parseSonicPhrase(q);

  if (sonicPhrase) {
    const sonic = await runSonic({ soundsLike: sonicPhrase }, Math.min(limit, SONIC_LIMIT));

    if (sonic) {
      return sonic;
    }
    // The reference named no real track. Fall through — the model may read the sentence
    // differently, and failing that, the text search below still answers.
  }

  // ── 4 · Language. The model translates; SQL retrieves.
  const filters = await translateQuery(q);

  if (filters) {
    const sonic = await runSonic(filters, Math.min(limit, SONIC_LIMIT));

    if (sonic) {
      return sonic;
    }

    const filtered = await runFilters(filters, limit);

    if (filtered.results.length > 0) {
      return filtered;
    }

    // Nothing came back. When the query named REAL COLUMNS (an artist, a key, a BPM range),
    // that empty is the honest answer — "no Andromedik track is in A minor" is a fact, and
    // papering over it with fuzzy text hits would be a worse product than saying so. But when
    // the filters were only loose words (or the sonic reference resolved to no real track),
    // there is nothing honest to report yet, so fall through to the text search below.
    if (compileFilters({ ...filters, text: undefined }).length > 0) {
      return filtered;
    }
  }

  // ── The degradation. The model was wanted and could not run (unprovisioned, slow, down),
  // or it parsed to nothing usable. Full text with OR semantics: bm25 ranks by rarity, so the
  // one distinctive word in the sentence carries the result.
  const match = toFtsMatch(q, "or");
  const [results, entities] = await Promise.all([
    match ? ftsSearch(match, limit) : Promise.resolve([]),
    // The first token is the one worth prefixing an artist against ("andromedik tracks …").
    matchArtists(tokenize(q)[0] ?? ""),
  ]);

  return { degraded: filters === null, entities, kind: "token", results };
}
