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
// ── THE ROUND TRIP: onto Apify, and back (2026-07-20) ─────────────────────────────────────────
// For half a day the tap ran OFF this app, on the Apify actor `musicae~spotify-extended-scraper`
// (the box-runs-actor / Worker-verifies split the catalogue ANCHOR still uses). The reason was
// budget: this official app's tier is small and SHARED with the user-facing paths, and an unpaced
// tap starved them. That move is REVERTED, because the actor's ALBUM mode broke Spotify-side the
// same day — measured live: an album search, an album-by-id, and even a famous-album query all
// returned `result:"0/N", albums:[]` while the actor's TRACK mode kept working and the actor's own
// code was untouched (last modified 10 days prior). That signature is a rotated GraphQL
// persisted-query hash on Spotify's side, which only the community maintainer can re-fix; it does
// not self-heal on our schedule. The alternatives were measured dead too: `apiharvest`'s actors
// 403 behind their residential proxy (2026-07-18), and the working TRACK mode cannot substitute —
// `label:"X" tag:new` returns nothing there (`tag:new` is ALBUM-only) and track results carry no
// release_date, which is the one field this tap exists to get.
// The official API's album search, by contrast, is a DOCUMENTED endpoint rather than a scraped
// GraphQL op, it is stable, and it does support `label:"X" tag:new` (verified live). So the tap
// comes home — and the budget problem that drove it away is solved properly now, by the shared
// call meter (./spotify-budget.ts) rather than by a second vendor. See the BUDGET section below.
// THE ANCHOR SWEEP IS UNAFFECTED: it uses the actor's TRACK mode, which still works, and stays.
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
// ── THE TWO-SIGNAL GATE: artist-grounding AND an exact copyright match (mandatory) ────────────
// `GET /search?type=album&q=label:"<name>" tag:new` finds a label's last-two-weeks releases with
// day-one dates — but its `label:` filter is FUZZY for generic names (live: `label:"RAM Records"`
// returned 93 junk albums), and OUR Spotify tier has NO `label` field on the album object at all.
// A single loose filter is not enough: the FIRST live drain minted 195 rows, MANY cross-genre (an
// Indian devotional record, Brazilian live albums, a Christmas record) that reached PUBLIC /fresh —
// because a loose SUBSTRING copyright match caught homonym labels worldwide ("Lens" ⊂ "Silent Lens";
// "Pilot." ⊂ Brazilian "Kelton Piloto"). So an album mints ONLY when BOTH signals agree:
//   (A) ARTIST-GROUNDING (the primary identity/genre anchor) — at least one of the album's Spotify
//       artist ids (`artists[].id`, carried on the album object — a LOCAL DB lookup, no extra call)
//       is already in our `artists.spotify_artist_id`. This killed 100% of the cross-genre junk
//       (every junk row was by an artist we had never certified). See `knownSpotifyArtistIds`.
//   (B) EXACT COPYRIGHT MATCH (the secondary attribution confirmation) — the copyright's label
//       portion (`stripCopyrightPrefix`, dropping the ℗/© + year) fold-EQUALS the seed name, not a
//       substring `includes`. See `copyrightMatchesLabel`.
// THE DELIBERATE TRADEOFF: a brand-NEW artist's debut on a real seed label is skipped until they
// exist in our archive — the MB tail-first re-arm backfills that within a day or two. Correctness
// over completeness is the right call for a public surface.
//
// Album-track objects carry no ISRC at our tier, so each kept album's tracks are fetched one at a
// time (`GET /tracks/{id}`) for `external_ids.isrc` + duration. SINGLES ONLY: the batch endpoints
// (`/albums?ids=`, `/tracks?ids=`) are 403 at our tier — see MAX_FETCHES_PER_PASS.
//
// ── THE DEDUPE CONTRACT (the load-bearing design point — catalogue-dedupe.ts) ─────────────────
// This probe and the MB crawl converge on ONE row per recording from EITHER direction:
//   1. tap-first: before minting, skip any track already present by its Spotify id (`sp_<id>` or a
//      bare-id finding), its `spotify_uri`, its ISRC, OR an EXACT title fold on the SAME album (the
//      no/divergent-ISRC convergence). See `writeLabelReleaseTracks`.
//   2. MB-walk-later: crawl.ts's `writeCatalogueTracks` carries the SAME same-album title-fold
//      branch, so a later MB walk of a tap-first row folds to a skip instead of an `mb_` twin.
//
// ── BUDGET: THE TAP TAKES ONLY SLACK (the priority rule) ─────────────────────────────────────
// USER WRITE PATHS GET THE WINDOW; THE TAP TAKES ONLY SLACK. Spotify rate-limits per-APP over a
// rolling ~30s window, and ONE app serves everything: a new crew member's playlist mint, the
// Frontier refresh, publish, /reach — and this tap. The mint is a user standing at a signup screen;
// the tap is a background drain that nobody is waiting on. So they must not compete as equals.
//
// The shared meter (./spotify-budget.ts) is the common view: every caller RECORDS each call into a
// fixed-window counter and CONSULTS it before making one. The mint's rule is "is there ANY budget
// left" (`isSpotifyCallBudgetAvailable`). The tap's rule is STRICTER — it holds itself to
// `TAP_BUDGET_CEILING`, a FRACTION of the window (half), so it stops while there is still real
// headroom and a mint arriving a moment later finds room. It never spends the last of the window.
//
// Hitting that ceiling is not an error: the pass ENDS CLEANLY and the durable per-label
// `label_releases_checked_at` cadence means the next tick resumes exactly where it stopped. Never a
// burst, never a wait-loop inside the Worker. A 429 (the backstop beneath the meter, #675) stops the
// pass the same way; a gone grant reports `configured: false` and is a no-op until Spotify is
// reconnected. GET-only throughout, on the publish path's OAuth (`getSpotifyAccessToken`).
//
// The volume is small by construction — ~1 search/label/day plus a trickle of single album/track
// reads — so at today's scale the tap and the user paths coexist comfortably inside one app's
// budget. If the crew grows enough that mints regularly find the window spent, the answer is to
// measure the app's real sustainable rate and raise `SPOTIFY_CALL_WINDOW_MAX` (the meter documents
// this), not to loosen the tap's ceiling.

import { ensureAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import { getDb, typedRows } from "./db";
import { labelFold } from "./labels";
import { ApiError, getSpotifyAccessToken, SPOTIFY_REAUTH_REQUIRED, spotifyFetch } from "./spotify";
import { readSpotifyCallCount, recordSpotifyCall, SPOTIFY_CALL_WINDOW_MAX } from "./spotify-budget";

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
 *  unrelated albums) cannot drain the whole Spotify budget in a single pass. Effectively bounded by
 *  `SEARCH_LIMIT` (10) already; this is a belt on top of it. */
const MAX_ALBUMS_PER_LABEL = 40;

/**
 * SINGLES ONLY — the batch endpoints are GONE at our app tier. Measured live 2026-07-20:
 * `GET /v1/albums?ids=…` → 403 and `GET /v1/tracks?ids=…` → 403 (the same family of tier-cuts as the
 * missing album `label` field and the search `limit` ≤ 10 cap), while the SINGLE reads
 * `GET /v1/albums/{id}` and `GET /v1/tracks/{id}` both → 200 (the single album carries `copyrights`;
 * the single track carries `external_ids.isrc` + duration). So the probe fetches one id at a time.
 *
 * Budget stays sane by construction: only fuzzy-search HITS get an album read (≤ `SEARCH_LIMIT`
 * per label → tens/day archive-wide), and only copyright-PASSING albums get their tracks read. This
 * ceiling is the backstop against one pathological day spraying calls: once a pass has made this
 * many single reads it ends CLEANLY (no more labels this tick), leaving the un-stamped labels for
 * the next tick — the durable `label_releases_checked_at` cadence resumes exactly where it left off.
 */
