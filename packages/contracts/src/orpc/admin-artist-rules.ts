// The global artist-rule admin surface. These rules are acquisition scope: they change
// what a future crawl takes and never mutate tracks already in the archive.
//
//   - `list_artist_rules` — admin tier (agent-allowed read).
//   - `add_artist_rule` — operator tier: add one global allow/block exception.
//   - `remove_artist_rule` — operator tier: remove one global exception.

// Per-label rules live beside their label in `./admin-labels.ts`; both surfaces share the
// exact rule and input schemas below so their wire vocabulary cannot drift.

import { oc } from "@orpc/contract";
import * as z from "zod";

export const ArtistRuleVerdictSchema = z.enum(["allow", "block"]).meta({ id: "ArtistRuleVerdict" });

const ArtistMbidSchema = z.string().uuid();
const ArtistNameSchema = z.string().trim().min(1, "Artist name cannot be blank");

/** One artist rule as exposed to admin clients. Internal scope/re-arm fields stay private. */
export const ArtistRuleSchema = z
  .object({
    artistMbid: ArtistMbidSchema,
    artistName: z.string(),
    artistSpotifyId: z.string().nullable(),
    checkedAt: z.string().nullable(),
    createdAt: z.string(),
    id: z.string(),
    resolvedMbid: z.string().nullable(),
    resolvedName: z.string().nullable(),
    updatedAt: z.string(),
    verdict: ArtistRuleVerdictSchema,
  })
  .meta({ id: "ArtistRule" });

/** A per-label whole-set member. Bare MBIDs and blank names are rejected at the boundary. */
export const ArtistRuleInputSchema = z
  .object({
    artistMbid: ArtistMbidSchema,
    artistName: ArtistNameSchema,
    verdict: ArtistRuleVerdictSchema,
  })
  .meta({ id: "ArtistRuleInput" });

/**
 * A global add accepts an omitted name so the server may fill it from the local artist row or
 * MusicBrainz payload. When supplied, it is still required to contain non-whitespace text.
 */
export const AddArtistRuleInputSchema = ArtistRuleInputSchema.extend({
  artistName: ArtistNameSchema.optional(),
}).meta({ id: "AddArtistRuleInput" });

/** `list_artist_rules` → `GET /admin/artist-rules` (operationId `listArtistRules`). */
export const listArtistRules = oc
  .route({
    method: "GET",
    operationId: "listArtistRules",
    path: "/admin/artist-rules",
    summary: "List the global artist rules that steer future catalogue acquisition",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ ok: z.literal(true), rules: z.array(ArtistRuleSchema) }));

/** `add_artist_rule` → `POST /admin/artist-rules` (operationId `addArtistRule`). */
export const addArtistRule = oc
  .route({
    method: "POST",
    operationId: "addArtistRule",
    path: "/admin/artist-rules",
    summary: "Add a global artist rule for future catalogue acquisition (operator)",
    tags: ["Admin"],
  })
  .input(AddArtistRuleInputSchema)
  .output(z.object({ ok: z.literal(true), rule: ArtistRuleSchema }));

/** `remove_artist_rule` → `DELETE /admin/artist-rules/{id}` (operationId `removeArtistRule`). */
export const removeArtistRule = oc
  .route({
    method: "DELETE",
    operationId: "removeArtistRule",
    path: "/admin/artist-rules/{id}",
    summary: "Remove a global artist rule (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const adminArtistRulesContract = {
  add_artist_rule: addArtistRule,
  list_artist_rules: listArtistRules,
  remove_artist_rule: removeArtistRule,
};
