// The `tracks` domain contract module. Owns every track-read op; a future wave
// adds an op here and one import line in `./index.ts`, touching no other
// domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  FeedItemSchema,
  FreshAlbumSchema,
  FreshTrackSchema,
  MixCandidateSchema,
  MixtapeDTOSchema,
  TrackListItemSchema,
} from "./_shared";

/**
 * `get_track` → `GET /tracks/{idOrLogId}` (operationId `getTrack`).
 *
 * Public read of a single finding by its Spotify trackId OR its Log ID — the
 * lookup the enrichment agent uses to turn its input into track metadata. A Log
 * ID can also resolve to a mixtape, so the response is the discriminated
 * `{ ok: true } & ({ track } | { mixtape })` envelope (mirrors `TrackGetResponse`
 * in ../index.ts, plus the mixtape arm the live route already serves).
 */
export const getTrack = oc
  .route({
    method: "GET",
    operationId: "getTrack",
    path: "/tracks/{idOrLogId}",
    summary: "Get a finding (or mixtape) by Spotify trackId or Log ID",
    tags: ["Tracks"],
  })
  .input(z.object({ idOrLogId: z.string() }))
  .output(
    z.union([
      z.object({ ok: z.literal(true), track: TrackListItemSchema }),
      z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true) }),
    ]),
  );

/**
 * `list_tracks` → `GET /tracks` (operationId `listTracks`).
 *
 * The public merged feed — findings interleaved with published mixtapes, newest
 * first, keyset-paginated. The query params mirror the live route exactly:
 *   - `limit`   — page size (default 16, clamped to 48). Kept as a raw string and
 *                 parsed in-handler so an invalid value degrades to the default
 *                 exactly as the live route does (rather than 400-ing on a
 *                 non-numeric query — coercion would reject `?limit=abc`).
 *   - `cursor`  — the opaque base64url keyset cursor from a prior page's
 *                 `nextCursor`.
 *   - `since` / `until` — the newsletter agent's discovery window (ISO 8601).
 *                 When EITHER is present the feed is findings-only (mixtapes are
 *                 dropped), matching the live `includeMixtapes` gate.
 *
 * Every param is a tolerant optional string: the live route never rejects a
 * malformed query, it degrades, so the contract accepts any string and the
 * handler ports the exact parse/clamp logic.
 *
 * The response is the `FeedListPage` itself — NO `ok` envelope (the page is the
 * body, mirroring `TracksResponse` in ../index.ts).
 */
export const listTracks = oc
  .route({
    method: "GET",
    operationId: "listTracks",
    path: "/tracks",
    summary: "List the merged feed (findings + published mixtapes)",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    }),
  )
  .output(
    z.object({
      nextCursor: z.string().optional(),
      totalCount: z.number(),
      tracks: z.array(FeedItemSchema),
    }),
  );

/**
 * `get_random_track` → `GET /tracks/random` (operationId `getRandomTrack`).
 *
 * One random certified finding, mapped like every other list item. The success
 * body is the `{ ok: true, track }` envelope (mirrors `RandomTrackResponse` in
 * ../index.ts). An empty archive is a 404 — handled by the rails error encoder,
 * not the output schema.
 */
export const getRandomTrack = oc
  .route({
    method: "GET",
    operationId: "getRandomTrack",
    path: "/tracks/random",
    summary: "Get one random finding",
    tags: ["Tracks"],
  })
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

/**
 * `get_similar_findings` → `GET /tracks/{idOrLogId}/similar` (operationId
 * `getSimilarFindings`).
 *
 * The N sonically-nearest findings to the given one — the automatic "more like this"
 * cluster (docs/track-lifecycle.md). Loads the target's MuQ audio
 * embedding, cosine-ranks it against every other coordinate-bearing finding's
 * embedding, and returns the top-N (self excluded, similarity order). A public read;
 * the same op backs the `/log` "more like this" row and a future radio "play
 * something like this" hook.
 *
 * `limit` is a tolerant optional string (default 6, clamped to 24), parsed in-handler
 * so a bad value degrades to the default rather than 400-ing — mirrors `list_tracks`.
 * An unknown coordinate, a finding with no embedding yet (the embed cron hasn't
 * drained it), or an otherwise-empty archive all yield `{ ok: true, findings: [] }` —
 * a quiet empty row, never an error.
 */
