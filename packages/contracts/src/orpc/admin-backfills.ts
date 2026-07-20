// The `admin-backfills` domain contract module — the operator-gated maintenance
// sweeps (the Discogs + Last.fm back-fills). Part of the admin fan-out, built on
// the same pattern as `./admin-tracks.ts`.
//
//   - `backfill_discogs` / `backfill_lastfm` — operator tier (live
//     `requireOperator`). Batched: one request handles a bounded pass and returns
//     `nextCursor`; the CLI loops `?cursor=` until null.
//
// The inputs are the live QUERY params (`limit`/`dryRun`/`cursor`), kept as
// tolerant optional strings: the live routes parse + clamp them in-handler and
// never 400 on a malformed value, so the contract must not coerce (coercion would
// reject `?limit=abc`). The handler reproduces the exact parse logic.
//
// These are query-only POSTs (the live routes carry their params on the URL, with
// NO request body). oRPC's compact input mode sources a POST's input from the
// BODY, so it would drop the query string; `inputStructure: "detailed"` makes the
// `query` explicit, so the params reach the handler and a bodyless POST is valid.
// The OUTPUT stays compact (the body is the envelope directly).

import { oc } from "@orpc/contract";
import * as z from "zod";

// The row shapes are ported VERBATIM from the live `backfill.ts` result types so
// the success bodies stay byte-for-byte for the CLI's `fluncle admin backfill`.

/** A resolved-Discogs row (`{ logId, releaseId, masterId?, source }`). */
const DiscogsResolvedSchema = z
  .object({
    logId: z.string(),
    masterId: z.number().optional(),
    releaseId: z.number(),
    source: z.string(),
  })
  .meta({ id: "DiscogsBackfillResolved" });

/** A failed-Last.fm row (`{ error, logId }`). */
const LastfmFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "LastfmBackfillFailed" });

/** A resolved-Apple-Music row (`{ logId, url }`). */
const AppleMusicResolvedSchema = z
  .object({
    logId: z.string(),
    url: z.string(),
  })
  .meta({ id: "AppleMusicBackfillResolved" });

/** A failed-Apple-Music row (`{ error, logId }`). */
const AppleMusicFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "AppleMusicBackfillFailed" });

/**
 * `backfill_discogs` → `POST /admin/backfill/discogs` (operationId
 * `backfillDiscogs`).
 *
 * Agent tier (`adminAuth`). One bounded, reliability-gated pass over
 * published findings missing a Discogs release id; on a confident match the ids are
 * written server-side. Returns `{ ok, dryRun, resolved, resolvedCount, unresolved,
 * unresolvedCount, skipped, skippedCount, nextCursor }` — `skipped` is the findings
 * the per-finding cooldown/done gate held back this pass.
 */
export const backfillDiscogs = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDiscogs",
    path: "/admin/backfill/discogs",
    summary: "Back-fill Discogs release ids over published findings (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Discogs rate-limit circuit breaker — the
      // CLI stops looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(DiscogsResolvedSchema),
      resolvedCount: z.number(),
      // Findings the reliability gate skipped this pass (already resolved, or
      // cooling down after a recent attempt/failure) — they didn't burn the batch.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/**
 * `backfill_lastfm` → `POST /admin/backfill/lastfm` (operationId
 * `backfillLastfm`).
 *
 * Agent tier (`adminAuth`). One bounded, reliability-gated pass
 * loving published findings on Last.fm (idempotent). Returns `{ ok, dryRun, loved,
 * lovedCount, failed, failedCount, skipped, skippedCount, nextCursor }` — `skipped`
 * is the findings the per-finding cooldown/done gate held back this pass.
 */
export const backfillLastfm = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLastfm",
    path: "/admin/backfill/lastfm",
    summary: "Back-fill Last.fm loves over published findings (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(LastfmFailedSchema),
      failedCount: z.number(),
      loved: z.array(z.string()),
      lovedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Last.fm rate-limit circuit breaker — the
      // CLI stops looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      // Findings the reliability gate skipped this pass (already loved, or cooling
      // down after a recent attempt/failure) — they didn't burn the batch budget.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
    }),
  );

/**
 * `backfill_apple_music` → `POST /admin/backfill/apple-music` (operationId
 * `backfillAppleMusic`).
 *
 * Agent tier (`adminAuth`). One bounded, reliability-gated pass over published findings
 * that carry an ISRC but no Apple Music URL; on an EXACT ISRC match (via the Apple Music
 * API) the URL is written server-side. NO-OP until the MusicKit secrets are provisioned
 * (`configured: false`). Returns `{ ok, configured, dryRun, resolved, resolvedCount,
 * unresolved, unresolvedCount, failed, failedCount, skipped, skippedCount, nextCursor,
 * rateLimited }` — `unresolved` is the ISRCs Apple had no song for, `skipped` the
 * findings the per-finding cooldown/done gate held back this pass.
 */
