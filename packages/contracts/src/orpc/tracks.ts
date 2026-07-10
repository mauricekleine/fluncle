// The `tracks` domain contract module. Owns every track-read op; a future wave
// adds an op here and one import line in `./index.ts`, touching no other
// domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  FeedItemSchema,
  MixableCandidateSchema,
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
 * The findings that mix cleanly OUT of the given one, ranked by the mixability engine
 * (`lib/server/mixability.ts`) — a harmonic next-track finder with a dense texture
 * tiebreak (the sonic MuQ term is wired but gated off until embedding coverage clears
 * the floor). The crew-facing rail behind `/mix`. Modeled on `get_similar_findings`:
 * one archive scan over coordinate-bearing findings, self excluded, mixability order,
 * NO numeric score in the payload (§3.0 invariant — only the `reason` chip).
 *
 * `limit` is a tolerant optional string (default 12, clamped to 32), parsed in-handler
 * so a bad value degrades rather than 400-ing (mirrors `get_similar_findings`).
 * `exclude` is a comma-separated Log ID list — the already-chained findings, excluded
 * SERVER-SIDE so a deep chain in a small archive can't silently empty the rail.
 *
 * Public-unauth AT THE OP (keys/BPMs are already public on every track chip), so the
 * `/mix` PAGE's admin gate is a pure route-level flip to lift at launch (Decision 1).
 * An unknown coordinate / a finding scored on nothing / an empty archive all yield
 * `{ ok: true, findings: [] }` — a quiet empty rail, never a fault.
 */
export const listMixableTracks = oc
  .route({
    method: "GET",
    operationId: "listMixableTracks",
    path: "/tracks/{idOrLogId}/mixable",
    summary: "List the findings that mix cleanly out of one (by Spotify trackId or Log ID)",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      exclude: z.string().optional(),
      idOrLogId: z.string(),
      limit: z.string().optional(),
    }),
  )
  .output(z.object({ findings: z.array(MixableCandidateSchema), ok: z.literal(true) }));

/** The `tracks` domain's ops, merged into the root contract by `./index.ts`. */
export const tracksContract = {
  get_random_track: getRandomTrack,
  get_similar_findings: getSimilarFindings,
  get_track: getTrack,
  list_mixable_tracks: listMixableTracks,
  list_tracks: listTracks,
};
