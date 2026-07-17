// The per-user recommendation engine — the operator's telescope (docs/the-ear.md),
// generalized to a signed-in listener's own seed set. A user picks up to
// MAX_REC_SEEDS tracks (archive or catalogue — a listener seeds with what they
// like, not with what Fluncle certified), and the engine ranks the embedded,
// Spotify-anchored catalogue against THEIR seeds by max-similarity, exactly the
// way The Ear ranks it against the findings.
//
// Every scan here is a derivative of a PROVEN query shape, never a new one:
//
//   - The max-similarity scan is `getTasteCosines` (tracks.ts): one `union all`
//     branch per probe, each probe bound ONCE as a raw float32 BLOB
//     (`toVectorProbe` — never text, the 14× hosted cliff), `min(dist)` grouped
//     per candidate. Bounded by construction: ≤ MAX_REC_SEEDS probes.
//   - The rank-and-cut lives IN SQL (`order by dist asc limit ?`), the
//     `getSimilarFindings` shape — only (track_id, dist) pairs cross the wire,
//     never a vector (docs/local-database.md: rank in SQL, or OOM the Worker).
//   - The candidate exclusions are the ear lens's WHERE (catalogue.ts
//     `listCatalogueTracks`, `lens === "ear"`): no findings row, not dismissed,
//     no duplicate marker, under the long-form veto — plus the display-band
//     duplicate cut (`nearest_finding_score < DUPLICATE_SIMILARITY`) the ear
//     applies at read time, and the Spotify anchor this surface needs (a rec a
//     listener cannot play is not a rec).
//   - The diversity re-rank is `diversifyRanked` (catalogue.ts) — the SAME
//     EAR_DIVERSITY_DECAY greed the ear lens uses, imported, never re-implemented.
//
// THE REGISTER SPLIT (the option-B blend, operator-ratified): 2–3 FINDINGS
// nearest the seed set ride along as labeled slots — certified tracks, so those
// rows carry Fluncle's full voice (the note, the Log ID). The catalogue rows
// carry NOTHING editorial: no note, no coined noun, no invented WHY — the
// instrument register (DESIGN.md's Unlit Rule on the wire). "Close to what you
// picked" is UI copy, not data.

import { bestAlbumCoverUrl } from "../media";
import { parseArtistsJson } from "./artists";
import { DUPLICATE_SIMILARITY, diversifyRanked, LONG_FORM_MS } from "./catalogue";
import { getDb, typedRow, typedRows } from "./db";
import { cosineFromDistance, readEmbeddingBlob, toVectorProbe } from "./embedding";
import { jsonError } from "./env";
import { type PublicUser } from "./public-auth";

/**
 * The seed cap. Twelve is the roadmap's "~10" with head-room, and it is
 * LOAD-BEARING for scale: the seed count IS the probe fan-out of every scan below
 * (one `union all` branch per seed vector), so the cap bounds the per-request
 * vector work at ≤ 12 × candidates, whatever the catalogue grows to.
 */
export const MAX_REC_SEEDS = 12;

/** How many catalogue recommendations a request returns (post-decay). */
export const RECOMMENDATIONS_PAGE = 30;

/**
 * The over-fetch pool the diversity decay chooses from — the ear lens's exact
 * formula (`page * 3 + 25`, catalogue.ts): a decayed clone can only be displaced
 * by a fresh artist if that fresh artist made the pool.
 */
export const RECOMMENDATIONS_POOL = RECOMMENDATIONS_PAGE * 3 + 25;

/** The labeled findings slots (option B): the findings nearest the seed set. */
export const FINDINGS_SLOT_COUNT = 3;

/**
 * The GET /me/recommendations rate limit: a modest per-user hourly budget,
 * because each request is a real vector scan in the database (≤ 12 probes ×
 * the embedded catalogue) — cheap enough to compute per request, not cheap
 * enough to hand a loop.
 */
export const RECOMMENDATIONS_RATE_LIMIT = 60;
export const RECOMMENDATIONS_RATE_WINDOW_MS = 60 * 60 * 1000;

