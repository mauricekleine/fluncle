// The `me-frontier` domain contract module — a signed-in user's ONE public Spotify
// playlist, "Fluncle's Frontier" (E2, the public recommendation machine;
// docs/planning/ROADMAP.md § the public recommendation machine). The playlist lives on
// FLUNCLE'S OWN Spotify account (no per-user OAuth) and mirrors the user's current
// recommendations (the E1 blend), refreshed weekly. The mint is a CSRF-guarded write
// gated on a VERIFIED email; the read is a plain cookie-session read. A future wave
// adds an op here and one import line in `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `mint_private_frontier_playlist` → `POST /me/frontier-playlist`
 * (operationId `mintPrivateFrontierPlaylist`).
 *
 * Mint (or, if it already exists, REFRESH) the signed-in user's Frontier playlist from
 * their current recommendations. CSRF-guarded, verified-email gated (403
 * `email_unverified`), and rate-limited (4/h — a real Spotify create/replace). The
 * empty request body keeps oRPC from pre-rejecting a bodyless POST.
 *
 * `status` reports what happened: `minted` (Spotify playlist created), `refreshed` (its
 * items changed), `unchanged` (nothing moved since the latest edition), `edition_only`
 * (the edition was written but the DEFAULT-DENY kill switch is closed, so no Spotify
 * playlist — the user's act still checkpoints an edition, `playlistUrl` absent), or
 * `building` (the edition was written but the shared per-app Spotify budget was spent, so
 * the playlist write was DEFERRED to the paced sweep — a distinct success state, never a
 * 429 in the user's face; `playlistUrl` absent on a first mint, present on a deferred
 * refresh). `playlistUrl` is present on every outcome that has a playlist.
 */
export const mintPrivateFrontierPlaylist = oc
  .route({
    method: "POST",
    operationId: "mintPrivateFrontierPlaylist",
    path: "/me/frontier-playlist",
    summary: "Mint or refresh the signed-in user's Frontier playlist",
    tags: ["Me"],
  })
  .input(z.looseObject({}))
  .output(
    z.object({
      ok: z.literal(true),
      playlistUrl: z.string().optional(),
      status: z.enum(["minted", "refreshed", "unchanged", "edition_only", "building"]),
    }),
  );

/**
 * `get_private_frontier_playlist` → `GET /me/frontier-playlist`
 * (operationId `getPrivateFrontierPlaylist`).
 *
 * The signed-in user's Frontier state: the playlist URL + when it last synced (both
 * absent until the first mint), plus `mintingOpen` — the kill-switch state — so the
 * page can message honestly (offer the mint, or say minting is closed) instead of
 * rendering a button that 503s. A missing session is the rails-encoded 401.
 */
export const getPrivateFrontierPlaylist = oc
  .route({
    method: "GET",
    operationId: "getPrivateFrontierPlaylist",
    path: "/me/frontier-playlist",
    summary: "Read the signed-in user's Frontier playlist state",
    tags: ["Me"],
  })
  .output(
    z.object({
      lastSyncedAt: z.string().optional(),
      mintingOpen: z.boolean(),
      ok: z.literal(true),
      playlistUrl: z.string().optional(),
    }),
  );

/**
 * One frozen edition's summary — a "past editions" dropdown row. `number` is the
 * per-user monotonic edition number (the ONE name — column, DTO, path param);
 * `refreshedAt` is the UTC instant the refresh froze (the date label derives from
 * it); `trackCount` is how many tracks the frozen playlist carried. `seedsUsed` /
 * `seedsSkipped` are the frozen seed accounting the shelf's honesty strings read
 * ("these two picks aren't steering yet"); both absent on a pre-migration edition
 * that cannot back them (the Readout Rule's honest absence).
 */
export const FrontierEditionSummarySchema = z.object({
  number: z.number(),
  refreshedAt: z.string(),
  seedsSkipped: z.array(z.string()).optional(),
  seedsUsed: z.number().optional(),
  trackCount: z.number(),
});

/**
 * One frozen track in an edition — everything the dialog renders without a JOIN.
 * `slot` + `logId` drive the finding/catalogue register split; a catalogue row
 * carries no `logId`. The instrument chips (`bpm`/`key`/`durationMs`) are frozen
 * readouts, present when they were known at freeze time. `similarity` is the frozen
 * max-similarity the engine gave the row; absent on a pre-migration edition.
 */
export const FrontierEditionTrackSchema = z.object({
  artists: z.array(z.string()),
  bpm: z.number().optional(),
  durationMs: z.number().optional(),
  imageUrl: z.string().optional(),
  key: z.string().optional(),
  logId: z.string().optional(),
  similarity: z.number().optional(),
  slot: z.enum(["catalogue", "finding"]),
  spotifyUrl: z.string().optional(),
  title: z.string(),
  trackId: z.string(),
});

/**
 * `list_private_frontier_editions` → `GET /me/frontier-editions`
 * (operationId `listPrivateFrontierEditions`).
 *
 * The signed-in user's frozen Frontier editions, newest first — the "past editions"
 * dropdown's list and the history read. Scoped to the session user. Zero editions is
 * a clean empty array, never a 404. A missing session is the rails-encoded 401.
 */
export const listPrivateFrontierEditions = oc
  .route({
    method: "GET",
    operationId: "listPrivateFrontierEditions",
    path: "/me/frontier-editions",
    summary: "List the signed-in user's frozen Frontier editions",
    tags: ["Me"],
  })
  .output(
    z.object({
      editions: z.array(FrontierEditionSummarySchema),
      ok: z.literal(true),
    }),
  );

/**
 * `get_private_frontier_edition` → `GET /me/frontier-editions/{number}`
 * (operationId `getPrivateFrontierEdition`).
 *
 * One of the signed-in user's frozen editions + its tracklist, by the per-user
 * edition number. `number` is a raw path string (the rails keep params raw); the
 * handler parses it and scopes the read by the session user, so the number alone
 * never reaches another user's edition. 404 if the user has no edition with that
 * number.
 */
export const getPrivateFrontierEdition = oc
  .route({
    method: "GET",
    operationId: "getPrivateFrontierEdition",
    path: "/me/frontier-editions/{number}",
    summary: "Get one of the signed-in user's frozen Frontier editions",
    tags: ["Me"],
  })
  .input(z.object({ number: z.string() }))
  .output(
    z.object({
      edition: FrontierEditionSummarySchema,
      ok: z.literal(true),
      tracks: z.array(FrontierEditionTrackSchema),
    }),
  );

/** The `me-frontier` domain's ops, merged into the root contract by `./index.ts`. */
export const meFrontierContract = {
  get_private_frontier_edition: getPrivateFrontierEdition,
  get_private_frontier_playlist: getPrivateFrontierPlaylist,
  list_private_frontier_editions: listPrivateFrontierEditions,
  mint_private_frontier_playlist: mintPrivateFrontierPlaylist,
};
