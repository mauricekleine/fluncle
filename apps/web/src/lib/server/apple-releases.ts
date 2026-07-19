// THE MUSICKIT FRESHNESS TAP (D8) — Apple Music as the day-one freshness feed for the archive.
//
// ── THE DOCTRINE AMENDMENT (operator-ratified 2026-07-19) ────────────────────────────────────
// MusicBrainz WALKS the graph (crawl.ts): label → releases → artists → their releases, the whole
// recording-centric catalogue. But MusicBrainz's editorial database lags a release by ~2 weeks,
// so a Friday drop is invisible on /fresh until the volunteers enter it. Apple Music has it on
// day one. So Apple becomes the FRESHNESS TAP: a bounded per-label "latest releases" probe that
// mints METADATA-ONLY catalogue rows with their real (day-one) release dates, closing the lag
// cliff. Apple never walks the graph and never certifies — it only taps freshness.
//
// ── THE HARD CONSTRAINTS (never widened) ─────────────────────────────────────────────────────
//   - ENABLED seed labels ONLY (`labels.seed_state = 'enabled'` — the crawl gate's allowlist). A
//     disabled/undecided label is never probed. The probe mints tracks/albums for the PROBED
//     label and NOTHING else: no new labels, no artist-graph hops, no certification. Rows land in
//     the unlit tier exactly like a crawl mint (a `tracks` row with no `findings` row).
//   - The archive's invariants hold: `tracks.label` is the archive's OWN spelling of the seed
//     label (so `slugify(tracks.label) = labels.slug`, the disabled-label-veto invariant the Ear's
//     capture ladder depends on), and the row is linked to the KNOWN seed label directly (never a
//     re-resolve of Apple's `recordLabel` string). `capture_status` is never named at insert — the
//     DDL default lands, so the row is nobody's capture work item until the operator rules.
//
// ── LABEL-ID RESOLUTION (a real vendor call, so it carries a state machine) ───────────────────
// No Apple label id exists anywhere, so each enabled label resolves its `apple_label_id` ONCE via
// Apple catalog search (`types=record-labels`), accepting ONLY an EXACT name-fold match against
// the seed label's own name — a wrong label match would mint wrong-label rows, so when the search
// is ambiguous or returns no exact fold the id is left NULL, the attempt is stamped, and it is
// counted in the op summary. NEVER a guess. The `labels.apple_label_*` triple is the label-images
// reliability convention (state/attempted_at/failures), so a persistent no-match gives up to
// `none` and is never re-searched.
//
// ── THE DEDUPE CONTRACT (the load-bearing design point — catalogue-dedupe.ts) ─────────────────
// This probe and the MB crawl converge on ONE row per recording from EITHER direction:
//   1. Apple-probe-first: before minting, skip any song whose ISRC already exists in `tracks`, OR
//      whose Apple song id already minted a row (`ap_<id>`), OR whose title EXACT-folds to an
//      existing row on the SAME album (the no/divergent-ISRC convergence). See `writeAppleTracks`.
//   2. MB-walk-later: crawl.ts's `writeCatalogueTracks` carries the SAME same-album title-fold
//      branch, so a later MB walk of an Apple-first row folds to a skip instead of an `mb_` twin.
//
// ── BUDGET (another consumer of the shared 18/min Apple meter + breaker) ──────────────────────
// Every Apple call consults `areAppleCallsAllowed` + `isAppleCallBudgetAvailable` and records via
// `recordAppleCall`/`recordAppleAuthOutcome` — the `backfillAppleMusicCatalogue` posture, verbatim.
// A tripped breaker (a suspended token) or a spent window STOPS the pass cleanly; a 429 backs it
// off. NO-OP until the three MusicKit secrets are provisioned (`configured: false`).

import { ensureAlbum } from "./albums";
import { type AppleCatalogRequestOutcome, requestAppleCatalogResource } from "./apple-music";
import {
  areAppleCallsAllowed,
  isAppleCallBudgetAvailable,
  recordAppleAuthOutcome,
  recordAppleCall,
} from "./apple-breaker";
import { linkTracksToArtistEntities } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import { getDb, typedRows } from "./db";
import { labelFold } from "./labels";