export const getSimilarFindings = oc
  .route({
    method: "GET",
    operationId: "getSimilarFindings",
    path: "/tracks/{idOrLogId}/similar",
    summary: "Get the sonically-nearest findings to one (by Spotify trackId or Log ID)",
    tags: ["Tracks"],
  })
  .input(z.object({ idOrLogId: z.string(), limit: z.string().optional() }))
  .output(z.object({ findings: z.array(TrackListItemSchema), ok: z.literal(true) }));

/**
 * `list_mixable_tracks` → `GET /tracks/{idOrLogId}/mixable` (operationId
 * `listMixableTracks`).
 *
 * The tracks that mix cleanly OUT of the given one, ranked by the mixability engine
 * (`lib/server/mixability.ts`) — a harmonic next-track finder with a dense texture
 * tiebreak and a live MuQ sonic term. The rail behind `/mix`.
 *
 * CANDIDATES ARE THE WHOLE ARCHIVE, not just the findings. Any track with a key is
 * rankable (the key is the engine's mandatory floor), so a track Fluncle has never
 * certified competes for the rail on exactly the same terms as one he has — which is what
 * makes the tool get BETTER as the archive grows rather than merely bigger. Each row says
 * which it is with `certified`, and nothing else: the uncertified tier has no public name
 * (DESIGN.md's Unlit Rule), so the flag picks a visual register and never a label. A row
 * with `certified: false` has no `logId` and cannot be given one — see `MixTrackSchema`.
 *
 * `taste` is the SEED: a comma-separated list of artist slugs (`list_mixable_artists`).
 * Present, the rail is ordered by mixability × taste rather than mixability alone — every
 * candidate still mixes clean, and the ones that sound like the artists you named come
 * first. Taste is max-similarity to the NEAREST seeded artist's track, never a centroid
 * (`tasteSubScore`). Absent or unresolvable, the rail is the plain mixability order.
 *
 * `limit` is a tolerant optional string (default 12, clamped to 32), parsed in-handler
 * so a bad value degrades rather than 400-ing (mirrors `get_similar_findings`).
 * `exclude` is a comma-separated list of the already-chained tracks — Log IDs or Spotify
 * track ids, mixed freely, because a chain now holds both kinds. Excluded SERVER-SIDE so
 * a deep chain can't silently empty the rail.
 *
 * Public-unauth (keys/BPMs are already public on every track chip). An unknown coordinate
 * / a target scored on nothing / an empty archive all yield `{ ok: true, findings: [] }` —
 * a quiet empty rail, never a fault.
 */
export const listMixableTracks = oc
  .route({
    method: "GET",
    operationId: "listMixableTracks",
    path: "/tracks/{idOrLogId}/mixable",
    summary: "List the tracks that mix cleanly out of one (by Spotify trackId or Log ID)",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      exclude: z.string().optional(),
      idOrLogId: z.string(),
      limit: z.string().optional(),
      taste: z.string().optional(),
    }),
  )
  .output(z.object({ findings: z.array(MixCandidateSchema), ok: z.literal(true) }));

/** The `tracks` domain's ops, merged into the root contract by `./index.ts`. */
/**
 * `list_fresh` → `GET /tracks/fresh` (operationId `listFresh`).
 *
 * WHAT JUST CAME OUT: the newest drum & bass RELEASES over a trailing 30-day window, newest release
 * first, flat and capped (`limit`, a tolerant string, default 50, max 100). Ordered by
 * `tracks.release_date` — NOT `findings.added_at` — so this is "just landed", never "Fluncle found"
 * (VOICE.md's Found Rule; the opposite date axis from `list_tracks`). Every track is unlit-safe: an
 * uncertified catalogue row carries no `logId` and no cover (the Unlit Rule, structural in the DTO).
 * `albums` are the album entities those releases sit on.
 */
export const listFresh = oc
  .route({
    method: "GET",
    operationId: "listFresh",
    path: "/tracks/fresh",
    summary: "List what just came out (newest releases)",
    tags: ["Tracks"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(
    z.object({
      albums: z.array(FreshAlbumSchema),
      tracks: z.array(FreshTrackSchema),
      windowDays: z.number(),
    }),
  );

export const tracksContract = {
  get_random_track: getRandomTrack,
  get_similar_findings: getSimilarFindings,
  get_track: getTrack,
  list_fresh: listFresh,
  list_mixable_tracks: listMixableTracks,
  list_tracks: listTracks,
};