type TrackRefRow = {
  log_id: null | string;
  track_id: string;
};

type SeedListRow = {
  added_at: string;
  album_image_key: null | string;
  album_image_state: null | string;
  album_image_updated_at: null | string;
  album_image_url: null | string;
  artists_json: string;
  log_id: null | string;
  title: string;
  track_id: string;
};

type SeedVectorRow = {
  embedding_blob: unknown;
  track_id: string;
};

type ScanRow = {
  dist: number | null;
  track_id: string;
};

type HydrateRow = {
  album_image_key: null | string;
  album_image_state: null | string;
  album_image_updated_at: null | string;
  album_image_url: null | string;
  artists_json: string;
  bpm: null | number;
  duration_ms: null | number;
  key: null | string;
  log_id: null | string;
  note: null | string;
  release_date: null | string;
  spotify_uri: null | string;
  spotify_url: null | string;
  title: string;
  track_id: string;
};

/** One seed as the list returns it — hydrated for recognition, like a saved finding. */
export type RecSeedItem = {
  addedAt: string;
  artists: string[];
  imageUrl?: string;
  /** Present only when the seed is a certified finding (a catalogue seed has none). */
  logId?: string;
  title: string;
  trackId: string;
};

/**
 * A recommended FINDING — a labeled slot. Certified, so it carries Fluncle's full
 * voice: the coordinate and, when he wrote one, the note (the row's WHY).
 */
export type RecommendationFindingItem = {
  artists: string[];
  /** The instrument readout (The Readout Rule) — each present only when the row carries it. */
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  logId: string;
  note?: string;
  similarity: number;
  spotifyUri?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
  /** The release year (`release_date.slice(0, 4)`), when the row has a release date. */
  year?: string;
};

/**
 * A recommended CATALOGUE track — the instrument register. Identity, links, and
 * the honest similarity number; deliberately NO editorial field of any kind
 * (no note, no coordinate — it has neither, and the wire never invents one).
 */
export type RecommendationCatalogueItem = {
  artists: string[];
  /** The instrument readout (The Readout Rule) — each present only when the row carries it. */
  bpm?: number;
  durationMs?: number;
  imageUrl?: string;
  key?: string;
  similarity: number;
  spotifyUri?: string;
  spotifyUrl?: string;
  title: string;
  trackId: string;
  /** The release year (`release_date.slice(0, 4)`), when the row has a release date. */
  year?: string;
};

export type RecommendationsResult = {
  catalogue: RecommendationCatalogueItem[];
  findings: RecommendationFindingItem[];
  ok: true;
  /**
   * Seeds whose track has no embedding yet (its audio was never captured or
   * measured) — skipped HONESTLY, named rather than silently ignored, so the
   * surface can say "these three aren't steering yet".
   */
  seedsSkipped: string[];
  /** How many seed vectors actually steered this response. */
  seedsUsed: number;
};

/**
 * Resolve a seed reference — a `tracks.track_id` OR a finding's Log ID — to its
 * track row. The LEFT-join twin of account-data's `findTrackByTrackOrLog` (which
 * INNER-joins findings, because a saved finding must be certified): a seed may be
 * an uncertified catalogue row, so the certification is optional here.
 */
async function findSeedTrack(trackIdOrLogId: string): Promise<TrackRefRow | undefined> {
  const value = trackIdOrLogId.trim();

  if (!value) {
    return undefined;
  }

  const result = await (
    await getDb()
  ).execute({
    args: [value, value],
    sql: `select tracks.track_id, findings.log_id
      from tracks left join findings on findings.track_id = tracks.track_id
      where tracks.track_id = ? or findings.log_id = ? limit 1`,
  });

  return typedRow<TrackRefRow>(result.rows);
}