// ── Policy constants ──────────────────────────────────────────────────────────────────────────

/** Enabled seed labels probed per pass — oldest-probe-stamp first. Bounded so one tick stays well
 *  inside the shared 18/min Apple budget (each label costs 1 latest-releases call + one per NEW
 *  album), leaving headroom for the live user-facing rungs. */
export const PROBE_LABELS_PER_PASS = 5;

/** How stale a resolved label's last probe may get before it is re-tapped. The cron runs daily, so
 *  20h means every enabled label's freshness is refreshed each day without re-probing one twice a
 *  day when the CLI loops passes. */
const REPROBE_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** The base cooldown between two RESOLUTION attempts on the same label (failure-scaled below). A
 *  label Apple has no exact-fold match for is not re-searched for a while. */
const RESOLVE_COOLDOWN_BASE_MS = 6 * 60 * 60 * 1000;
const RESOLVE_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** After this many consecutive failed resolutions a label GIVES UP (`apple_label_state = 'none'`),
 *  so a label Apple simply does not carry is never searched forever. */
const RESOLVE_MAX_FAILURES = 5;

/** How many enabled-label rows the worklist reads before the TS eligibility refine — a small
 *  multiple of the per-pass cap, so cooling-down rows never starve an eligible one out of the pass. */
const WORKLIST_OVERSCAN = PROBE_LABELS_PER_PASS * 4;

/** Albums the probe inspects per label per pass, newest first. Apple returns latest-releases
 *  newest-first; this caps the per-label album-tracks calls so one hot label cannot drain the
 *  whole Apple budget in a single pass. */
const MAX_ALBUMS_PER_LABEL = 12;

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

/** One enabled seed label as the worklist reads it (identity + the Apple reliability columns). */
type LabelProbeRow = {
  appleLabelFailures: number;
  appleLabelId: null | string;
  appleLabelState: "pending" | "resolved" | "none";
  appleReleasesCheckedAt: null | string;
  attemptedAt: null | string;
  id: string;
  name: string;
  slug: string;
};

/** A parsed Apple record-label search candidate — the id + the name the exact fold ranks on. */
export type AppleLabelCandidate = { id: string; name: string };

/** A parsed album off a label's latest-releases view. */
export type AppleLatestAlbum = { id: string; name: null | string; releaseDate: null | string };

/** A parsed song off an album's tracks relationship — everything a valid catalogue row needs. */
export type AppleReleaseSong = {
  appleMusicUrl: null | string;
  artistName: null | string;
  durationMs: number;
  isrc: null | string;
  releaseDate: null | string;
  songId: string;
  title: string;
};

/** One probe pass's honest numbers — the op summary + the CLI/cron readout. */
export type AppleReleasesProbeResult = {
  /** Distinct albums the probe inspected across every label this pass. */
  albumsSeen: number;
  /** True when the pass STOPPED because the cross-cutting Apple breaker is tripped (a suspended
   *  token) or its shared call budget is spent — not a 429. */
  breakerTripped: boolean;
  /** False when the MusicKit secrets are unset — the whole tap is a no-op this tick. */
  configured: boolean;
  dryRun: boolean;
  /** Enabled seed labels whose latest releases the probe actually tapped this pass. */
  labelsProbed: number;
  /** Catalogue rows this pass minted (never a certification). */
  newRows: number;
  /** The minted track ids — bounded (a few labels × their fresh releases), so honest to return. */
  newTrackIds: string[];
  /** True when the pass STOPPED on an Apple 429 — the CLI stops looping; the next tick resumes. */
  rateLimited: boolean;
  /** Enabled labels that gained an `apple_label_id` this pass (a one-time resolution). */
  resolvedLabels: string[];
  /** Songs skipped because they already exist in the archive (by ISRC, Apple id, or same-album
   *  title fold) — the dedupe contract, working. */
  skippedKnown: number;
  /** Enabled labels Apple has no exact-fold match for this pass (left NULL, attempt stamped). */
  unresolvedLabels: string[];
};

// ── Pure parsers (exported for fixture tests) ───────────────────────────────────────────────────