export const backfillAppleMusic = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAppleMusic",
    path: "/admin/backfill/apple-music",
    summary: "Back-fill Apple Music URLs over published findings by exact ISRC (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      // Album-fact rows written once this pass (recordLabel/upc/artwork/palette) off the
      // single-ISRC oracle's canonical album — the second half of the Apple read (RFC U1).
      albumFactsWritten: z.number(),
      // True when the pass STOPPED because the cross-cutting Apple breaker is tripped (K
      // consecutive 401/403 — a suspended developer token) or its call budget is spent.
      breakerTripped: z.boolean(),
      // False when the MusicKit secrets are unset — the leg is a no-op this tick.
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(AppleMusicFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Apple Music rate-limit circuit breaker — the
      // CLI stops looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(AppleMusicResolvedSchema),
      resolvedCount: z.number(),
      // Findings the reliability gate skipped this pass (already resolved, or cooling
      // down after a recent attempt/failure) — they didn't burn the batch.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      // Findings whose ISRC Apple has no song for (a clean no-match, re-checkable later).
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/** A resolved catalogue row (`{ trackId, url }`) — the batched drain keys by track, not log id. */
const AppleCatalogueResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "AppleCatalogueResolved" });

/** A failed catalogue row (`{ error, trackId }`). */
const AppleCatalogueFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "AppleCatalogueFailed" });

/**
 * `backfill_apple_catalogue` → `POST /admin/backfill/apple-catalogue` (operationId
 * `backfillAppleCatalogue`).
 *
 * Agent tier (`adminAuth`) — the catalogue sibling of `backfill_apple_music` (RFC U1). One
 * bounded, reliability-gated pass over CATALOGUE tracks (a `tracks` row with no `findings` row)
 * that carry an ISRC but no Apple URL: the BATCHED oracle (≤25 ISRCs/request) resolves the URL,
 * and the single-ISRC oracle populates each NEW album's second-authority facts once. No cursor —
 * the worklist is a fresh reliability-gated anti-join each tick, so a drained row simply drops
 * out. NO-OP until the MusicKit secrets are provisioned (`configured: false`). It writes catalogue
 * identity only (a URL on `tracks`, facts on `albums`) — never a certification — so it stays
 * agent-allowed, exactly like `rank_catalogue`.
 */
export const backfillAppleCatalogue = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAppleCatalogue",
    path: "/admin/backfill/apple-catalogue",
    summary: "Back-fill Apple URLs + album facts over catalogue tracks by exact ISRC (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      // Album-fact rows written once this pass (recordLabel/upc/artwork/palette).
      albumFactsWritten: z.number(),
      // True when the pass STOPPED on the cross-cutting Apple breaker (suspended token / spent
      // call budget) rather than a 429.
      breakerTripped: z.boolean(),
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(AppleCatalogueFailedSchema),
      failedCount: z.number(),
      ok: z.literal(true),
      rateLimited: z.boolean(),
      resolved: z.array(AppleCatalogueResolvedSchema),
      resolvedCount: z.number(),
      // Catalogue ISRCs Apple has no song for (a clean no-match, re-checkable later).
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/** One credited artist on a candidate album — its name, and its stable Spotify id (grounding key). */
const LabelReleaseArtistSchema = z
  .object({ id: z.string().nullish(), name: z.string() })
  .meta({ id: "LabelReleaseArtist" });

/** One track on a candidate album, mapped from the actor's inline `tracks[]`. */
const LabelReleaseTrackSchema = z
  .object({
    durationMs: z.number().nullish(),
    isrc: z.string().nullish(),
    spotifyTrackId: z.string(),
    title: z.string(),
    /** `spotify:track:<id>` (the actor's `track_uri`); a fallback is derived server-side when absent. */
    uri: z.string().nullish(),
    /** `https://open.spotify.com/track/<id>` (the actor's `track_url`); derived when absent. */
    url: z.string().nullish(),
  })
  .meta({ id: "LabelReleaseTrack" });

