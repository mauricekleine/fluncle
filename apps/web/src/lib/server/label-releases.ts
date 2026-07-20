// THE FRESHNESS TAP (D8) — the day-one freshness feed for the archive, off the Apify actor.
//
// ── THE DOCTRINE AMENDMENT (operator-ratified 2026-07-19; vendor swapped 2026-07-20) ──────────
// MusicBrainz WALKS the graph (crawl.ts): label → releases → artists → their releases, the whole
// recording-centric catalogue. But MusicBrainz's editorial database lags a release by ~2 weeks,
// so a Friday drop is invisible on /fresh until the volunteers enter it. So a second vendor taps
// FRESHNESS: a bounded per-label probe over the ENABLED seed labels that mints METADATA-ONLY
// catalogue rows with their real (day-one) release dates, closing the lag cliff. The tap never
// walks the graph and never certifies — it only taps freshness.
//
// ── THE ANCHOR-SWEEP MOVE (2026-07-20): off the official Spotify budget, onto Apify ────────────
// The first cut of this tap ran the Spotify reads IN THE WORKER against the official dev-mode
// Spotify app — the SAME app the user-facing paths (adds, publish, the Frontier playlist mints)
// depend on. That app is rate-limited to death at its tier: the batch endpoints are 403, the search
// `limit` is capped at 10, and sustained probing starved under 429s and blocked the tap's backfill.
// So the tap moved OFF that budget onto the Apify actor `musicae~spotify-extended-scraper` — the
// SAME actor + box-runs-actor / Worker-verifies split the catalogue ANCHOR already uses (anchor.ts).
// The BOX runs the actor (docs/agents/hermes/scripts/label-releases-sweep.*): it reads the due seed
// labels from `list_label_releases_work`, runs `albums:["label:\"<name>\" tag:new"]` once per label,
// maps each result album (with its inline `tracks[]` + `artists[]`) to a candidate, and POSTs a
// label's candidates to this module's `backfill_label_releases` verify+mint op. The Worker no longer
// touches the official Spotify API on this path at all — the tap is on Apify's separate budget.
//
// THE BOX'S VERDICT IS NEVER TRUSTED. The box only fetches candidates; this module re-runs the FULL
// grounding + attribution + dedupe (the anchor/verify_capture doctrine: the box measures, the Worker
// rules), so a re-baked box script can never loosen the match rule or mint junk.
//
// ── THE HARD CONSTRAINTS (never widened) ─────────────────────────────────────────────────────
//   - ENABLED seed labels ONLY (`labels.seed_state = 'enabled'` — the crawl gate's allowlist). A
//     disabled/undecided label is never in the worklist, and the mint op re-checks the seed state
//     (a label disabled mid-flight is a no-op). The probe mints tracks/albums for the PROBED label
//     and NOTHING else: no new labels, no artist-graph hops, no certification. Rows land in the
//     unlit tier exactly like a crawl mint (a `tracks` row with no `findings` row).
//   - The archive's invariants hold: `tracks.label` is the archive's OWN spelling of the seed
//     label (so `slugify(tracks.label) = labels.slug`, the disabled-label-veto invariant the Ear's
//     capture ladder depends on), and the row is linked to the KNOWN seed label directly (never a
//     re-resolve of the actor's label string). `capture_status` is never named at insert — the DDL
//     default lands, so the row is nobody's capture work item until the operator rules.
//
// ── THE GATE: artist-grounding (mandatory) AND label attribution (when the actor gives it) ─────
// `albums:["label:\"<name>\" tag:new"]` forwards Spotify's `label:` freshness filter — but that
// filter is FUZZY for generic names (live: `label:"RAM Records"` returned 93 junk albums), so a
// single loose filter is not enough. The FIRST live drain of the old cut minted 195 rows, MANY
// cross-genre (an Indian devotional record, Brazilian live albums) that reached PUBLIC /fresh. So an
// album mints ONLY when it clears grounding, and additionally the label signal when one is present:
//   (A) ARTIST-GROUNDING (the PRIMARY identity/genre anchor, ALWAYS required) — at least one of the
//       album's Spotify artist ids (`artists[].id`, carried on the actor's result item) is already
//       in our `artists.spotify_artist_id`. This killed 100% of the cross-genre junk (every junk row
//       was by an artist we had never certified). See `knownSpotifyArtistIds`.
//   (B) LABEL ATTRIBUTION (the SECONDARY confirmation, applied ONLY when the actor populates it) —
//       the actor's `album_label` (exact-fold-equals the seed name, a real field — stronger than a
//       copyright parse), or failing that its `album_copyright` (the ℗/© string, exact-fold on the
//       stripped label portion). In `albums`-search mode the actor returns BOTH null (measured live
//       2026-07-20), so the tap runs on grounding ALONE there — the documented, operator-ratified
//       fallback (see `labelAttributionSignal`). The gate is GRACEFUL: the moment a mode/actor
//       populates `album_label`, the second gate engages with no code change.
// THE DELIBERATE TRADEOFF: a brand-NEW artist's debut on a real seed label is skipped until they
// exist in our archive — the MB tail-first re-arm backfills that within a day or two. And in
// grounding-only mode, a KNOWN artist's release on a DIFFERENT label that the fuzzy `label:` filter
// mis-returned would be minted under the seed label; that narrow edge self-corrects via the MB
// crawl's dedupe convergence (below). Correctness over completeness for a public surface.
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
// The Worker does NO vendor call on this path — it verifies box-supplied candidates and writes. The
// Apify spend lives on the box (~$0.005/result item, the anchor rate): one album search per due seed
// label per day, a handful of albums each → a few cents a day. See ../label-releases-timer/README.md.

import { ensureAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import { getDb, typedRows } from "./db";
import { labelFold } from "./labels";

// ── Policy constants ──────────────────────────────────────────────────────────────────────────

/** Enabled seed labels the worklist returns per read, oldest-probe-stamp first. The box paces its
 *  own per-tick batch under this; the read is just the eligible set, capped by the caller's limit. */
export const PROBE_LABELS_PER_PASS = 5;

/** How stale a label's last probe may get before it is due again. The cron runs daily, so 20h means
 *  every enabled label's freshness is refreshed each day without re-probing one twice a day when the
 *  box loops passes. */
const REPROBE_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** How many enabled-label rows the worklist reads before the TS eligibility refine — a small
 *  multiple of the per-pass cap, so recently-probed rows never starve a due one out of the read. */
const WORKLIST_OVERSCAN = PROBE_LABELS_PER_PASS * 4;

// ── Candidate shapes (what the box POSTs; the Worker re-verifies) ─────────────────────────────

/** One credited artist on a candidate album — its name, and its stable Spotify id (the grounding key). */
export type LabelReleaseArtist = { id?: null | string; name: string };

/** One track on a candidate album, mapped from the actor's inline `tracks[]`. */
export type LabelReleaseTrackCandidate = {
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
  /** `spotify:track:<id>` — the actor's `track_uri`; a fallback is derived when absent. */
  uri?: null | string;
  /** `https://open.spotify.com/track/<id>` — the actor's `track_url`; a fallback is derived when absent. */
  url?: null | string;
};

/**
 * One candidate album for a label, mapped from ONE actor result item. Carries the album's identity,
 * its GROUNDING key (`artists[].id`), its optional LABEL-ATTRIBUTION signals (`albumLabel`/
 * `albumCopyright` — both null in the actor's `albums`-search mode), and its inline tracks.
 */
export type LabelReleaseAlbumCandidate = {
  albumCopyright?: null | string;
  albumId?: null | string;
  albumLabel?: null | string;
  albumName?: null | string;
  artists: LabelReleaseArtist[];
  releaseDate?: null | string;
  tracks: LabelReleaseTrackCandidate[];
};

/** One label's verify+mint result — the op summary + the box's per-label tally. */
export type MintLabelReleasesResult = {
  /** Albums that PASSED the gate (grounded AND, when a label signal was present, attributed) and minted. */
  albumsMatched: number;
  /** Albums the box supplied for this label this call (before the gate). */
  albumsSeen: number;
  /** False when the slug is not an ENABLED seed label — the op is a no-op and stamps nothing. */
  found: boolean;
  labelSlug: string;
  /** Catalogue rows this call minted (never a certification). */
  newRows: number;
  /** The minted track ids — bounded (a label's fresh releases), so honest to return. */
  newTrackIds: string[];
  /** Tracks skipped because the archive already holds them (Spotify id / uri / ISRC / same-album
   *  title fold) — the dedupe contract, working. */
  skippedKnown: number;
  /** Albums DROPPED because a label-attribution signal WAS present but did not fold-match the seed
   *  name (a homonym label the fuzzy filter returned). Always 0 in the actor's grounding-only mode. */
  skippedUnattributed: number;
  /** Albums DROPPED for artist-grounding — no artist on the album is in our archive yet (a homonym
   *  label, or a debut awaiting the MB backfill). */
  skippedUngrounded: number;
};

/** One enabled seed label as the worklist returns it (identity the box's actor query reads). */
export type FreshnessProbeLabel = { name: string; slug: string };

// ── Pure helpers (exported for tests) ───────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
 * THE COPYRIGHT SIGNAL: does one of an album's copyright strings name the seed label EXACTLY? The
 * copyright's label portion (`stripCopyrightPrefix`) is fold-compared to the seed name for EQUALITY —
 * not a substring `includes`. This is deliberate: a loose substring match caught homonym labels
 * worldwide for generic seed names ("Lens" matched "℗ 2026 Silent Lens"; "Pilot." matched Brazilian
 * "Kelton Piloto"), spraying cross-genre junk onto a PUBLIC surface. Exact-fold-equal rejects
 * "silent lens" ≠ "lens" while still confirming a real "℗ 2026 <Seed Label>" attribution. Pure.
 */
export function copyrightMatchesLabel(copyrights: string[], seedLabelName: string): boolean {
  const want = labelFold(seedLabelName);

  if (!want) {
    return false;
  }

  return copyrights.some((text) => labelFold(stripCopyrightPrefix(text)) === want);
}

/**
 * THE LABEL-ATTRIBUTION signal (secondary), computed off whatever the actor gave. Precedence:
 *   1. `album_label` present → the STRONG signal: exact-fold-equals the seed name.
 *   2. else `album_copyright` present → the ℗/© string: `copyrightMatchesLabel`.
 *   3. else → NO signal (`present:false`) — the actor's `albums`-search mode, where both are null.
 *      The gate then runs on artist-grounding ALONE (the documented fallback).
 * Returns `{ present, matches }`: an album passes attribution when `!present || matches`.
 */
export function labelAttributionSignal(
  album: Pick<LabelReleaseAlbumCandidate, "albumCopyright" | "albumLabel">,
  seedLabelName: string,
): { matches: boolean; present: boolean } {
  const label = asString(album.albumLabel);

  if (label) {
    const want = labelFold(seedLabelName);

    return { matches: Boolean(want) && labelFold(label) === want, present: true };
  }

  const copyright = asString(album.albumCopyright);

  if (copyright) {
    return { matches: copyrightMatchesLabel([copyright], seedLabelName), present: true };
  }

  return { matches: false, present: false };
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

/** The write shape one album's tracks take — a candidate track resolved to what the insert needs. */
type WritableTrack = {
  artistNames: string[];
  durationMs: number;
  isrc: null | string;
  spotifyTrackId: string;
  spotifyUri: string;
  spotifyUrl: string;
  title: string;
};

/** Resolve one candidate track (+ the album's artists) to the write shape, deriving the uri/url. */
function toWritableTrack(
  track: LabelReleaseTrackCandidate,
  albumArtistNames: string[],
): WritableTrack {
  return {
    artistNames: albumArtistNames,
    durationMs:
      typeof track.durationMs === "number" && Number.isFinite(track.durationMs)
        ? Math.round(track.durationMs)
        : 0,
    isrc: asString(track.isrc),
    spotifyTrackId: track.spotifyTrackId,
    spotifyUri: asString(track.uri) ?? `spotify:track:${track.spotifyTrackId}`,
    spotifyUrl: asString(track.url) ?? `https://open.spotify.com/track/${track.spotifyTrackId}`,
    title: track.title,
  };
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
 * Then `on conflict (track_id) do nothing` closes the two-calls race at the primary key.
 *
 * `label` is the ARCHIVE's own spelling (the seed label's `name`), so `slugify(tracks.label)` lands
 * on `labels.slug`; `label_id` is stamped at the KNOWN seed label directly. `spotify_uri`/`spotify_url`
 * ARE set — the anchor sweep's job done for free. `capture_status` and every queue column are simply
 * never named — the DDL defaults land and no agent sweep can reach a `findings`-less row.
 */
async function writeLabelReleaseTracks(
  tracks: WritableTrack[],
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

    // The label edge, stamped directly at the KNOWN seed label — no re-resolve of the actor's string.
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
 * THE ARTIST-GROUNDING gate (the PRIMARY identity/genre anchor): of a set of Spotify artist ids,
 * the ones already in our archive (`artists.spotify_artist_id`). An album mints ONLY when at least
 * one of ITS artist ids is in this set — which kills 100% of the cross-genre junk the fuzzy Spotify
 * `label:` filter returns (an Indian devotional record, a Brazilian live album — every one by an
 * artist we have never certified), while keeping a real seed-label release (whose artists we already
 * hold). A local, indexed lookup on the unique `spotify_artist_id` — the actor already carried
 * `artists[].id`, so grounding is DB-only, never an extra vendor call.
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

// ── The label cadence stamp ───────────────────────────────────────────────────────────────────

/** A completed probe: stamp the cadence + clear any legacy failure streak. */
async function markLabelChecked(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels
          set label_releases_checked_at = ?, label_releases_failures = 0
          where slug = ?`,
  });
}

// ── The verify + mint op (agent tier; the box POSTs a label's candidates here) ────────────────

/**
 * VERIFY box-supplied candidates for ONE label and mint the ones that clear the gate. The box ran
 * the Apify actor for `labelSlug` and mapped each result album to a candidate; this re-runs the FULL
 * grounding + attribution + dedupe (the box's verdict is never trusted) and writes the survivors as
 * catalogue rows for the KNOWN seed label. On completion it stamps `label_releases_checked_at` so the
 * worklist backs the label off for the re-probe window — a label with zero fresh releases is stamped
 * too, so an empty result is not re-asked (or re-billed) every tick.
 *
 * A slug that is NOT an enabled seed label (disabled mid-flight, or never seeded) is a NO-OP:
 * `found:false`, nothing minted, nothing stamped.
 */
export async function mintLabelReleases(
  labelSlug: string,
  candidates: LabelReleaseAlbumCandidate[],
): Promise<MintLabelReleasesResult> {
  const result: MintLabelReleasesResult = {
    albumsMatched: 0,
    albumsSeen: 0,
    found: false,
    labelSlug,
    newRows: 0,
    newTrackIds: [],
    skippedKnown: 0,
    skippedUnattributed: 0,
    skippedUngrounded: 0,
  };

  const db = await getDb();
  const labelResult = await db.execute({
    args: [labelSlug],
    sql: `select id, name from labels where slug = ? and seed_state = 'enabled' limit 1`,
  });
  const label = typedRows<{ id: string; name: string }>(labelResult.rows)[0];

  if (!label) {
    return result;
  }

  result.found = true;

  // Grounding set — every candidate album's artist ids, resolved in ONE indexed DB lookup.
  const known = await knownSpotifyArtistIds(
    candidates.flatMap((album) =>
      album.artists.map((artist) => artist.id).filter((id): id is string => Boolean(id)),
    ),
  );

  for (const album of candidates) {
    result.albumsSeen += 1;

    // (B) LABEL ATTRIBUTION — only gates when the actor gave a signal; grounding-only otherwise.
    const attribution = labelAttributionSignal(album, label.name);

    if (attribution.present && !attribution.matches) {
      result.skippedUnattributed += 1;
      continue;
    }

    // (A) ARTIST-GROUNDING — always required.
    const grounded = album.artists.some((artist) => artist.id && known.has(artist.id));

    if (!grounded) {
      result.skippedUngrounded += 1;
      continue;
    }

    result.albumsMatched += 1;

    const albumArtistNames = album.artists
      .map((artist) => asString(artist.name))
      .filter((name): name is string => Boolean(name));
    const writable = album.tracks
      .filter((track) => asString(track.spotifyTrackId) && asString(track.title))
      .map((track) => toWritableTrack(track, albumArtistNames));

    if (writable.length === 0) {
      continue;
    }

    // The album row, folded on the album-title slug (Spotify carries no release-group MBID).
    const albumId = (await ensureAlbum(asString(album.albumName), null)) ?? null;
    const { skipped, written, writtenIds } = await writeLabelReleaseTracks(writable, {
      albumId,
      albumName: asString(album.albumName),
      labelId: label.id,
      labelName: label.name,
      releaseDate: asString(album.releaseDate),
    });

    result.newRows += written;
    result.skippedKnown += skipped;
    result.newTrackIds.push(...writtenIds);
  }

  await markLabelChecked(labelSlug);

  return result;
}

// ── The worklist read (agent tier; the box asks which labels are due) ─────────────────────────

/** One enabled seed label as the worklist SQL reads it (identity + the last-probe stamp). */
type LabelProbeRow = { checkedAt: null | string; name: string; slug: string };

/**
 * The probe worklist SQL: ENABLED seed labels, oldest-probe-stamp first (NULLs — never-probed —
 * sort first). Reads over the partial `labels_label_releases_queue_idx`, so it never scans the
 * crawler-swollen labels table. The TS refine (below) drops labels re-probed too recently.
 */
async function listProbeLabels(): Promise<LabelProbeRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [WORKLIST_OVERSCAN],
    sql: `select slug, name, label_releases_checked_at
          from labels
          where seed_state = 'enabled'
          order by label_releases_checked_at asc, slug asc
          limit ?`,
  });

  return typedRows<{
    label_releases_checked_at: null | string;
    name: string;
    slug: string;
  }>(result.rows).map((row) => ({
    checkedAt: row.label_releases_checked_at,
    name: row.name,
    slug: row.slug,
  }));
}

/** Whether a label is due to be probed, given the clock and its last successful-probe stamp. */
function isDue(label: LabelProbeRow, now: number): boolean {
  if (!label.checkedAt) {
    return true;
  }

  const last = Date.parse(label.checkedAt);

  return !Number.isFinite(last) || now - last >= REPROBE_INTERVAL_MS;
}

/**
 * The freshness-tap worklist: the ENABLED seed labels DUE for a probe (oldest first, up to `limit`),
 * each as `{ slug, name }` — the box builds its `label:"<name>" tag:new` actor query off the name and
 * POSTs the result back keyed by the slug. A pure read: it stamps nothing (the mint op stamps on the
 * POST-back), the `list_track_work`/anchor-worklist precedent.
 */
export async function listDueFreshnessLabels(limit: number): Promise<FreshnessProbeLabel[]> {
  const now = Date.now();
  const cap = Math.max(1, limit);

  return (await listProbeLabels())
    .filter((label) => isDue(label, now))
    .slice(0, cap)
    .map((label) => ({ name: label.name, slug: label.slug }));
}
