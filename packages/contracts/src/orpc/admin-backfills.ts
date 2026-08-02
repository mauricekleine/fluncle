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
 * unresolvedCount, skipped, skippedCount, nextCursor, rateLimited, rateLimitedBy }`
 * — `skipped` is the findings the per-finding cooldown/done gate held back this
 * pass, and `rateLimitedBy` names the actual vendor behind a throttle.
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
      // The resolver walks MusicBrainz before Discogs. Name the actual brake rather
      // than attributing every throttle to the command's Discogs label.
      rateLimitedBy: z.enum(["discogs", "musicbrainz"]).nullable(),
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

/** A resolved Discogs-facts row (`{ catno, slug }`) — the leg is album-grained, so it keys by slug. */
const DiscogsFactsResolvedSchema = z
  .object({
    catno: z.string(),
    slug: z.string(),
  })
  .meta({ id: "DiscogsFactsResolved" });

/** A failed Discogs-facts row (`{ error, slug }`). */
const DiscogsFactsFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "DiscogsFactsFailed" });

/**
 * `backfill_discogs_facts` → `POST /admin/backfill/discogs-facts` (operationId
 * `backfillDiscogsFacts`).
 *
 * Agent tier (`adminAuth`) — the FACTS sibling of `backfill_discogs`. That leg resolves a finding to
 * a Discogs RELEASE ID and stops; this one takes the id and reads the two album-grained facts off
 * the release: `labels[].catno` (the label's own catalogue number, the code printed on the sleeve)
 * and `styles[]`. Both land on the `albums` row — the catno reaches `/album/<slug>` and its
 * MusicRelease JSON-LD as `catalogNumber`, the styles are stored only (the album page has no honest
 * home for them; see docs/album-entity.md).
 *
 * IT EXISTS BECAUSE THE RESOLVER'S PRIMARY LEG NEVER SEES A RELEASE PAYLOAD: the MusicBrainz bridge
 * reaches a Discogs id through a curated `url-rels` relation and accepts it directly, so most
 * resolved findings carry an id whose payload nobody fetched. The scored-search half is captured
 * inline at resolve time for free; this drains the rest at the shared client's ~1 req/s pacing.
 *
 * ALBUM-GRAINED AND SELF-DRAINING. Ten findings off one record share one catalogue number, so the
 * worklist groups by album and buys the release once, and the ledger lives on `albums`
 * (`discogs_state` pending → resolved | none, plus the attempted/failures pair). No cursor: an album
 * leaves the worklist the moment it is ruled. `none` is the releases that genuinely carry no number
 * (terminal — a pressing does not grow one later); `failed` is a lookup that errored, where nothing
 * was learned and a later tick retries. It writes catalogue metadata only, never a certification, so
 * it stays agent-allowed. A NO-OP until `DISCOGS_USER_TOKEN` is provisioned (`configured: false`).
 */
export const backfillDiscogsFacts = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDiscogsFacts",
    path: "/admin/backfill/discogs-facts",
    summary: "Back-fill album catalogue numbers + styles from already-resolved Discogs releases",
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
      // False when DISCOGS_USER_TOKEN is unset — the leg was a no-op this tick.
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(DiscogsFactsFailedSchema),
      failedCount: z.number(),
      // Albums whose release genuinely carries no catalogue number — terminal, never re-read.
      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Discogs rate-limit circuit breaker — the next tick
      // resumes with a fresh window, and nothing was stamped.
      rateLimited: z.boolean(),
      resolved: z.array(DiscogsFactsResolvedSchema),
      resolvedCount: z.number(),
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

/** A resolved Beatport row (`{ logId, url }`). */
const BeatportResolvedSchema = z
  .object({
    logId: z.string(),
    url: z.string(),
  })
  .meta({ id: "BeatportResolved" });

/** A failed Beatport row (`{ error, logId }`). */
const BeatportFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "BeatportFailed" });

/** A resolved Beatport CATALOGUE row (`{ trackId, url }`) — an uncertified row has no Log ID. */
const BeatportCatalogueResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "BeatportCatalogueResolved" });

/** A failed Beatport CATALOGUE row (`{ error, trackId }`). */
const BeatportCatalogueFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "BeatportCatalogueFailed" });

/**
 * `backfill_beatport` → `POST /admin/backfill/beatport` (operationId `backfillBeatport`).
 *
 * Agent tier (`adminAuth`) — the STORE leg of the identity answer. One bounded, reliability-gated
 * pass over published findings carrying an ISRC but no Beatport link: a keyless scrape of
 * Beatport's public search (through Firecrawl, since the site is Cloudflare-walled) whose results
 * embed their own ISRCs, and the link is kept ONLY on exact ISRC equality with the one Fluncle
 * already holds. Never a title guess, so a wrong link cannot render.
 *
 * NO BEATPORT API KEY IS USED, and the ecosystem's borrowed-embed-`client_id` workaround is
 * forbidden outright — see lib/server/beatport-resolve.ts. A NO-OP until `FIRECRAWL_API_KEY` is
 * provisioned (`configured: false`), stamping nothing so the archive stays eligible.
 *
 * `unresolved` is a CLEAN no-match (Beatport does not carry the recording — a `tried`, re-checkable
 * if their catalogue grows); `failed` is a scrape that errored, where nothing was learned. The two
 * are deliberately separate: writing the first as the second would tell a reader "not on Beatport"
 * because a request timed out. It writes catalogue identity only (one URL on `tracks`), never a
 * certification, so it stays agent-allowed.
 */
export const backfillBeatport = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillBeatport",
    path: "/admin/backfill/beatport",
    summary: "Back-fill Beatport URLs over published findings by exact ISRC",
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
      // The CATALOGUE tier's own counters, kept apart from the findings arrays because the two are
      // different money (one of ~85 certified rows versus one of five figures, each a Firecrawl
      // credit) and keyed differently (a catalogue row has no Log ID).
      catalogueFailed: z.array(BeatportCatalogueFailedSchema),
      catalogueFailedCount: z.number(),
      catalogueResolved: z.array(BeatportCatalogueResolvedSchema),
      catalogueResolvedCount: z.number(),
      catalogueUnresolved: z.array(z.string()),
      catalogueUnresolvedCount: z.number(),
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(BeatportFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      resolved: z.array(BeatportResolvedSchema),
      resolvedCount: z.number(),
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      // Findings Beatport ran a search for and does not carry (a clean no-match).
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/** A resolved Deezer row (`{ trackId, url }`) — the leg spans both tiers, so it keys by track. */
const DeezerResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "DeezerResolved" });

/** A failed Deezer row (`{ error, trackId }`). */
const DeezerFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "DeezerFailed" });

/**
 * `backfill_deezer` → `POST /admin/backfill/deezer` (operationId `backfillDeezer`).
 *
 * Agent tier (`adminAuth`) — the FORWARD-ACCRETION leg for the Deezer link. One bounded,
 * ledger-gated pass over ISRC-bearing rows with no `deezer_track_id` and no concluded look yet:
 * CERTIFIED rows first, then CATALOGUE rows in the Ear's capture-priority order, one keyless
 * `GET /track/isrc:<ISRC>` each. No key is used or wanted, so there is no `configured` flag — the
 * leg is live on deploy.
 *
 * THE GATE IS THE DURATION. That endpoint PICKS a recording rather than listing them (a measured
 * ~7% silent mismatch), so an id is kept only when the returned track's duration agrees with the
 * row's within the ratified window. A pick that cannot be vouched for is reported as `unvouchable`
 * and stamps NOTHING — it is neither a hit nor a miss, and the receipt refuses to claim either.
 *
 * `unresolved` is a CONCLUDED miss (Deezer answered `DataException`: it looked and carries nothing),
 * stamped so `/identity` can say "Not found · checked <date>" instead of "Not checked yet".
 * `failed` is transport, which stamps only a failure streak so the row stays eligible.
 * `rateLimited` is Deezer's quota answer — which arrives in an HTTP-200 body, so it is invisible to
 * anything that only reads `data` — and it ENDS the pass having stamped nothing at all. No cursor:
 * the worklist is a fresh ledger-gated read each tick. It writes catalogue identity only (one id +
 * its provenance on `tracks`), never a certification, so it stays agent-allowed.
 */
export const backfillDeezer = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDeezer",
    path: "/admin/backfill/deezer",
    summary: "Back-fill Deezer track ids over certified + catalogue rows by exact ISRC",
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
      dryRun: z.boolean(),
      failed: z.array(DeezerFailedSchema),
      failedCount: z.number(),
      ok: z.literal(true),
      // True when the pass STOPPED on Deezer's quota answer; nothing was stamped.
      rateLimited: z.boolean(),
      resolved: z.array(DeezerResolvedSchema),
      resolvedCount: z.number(),
      // ISRCs Deezer concluded it carries no recording for (stamped, a real negative).
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
      // Rows Deezer picked a track for whose duration did not vouch — stamped nothing.
      unvouchable: z.array(z.string()),
      unvouchableCount: z.number(),
    }),
  );

/**
 * `backfill_label_releases` → `POST /admin/backfill/label-releases` (operationId
 * `backfillLabelReleases`).
 *
 * Agent tier (`adminAuth`) — the FRESHNESS TAP (D8). ONE bounded probe pass over the operator's
 * ENABLED seed labels (`labels.seed_state = 'enabled'` — the crawl allowlist, never widened): the
 * WORKER searches each label's fresh releases on the official Spotify API (`label:"<name>" tag:new`),
 * reads each hit as a SINGLE `GET /albums/{id}` (the batch endpoints are 403 at our tier), and mints
 * METADATA-ONLY catalogue rows (a `tracks` row with no `findings` row) carrying their day-one release
 * dates — closing the ~2-week MusicBrainz-editorial-lag on /fresh. An album mints only when it clears
 * BOTH signals: ARTIST-GROUNDING (≥1 of its Spotify artist ids already in `artists.spotify_artist_id`
 * — the primary anchor against cross-genre homonym junk) AND an EXACT fold-match of the seed name in
 * the ℗/© copyright. An undated album is dropped outright (/fresh could never show it). MusicBrainz
 * still WALKS the graph; the tap only TAPS freshness — no new labels, no artist hops, never a
 * certification. Deduped against the MB crawl from both directions (Spotify id / uri / ISRC +
 * same-album title fold).
 *
 * PACED BY THE SHARED CALL METER, and deliberately a second-class citizen on it: the tap proceeds
 * only while the per-app window is below its own ceiling (a FRACTION of the meter's max), so it
 * leaves headroom for the user-facing mints rather than spending the window down. Hitting that
 * ceiling reports `budgetPaused` and ENDS the pass cleanly — the durable per-label cadence stamps
 * resume it next tick. `configured: false` when the publish path's Spotify grant is gone. No cursor:
 * the worklist is the oldest-probed enabled labels each tick, so re-running drains what is due.
 */
export const backfillLabelReleases = oc
  .route({
    method: "POST",
    operationId: "backfillLabelReleases",
    path: "/admin/backfill/label-releases",
    summary: "Tap Spotify's fresh releases for enabled seed labels into catalogue rows (bounded)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      // A real JSON boolean, never a coerced string: `z.coerce.boolean()` reads the STRING "false"
      // as true, which would turn a dry run into a live pass. The body is JSON, so this is honest.
      dryRun: z.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(200).default(5),
    }),
  )
  .output(
    z.object({
      // Albums that PASSED both signals (artist-grounded AND an exact copyright match).
      albumsMatched: z.number(),
      // Albums the label searches returned this pass (before the gate).
      albumsSeen: z.number(),
      // True when the pass STEPPED BACK from the shared Spotify window at the tap's own ceiling,
      // leaving the remaining headroom for the user-facing paths. Clean; resumes next tick.
      budgetPaused: z.boolean(),
      // False when the Spotify grant is gone — the whole tap is a no-op this tick (reconnect needed).
      configured: z.boolean(),
      dryRun: z.boolean(),
      // Single album/track reads that 404/5xx'd and were SKIPPED (not a label failure stamp).
      failedFetches: z.number(),
      // Labels that hit a TRANSIENT Spotify error on their SEARCH this pass (backed off, re-probed).
      failedLabels: z.array(z.string()),
      // True when the pass ended early on the per-pass single-fetch ceiling — a soft cap; the
      // un-stamped labels resume next tick.
      fetchCeilingHit: z.boolean(),
      // The seed-label slugs probed this pass — or, in a dry run, the ones that WOULD be probed.
      labelSlugs: z.array(z.string()),
      // Enabled seed labels whose fresh-release search actually ran this pass.
      labelsProbed: z.number(),
      // Catalogue rows minted this pass (never a certification).
      newRows: z.number(),
      // The minted track ids — bounded (a few labels x their fresh releases).
      newTrackIds: z.array(z.string()),
      ok: z.literal(true),
      // True when the pass STOPPED on a Spotify 429 (the backstop beneath the meter).
      rateLimited: z.boolean(),
      // Tracks skipped because the archive already holds them (Spotify id / uri / ISRC / same-album
      // title fold) — the dedupe contract, working.
      skippedKnown: z.number(),
      // Albums DROPPED for carrying no release_date — a row /fresh could never surface.
      skippedUndated: z.number(),
      // Albums DROPPED for artist-grounding (no artist on the album is in our archive yet — a
      // homonym label, or a debut awaiting the MB backfill).
      skippedUngrounded: z.number(),
      // Tracks dropped by a bridged FIRST-credit Spotify artist BLOCK rule. Optional so pinned
      // consumers that predate the freshness-tap scope counter continue to parse old responses.
      tracksSkippedArtistRule: z.number().optional(),
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

/**
 * `backfill_artist_edges` → `POST /admin/backfill/artist-edges` (operationId
 * `backfillArtistEdges`).
 *
 * Agent tier (`adminAuth`): the track_artists graph backfill (RFC artist-primary-capture, slice 0).
 * It folds each edge-less track's `artists_json` NAMES onto EXISTING `artists` rows — exact
 * case-insensitive fold, then `artist_aliases` (auto|confirmed) — and writes the `track_artists`
 * edges `insert or ignore`. It MINTS NOTHING (a bare name is not enough identity), makes NO vendor
 * call (pure DB matching), and stamps every visited track (`artist_edges_backfilled_at`) so the
 * worklist drains and a re-run is a no-op — catalogue-graph identity only (no publish, no
 * certification), so the box's agent-token cron drives it, the `backfill_recording_mbids` precedent.
 * Returns `{ ok, dryRun, scanned, edgesWritten, fullyMatched(+Count), partiallyMatched(+Count),
 * zeroMatched(+Count), unmatchedNames, nextCursor, queueDepth }` — `unmatchedNames` is the residual
 * (credited names with no identity) a future paced MusicBrainz credit-sweep would mint from.
 */
export const backfillArtistEdges = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtistEdges",
    path: "/admin/backfill/artist-edges",
    summary: "Fold artists_json names onto existing artist identities → track_artists (batched)",
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
      // `track_artists` edges written this pass (or, in a dry run, the count that WOULD be written).
      edgesWritten: z.number(),
      // Track ids where EVERY credited name matched an existing identity.
      fullyMatched: z.array(z.string()),
      fullyMatchedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // Track ids where SOME names matched and some did not — their unmatched names feed the residual.
      partiallyMatched: z.array(z.string()),
      partiallyMatchedCount: z.number(),
      // Authoritative post-pass worklist size. The Worker counts through the two queue indexes.
      queueDepth: z.number(),
      // Tracks VISITED this pass (fully + partially + zero) — the CLI loop's cap unit.
      scanned: z.number(),
      // Total credited names across the batch that matched NO identity — the residual a future paced
      // MusicBrainz credit-sweep would mint from.
      unmatchedNames: z.number(),
      // Track ids where NO credited name matched an identity.
      zeroMatched: z.array(z.string()),
      zeroMatchedCount: z.number(),
    }),
  );

/**
 * `backfill_artist_credits` → `POST /admin/backfill/artist-credits` (operationId
 * `backfillArtistCredits`).
 *
 * Agent tier (`adminAuth`): the MB CREDIT SWEEP (RFC artist-primary-capture, slice 1b) — the sibling
 * that completes what `backfill_artist_edges` (slice 0) could not. Slice 0's name-fold left a
 * zero-matched residual (a track it stamped but wrote no edge, because no credited name folded to an
 * existing identity); this sweep picks up that residual. For each zero-matched track carrying a
 * MusicBrainz recording identity (`mb_recording_id`, or the `mb_<recording-mbid>` PK a crawler-born
 * row carries), ONE paced `/recording/<mbid>?inc=artist-credits` lookup through the shared MusicBrainz
 * client names its credited artists WITH their MB artist ids. Each resolves down a three-rung ladder:
 * an EXACT `mbid` match, else an ADOPT (the credit name folds unambiguously onto an existing artist
 * with no mbid — the common case, since the residual is dominated by compound credit strings whose
 * members Fluncle already holds as Spotify-keyed rows; adopting instead of minting is what stops this
 * sweep spawning split-identity duplicates), else a MINT of a fresh identity-true row. The
 * `track_artists` edges are then written. A zero-matched track with NO MB identity is TERMINALLY
 * SKIPPED. It writes catalogue-graph identity only (no publish, no certification), so the box's
 * agent-token cron drives it, the `backfill_recording_mbids` precedent. Its OWN reliability stamp
 * (`artist_credits_backfilled_at`) — DISTINCT from slice 0's, whose semantics it never disturbs.
 * Worker-paced (1 req/s, circuit-broken on a throttle) with a 60s response budget. Returns `{ ok,
 * dryRun, scanned, mintedArtists, matchedArtists, adoptedArtists, edgesWritten, skippedNoIdentity,
 * rateLimited, nextCursor }`.
 */
export const backfillArtistCredits = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtistCredits",
    path: "/admin/backfill/artist-credits",
    summary:
      "Mint identity-true artists from MusicBrainz credits for slice 0's zero-matched residual (batched)",
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
      // EXISTING artists that had no mbid and gained one via an unambiguous name fold this pass — the
      // duplicate-prevention rung (a Spotify-keyed row slice 0 could not match, now MB-identified).
      adoptedArtists: z.number(),
      dryRun: z.boolean(),
      // `track_artists` edges written this pass (or, in a dry run, 0 — the edges are unknowable
      // without the vendor calls a dry run skips).
      edgesWritten: z.number(),
      // Credited artists matched to an EXISTING `artists` row by exact MB artist id this pass.
      matchedArtists: z.number(),
      // NEW `artists` rows minted by MB artist id this pass (identity-true — a real MBID backs each).
      mintedArtists: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — the CLI stops
      // looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      // Worklist rows VISITED this pass (edged + skipped) — the CLI loop's cap unit.
      scanned: z.number(),
      // Zero-matched rows carrying NO MB recording identity — terminally skipped (stamped, never retried).
      skippedNoIdentity: z.number(),
    }),
  );

/** The `admin-backfills` domain's ops, merged into the root contract by `./index.ts`. */
export const adminBackfillsContract = {
  backfill_apple_catalogue: backfillAppleCatalogue,
  backfill_apple_music: backfillAppleMusic,
  backfill_artist_credits: backfillArtistCredits,
  backfill_artist_edges: backfillArtistEdges,
  backfill_beatport: backfillBeatport,
  backfill_cover_masters: backfillCoverMasters,
  backfill_deezer: backfillDeezer,
  backfill_discogs: backfillDiscogs,
  backfill_discogs_facts: backfillDiscogsFacts,
  backfill_label_images: backfillLabelImages,
  backfill_label_lineage: backfillLabelLineage,
  backfill_label_releases: backfillLabelReleases,
  backfill_lastfm: backfillLastfm,
  backfill_recording_mbids: backfillRecordingMbids,
};