/**
 * One candidate album the box's Apify sweep mapped from a single actor result item. The server
 * RE-RUNS the whole gate against it (never trusting the box): `artists[].id` is the GROUNDING key,
 * `albumLabel`/`albumCopyright` the optional ATTRIBUTION signals (both null in the actor's
 * `albums`-search mode — the tap runs on grounding alone there), and `tracks[]` the inline recordings.
 */
const LabelReleaseAlbumSchema = z
  .object({
    albumCopyright: z.string().nullish(),
    albumId: z.string().nullish(),
    albumLabel: z.string().nullish(),
    albumName: z.string().nullish(),
    artists: z.array(LabelReleaseArtistSchema).default([]),
    releaseDate: z.string().nullish(),
    tracks: z.array(LabelReleaseTrackSchema).default([]),
  })
  .meta({ id: "LabelReleaseAlbum" });

/**
 * `list_label_releases_work` → `GET /admin/backfill/label-releases/work` (operationId
 * `listLabelReleasesWork`).
 *
 * Agent tier (`adminAuth`), the `list_track_work` precedent — the FRESHNESS TAP's worklist. The
 * ENABLED seed labels DUE for a fresh-release probe (oldest-probe-stamp first, up to `limit`), each
 * as `{ slug, name }`: the box's Apify sweep builds a `label:"<name>" tag:new` actor query off the
 * name and POSTs the result back keyed by the slug. A pure read — it stamps nothing (the mint op
 * stamps on the POST-back), so a stopped tick loses nothing and re-running drains what is due.
 */
export const listLabelReleasesWork = oc
  .route({
    method: "GET",
    operationId: "listLabelReleasesWork",
    path: "/admin/backfill/label-releases/work",
    summary: "The enabled seed labels due for a fresh-release probe (slug + name)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }))
  .output(
    z.object({
      labels: z.array(z.object({ name: z.string(), slug: z.string() })),
      ok: z.literal(true),
    }),
  );

/**
 * `backfill_label_releases` → `POST /admin/backfill/label-releases` (operationId
 * `backfillLabelReleases`).
 *
 * Agent tier (`adminAuth`) — the FRESHNESS TAP's verify+mint receiver (D8), the `anchor_track`
 * precedent. The box ran the Apify actor `musicae~spotify-extended-scraper` for ONE enabled seed
 * label (`albums:["label:\"<name>\" tag:new"]`) and mapped each result album (with its inline
 * `tracks[]` + `artists[]`) to a candidate; it POSTs them here and the SERVER re-runs the FULL gate
 * (the box's verdict is never trusted). An album mints ONLY when it clears ARTIST-GROUNDING (≥1 of
 * its Spotify artist ids is already in `artists.spotify_artist_id` — the primary anchor), AND, when
 * the actor populated a LABEL signal (`albumLabel`/`albumCopyright` — both null in `albums`-search
 * mode), that signal fold-matches the seed name. Survivors mint METADATA-ONLY catalogue rows (a
 * `tracks` row with no `findings` row) with their day-one release dates — closing the ~2-week
 * MusicBrainz-editorial-lag on /fresh. Deduped against the MB crawl from both directions (Spotify id /
 * uri / ISRC + same-album title fold), never a certification, no graph expansion. It writes catalogue
 * identity only, so the box's agent token drives it. Completing a label stamps its re-probe cadence;
 * a slug that is not an enabled seed label is a no-op (`found:false`). The Worker touches NO official
 * Spotify API on this path — the tap is on Apify's separate budget.
 */
export const backfillLabelReleases = oc
  .route({
    method: "POST",
    operationId: "backfillLabelReleases",
    path: "/admin/backfill/label-releases",
    summary: "Verify a seed label's Apify-supplied fresh releases and mint the catalogue rows",
    tags: ["Admin"],
  })
  .input(
    z.object({
      candidates: z.array(LabelReleaseAlbumSchema).default([]),
      labelSlug: z.string().min(1),
    }),
  )
  .output(
    z.object({
      // Albums that PASSED the gate (grounded AND, when a label signal was present, attributed).
      albumsMatched: z.number(),
      // Albums the box supplied for this label this call (before the gate).
      albumsSeen: z.number(),
      // False when the slug is not an ENABLED seed label — a no-op, nothing minted or stamped.
      found: z.boolean(),
      labelSlug: z.string(),
      // Catalogue rows minted this call (never a certification).
      newRows: z.number(),
      // The minted track ids — bounded (a label's fresh releases).
      newTrackIds: z.array(z.string()),
      ok: z.literal(true),
      // Tracks skipped because the archive already holds them (Spotify id / uri / ISRC / same-album
      // title fold) — the dedupe contract, working.
      skippedKnown: z.number(),
      // Albums DROPPED because a label signal WAS present but did not fold-match the seed name (a
      // homonym label the fuzzy filter returned). Always 0 in the actor's grounding-only mode.
      skippedUnattributed: z.number(),
      // Albums DROPPED for artist-grounding (no artist on the album is in our archive yet — a
      // homonym label, or a debut awaiting the MB backfill).
      skippedUngrounded: z.number(),
    }),
  );

/** A failed label-image row (`{ error, slug }`). */
const LabelImagesBackfillFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "LabelImagesBackfillFailed" });