const MAX_FETCHES_PER_PASS = 150;

/**
 * THE TAP'S SHARE OF THE SHARED SPOTIFY WINDOW — the "takes only slack" number.
 *
 * The meter's `SPOTIFY_CALL_WINDOW_MAX` (24 calls / 30s) is the ceiling for ALL callers combined.
 * A user-facing path may spend right up to it: someone is waiting. The tap may not. It stops at
 * HALF the window, so at the instant the tap steps back there is still a full half-window of room
 * for a mint or a refresh that arrives next — the tap can never be the caller that spent the last
 * call before a user needed one.
 *
 * Half is the deliberate choice: a smaller fraction would make the tap's daily drain crawl for no
 * added user safety (a mint costs 2–3 calls, so half a window is many mints' worth of headroom),
 * and a larger one starts to feel like competing. This is the knob to turn if the tap ever needs
 * to be quieter still — turning it DOWN is always safe; turning it up trades user headroom away.
 */
export const TAP_BUDGET_CEILING = Math.floor(SPOTIFY_CALL_WINDOW_MAX / 2);

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

/** A parsed full album (`GET /albums/{id}`) — the fields the two-signal gate + the mint read. */
export type ProbeAlbum = {
  copyrights: string[];
  id: string;
  name: null | string;
  releaseDate: null | string;
  /** The album's Spotify artist ids (`artists[].id`) — the ARTIST-GROUNDING key. Carried on the
   *  album object itself, so grounding is a local DB lookup, never an extra Spotify call. */
  spotifyArtistIds: string[];
  trackIds: string[];
};

/** A parsed full track (`GET /tracks/{id}`) — everything a valid catalogue row needs. */
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
  /** Albums that PASSED BOTH signals (artist-grounded AND exact copyright match) and will mint. */
  albumsMatched: number;
  /** Albums the label search returned across every label this pass (before the two-signal gate). */
  albumsSeen: number;
  /** True when the pass STEPPED BACK from the shared Spotify window at `TAP_BUDGET_CEILING` —
   *  leaving the rest of the window for the user-facing paths. Not an error: the un-stamped labels
   *  resume next tick off their durable cadence stamps. */
  budgetPaused: boolean;
  /** False when the Spotify grant is gone — the whole tap is a no-op this tick (reconnect needed). */
  configured: boolean;
  dryRun: boolean;
  /** Labels that hit a TRANSIENT Spotify error this pass (backed off, re-probed later). */
  failedLabels: string[];
  /** The seed-label slugs probed this pass — or, in a dry run, the ones that WOULD be probed. */
  labelSlugs: string[];
  /** Single album/track reads that failed (a 404/5xx on `GET /albums/{id}` or `/tracks/{id}`) and
   *  were SKIPPED — never a label failure stamp (that is reserved for the search call). */
  failedFetches: number;
  /** True when the pass ENDED EARLY on the per-pass single-fetch ceiling (`MAX_FETCHES_PER_PASS`).
   *  The un-stamped labels resume next tick; a soft cap, not an error. */
  fetchCeilingHit: boolean;
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
  /** Albums DROPPED for carrying no `release_date` — a row /fresh could never surface, so never
   *  minted. Dropped BEFORE the two-signal gate (an undated album is unusable however it is
   *  attributed). Normally 0 on this vendor; the counter is the tripwire if that ever changes. */
  skippedUndated: number;
  /** Albums that passed the EXACT copyright match but were DROPPED for artist-grounding — no artist
   *  on the album is in our archive yet (a homonym label, or a debut awaiting the MB backfill). */
  skippedUngrounded: number;
};

