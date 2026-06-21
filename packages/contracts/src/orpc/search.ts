// The `search` domain contract module. Owns the public Spotify-candidate search
// op; a future wave adds an op here and one import line in `./index.ts`,
// touching no other domain's file.

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
  .input(z.object({ q: z.string().optional() }))
  .output(z.object({ ok: z.literal(true), results: z.array(TrackSearchResultSchema) }));

/** The `search` domain's ops, merged into the root contract by `./index.ts`. */
export const searchContract = {
  search_tracks: searchTracks,
};