/** The signed-in user's seeds, newest first, hydrated for recognition. */
export async function listRecSeeds(user: PublicUser): Promise<{ ok: true; seeds: RecSeedItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],
    sql: `select s.track_id, s.added_at, t.title, t.artists_json, t.album_image_url, f.log_id,
        (select image_key from albums where albums.id = t.album_id) as album_image_key,
        (select image_state from albums where albums.id = t.album_id) as album_image_state,
        (select image_updated_at from albums where albums.id = t.album_id) as album_image_updated_at
      from user_rec_seeds s
      join tracks t on t.track_id = s.track_id
      left join findings f on f.track_id = s.track_id
      where s.user_id = ?
      order by s.added_at desc, s.track_id asc`,
  });

  return {
    ok: true,
    seeds: typedRows<SeedListRow>(result.rows).map((row) => ({
      addedAt: row.added_at,
      artists: parseArtistsJson(row.artists_json),
      imageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      logId: row.log_id ?? undefined,
      title: row.title,
      trackId: row.track_id,
    })),
  };
}

/**
 * Add a seed (by trackId or Log ID). Re-adding an existing seed refreshes its
 * `added_at` and never counts against the cap; a NEW seed past MAX_REC_SEEDS is a
 * 409 (`seed_limit`) with plain instructions — the cap is the scan's fan-out
 * bound, so it is enforced here, on the write.
 */
export async function saveRecSeed(
  user: PublicUser,
  body: unknown,
): Promise<Response | { ok: true; seed: { addedAt: string; logId?: string; trackId: string } }> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid seed");
  }

  const id =
    typeof body.trackId === "string"
      ? body.trackId
      : typeof body.logId === "string"
        ? body.logId
        : "";
  const track = await findSeedTrack(id);

  if (!track) {
    return jsonError(404, "track_not_found", "No track by that id");
  }

  const db = await getDb();
  const existing = await db.execute({
    args: [user.id],
    sql: `select track_id from user_rec_seeds where user_id = ?`,
  });
  const seeded = typedRows<{ track_id: string }>(existing.rows).map((row) => row.track_id);

  if (!seeded.includes(track.track_id) && seeded.length >= MAX_REC_SEEDS) {
    return jsonError(
      409,
      "seed_limit",
      `You can pick up to ${MAX_REC_SEEDS} seeds. Remove one to add another.`,
    );
  }

  const now = new Date().toISOString();

  await db.execute({
    args: [user.id, track.track_id, now],
    sql: `insert into user_rec_seeds (user_id, track_id, added_at)
      values (?, ?, ?)
      on conflict(user_id, track_id) do update set added_at = excluded.added_at`,
  });

  return {
    ok: true,
    seed: {
      addedAt: now,
      logId: track.log_id ?? undefined,
      trackId: track.track_id,
    },
  };
}

/** Remove a seed (by trackId or Log ID). An unknown track is a 404; removing a track that was never a seed is a no-op `{ ok: true }`, the `deleteSavedFinding` discipline. */
export async function deleteRecSeed(
  user: PublicUser,
  trackIdOrLogId: string,
): Promise<Response | { ok: true }> {
  const track = await findSeedTrack(trackIdOrLogId);

  if (!track) {
    return jsonError(404, "track_not_found", "No track by that id");
  }

  await (
    await getDb()
  ).execute({
    args: [user.id, track.track_id],
    sql: `delete from user_rec_seeds where user_id = ? and track_id = ?`,
  });

  return { ok: true };
}

/**
 * THE ENGINE — compute the signed-in user's recommendations per request. No
 * cache in v1: the scan is bounded (≤ MAX_REC_SEEDS probes × the embedded
 * catalogue, ranked entirely in SQL) and the GET carries its own hourly rate
 * limit (RECOMMENDATIONS_RATE_LIMIT, applied in the handler).
 *
 * GATED on a VERIFIED EMAIL (the learning-cohort ruling): a signed-in but
 * unverified account gets a 403 `email_unverified`, never a silent empty list.
 * The session itself is the caller's job (`privateUserAuth`).
 */