// ── Pure helpers (exported for tests) ───────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
 * A Spotify `GET /albums/{id}` response → the parsed album (copyrights + track ids + date), or null
 * when the body carries no id. The SINGLE-album shape: the album object is the top-level body (no
 * `{ albums: [...] }` batch wrapper — the batch endpoint is 403 at our tier). `copyrights` is
 * flattened to its `text` strings for the fold. Pure, so the probe tests pin it directly.
 */
export function parseProbeAlbum(body: unknown): ProbeAlbum | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const album = body as {
    artists?: Array<{ id?: unknown }>;
    copyrights?: Array<{ text?: unknown }>;
    id?: unknown;
    name?: unknown;
    release_date?: unknown;
    tracks?: { items?: Array<{ id?: unknown }> };
  };
  const id = asString(album.id);

  if (!id) {
    return null;
  }

  return {
    copyrights: (Array.isArray(album.copyrights) ? album.copyrights : [])
      .map((entry) => asString(entry?.text))
      .filter((text): text is string => Boolean(text)),
    id,
    name: asString(album.name),
    releaseDate: asString(album.release_date),
    spotifyArtistIds: (Array.isArray(album.artists) ? album.artists : [])
      .map((artist) => asString(artist?.id))
      .filter((aid): aid is string => Boolean(aid)),
    trackIds: (Array.isArray(album.tracks?.items) ? album.tracks.items : [])
      .map((track) => asString(track?.id))
      .filter((tid): tid is string => Boolean(tid)),
  };
}

/**
 * A Spotify `GET /tracks/{id}` response → the parsed track (ISRC + duration + uri/url + artists), or
 * null when the body carries no id or no name. The SINGLE-track shape: the track object is the
 * top-level body (no `{ tracks: [...] }` batch wrapper — the batch endpoint is 403 at our tier).
 * `duration_ms` is the real duration (`duration_ms` is NOT NULL on `tracks`; 0 is the honest
 * unknown). Pure, so the probe tests pin it directly.
 */
export function parseProbeTrack(body: unknown): ProbeTrack | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const track = body as {
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
    return null;
  }

  const duration = track.duration_ms;

  return {
    artistNames: (Array.isArray(track.artists) ? track.artists : [])
      .map((artist) => asString(artist?.name))
      .filter((name): name is string => Boolean(name)),
    durationMs:
      typeof duration === "number" && Number.isFinite(duration) ? Math.round(duration) : 0,
    isrc: asString(track.external_ids?.isrc),
    spotifyTrackId,
    spotifyUri: asString(track.uri) ?? `spotify:track:${spotifyTrackId}`,
    spotifyUrl:
      asString(track.external_urls?.spotify) ?? `https://open.spotify.com/track/${spotifyTrackId}`,
    title,
  };
}

/**
 * Strip a copyright string's leading notice down to its LABEL-ATTRIBUTION portion: the ℗/© (or
 * `(P)`/`(C)`) symbol(s) and the copyright year. `"℗ 2026 Hospital Records" → "Hospital Records"`.
 * Symbols may repeat (`"© ℗ 2026 …"`) and precede a single 4-digit year. Exported for the tests.
 */
export function stripCopyrightPrefix(text: string): string {
  return text.replace(/^\s*(?:[℗©]\s*|\((?:p|c)\)\s*)*(?:\d{4}\s+)?/iu, "").trim();
}

/**
 * THE COPYRIGHT SIGNAL (secondary): does one of an album's copyright strings name the seed label
 * EXACTLY? The copyright's label portion (`stripCopyrightPrefix`) is fold-compared to the seed name
 * for EQUALITY — not a substring `includes`. This is deliberate: a loose substring match caught
 * homonym labels worldwide for generic seed names ("Lens" matched any copyright containing "lens" —
 * "℗ 2026 Silent Lens"; "Pilot." matched Brazilian "Kelton Piloto"), spraying cross-genre junk onto
 * a PUBLIC surface. Exact-fold-equal rejects "silent lens" ≠ "lens" while still confirming a real
 * "℗ 2026 <Seed Label>" attribution. It is the SECONDARY confirmation — the ARTIST-GROUNDING gate
 * (`knownSpotifyArtistIds`) is the primary identity/genre anchor. Pure, so the probe tests pin it.
 */