type RawAttrs = Record<string, unknown>;
type RawResource = { attributes?: RawAttrs; id?: unknown; type?: unknown };

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The record-label search response → the id + name candidates, in Apple's returned order. Apple
 * nests search results under `results[<type>].data[]`; each datum is a record-label with a `name`
 * attribute. Tolerant at every hop (a malformed body yields an empty list, never a throw).
 */
export function parseAppleLabelSearch(body: unknown): AppleLabelCandidate[] {
  const results = (body as { results?: Record<string, { data?: unknown }> } | null | undefined)
    ?.results;
  const data = (results?.["record-labels"]?.data ?? []) as unknown[];
  const candidates: AppleLabelCandidate[] = [];

  for (const raw of Array.isArray(data) ? data : []) {
    const resource = raw as RawResource;
    const id = asString(resource.id);
    const name = asString(resource.attributes?.name);

    if (id && name) {
      candidates.push({ id, name });
    }
  }

  return candidates;
}

/**
 * A record-label resource fetched with `views=latest-releases` → the album resources of that view.
 * Apple returns the view under `data[0].views["latest-releases"].data[]`; a `relationships` variant
 * is accepted as a fallback. Newest-first, as Apple orders it. Bare/attribute-less refs drop out.
 */
export function parseLatestReleaseAlbums(body: unknown): AppleLatestAlbum[] {
  const primary = (body as { data?: unknown[] } | null | undefined)?.data?.[0] as
    | {
        relationships?: Record<string, { data?: unknown }>;
        views?: Record<string, { data?: unknown }>;
      }
    | undefined;

  const view =
    primary?.views?.["latest-releases"]?.data ?? primary?.relationships?.["latest-releases"]?.data;
  const albums: AppleLatestAlbum[] = [];

  for (const raw of Array.isArray(view) ? view : []) {
    const resource = raw as RawResource;

    if (resource.type !== "albums") {
      continue;
    }

    const id = asString(resource.id);

    if (id) {
      albums.push({
        id,
        name: asString(resource.attributes?.name),
        releaseDate: asString(resource.attributes?.releaseDate),
      });
    }
  }

  return albums;
}

/**
 * An album's `/tracks` response → the parsed songs. Apple returns the songs directly under `data[]`
 * (a `relationships.tracks.data[]` variant is accepted as a fallback). `durationInMillis` is the
 * real duration (`duration_ms` is NOT NULL on `tracks`; 0 is the honest unknown). A datum with no
 * id or no title drops out.
 */