export async function listRecommendations(
  user: PublicUser,
): Promise<RecommendationsResult | Response> {
  if (!user.emailVerified) {
    return jsonError(403, "email_unverified", "Verify your email to get your recommendations.");
  }

  const db = await getDb();

  // The seed vectors — ≤ MAX_REC_SEEDS rows, each carrying its embedding blob
  // OUT of the database exactly once per request (a bounded, capped read — the
  // one place a vector legitimately enters the isolate, to be re-bound as the
  // probes below). A seed without a vector is skipped honestly and reported.
  const seedResult = await db.execute({
    args: [user.id],
    sql: `select s.track_id, t.embedding_blob
      from user_rec_seeds s
      join tracks t on t.track_id = s.track_id
      where s.user_id = ?
      order by s.added_at asc, s.track_id asc`,
  });
  const seedRows = typedRows<SeedVectorRow>(seedResult.rows);
  const probes: Uint8Array[] = [];
  const seedIds: string[] = [];
  const seedsSkipped: string[] = [];

  for (const row of seedRows) {
    const vector = readEmbeddingBlob(row.embedding_blob);

    seedIds.push(row.track_id);

    if (vector) {
      probes.push(toVectorProbe(vector));
    } else {
      seedsSkipped.push(row.track_id);
    }
  }

  if (probes.length === 0) {
    return { catalogue: [], findings: [], ok: true, seedsSkipped, seedsUsed: 0 };
  }

  // A row the user SEEDED is never recommended back to them — telling someone
  // about the track they just told us about is not a recommendation. Applied to
  // both halves of the blend.
  const seedExclusion =
    seedIds.length > 0 ? `and t.track_id not in (${seedIds.map(() => "?").join(", ")})` : "";

  const branches = (cte: string) =>
    probes
      .map(() => `select track_id, vector_distance_cos(vec, ?) as dist from ${cte}`)
      .join(" union all ");

  // THE CATALOGUE SCAN. Candidates are the ear lens's WHERE + the display-band
  // duplicate cut + the Spotify anchor; each candidate's max-similarity across
  // the seed set is `min(dist)` over one union-all branch per probe
  // (getTasteCosines), and the pool is cut IN SQL (getSimilarFindings) — only
  // (track_id, dist) pairs come back, never a vector.
  //
  // SQL-TEXT order decides the bind order: the CTE binds the seed exclusions
  // first, then one probe per branch, then the pool limit.
  const catalogueScan = await db.execute({
    args: [...seedIds, ...probes, RECOMMENDATIONS_POOL],
    sql: `with candidates as (
        select t.track_id, t.embedding_blob as vec
        from tracks t
        left join findings f on f.track_id = t.track_id
        where f.track_id is null
          and t.embedding_blob is not null
          and t.spotify_uri is not null
          and t.dismissed_at is null
          and t.duplicate_of_track_id is null
          and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
          and t.duration_ms < ${LONG_FORM_MS}
          ${seedExclusion}
      )
      select track_id, min(dist) as dist
      from (${branches("candidates")})
      where dist is not null
      group by track_id
      order by dist asc, track_id asc
      limit ?`,
  });

  // THE FINDINGS SLOTS (option B): the certified findings nearest the seed set,
  // same max-similarity shape over the finding join. These are the labeled slots
  // Fluncle's full voice rides — hydrated with the note + Log ID below.
  const findingsScan = await db.execute({
    args: [...seedIds, ...probes, FINDINGS_SLOT_COUNT],
    sql: `with candidates as (
        select t.track_id, t.embedding_blob as vec
        from tracks t
        join findings f on f.track_id = t.track_id
        where f.log_id is not null
          and t.embedding_blob is not null
          ${seedExclusion}
      )
      select track_id, min(dist) as dist
      from (${branches("candidates")})
      where dist is not null
      group by track_id
      order by dist asc, track_id asc
      limit ?`,
  });

  const cataloguePool = typedRows<ScanRow>(catalogueScan.rows);
  const findingSlots = typedRows<ScanRow>(findingsScan.rows);
  const hydrated = await hydrateTracks([
    ...cataloguePool.map((row) => row.track_id),
    ...findingSlots.map((row) => row.track_id),
  ]);

  // The catalogue pool → the diversity decay (the ear's EAR_DIVERSITY_DECAY
  // greed, via the shared diversifyRanked) → the page. The decay re-orders on
  // artist/year/key; the similarity each row DISPLAYS stays the true number.
  type PoolEntry = { row: HydrateRow; similarity: number };

  const pool: PoolEntry[] = cataloguePool.flatMap((scan) => {
    const row = hydrated.get(scan.track_id);
    const similarity = cosineFromDistance(scan.dist);

    return row && similarity !== null ? [{ row, similarity }] : [];
  });

  const catalogue = diversifyRanked(pool, RECOMMENDATIONS_PAGE, (entry) => {
    const artists = parseArtistsJson(entry.row.artists_json);

    return {
      artist: artists[0] ? artists[0].trim().toLowerCase() : null,
      key: entry.row.key ? entry.row.key.trim().toLowerCase() : null,
      score: entry.similarity,
      year: entry.row.release_date ? entry.row.release_date.slice(0, 4) : null,
    };
  }).map((entry) => ({
    artists: parseArtistsJson(entry.row.artists_json),
    ...readoutOf(entry.row),
    imageUrl: coverOf(entry.row),
    similarity: entry.similarity,
    spotifyUri: entry.row.spotify_uri ?? undefined,
    spotifyUrl: entry.row.spotify_url ?? undefined,
    title: entry.row.title,
    trackId: entry.row.track_id,
  }));

  const findings = findingSlots.flatMap((scan) => {
    const row = hydrated.get(scan.track_id);
    const similarity = cosineFromDistance(scan.dist);

    if (!row || row.log_id === null || similarity === null) {
      return [];
    }

    return [
      {
        artists: parseArtistsJson(row.artists_json),
        ...readoutOf(row),
        imageUrl: coverOf(row),
        logId: row.log_id,
        note: row.note ?? undefined,
        similarity,
        spotifyUri: row.spotify_uri ?? undefined,
        spotifyUrl: row.spotify_url ?? undefined,
        title: row.title,
        trackId: row.track_id,
      },
    ];
  });

  return { catalogue, findings, ok: true, seedsSkipped, seedsUsed: probes.length };
}