/**
 * `backfill_label_images` → `POST /admin/backfill/label-images` (operationId
 * `backfillLabelImages`).
 *
 * Agent tier (`adminAuth`): internal + reversible metadata enrichment (it resolves a label's
 * OWN logo and stores it in R2 — no publish), so the box's agent-token cron drives it. One
 * bounded, reliability-gated pass over the `labels` worklist: each label's identity is walked
 * (MusicBrainz label search → its curated Discogs/Wikidata url-rels) and its logo downloaded once
 * into our own bucket, up the ladder Discogs → Wikidata → none (the freshest-cover floor).
 * Returns `{ ok, dryRun, resolved, resolvedCount, none, noneCount, failed, failedCount,
 * nextCursor, rateLimited }` — `none` is the labels with no own image anywhere (floored to the
 * cover), `rateLimited` STOPS the loop on a vendor throttle.
 */
export const backfillLabelImages = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLabelImages",
    path: "/admin/backfill/label-images",
    summary: "Resolve label logos (Discogs → Wikidata) into R2 for existing labels (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(LabelImagesBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      // Labels with no own image anywhere (Discogs + Wikidata both empty) — floored to the
      // freshest finding's cover, terminal so they never re-resolve.
      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),
      // True when the pass STOPPED on a vendor rate-limit circuit breaker — the CLI stops
      // looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

/** A failed label-lineage row (`{ error, slug }`). */
const LabelLineageBackfillFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "LabelLineageBackfillFailed" });

/**
 * `backfill_label_lineage` → `POST /admin/backfill/label-lineage` (operationId
 * `backfillLabelLineage`).
 *
 * Agent tier (`adminAuth`): internal + reversible metadata enrichment (RFC label-lineage-remixer,
 * U1). It gives each label its FOUNDING facts + its place in the imprint hierarchy from MusicBrainz
 * — `life-span.begin` → `founding_date`, `area.name` → `founded_location`, and the `backward`
 * `label ownership` / `imprint` label-rels → `parent_label_id` (matched to an EXISTING label by
 * MBID; NEVER minted). One bounded, reliability-gated pass over the `labels` worklist (its own
 * `lineage_state` machine, so it reaches every label the image sweep already retired), the
 * `backfill_label_images` precedent. Returns `{ ok, dryRun, resolved, resolvedCount, none,
 * noneCount, failed, failedCount, unmatchedParents, nextCursor, rateLimited }` — `unmatchedParents`
 * is the parent edges MusicBrainz named but no archive row carries (noted, never minted).
 */
export const backfillLabelLineage = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLabelLineage",
    path: "/admin/backfill/label-lineage",
    summary:
      "Resolve label lineage (founding date, place, parent imprint) from MusicBrainz (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(LabelLineageBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      // Labels with no MusicBrainz identity to walk — terminal, so they never re-resolve.
      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),
      // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — the CLI stops
      // looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
      // Backward parent edges MusicBrainz named but no archive label carries by MBID — noted for
      // the operator, NEVER minted from this path.
      unmatchedParents: z.number(),
    }),
  );

/** A failed cover-master row (`{ error, slug }`). */
const CoverMastersFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "CoverMastersFailed" });

/**
 * `backfill_cover_masters` → `POST /admin/backfill/cover-masters` (operationId
 * `backfillCoverMasters`).
 *
 * Agent tier (`adminAuth`): internal + reversible metadata enrichment (RFC U3b). It resolves an
 * ALBUM or ARTIST (`?kind=album|artist`, default album) its OWN ≤1200²-capped cover derivative and
 * stores it in R2 — no publish — up the source ladder (album: Apple template → Cover Art Archive →
 * Spotify floor; artist: Spotify floor). The `label_images` precedent: one bounded, reliability-
 * gated pass over the `pending` worklist, slug-cursored, the box's agent-token cron drives it.
 * Returns `{ ok, kind, dryRun, resolved, resolvedCount, none, noneCount, failed, failedCount,
 * nextCursor, rateLimited }` — `none` is the entities with no usable source (floored to the raw
 * URL, terminal). `?retry=none` FIRST re-queues a bounded batch of terminal `none` rows to
 * `pending` (the operator heal for a cover that went `none` historically but now has a source),
 * then runs the pass in the same call; the re-queued slugs come back as `requeued`/`requeuedCount`.
 */