export function parseAlbumSongs(body: unknown): AppleReleaseSong[] {
  const root = body as
    | {
        data?: Array<{ relationships?: Record<string, { data?: unknown }> } & RawResource>;
      }
    | null
    | undefined;
  const top = Array.isArray(root?.data) ? root.data : [];
  // Primary: `/albums/<id>/tracks` returns the songs directly under `data[]`. Fallback: an
  // `?include=tracks` single-album lookup nests them under `data[0].relationships.tracks.data[]`.
  const rows =
    top.length > 0 && top[0]?.type === "songs"
      ? top
      : ((top[0]?.relationships?.tracks?.data ?? top) as unknown[]);
  const songs: AppleReleaseSong[] = [];

  for (const raw of Array.isArray(rows) ? rows : []) {
    const resource = raw as RawResource;

    if (resource.type && resource.type !== "songs") {
      continue;
    }

    const songId = asString(resource.id);
    const attrs = resource.attributes ?? {};
    const title = asString(attrs.name);

    if (!songId || !title) {
      continue;
    }

    const duration = attrs.durationInMillis;

    songs.push({
      appleMusicUrl: asString(attrs.url),
      artistName: asString(attrs.artistName),
      durationMs:
        typeof duration === "number" && Number.isFinite(duration) ? Math.round(duration) : 0,
      isrc: asString(attrs.isrc),
      releaseDate: asString(attrs.releaseDate),
      songId,
      title,
    });
  }

  return songs;
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────

/**
 * A freshness-tapped track's `track_id` — the Apple twin of crawl.ts's `catalogueTrackId`
 * (`mb_<recording-mbid>`). `tracks.track_id` is an opaque PK that happens to be the Spotify id for
 * a finding; a freshness-tapped row mints its own from the identity that exists for it — the Apple
 * catalog song id, namespaced `ap_<id>`. Deterministic, so a re-probe of the same song collides on
 * the primary key and writes nothing.
 */
export function appleReleaseTrackId(appleSongId: string): string {
  return `ap_${appleSongId}`;
}

// ── The write (the Apple half of the dedupe contract) ───────────────────────────────────────────

/**
 * Write one album's songs into `tracks` as CATALOGUE rows for the KNOWN seed label — deduped from
 * both directions, and nowhere near `findings`.
 *
 * THE DEDUPE, three layers, before the insert:
 *   1. an existing `ap_<id>` row (a prior probe already minted this song);
 *   2. an existing byte-equal ISRC anywhere in `tracks` (a finding, a crawl mint, an earlier probe);
 *   3. an existing row on the SAME album whose title EXACT-folds to this one (the no/divergent-ISRC
 *      convergence with an MB-crawled twin — catalogue-dedupe.ts).
 * Then `on conflict (track_id) do nothing` closes the two-ticks race at the primary key.
 *
 * `label` is the ARCHIVE's own spelling (the seed label's `name`), so `slugify(tracks.label)`
 * lands on `labels.slug`; `label_id` is stamped at the KNOWN seed label directly (never a
 * re-resolve of Apple's string). `capture_status` and every queue column are simply never named —
 * the DDL defaults land and no agent sweep can reach a `findings`-less row.
 */
async function writeAppleTracks(
  songs: AppleReleaseSong[],
  ctx: { albumId: null | string; albumName: null | string; labelId: string; labelName: string },
): Promise<{ skipped: number; written: number; writtenIds: string[] }> {
  if (songs.length === 0) {
    return { skipped: 0, written: 0, writtenIds: [] };
  }

  const db = await getDb();
  const ids = songs.map((song) => appleReleaseTrackId(song.songId));
  const isrcs = songs.map((song) => song.isrc).filter((isrc): isrc is string => Boolean(isrc));

  const existing = await db.execute({
    args: [...ids, ...isrcs],
    sql: `select track_id, isrc from tracks
          where track_id in (${ids.map(() => "?").join(", ")})
          ${isrcs.length > 0 ? `or isrc in (${isrcs.map(() => "?").join(", ")})` : ""}`,
  });

  const heldIds = new Set<string>();
  const heldIsrcs = new Set<string>();

  for (const row of typedRows<{ isrc: null | string; track_id: string }>(existing.rows)) {
    heldIds.add(row.track_id);

    if (row.isrc) {
      heldIsrcs.add(row.isrc);
    }
  }

  // The same-album title-fold convergence index (the no/divergent-ISRC MB-twin guard).
  const albumTitleFolds = await existingAlbumTitleFolds(ctx.albumId);

  let written = 0;
  let skipped = 0;
  const writtenIds: string[] = [];

  for (const song of songs) {
    const trackId = appleReleaseTrackId(song.songId);
    const titleFold = foldTrackTitle(song.title);

    if (
      heldIds.has(trackId) ||
      (song.isrc && heldIsrcs.has(song.isrc)) ||
      (ctx.albumId && titleFold && albumTitleFolds.has(titleFold))
    ) {
      skipped += 1;
      continue;
    }

    const artists = song.artistName ? [song.artistName] : ["Unknown"];
    const result = await db.execute({
      args: [
        trackId,
        song.title,
        JSON.stringify(artists),
        song.durationMs,
        ctx.albumName,
        song.isrc,
        ctx.labelName,
        song.releaseDate,
        song.appleMusicUrl,
      ],
      // `capture_status`, `album_image_url`, `mb_recording_id`, `in_release_id`/`in_master_id` are
      // deliberately unnamed — the DDL defaults (NULL / 'pending') land. The album's own cover
      // master + Apple album facts arrive at ALBUM grain via their own sweeps, never at this mint.
      sql: `insert into tracks
              (track_id, title, artists_json, duration_ms, album, isrc, label, release_date,
               apple_music_url)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (track_id) do nothing`,
    });

    if (result.rowsAffected > 0) {
      written += 1;
      writtenIds.push(trackId);
      heldIds.add(trackId);

      if (song.isrc) {
        heldIsrcs.add(song.isrc);
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

    // The label edge, stamped directly at the KNOWN seed label — no re-resolve of Apple's string.
    await db.execute({
      args: [ctx.labelId, ...writtenIds],
      sql: `update tracks set label_id = ? where track_id in (${placeholders})`,
    });

    // The album edge (fold on the album-title slug — Apple carries no release-group MBID, so
    // `ensureAlbum`'s slug fallback is what converges an Apple-minted album with an MB-crawled one).
    if (ctx.albumId) {
      await db.execute({
        args: [ctx.albumId, ...writtenIds],
        sql: `update tracks set album_id = ? where track_id in (${placeholders})`,
      });
    }

    // The artist edge — the NAME-FOLD link to ALREADY-CERTIFIED artists only (artists.ts). It
    // mints nothing and hops nowhere, so it is not a graph expansion; it just lets an Apple-tapped
    // row show its artist's avatar on /fresh exactly as a crawl-tapped row does.
    await linkTracksToArtistEntities(writtenIds);
  }

  return { skipped, written, writtenIds };
}

// ── Label reliability writers ───────────────────────────────────────────────────────────────────

function resolveCooldownMs(failures: number): number {
  if (failures <= 0) {
    return RESOLVE_COOLDOWN_BASE_MS;
  }

  return Math.min(RESOLVE_COOLDOWN_BASE_MS * 2 ** Math.min(failures, 10), RESOLVE_COOLDOWN_MAX_MS);
}

async function markLabelResolved(slug: string, appleLabelId: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [appleLabelId, new Date().toISOString(), slug],
    sql: `update labels
          set apple_label_id = ?, apple_label_state = 'resolved',
              apple_label_failures = 0, apple_label_attempted_at = ?
          where slug = ?`,
  });
}

async function recordResolveFailure(slug: string, priorFailures: number): Promise<void> {
  const db = await getDb();
  const failures = priorFailures + 1;
  const giveUp = failures >= RESOLVE_MAX_FAILURES;

  await db.execute({
    args: [failures, giveUp ? "none" : "pending", new Date().toISOString(), slug],
    sql: `update labels
          set apple_label_failures = ?, apple_label_state = ?, apple_label_attempted_at = ?
          where slug = ?`,
  });
}

async function markLabelChecked(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels set apple_releases_checked_at = ? where slug = ?`,
  });
}

// ── The worklist ────────────────────────────────────────────────────────────────────────────────

/**
 * The probe worklist: ENABLED seed labels that are not terminally `none`, oldest-probe-stamp first
 * (NULLs — never-probed + unresolved — sort first). Reads over the partial
 * `labels_apple_probe_queue_idx`, so it never scans the crawler-swollen labels table. The TS
 * eligibility refine (below) then drops rows in their resolution cooldown / recently re-probed.
 */
async function listProbeLabels(): Promise<LabelProbeRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [WORKLIST_OVERSCAN],
    sql: `select id, slug, name, apple_label_id, apple_label_state,
                 apple_label_attempted_at, apple_label_failures, apple_releases_checked_at
          from labels
          where seed_state = 'enabled' and apple_label_state <> 'none'
          order by apple_releases_checked_at asc, slug asc
          limit ?`,
  });

  return typedRows<{
    apple_label_attempted_at: null | string;
    apple_label_failures: null | number;
    apple_label_id: null | string;
    apple_label_state: "none" | "pending" | "resolved";
    apple_releases_checked_at: null | string;
    id: string;
    name: string;
    slug: string;
  }>(result.rows).map((row) => ({
    appleLabelFailures: typeof row.apple_label_failures === "number" ? row.apple_label_failures : 0,
    appleLabelId: row.apple_label_id,
    appleLabelState: row.apple_label_state,
    appleReleasesCheckedAt: row.apple_releases_checked_at,
    attemptedAt: row.apple_label_attempted_at,
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

/** Whether a label is eligible to be worked THIS pass, given the reliability state and the clock. */
function isEligible(label: LabelProbeRow, now: number): boolean {
  if (label.appleLabelState === "resolved") {
    // A resolved label is re-probed once its last tap is older than the re-probe interval.
    if (!label.appleReleasesCheckedAt) {
      return true;
    }

    const last = Date.parse(label.appleReleasesCheckedAt);

    return !Number.isFinite(last) || now - last >= REPROBE_INTERVAL_MS;
  }

  // A pending label is resolution-attempted once its cooldown (failure-scaled) has elapsed.
  if (!label.attemptedAt) {
    return true;
  }

  const last = Date.parse(label.attemptedAt);

  return !Number.isFinite(last) || now - last >= resolveCooldownMs(label.appleLabelFailures);
}

// ── The pass ──────────────────────────────────────────────────────────────────────────────────

/** A non-ok Apple outcome, mapped to the breaker's outcome kind (the `appleOutcomeKind` twin). */
function outcomeKind(outcome: { authFailed?: boolean }): "auth_failure" | "other" {
  return outcome.authFailed ? "auth_failure" : "other";
}

/**
 * ONE bounded probe pass. Reads the enabled seed labels due for work, resolves each label's Apple
 * id once (exact-fold only), taps its latest releases, and mints the fresh catalogue rows it does
 * not already hold — consulting the shared Apple breaker + call meter before EVERY call. A tripped
 * breaker / spent budget / 429 STOPS the pass cleanly (durable state, resumes next tick). NO-OP
 * until the MusicKit secrets are provisioned.
 *
 * `dryRun` reports the labels that WOULD be probed and makes no Apple call and no write.
 */
export async function probeAppleReleases({
  dryRun = false,
  limit = PROBE_LABELS_PER_PASS,
}: { dryRun?: boolean; limit?: number } = {}): Promise<AppleReleasesProbeResult> {
  const now = Date.now();
  const result: AppleReleasesProbeResult = {
    albumsSeen: 0,
    breakerTripped: false,
    configured: true,
    dryRun,
    labelsProbed: 0,
    newRows: 0,
    newTrackIds: [],
    rateLimited: false,
    resolvedLabels: [],
    skippedKnown: 0,
    unresolvedLabels: [],
  };

  const cap = Math.max(1, Math.min(limit, PROBE_LABELS_PER_PASS));
  const candidates = await listProbeLabels();
  const eligible = candidates.filter((label) => isEligible(label, now)).slice(0, cap);

  if (eligible.length === 0) {
    return result;
  }

  if (dryRun) {
    // Report the eligible labels (as `resolvedLabels` — the "would probe" set) without any call.
    for (const label of eligible) {
      result.resolvedLabels.push(label.slug);
    }

    return result;
  }

  for (const label of eligible) {
    // ── Resolve the label's Apple id (once), if it has none yet ──────────────────────────────
    let appleLabelId = label.appleLabelId;

    if (label.appleLabelState !== "resolved" || !appleLabelId) {
      if (!(await gateAllowed(now))) {
        result.breakerTripped = true;
        break;
      }

      await recordAppleCall(now);
      const search = await consumeOutcome(
        await requestAppleCatalogResource(
          `search?types=record-labels&limit=10&term=${encodeURIComponent(label.name)}`,
        ),
        result,
        now,
      );

      if (search.kind === "unconfigured") {
        return { ...result, configured: false };
      }

      if (search.kind === "stop") {
        break;
      }

      if (search.kind === "failure") {
        await recordResolveFailure(label.slug, label.appleLabelFailures);
        continue;
      }

      const want = labelFold(label.name);
      const match = parseAppleLabelSearch(search.body).find(
        (candidate) => labelFold(candidate.name) === want,
      );

      if (!match) {
        // Ambiguous / no exact fold — leave the id NULL, stamp the attempt, count it. NEVER guess.
        await recordResolveFailure(label.slug, label.appleLabelFailures);
        result.unresolvedLabels.push(label.slug);
        continue;
      }

      appleLabelId = match.id;
      await markLabelResolved(label.slug, match.id);
      result.resolvedLabels.push(label.slug);
    }

    // ── Tap the label's latest releases ──────────────────────────────────────────────────────
    if (!(await gateAllowed(now))) {
      result.breakerTripped = true;
      break;
    }

    await recordAppleCall(now);
    const releases = await consumeOutcome(
      await requestAppleCatalogResource(
        `record-labels/${encodeURIComponent(appleLabelId)}?views=latest-releases`,
      ),
      result,
      now,
    );

    if (releases.kind === "unconfigured") {
      return { ...result, configured: false };
    }

    if (releases.kind === "stop") {
      break;
    }

    if (releases.kind === "failure") {
      // A transient vendor error on the releases read — leave `apple_releases_checked_at` stale so
      // the label is re-probed next tick; nothing to record on the label's resolution state.
      continue;
    }

    result.labelsProbed += 1;

    const albums = parseLatestReleaseAlbums(releases.body).slice(0, MAX_ALBUMS_PER_LABEL);

    let stoppedMidLabel = false;

    for (const album of albums) {
      if (!(await gateAllowed(now))) {
        result.breakerTripped = true;
        stoppedMidLabel = true;
        break;
      }

      result.albumsSeen += 1;
      await recordAppleCall(now);
      const tracks = await consumeOutcome(
        await requestAppleCatalogResource(`albums/${encodeURIComponent(album.id)}/tracks`),
        result,
        now,
      );

      if (tracks.kind === "unconfigured") {
        return { ...result, configured: false };
      }

      if (tracks.kind === "stop") {
        stoppedMidLabel = true;
        break;
      }

      if (tracks.kind === "failure") {
        continue;
      }

      const songs = parseAlbumSongs(tracks.body);

      if (songs.length === 0) {
        continue;
      }

      // Resolve the album row ONCE (slug fold — Apple carries no release-group MBID). Reused for
      // the same-album title-fold dedupe AND the `album_id` stamp.
      const albumId = (await ensureAlbum(album.name, null)) ?? null;
      const { skipped, written, writtenIds } = await writeAppleTracks(songs, {
        albumId,
        albumName: album.name,
        labelId: label.id,
        labelName: label.name,
      });

      result.newRows += written;
      result.skippedKnown += skipped;
      result.newTrackIds.push(...writtenIds);
    }

    // Stamp the probe cadence ONLY when the label's albums were fully walked — a mid-label
    // breaker/budget stop leaves it stale so the next tick resumes (idempotent: the dedupe skips
    // the rows already minted).
    if (!stoppedMidLabel) {
      await markLabelChecked(label.slug);
    } else {
      break;
    }
  }

  return result;
}

/** May an Apple call be made now — the breaker is untripped AND the shared window has budget. */
async function gateAllowed(now: number): Promise<boolean> {
  return (await areAppleCallsAllowed(now)) && (await isAppleCallBudgetAvailable(now));
}

/** What the pass should do with one Apple call's outcome (the `ok` case carries the parsed body). */
type ConsumedOutcome =
  | { body: unknown; kind: "ok" }
  | { kind: "failure" }
  | { kind: "stop" }
  | { kind: "unconfigured" };

/**
 * Fold one Apple call's outcome into the pass result and say what to do:
 *   - `unconfigured` — the MusicKit secrets are unset (the caller returns the whole no-op);
 *   - `stop` — a 429 (`rateLimited`) or a suspended-token 401/403 (`breakerTripped`): stop the pass
 *     cleanly, durable state resumes next tick — the breaker has already advanced;
 *   - `failure` — any other transient vendor error: the caller records a per-item failure + continues;
 *   - `ok` — the call succeeded; the body rides along for the caller's parser.
 * Records the auth outcome into the shared breaker for EVERY resolved outcome (a success resets the
 * streak; a 401/403 advances it; a 429/other leaves it alone).
 */
async function consumeOutcome(
  outcome: AppleCatalogRequestOutcome,
  result: AppleReleasesProbeResult,
  now: number,
): Promise<ConsumedOutcome> {
  if (!outcome.configured) {
    return { kind: "unconfigured" };
  }

  if (outcome.ok) {
    await recordAppleAuthOutcome("ok", now);

    return { body: outcome.body, kind: "ok" };
  }

  await recordAppleAuthOutcome(outcomeKind(outcome), now);

  if (outcome.rateLimited) {
    result.rateLimited = true;

    return { kind: "stop" };
  }

  if (outcome.authFailed) {
    result.breakerTripped = true;

    return { kind: "stop" };
  }

  return { kind: "failure" };
}
