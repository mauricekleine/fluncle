// The `search` domain contract module. Owns TWO ops, and they look for different things
// in different places:
//
//   - `search_tracks` → SPOTIFY. Candidates for the submit flow — music Fluncle does not
//     have yet. It burns the operator's shared Spotify token, so it is rate-limited.
//   - `search_archive` → FLUNCLE. The archive itself, and the public surface that becomes
//     the primary navigation once the archive is deep. Four resolution tiers, an LLM only
//     on the fourth, and a sonic tier no other drum & bass tool has.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TrackSearchResultSchema } from "./_shared";

/**
 * `search_tracks` → `GET /search` (operationId `searchTracks`).
 *
 * Spotify candidate search for the submit flow. The query is the `q` param;
 * kept as a tolerant optional string and length-checked in-handler so a < 2-char
 * query degrades to the live route's hand-rolled 400 (`invalid_query`) rather
 * than an oRPC schema rejection. The success body is the `{ ok: true, results }`
 * envelope (mirrors `SearchResponse` in ../index.ts).
 */
export const searchTracks = oc
  .route({
    method: "GET",
    operationId: "searchTracks",
    path: "/search",
    summary: "Search Spotify for finding candidates",
    tags: ["Search"],
  })
  .input(z.object({ q: z.string().max(512).optional() }))
  .output(z.object({ ok: z.literal(true), results: z.array(TrackSearchResultSchema) }));

/**
 * The structured filter object — the ONLY thing the LLM is ever allowed to emit.
 *
 * This schema IS the safety property of the whole design. The model translates language
 * into filters; SQL does the retrieval. It never sees a track, never names a track, and
 * never returns one — so it CANNOT hallucinate a finding into existence. The worst a bad
 * parse can do is filter for something that isn't there and return an honest empty state.
 *
 * `soundsLike` is the sonic hook: a free-text reference to a real track, which the server
 * resolves against the archive and turns into that track's MuQ embedding. It is anchored on
 * a row that exists, so even the "vibe" query cannot be invented.
 */
export const SearchFiltersSchema = z
  .object({
    album: z.string().optional(),
    artist: z.string().optional(),
    bpmMax: z.number().optional(),
    bpmMin: z.number().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    soundsLike: z.string().optional(),
    text: z.string().optional(),
    yearMax: z.number().optional(),
    yearMin: z.number().optional(),
  })
  .meta({ id: "SearchFilters" });

/**
 * One row of the archive as search returns it — and the object that carries THE CATALOGUE
 * RULE across the wire.
 *
 * A certified finding has a `logId` and links to `/log/<logId>`. A track Fluncle has not
 * certified has NO coordinate and no `logId`, so it links OUT (`spotifyUrl`). `certified`
 * is the one bit a client needs to render the two registers, and it is deliberately a
 * boolean and not a tier NAME: the uncertified tier has no public name, is never labelled,
 * and is never introduced. "Finding" stays the only named object in Fluncle's world.
 */
export const SearchHitSchema = z
  .object({
    album: z.string().optional(),
    albumImageUrl: z.string().optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    /** True ⇔ a `findings` row exists ⇔ this is one of Fluncle's Findings. */
    certified: z.boolean(),
    galaxy: z.string().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    /** The permanent coordinate. Present only on a certified finding. */
    logId: z.string().optional(),
    releaseDate: z.string().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "SearchHit" });

/**
 * An entity a query named or prefixed — a jump target, not a result row.
 *
 * The three nodes of the graph that have a PAGE: an artist (`/artist/<slug>`), a label
 * (`/label/<slug>`), an album (`/album/<slug>`). They are one shape because they are one
 * affordance: the thing you searched for, offered as a destination, with its cover or its
 * portrait. `kind` decides the route and nothing else. (The log is the fourth node, and it
 * needs no entity row — a coordinate resolves straight to its finding.)
 */
export const SearchEntitySchema = z
  .object({
    imageUrl: z.string().optional(),
    kind: z.enum(["album", "artist", "label"]),
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "SearchEntity" });

/**
 * Which of the four tiers answered. Carried on the wire because it is not a debug detail —
 * it decides what the client renders (a `coordinate` is a jump, `sonic` names its anchor,
 * `filters` shows what it understood) and it is the honest label for HOW a result was found.
 */
export const SearchKindSchema = z
  .enum(["coordinate", "empty", "entity", "filters", "sonic", "token"])
  .meta({ id: "SearchKind" });

/**
 * `search_archive` → `GET /search/archive` (operationId `searchArchive`).
 *
 * The public read behind Fluncle's search. Resolution stops at the first tier that answers:
 * a coordinate, an exact entity, a bare token (FTS5), and only then a small LLM that
 * translates the sentence into `SearchFilters` which SQL executes.
 *
 * `degraded: true` says the fourth tier was ASKED FOR and could not run (no key, a slow
 * model, a vendor outage) and the query fell back to full-text. Search degrades; it never
 * breaks — and it says so rather than pretending the text hits were what you meant.
 */
export const searchArchive = oc
  .route({
    method: "GET",
    operationId: "searchArchive",
    path: "/search/archive",
    summary: "Search Fluncle's archive — coordinate, entity, full-text, or natural language",
    tags: ["Search"],
  })
  .input(
    z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), q: z.string().max(512) }),
  )
  .output(
    z.object({
      /** The track the sonic tier anchored on — a REAL row, never an invented vibe. */
      anchor: SearchHitSchema.optional(),
      /** True ⇔ the LLM tier was wanted and unavailable; these are full-text results. */
      degraded: z.boolean(),
      entities: z.array(SearchEntitySchema),
      /** What the LLM understood, echoed back so the reader can see it and correct it. */
      filters: SearchFiltersSchema.optional(),
      kind: SearchKindSchema,
      ok: z.literal(true),
      /** A resolved coordinate/entity: the app route this query IS. */
      redirect: z.string().optional(),
      results: z.array(SearchHitSchema),
    }),
  );

/** The filter object the LLM emits and SQL executes. */
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;
/** One archive row as search returns it — `certified` carries the catalogue rule. */
export type SearchHit = z.infer<typeof SearchHitSchema>;
/** A jump target (an artist), not a result row. */
export type SearchEntity = z.infer<typeof SearchEntitySchema>;
/** Which of the four resolution tiers answered. */
export type SearchKind = z.infer<typeof SearchKindSchema>;

/** The `search` domain's ops, merged into the root contract by `./index.ts`. */
export const searchContract = {
  search_archive: searchArchive,
  search_tracks: searchTracks,
};