export function copyrightMatchesLabel(copyrights: string[], seedLabelName: string): boolean {
  const want = labelFold(seedLabelName);

  if (!want) {
    return false;
  }

  return copyrights.some((text) => labelFold(stripCopyrightPrefix(text)) === want);
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

/**
 * THE ARTIST-GROUNDING gate (the primary identity/genre anchor): of a set of Spotify artist ids,
 * the ones already in our archive (`artists.spotify_artist_id`). An album mints ONLY when at least
 * one of ITS artist ids is in this set — which kills 100% of the cross-genre junk the fuzzy Spotify
 * `label:` search returns (an Indian devotional record, a Brazilian live album — every one by an
 * artist we have never certified), while keeping a real seed-label release (whose artists we already
 * hold). A local, indexed lookup on the unique `spotify_artist_id` — NO extra Spotify call; the
 * album object already carries `artists[].id`. The `in` list is bounded by the pass's few albums.
 */
async function knownSpotifyArtistIds(spotifyArtistIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(spotifyArtistIds.filter(Boolean))];

  if (ids.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const result = await db.execute({
    args: ids,
    sql: `select spotify_artist_id from artists
          where spotify_artist_id in (${ids.map(() => "?").join(", ")})`,
  });

  return new Set(
    typedRows<{ spotify_artist_id: string }>(result.rows).map((row) => row.spotify_artist_id),
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
 * Has the tap still got SLACK in the shared Spotify window — is the window's count below the tap's
 * own `TAP_BUDGET_CEILING` (half), rather than merely below the meter's hard max? Consulted before
 * each label and before each batch of single reads, so the tap steps back with user headroom left.
 *
 * FAIL-OPEN, the meter's own documented posture: a KV read that throws answers TRUE. The meter is a
 * soft governor and `spotifyFetch`'s per-call 429 backoff is the real safety net, so a settings-store
 * hiccup must never darken the tap entirely.
 */
async function tapHasBudgetHeadroom(): Promise<boolean> {
  try {
    return (await readSpotifyCallCount(Date.now())) < TAP_BUDGET_CEILING;
  } catch {
    return true;
  }
}

/**
 * Record one call the tap just made into the shared meter, so the user-facing paths see the tap's
 * spend. Recorded whatever the outcome — a 429 or a 500 SPENT the call as surely as a 200 did, and
 * a meter that only counted successes would under-report exactly when the app is most stressed.
 * Swallows its own faults for the same fail-open reason as above.
 */
async function recordTapCall(): Promise<void> {
  try {
    await recordSpotifyCall(Date.now());
  } catch {
    // The meter is advisory; a KV hiccup must not fail a pass.
  }
}

/**
 * One authed Spotify GET, reusing the publish path's token + the client's 429 backoff, RECORDED into
 * the shared call meter. Never throws: a gone grant → `unauthorized` (the pass stops, a no-op until
 * reconnect), a 429 → `ratelimited` (the pass stops cleanly), any other error → `failed` (the caller
 * backs the label off). The `findSpotifyTrackByIsrc` discipline, verbatim.
 */
async function spotifyGet(path: string, accessToken: string): Promise<SpotifyGet> {
  try {
    const response = await spotifyFetch(path, accessToken);
    await recordTapCall();

    return { body: await response.json(), kind: "ok" };
  } catch (error) {
    // The call went out and counted against the app's window even though it came back an error.
    await recordTapCall();

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

/** How probing one label ended — the signal the main loop acts on. `stop-meter` is the polite one:
 *  the tap hit its share of the shared Spotify window and steps back with user headroom to spare. */
type LabelSignal = "continue" | "stop-budget" | "stop-meter" | "stop-rate" | "stop-unauth";

/** A mutable per-PASS single-fetch counter, threaded through every label so the ceiling is a
 *  pass-wide budget rather than a per-label one. */
type FetchBudget = { fetches: number };

/**
 * Probe ONE label: search its fresh releases, copyright-filter the albums (each fetched as a SINGLE
 * `GET /albums/{id}` — the batch endpoint is 403 at our tier), and mint the tracks the archive does
 * not already hold (each fetched as a SINGLE `GET /tracks/{id}`). Stamps the cadence on success,
 * backs the LABEL off only on a search error; a failed single album/track read is skipped + counted,
 * never a label stamp. Returns whether the pass should continue, stop on the fetch ceiling, a 429, or
 * a gone grant.
 */
async function probeOneLabel(
  label: LabelProbeRow,
  accessToken: string,
  result: LabelReleasesProbeResult,
  budget: FetchBudget,
): Promise<LabelSignal> {
  // 1. Search the label's fresh releases. A search error backs the LABEL off (the one place that
  //    stamps a label failure — its own read failed, so its whole probe is untrustworthy this tick).
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

  // 2. Fetch each album as a SINGLE `GET /albums/{id}` (the batch endpoint is 403 at our tier). A
  //    failed single read SKIPS that album and continues — never a label stamp. The meter is
  //    consulted before the BATCH: a run of single reads is where the tap could crowd a user out,
  //    so it starts one only with slack in hand (per-call checks would cost a KV read per call).
  if (!(await tapHasBudgetHeadroom())) {
    result.budgetPaused = true;

    return "stop-meter";
  }

  const albums: ProbeAlbum[] = [];

  for (const id of albumIds) {
    if (budget.fetches >= MAX_FETCHES_PER_PASS) {
      result.fetchCeilingHit = true;

      return "stop-budget";
    }

    budget.fetches += 1;
    const outcome = await spotifyGet(`/albums/${encodeURIComponent(id)}`, accessToken);

    if (outcome.kind === "unauthorized") {
      return "stop-unauth";
    }

    if (outcome.kind === "ratelimited") {
      result.rateLimited = true;

      return "stop-rate";
    }

    if (outcome.kind === "failed") {
      result.failedFetches += 1;
      continue;
    }

    const album = parseProbeAlbum(outcome.body);

    if (album) {
      albums.push(album);
    }
  }

  // 3. THE TWO-SIGNAL GATE (belt and suspenders — both required before an album mints onto PUBLIC
  //    /fresh): (a) ARTIST-GROUNDING — at least one of the album's Spotify artist ids is already in
  //    our archive (the primary identity/genre anchor, `knownSpotifyArtistIds`), AND (b) the EXACT
  //    copyright label match (the secondary attribution confirmation, `copyrightMatchesLabel`). The
  //    first live drain minted 195 rows, many cross-genre (an Indian devotional record, Brazilian
  //    live albums) because the fuzzy `label:` search + a loose substring copyright match let homonym
  //    labels through; both were by artists we had never certified. Grounding is what closes that.
  //
  //    THE DELIBERATE TRADEOFF: a brand-NEW artist's debut on a real seed label is SKIPPED until they
  //    exist in our archive — D7's MusicBrainz tail-first re-arm backfills that within a day or two.
  //    Correctness over completeness is the right call for a public surface.
  //
  //    AND A DATE IS REQUIRED. An album with no `release_date` is dropped before either signal is
  //    considered: /fresh selects on `release_date`, so a null-dated row is INVISIBLE there — it
  //    would be a permanently unreachable row polluting `tracks` while delivering exactly none of
  //    the day-one freshness this tap exists for. Minting it is a silent no-op, so it is never
  //    minted. (Learned the hard way from a vendor whose album shape returned undated rows.)
  const dated = albums.filter((album) => {
    if (album.releaseDate) {
      return true;
    }

    result.skippedUndated += 1;

    return false;
  });
  const copyrightOk = dated.filter((album) => copyrightMatchesLabel(album.copyrights, label.name));
  const known = await knownSpotifyArtistIds(copyrightOk.flatMap((album) => album.spotifyArtistIds));
  const matched: ProbeAlbum[] = [];

  for (const album of copyrightOk) {
    if (album.spotifyArtistIds.some((id) => known.has(id))) {
      matched.push(album);
    } else {
      // Right label name, but no artist we know — a homonym label or a debut. Dropped, counted.
      result.skippedUngrounded += 1;
    }
  }

  result.albumsMatched += matched.length;

  // 4. Mint the un-held tracks of each matched album, each fetched as a SINGLE `GET /tracks/{id}`.
  for (const album of matched) {
    const unminted = await unmintedSpotifyTrackIds(album.trackIds);

    if (unminted.length === 0) {
      continue;
    }

    // The second single-read batch of the pass — same rule, checked again because the window may
    // have filled with a user's calls while the album reads were in flight.
    if (!(await tapHasBudgetHeadroom())) {
      result.budgetPaused = true;

      return "stop-meter";
    }

    const probeTracks: ProbeTrack[] = [];

    for (const id of unminted) {
      if (budget.fetches >= MAX_FETCHES_PER_PASS) {
        result.fetchCeilingHit = true;

        return "stop-budget";
      }

      budget.fetches += 1;
      const outcome = await spotifyGet(`/tracks/${encodeURIComponent(id)}`, accessToken);

      if (outcome.kind === "unauthorized") {
        return "stop-unauth";
      }

      if (outcome.kind === "ratelimited") {
        result.rateLimited = true;

        return "stop-rate";
      }

      if (outcome.kind === "failed") {
        result.failedFetches += 1;
        continue;
      }

      const track = parseProbeTrack(outcome.body);

      if (track) {
        probeTracks.push(track);
      }
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
 * fresh-release search → the copyrights post-filter → a per-track ISRC read → the deduped mint.
 *
 * FOUR WAYS A PASS ENDS EARLY, all clean, all resumable off the durable per-label cadence stamps:
 * the tap's share of the shared Spotify window is spent (`budgetPaused` — the polite one, and the
 * expected one under load), a 429 got through anyway (`rateLimited`), the per-pass single-fetch
 * ceiling is hit (`fetchCeilingHit`), or the Spotify grant is gone (`configured: false`, a whole
 * no-op until the operator reconnects).
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
    budgetPaused: false,
    configured: true,
    dryRun,
    failedFetches: 0,
    failedLabels: [],
    fetchCeilingHit: false,
    labelSlugs: [],
    labelsProbed: 0,
    newRows: 0,
    newTrackIds: [],
    rateLimited: false,
    skippedKnown: 0,
    skippedUndated: 0,
    skippedUngrounded: 0,
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

  // The single-fetch budget, shared across every label this pass so the ceiling is pass-wide.
  const budget: FetchBudget = { fetches: 0 };

  for (const label of eligible) {
    // THE PRIORITY RULE, at the top of each label: the tap proceeds only while the shared window has
    // real slack (below `TAP_BUDGET_CEILING`, not merely below the meter's hard max). A label is the
    // natural stopping point — it is the unit the durable `label_releases_checked_at` cadence
    // resumes on, so stepping back here costs the pass nothing but a tick.
    if (!(await tapHasBudgetHeadroom())) {
      result.budgetPaused = true;
      break;
    }

    const signal = await probeOneLabel(label, accessToken, result, budget);

    if (signal === "stop-unauth") {
      return { ...result, configured: false };
    }

    // A 429, the fetch ceiling, and the tap's meter ceiling all END the pass cleanly — the
    // un-stamped labels resume next tick off their durable cadence stamps.
    if (signal === "stop-rate" || signal === "stop-budget" || signal === "stop-meter") {
      break;
    }
  }

  return result;
}
