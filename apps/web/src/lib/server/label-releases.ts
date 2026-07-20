// THE FRESHNESS TAP (D8) — Spotify as the day-one freshness feed for the archive.
//
// ── THE DOCTRINE AMENDMENT (operator-ratified 2026-07-19; vendor swapped 2026-07-20) ──────────
// MusicBrainz WALKS the graph (crawl.ts): label → releases → artists → their releases, the whole
// recording-centric catalogue. But MusicBrainz's editorial database lags a release by ~2 weeks,
// so a Friday drop is invisible on /fresh until the volunteers enter it. So a second vendor taps
// FRESHNESS: a bounded per-label probe over the ENABLED seed labels that mints METADATA-ONLY
// catalogue rows with their real (day-one) release dates, closing the lag cliff. The tap never
// walks the graph and never certifies — it only taps freshness.
//
// ── WHY SPOTIFY, NOT APPLE ────────────────────────────────────────────────────────────────────
// The first cut used Apple Music's `record-labels` catalog. Live probes (2026-07-19) measured its
// seed-label coverage at 2/99 — only Hospital and one other resolved; RAM, Shogun, Viper, Critical,
// UKF and the rest simply do not exist as Apple record-label entities. A search-based Apple
// resolution was a MEASURED dead end. Spotify carries every seed label's fresh releases, and we
// already hold its OAuth (the publish path), so the tap rides the existing Spotify client — no new
// secret. Everything downstream of resolution (the dedupe contract, the mint path, the allowlist
// gate, the sweep/cron shape) is unchanged; only the vendor and the resolution mechanism differ.
//
// ── THE HARD CONSTRAINTS (never widened) ─────────────────────────────────────────────────────
//   - ENABLED seed labels ONLY (`labels.seed_state = 'enabled'` — the crawl gate's allowlist). A
//     disabled/undecided label is never probed. The probe mints tracks/albums for the PROBED
//     label and NOTHING else: no new labels, no artist-graph hops, no certification. Rows land in
//     the unlit tier exactly like a crawl mint (a `tracks` row with no `findings` row).
//   - The archive's invariants hold: `tracks.label` is the archive's OWN spelling of the seed
//     label (so `slugify(tracks.label) = labels.slug`, the disabled-label-veto invariant the Ear's
//     capture ladder depends on), and the row is linked to the KNOWN seed label directly (never a
//     re-resolve of Spotify's label string). `capture_status` is never named at insert — the DDL
//     default lands, so the row is nobody's capture work item until the operator rules.
//
// ── THE FUZZY-SEARCH + COPYRIGHTS POST-FILTER (mandatory) ─────────────────────────────────────
// `GET /search?type=album&q=label:"<name>" tag:new` finds a label's last-two-weeks releases with
// day-one dates — but its `label:` filter is FUZZY for generic names (live: `label:"RAM Records"`
// returned 93 junk albums; `label:"Hospital Records"` returned exactly its 2 real ones). Worse,
// OUR Spotify tier has NO `label` field on the full album object at all. So the post-filter is the
// `copyrights` array (present at our tier): an album is kept ONLY when the seed label's name
// FOLD-matches one of its ℗/© strings. No copyright match ⇒ skip (never mint on the fuzzy hit
// alone). Album-track objects carry no ISRC at our tier either, so each kept album's tracks are
// fetched individually (`GET /tracks?ids=`) for `external_ids.isrc` + duration.
//
// ── THE DEDUPE CONTRACT (the load-bearing design point — catalogue-dedupe.ts) ─────────────────
// This probe and the MB crawl converge on ONE row per recording from EITHER direction:
//   1. tap-first: before minting, skip any track already present by its Spotify id (`sp_<id>` or a
//      bare-id finding), its `spotify_uri`, its ISRC, OR an EXACT title fold on the SAME album (the
//      no/divergent-ISRC convergence). See `writeLabelReleaseTracks`.
//   2. MB-walk-later: crawl.ts's `writeCatalogueTracks` carries the SAME same-album title-fold
//      branch, so a later MB walk of a tap-first row folds to a skip instead of an `mb_` twin.
//
// ── BUDGET ────────────────────────────────────────────────────────────────────────────────────
// GET-only, riding the existing Spotify client (`spotifyFetch` + its 429 Retry-After backoff, #675)
// and the publish path's OAuth (`getSpotifyAccessToken`). ~1 search/label/day + a trickle of
// album/track reads — negligible. A 429 STOPS the pass cleanly (durable state, resumes next tick); a
// gone grant reports `configured: false` and is a no-op until the operator reconnects Spotify.

import { ensureAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import { getDb, typedRows } from "./db";
import { labelFold } from "./labels";
import { ApiError, getSpotifyAccessToken, SPOTIFY_REAUTH_REQUIRED, spotifyFetch } from "./spotify";

// ── Policy constants ──────────────────────────────────────────────────────────────────────────

/** Enabled seed labels probed per pass — oldest-probe-stamp first. Bounded so one tick stays a
 *  trickle on the shared Spotify budget, leaving headroom for the live publish/reach calls. */
export const PROBE_LABELS_PER_PASS = 5;

/** How stale a label's last probe may get before it is re-tapped. The cron runs daily, so 20h means
 *  every enabled label's freshness is refreshed each day without re-probing one twice a day when the
 *  CLI loops passes. */
const REPROBE_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** The base cooldown between two probe ATTEMPTS on a label that hit a transient Spotify error
 *  (failure-scaled below), so a persistently-erroring label backs off instead of retrying each tick. */
const FAILURE_COOLDOWN_BASE_MS = 6 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** How many enabled-label rows the worklist reads before the TS eligibility refine — a small
 *  multiple of the per-pass cap, so cooling-down rows never starve an eligible one out of the pass. */
const WORKLIST_OVERSCAN = PROBE_LABELS_PER_PASS * 4;

/** Fresh albums the search asks for. Spotify DOCUMENTS a page cap of 50, but OUR app's limited
 *  tier rejects any search `limit` above 10 with a 400 (measured live 2026-07-20: 10 → 200, every
 *  value 20–50 → 400) — the same family of quiet tier-cuts as the missing album `label` field. Ten
 *  is plenty: `tag:new` spans two weeks and even the busiest seed label ships fewer fresh records
 *  than that. */
const SEARCH_LIMIT = 10;

/** Albums inspected per label per pass, so one junk-heavy label (a fuzzy `label:` match returning
 *  scores of unrelated albums) cannot drain the whole Spotify budget in a single pass. */
const MAX_ALBUMS_PER_LABEL = 40;

/** Spotify's batch caps: 20 albums / 50 tracks per `?ids=` request. */
const ALBUMS_BATCH = 20;
const TRACKS_BATCH = 50;

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

/** One enabled seed label as the worklist reads it (identity + the probe reliability columns). */
type LabelProbeRow = {
  attemptedAt: null | string;
  checkedAt: null | string;
  failures: number;
  id: string;
  name: string;
  slug: string;
};

/** A parsed full album (`/albums?ids=`) — the fields the copyrights post-filter + the mint read. */
export type ProbeAlbum = {
  copyrights: string[];
  id: string;
  name: null | string;
  releaseDate: null | string;
  trackIds: string[];
};

/** A parsed full track (`/tracks?ids=`) — everything a valid catalogue row needs. */
export type ProbeTrack = {
  artistNames: string[];
  durationMs: number;
  isrc: null | string;
  spotifyTrackId: string;
  spotifyUri: string;
  spotifyUrl: string;
  title: string;
};

/** One probe pass's honest numbers — the op summary + the CLI/cron readout. */
export type LabelReleasesProbeResult = {
  /** Albums that PASSED the copyrights post-filter (genuinely this label's) across every label. */
  albumsMatched: number;
  /** Albums the label search returned across every label this pass (before the copyrights filter). */
  albumsSeen: number;
  /** False when the Spotify grant is gone — the whole tap is a no-op this tick (reconnect needed). */
  configured: boolean;
  dryRun: boolean;
  /** Labels that hit a TRANSIENT Spotify error this pass (backed off, re-probed later). */
  failedLabels: string[];
  /** The seed-label slugs probed this pass — or, in a dry run, the ones that WOULD be probed. */
  labelSlugs: string[];
  /** Enabled seed labels whose fresh-release search actually ran this pass. */
  labelsProbed: number;
  /** Catalogue rows this pass minted (never a certification). */
  newRows: number;
  /** The minted track ids — bounded (a few labels × their fresh releases), so honest to return. */
  newTrackIds: string[];
  /** True when the pass STOPPED on a Spotify 429 — the CLI stops looping; the next tick resumes. */
  rateLimited: boolean;
  /** Tracks skipped because they already exist in the archive (Spotify id / uri / ISRC / same-album
   *  title fold) — the dedupe contract, working. */
  skippedKnown: number;
};

// ── Pure helpers (exported for tests) ───────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Chunk an array into groups of at most `size` (the Spotify `?ids=` batching). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

/**
 * A Spotify album-search response → the album ids, in Spotify's returned order. Tolerant at every
 * hop (a malformed body yields an empty list, never a throw).
 */
export function parseLabelAlbumSearch(body: unknown): string[] {
  const items = (body as { albums?: { items?: unknown[] } } | null | undefined)?.albums?.items;
  const ids: string[] = [];

  for (const raw of Array.isArray(items) ? items : []) {
    const id = asString((raw as { id?: unknown }).id);

    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

/**
 * A Spotify `/albums?ids=` response → the parsed albums (copyrights + track ids + date). A null
 * entry (an invalid id) drops out. `copyrights` is flattened to its `text` strings for the fold.
 */
export function parseProbeAlbums(body: unknown): ProbeAlbum[] {
  const list = (body as { albums?: unknown[] } | null | undefined)?.albums;
  const albums: ProbeAlbum[] = [];

  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const album = raw as {
      copyrights?: Array<{ text?: unknown }>;
      id?: unknown;
      name?: unknown;
      release_date?: unknown;
      tracks?: { items?: Array<{ id?: unknown }> };
    };
    const id = asString(album.id);

    if (!id) {
      continue;
    }

    const copyrights = (Array.isArray(album.copyrights) ? album.copyrights : [])
      .map((entry) => asString(entry?.text))
      .filter((text): text is string => Boolean(text));
    const trackIds = (Array.isArray(album.tracks?.items) ? album.tracks.items : [])
      .map((track) => asString(track?.id))
      .filter((tid): tid is string => Boolean(tid));

    albums.push({
      copyrights,
      id,
      name: asString(album.name),
      releaseDate: asString(album.release_date),
      trackIds,
    });
  }

  return albums;
}

/**
 * A Spotify `/tracks?ids=` response → the parsed tracks (ISRC + duration + uri/url + artists). A
 * null entry drops out. `duration_ms` is the real duration (`duration_ms` is NOT NULL on `tracks`;
 * 0 is the honest unknown). A track with no id or no name drops out.
 */
export function parseProbeTracks(body: unknown): ProbeTrack[] {
  const list = (body as { tracks?: unknown[] } | null | undefined)?.tracks;
  const tracks: ProbeTrack[] = [];

  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const track = raw as {
      artists?: Array<{ name?: unknown }>;
      duration_ms?: unknown;
      external_ids?: { isrc?: unknown };
      external_urls?: { spotify?: unknown };
      id?: unknown;
      name?: unknown;
      uri?: unknown;
    };
    const spotifyTrackId = asString(track.id);
    const title = asString(track.name);

    if (!spotifyTrackId || !title) {
      continue;
    }

    const artistNames = (Array.isArray(track.artists) ? track.artists : [])
      .map((artist) => asString(artist?.name))
      .filter((name): name is string => Boolean(name));
    const duration = track.duration_ms;

    tracks.push({
      artistNames,
      durationMs:
        typeof duration === "number" && Number.isFinite(duration) ? Math.round(duration) : 0,
      isrc: asString(track.external_ids?.isrc),
      spotifyTrackId,
      spotifyUri: asString(track.uri) ?? `spotify:track:${spotifyTrackId}`,
      spotifyUrl:
        asString(track.external_urls?.spotify) ??
        `https://open.spotify.com/track/${spotifyTrackId}`,
      title,
    });
  }

  return tracks;
}

/**
 * THE POST-FILTER: does one of an album's copyright strings name the seed label? The seed label's
 * name is FOLD-matched (the shared `labelFold`: casefold to bare alphanumerics) as a SUBSTRING of a
 * folded ℗/© string — so "Med School" matches "℗ 2026 Med School Recordings" and a junk album whose
 * copyright names a different label is rejected. The fuzzy `label:` search hit ALONE is never enough
 * (that is how `label:"RAM Records"` returns 93 wrong albums); the copyright is the corroboration.
 * Pure, so the probe tests pin it directly.
 */
export function copyrightMatchesLabel(copyrights: string[], seedLabelName: string): boolean {
  const want = labelFold(seedLabelName);

  if (!want) {
    return false;
  }

  return copyrights.some((text) => labelFold(text).includes(want));
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────

/**
 * A freshness-tapped track's `track_id` — the sibling of crawl.ts's `catalogueTrackId`
 * (`mb_<recording-mbid>`). `tracks.track_id` is an opaque PK that happens to be the bare Spotify id
 * for a certified finding; a freshness-tapped row mints its own from the identity that exists for it
 * — the Spotify track id, namespaced `sp_<id>` so it is clearly a catalogue mint (like `mb_`), never
 * mistaken for a finding's bare-id PK. Deterministic, so a re-probe of the same track collides on
 * the primary key and writes nothing. Convergence with a bare-id finding rides the dedupe below
 * (`spotify_uri` / ISRC), not the PK.
 */
export function labelReleaseTrackId(spotifyTrackId: string): string {
  return `sp_${spotifyTrackId}`;
}

// ── The write (the tap half of the dedupe contract) ─────────────────────────────────────────────

/**
 * Write one album's tracks into `tracks` as CATALOGUE rows for the KNOWN seed label — deduped from
 * both directions, and nowhere near `findings`.
 *
 * THE DEDUPE, before the insert, skipping a track already present by ANY of:
 *   1. its Spotify id — the `sp_<id>` mint OR a bare-id finding (`track_id in (sp_<id>, <id>)`);
 *   2. its `spotify_uri` — a finding/mint anchored to the same Spotify track (the uri is NOT unique
 *      on `tracks`, so this app-level guard is what stops a duplicate anchor);
 *   3. its ISRC anywhere in `tracks` (a finding, a crawl mint, an earlier probe);
 *   4. an EXACT title fold on the SAME album (the no/divergent-ISRC MB-twin convergence).
 * Then `on conflict (track_id) do nothing` closes the two-ticks race at the primary key.
 *
 * `label` is the ARCHIVE's own spelling (the seed label's `name`), so `slugify(tracks.label)` lands
 * on `labels.slug`; `label_id` is stamped at the KNOWN seed label directly. `spotify_uri`/`spotify_url`
 * ARE set — the anchor sweep's job done for free. `capture_status` and every queue column are simply
 * never named — the DDL defaults land and no agent sweep can reach a `findings`-less row.
 */
async function writeLabelReleaseTracks(
  tracks: ProbeTrack[],
  ctx: {
    albumId: null | string;
    albumName: null | string;
    labelId: string;
    labelName: string;
    releaseDate: null | string;
  },
): Promise<{ skipped: number; written: number; writtenIds: string[] }> {
  if (tracks.length === 0) {
    return { skipped: 0, written: 0, writtenIds: [] };
  }

  const db = await getDb();
  // Both id forms: the `sp_` mint and a bare-id finding for the same Spotify track.
  const idKeys = tracks.flatMap((track) => [
    labelReleaseTrackId(track.spotifyTrackId),
    track.spotifyTrackId,
  ]);
  const uris = tracks.map((track) => track.spotifyUri);
  const isrcs = tracks.map((track) => track.isrc).filter((isrc): isrc is string => Boolean(isrc));

  const existing = await db.execute({
    args: [...idKeys, ...uris, ...isrcs],
    sql: `select track_id, spotify_uri, isrc from tracks
          where track_id in (${idKeys.map(() => "?").join(", ")})
             or spotify_uri in (${uris.map(() => "?").join(", ")})
          ${isrcs.length > 0 ? `or isrc in (${isrcs.map(() => "?").join(", ")})` : ""}`,
  });

  const heldIds = new Set<string>();
  const heldUris = new Set<string>();
  const heldIsrcs = new Set<string>();

  for (const row of typedRows<{
    isrc: null | string;
    spotify_uri: null | string;
    track_id: string;
  }>(existing.rows)) {
    heldIds.add(row.track_id);

    if (row.spotify_uri) {
      heldUris.add(row.spotify_uri);
    }

    if (row.isrc) {
      heldIsrcs.add(row.isrc);
    }
  }

  // The same-album title-fold convergence index (the no/divergent-ISRC MB-twin guard).
  const albumTitleFolds = await existingAlbumTitleFolds(ctx.albumId);

  let written = 0;
  let skipped = 0;
  const writtenIds: string[] = [];

  for (const track of tracks) {
    const trackId = labelReleaseTrackId(track.spotifyTrackId);
    const titleFold = foldTrackTitle(track.title);

    if (
      heldIds.has(trackId) ||
      heldIds.has(track.spotifyTrackId) ||
      heldUris.has(track.spotifyUri) ||
      (track.isrc && heldIsrcs.has(track.isrc)) ||
      (ctx.albumId && titleFold && albumTitleFolds.has(titleFold))
    ) {
      skipped += 1;
      continue;
    }

    const artists = track.artistNames.length > 0 ? track.artistNames : ["Unknown"];
    const result = await db.execute({
      args: [
        trackId,
        track.title,
        JSON.stringify(artists),
        track.durationMs,
        ctx.albumName,
        track.isrc,
        ctx.labelName,
        ctx.releaseDate,
        track.spotifyUri,
        track.spotifyUrl,
      ],
      // `capture_status`, `album_image_url`, `mb_recording_id`, `in_release_id`/`in_master_id` are
      // deliberately unnamed — the DDL defaults (NULL / 'pending') land. The album's own cover
      // master arrives at ALBUM grain via its own sweep, never at this mint.
      sql: `insert into tracks
              (track_id, title, artists_json, duration_ms, album, isrc, label, release_date,
               spotify_uri, spotify_url)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (track_id) do nothing`,
    });

    if (result.rowsAffected > 0) {
      written += 1;
      writtenIds.push(trackId);
      heldIds.add(trackId);
      heldUris.add(track.spotifyUri);

      if (track.isrc) {
        heldIsrcs.add(track.isrc);
      }

      if (titleFold) {
        albumTitleFolds.set(titleFold, trackId);
      }
    } else {
      skipped += 1;
    }
  }

  if (writtenIds.length > 0) {
    const placeholders = writtenIds.map(() => "?").join(", ");

    // The label edge, stamped directly at the KNOWN seed label — no re-resolve of Spotify's string.
    await db.execute({
      args: [ctx.labelId, ...writtenIds],
      sql: `update tracks set label_id = ? where track_id in (${placeholders})`,
    });

    // The album edge (fold on the album-title slug — Spotify carries no release-group MBID, so
    // `ensureAlbum`'s slug fallback is what converges a tap-minted album with an MB-crawled one).
    if (ctx.albumId) {
      await db.execute({
        args: [ctx.albumId, ...writtenIds],
        sql: `update tracks set album_id = ? where track_id in (${placeholders})`,
      });
    }

    // The artist edge — the NAME-FOLD link to ALREADY-CERTIFIED artists only (artists.ts). It mints
    // nothing and hops nowhere, so it is not a graph expansion; it just lets a tapped row show its
    // artist's avatar on /fresh exactly as a crawl-tapped row does.
    await linkTracksToArtistEntities(writtenIds);
  }

  return { skipped, written, writtenIds };
}

/**
 * Of a set of Spotify track ids, the ones the archive does NOT already hold (by `sp_<id>`, a bare-id
 * finding, or the `spotify_uri` anchor) — the pre-fetch filter that skips the per-album `/tracks`
 * read for an album whose tracks are all already minted, keeping a daily re-probe a true trickle.
 */
async function unmintedSpotifyTrackIds(spotifyTrackIds: string[]): Promise<string[]> {
  if (spotifyTrackIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const idKeys = spotifyTrackIds.flatMap((id) => [labelReleaseTrackId(id), id]);
  const uris = spotifyTrackIds.map((id) => `spotify:track:${id}`);

  const existing = await db.execute({
    args: [...idKeys, ...uris],
    sql: `select track_id, spotify_uri from tracks
          where track_id in (${idKeys.map(() => "?").join(", ")})
             or spotify_uri in (${uris.map(() => "?").join(", ")})`,
  });

  const held = new Set<string>();

  for (const row of typedRows<{ spotify_uri: null | string; track_id: string }>(existing.rows)) {
    held.add(row.track_id);

    if (row.spotify_uri) {
      held.add(row.spotify_uri);
    }
  }

  return spotifyTrackIds.filter(
    (id) => !held.has(labelReleaseTrackId(id)) && !held.has(id) && !held.has(`spotify:track:${id}`),
  );
}

// ── Label reliability writers ───────────────────────────────────────────────────────────────────

function failureCooldownMs(failures: number): number {
  if (failures <= 0) {
    return FAILURE_COOLDOWN_BASE_MS;
  }

  return Math.min(FAILURE_COOLDOWN_BASE_MS * 2 ** Math.min(failures, 10), FAILURE_COOLDOWN_MAX_MS);
}

/** A successful probe: stamp the cadence + clear the failure streak. */
async function markLabelChecked(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels
          set label_releases_checked_at = ?, label_releases_failures = 0
          where slug = ?`,
  });
}

/** A transient Spotify error: bump the streak + stamp the attempt (drives the backoff). */
async function recordLabelFailure(slug: string, priorFailures: number): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [priorFailures + 1, new Date().toISOString(), slug],
    sql: `update labels
          set label_releases_failures = ?, label_releases_attempted_at = ?
          where slug = ?`,
  });
}

// ── The worklist ────────────────────────────────────────────────────────────────────────────────

/**
 * The probe worklist: ENABLED seed labels, oldest-probe-stamp first (NULLs — never-probed — sort
 * first). Reads over the partial `labels_label_releases_queue_idx`, so it never scans the
 * crawler-swollen labels table. The TS eligibility refine (below) drops labels re-probed too
 * recently or cooling down after an error.
 */
async function listProbeLabels(): Promise<LabelProbeRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [WORKLIST_OVERSCAN],
    sql: `select id, slug, name, label_releases_checked_at, label_releases_attempted_at,
                 label_releases_failures
          from labels
          where seed_state = 'enabled'
          order by label_releases_checked_at asc, slug asc
          limit ?`,
  });

  return typedRows<{
    id: string;
    label_releases_attempted_at: null | string;
    label_releases_checked_at: null | string;
    label_releases_failures: null | number;
    name: string;
    slug: string;
  }>(result.rows).map((row) => ({
    attemptedAt: row.label_releases_attempted_at,
    checkedAt: row.label_releases_checked_at,
    failures: typeof row.label_releases_failures === "number" ? row.label_releases_failures : 0,
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

/** Whether a label is eligible to be probed THIS pass, given the reliability state and the clock. */
function isEligible(label: LabelProbeRow, now: number): boolean {
  // Backing off after a transient error: skip until the failure-scaled cooldown elapses.
  if (label.failures > 0 && label.attemptedAt) {
    const last = Date.parse(label.attemptedAt);

    if (Number.isFinite(last) && now - last < failureCooldownMs(label.failures)) {
      return false;
    }
  }

  // Otherwise eligible once the last successful probe is stale (or it was never probed).
  if (!label.checkedAt) {
    return true;
  }

  const last = Date.parse(label.checkedAt);

  return !Number.isFinite(last) || now - last >= REPROBE_INTERVAL_MS;
}

// ── The Spotify reads ──────────────────────────────────────────────────────────────────────────

/** One Spotify GET's outcome, from the pass's point of view. */
type SpotifyGet =
  | { body: unknown; kind: "ok" }
  | { kind: "failed" }
  | { kind: "ratelimited" }
  | { kind: "unauthorized" };

/**
 * One authed Spotify GET, reusing the publish path's token + the client's 429 backoff. Never throws:
 * a gone grant → `unauthorized` (the pass stops, a no-op until reconnect), a 429 → `ratelimited`
 * (the pass stops cleanly), any other error → `failed` (the caller backs the label off). The
 * `findSpotifyTrackByIsrc` discipline, verbatim.
 */
async function spotifyGet(path: string, accessToken: string): Promise<SpotifyGet> {
  try {
    const response = await spotifyFetch(path, accessToken);

    return { body: await response.json(), kind: "ok" };
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "spotify_not_authenticated" || error.code === SPOTIFY_REAUTH_REQUIRED)
    ) {
      return { kind: "unauthorized" };
    }

    if (error instanceof Error && error.message.includes("429")) {
      return { kind: "ratelimited" };
    }

    return { kind: "failed" };
  }
}

function labelSearchPath(labelName: string): string {
  // `q=label:"<name>" tag:new` — the label's last-two-weeks releases with day-one dates.
  const q = `label:"${labelName}" tag:new`;
  const params = new URLSearchParams({ limit: String(SEARCH_LIMIT), q, type: "album" });

  return `/search?${params.toString()}`;
}

// ── The pass ──────────────────────────────────────────────────────────────────────────────────

/** How probing one label ended — the signal the main loop acts on. */
type LabelSignal = "continue" | "stop-rate" | "stop-unauth";

/**
 * Probe ONE label: search its fresh releases, copyright-filter the albums, mint the tracks the
 * archive does not already hold. Stamps the cadence on success, backs the label off on a transient
 * error. Returns whether the pass should continue, stop on a 429, or stop on a gone grant.
 */
async function probeOneLabel(
  label: LabelProbeRow,
  accessToken: string,
  result: LabelReleasesProbeResult,
): Promise<LabelSignal> {
  // 1. Search the label's fresh releases.
  const search = await spotifyGet(labelSearchPath(label.name), accessToken);

  if (search.kind === "unauthorized") {
    return "stop-unauth";
  }

  if (search.kind === "ratelimited") {
    result.rateLimited = true;

    return "stop-rate";
  }

  if (search.kind === "failed") {
    await recordLabelFailure(label.slug, label.failures);
    result.failedLabels.push(label.slug);

    return "continue";
  }

  result.labelsProbed += 1;
  result.labelSlugs.push(label.slug);

  const albumIds = [...new Set(parseLabelAlbumSearch(search.body))].slice(0, MAX_ALBUMS_PER_LABEL);
  result.albumsSeen += albumIds.length;

  if (albumIds.length === 0) {
    await markLabelChecked(label.slug);

    return "continue";
  }

  // 2. Fetch the full albums (batched) for their copyrights + track ids.
  const albums: ProbeAlbum[] = [];

  for (const ids of chunk(albumIds, ALBUMS_BATCH)) {
    const outcome = await spotifyGet(`/albums?ids=${ids.join(",")}`, accessToken);

    if (outcome.kind === "unauthorized") {
      return "stop-unauth";
    }

    if (outcome.kind === "ratelimited") {
      result.rateLimited = true;

      return "stop-rate";
    }

    if (outcome.kind === "failed") {
      // A transient error mid-label — back it off and DON'T stamp the cadence, so the next tick
      // re-probes (the dedupe skips anything already minted).
      await recordLabelFailure(label.slug, label.failures);
      result.failedLabels.push(label.slug);

      return "continue";
    }

    albums.push(...parseProbeAlbums(outcome.body));
  }

  // 3. THE POST-FILTER: keep only albums whose copyrights name the seed label.
  const matched = albums.filter((album) => copyrightMatchesLabel(album.copyrights, label.name));
  result.albumsMatched += matched.length;

  // 4. Mint the un-held tracks of each matched album.
  for (const album of matched) {
    const unminted = await unmintedSpotifyTrackIds(album.trackIds);

    if (unminted.length === 0) {
      continue;
    }

    const probeTracks: ProbeTrack[] = [];

    for (const ids of chunk(unminted, TRACKS_BATCH)) {
      const outcome = await spotifyGet(`/tracks?ids=${ids.join(",")}`, accessToken);

      if (outcome.kind === "unauthorized") {
        return "stop-unauth";
      }

      if (outcome.kind === "ratelimited") {
        result.rateLimited = true;

        return "stop-rate";
      }

      if (outcome.kind === "failed") {
        await recordLabelFailure(label.slug, label.failures);
        result.failedLabels.push(label.slug);

        return "continue";
      }

      probeTracks.push(...parseProbeTracks(outcome.body));
    }

    // The album row, folded on the album-title slug (Spotify carries no release-group MBID).
    const albumId = (await ensureAlbum(album.name, null)) ?? null;
    const { skipped, written, writtenIds } = await writeLabelReleaseTracks(probeTracks, {
      albumId,
      albumName: album.name,
      labelId: label.id,
      labelName: label.name,
      releaseDate: album.releaseDate,
    });

    result.newRows += written;
    result.skippedKnown += skipped;
    result.newTrackIds.push(...writtenIds);
  }

  await markLabelChecked(label.slug);

  return "continue";
}

/**
 * ONE bounded probe pass. Reads the enabled seed labels due for work and probes each — a Spotify
 * fresh-release search → the copyrights post-filter → a per-track ISRC read → the deduped mint. A
 * gone Spotify grant makes the whole pass a no-op (`configured: false`); a 429 STOPS it cleanly
 * (durable state resumes next tick).
 *
 * `dryRun` reports the labels that WOULD be probed and makes no Spotify call and no write.
 */
export async function probeLabelReleases({
  dryRun = false,
  limit = PROBE_LABELS_PER_PASS,
}: { dryRun?: boolean; limit?: number } = {}): Promise<LabelReleasesProbeResult> {
  const now = Date.now();
  const result: LabelReleasesProbeResult = {
    albumsMatched: 0,
    albumsSeen: 0,
    configured: true,
    dryRun,
    failedLabels: [],
    labelSlugs: [],
    labelsProbed: 0,
    newRows: 0,
    newTrackIds: [],
    rateLimited: false,
    skippedKnown: 0,
  };

  const cap = Math.max(1, Math.min(limit, PROBE_LABELS_PER_PASS));
  const candidates = await listProbeLabels();
  const eligible = candidates.filter((label) => isEligible(label, now)).slice(0, cap);

  if (eligible.length === 0) {
    return result;
  }

  if (dryRun) {
    // Report the eligible labels (the "would probe" set) without any Spotify call or write.
    result.labelSlugs = eligible.map((label) => label.slug);

    return result;
  }

  // The publish path's OAuth. A gone grant makes the whole tap a no-op until the operator reconnects
  // Spotify — the same posture the ISRC-anchor legs take (findSpotifyTrackByIsrc).
  let accessToken: string;

  try {
    accessToken = await getSpotifyAccessToken();
  } catch {
    return { ...result, configured: false };
  }

  for (const label of eligible) {
    const signal = await probeOneLabel(label, accessToken, result);

    if (signal === "stop-unauth") {
      return { ...result, configured: false };
    }

    if (signal === "stop-rate") {
      break;
    }
  }

  return result;
}