/** Hydrate the recommended rows in ONE batched read (never N+1), keyed by track id. */
async function hydrateTracks(trackIds: string[]): Promise<Map<string, HydrateRow>> {
  const ids = [...new Set(trackIds)];

  if (ids.length === 0) {
    return new Map();
  }

  const result = await (
    await getDb()
  ).execute({
    args: ids,
    sql: `select t.track_id, t.title, t.artists_json, t.album_image_url, t.spotify_url,
        t.spotify_uri, t.key, t.bpm, t.duration_ms, t.release_date, f.log_id, f.note,
        (select image_key from albums where albums.id = t.album_id) as album_image_key,
        (select image_state from albums where albums.id = t.album_id) as album_image_state,
        (select image_updated_at from albums where albums.id = t.album_id) as album_image_updated_at
      from tracks t
      left join findings f on f.track_id = t.track_id
      where t.track_id in (${ids.map(() => "?").join(", ")})`,
  });

  const byTrackId = new Map<string, HydrateRow>();

  for (const row of typedRows<HydrateRow>(result.rows)) {
    byTrackId.set(row.track_id, row);
  }

  return byTrackId;
}

/**
 * The instrument readout every track-shaped surface carries (DESIGN.md's Readout Rule): the
 * duration/BPM/key chips and the release year, each present ONLY when the row can back it — a
 * missing chip is an honest data gap upstream, never dropped by choice.
 */
function readoutOf(row: HydrateRow): {
  bpm?: number;
  durationMs?: number;
  key?: string;
  year?: string;
} {
  return {
    bpm: row.bpm ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    key: row.key ?? undefined,
    year: row.release_date ? row.release_date.slice(0, 4) : undefined,
  };
}

function coverOf(row: HydrateRow): string | undefined {
  return bestAlbumCoverUrl({
    imageKey: row.album_image_key,
    imageState: row.album_image_state,
    imageUpdatedAt: row.album_image_updated_at,
    spotifyUrl: row.album_image_url,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