export const backfillCoverMasters = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillCoverMasters",
    path: "/admin/backfill/cover-masters",
    summary: "Resolve owned ≤1200² cover masters (album/artist) into R2 (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        // `album` (the 3-rung ladder) or `artist` (the Spotify floor). Default album. Tolerant
        // string, clamped in-handler like `limit`/`dryRun` — never a 400 on a stray value.
        kind: z.string().optional(),
        limit: z.string().optional(),
        // `none` re-queues a bounded batch of the kind's TERMINAL `none` rows back to `pending`
        // BEFORE the pass runs — the operator heal for a cover that went `none` historically but
        // now has a source (a fresh Apple template / a recovered Cover Art Archive). Tolerant
        // string, clamped in-handler like `kind` — any value other than `none` is ignored.
        retry: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(CoverMastersFailedSchema),
      failedCount: z.number(),
      // The kind this pass drained — echoed back so the CLI/cron reads honestly.
      kind: z.enum(["album", "artist"]),
      nextCursor: z.string().nullable(),
      // Entities with no usable source anywhere — floored to the raw URL, terminal.
      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),
      // Uniform with the label-images sweep; image CDNs are not throttled, so this never trips.
      rateLimited: z.boolean(),
      // Slugs re-queued from terminal `none` → `pending` this call by `retry=none`, before the pass
      // ran (in a dry run, what WOULD requeue). Optional so a consumer that never sends `retry` is
      // untouched — the field is simply absent / empty on a normal pass.
      requeued: z.array(z.string()).optional(),
      requeuedCount: z.number().optional(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

/** A failed recording-MBID row (`{ error, trackId }`). */
const RecordingMbidsFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "RecordingMbidsBackfillFailed" });

/**
 * `backfill_recording_mbids` → `POST /admin/backfill/recording-mbids` (operationId
 * `backfillRecordingMbids`).
 *
 * Agent tier (`adminAuth`): internal metadata enrichment (the MusicBrainz identity layer). It gives
 * every track its canonical MusicBrainz recording MBID — the KG join key the `/log` MusicRecording
 * emits as a `sameAs` + `identifier` — via two fill paths: a FREE SQL strip of crawler-born rows'
 * PK (`mb_<recording-mbid>` → the column), then an ISRC→recording resolve over findings/Spotify-born
 * rows through the shared MusicBrainz client (1 req/s, circuit-broken on a throttle). It writes
 * catalogue identity only (never a certification), so the box's agent-token cron drives it, the
 * `backfill_label_images` precedent. Returns `{ ok, dryRun, prefixStripped, resolved, resolvedCount,
 * missed, missedCount, failed, failedCount, nextCursor, rateLimited }` — `missed` is the ISRCs
 * MusicBrainz has no recording for (attempt-stamped so the worklist drains), `rateLimited` STOPS the
 * loop on a MusicBrainz throttle.
 */
export const backfillRecordingMbids = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillRecordingMbids",
    path: "/admin/backfill/recording-mbids",
    summary:
      "Fill MusicBrainz recording MBIDs (crawler PK strip + ISRC resolve) over tracks (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(RecordingMbidsFailedSchema),
      failedCount: z.number(),
      // Track ids whose ISRC MusicBrainz has no recording for — attempt-stamped so they drain.
      missed: z.array(z.string()),
      missedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // Crawler-history rows filled from their PK this pass (the free no-vendor strip).
      prefixStripped: z.number(),
      // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — the CLI stops
      // looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

/** The `admin-backfills` domain's ops, merged into the root contract by `./index.ts`. */
export const adminBackfillsContract = {
  backfill_apple_catalogue: backfillAppleCatalogue,
  backfill_apple_music: backfillAppleMusic,
  backfill_cover_masters: backfillCoverMasters,
  backfill_discogs: backfillDiscogs,
  backfill_label_images: backfillLabelImages,
  backfill_label_lineage: backfillLabelLineage,
  backfill_label_releases: backfillLabelReleases,
  backfill_lastfm: backfillLastfm,
  backfill_recording_mbids: backfillRecordingMbids,
  list_label_releases_work: listLabelReleasesWork,
};
