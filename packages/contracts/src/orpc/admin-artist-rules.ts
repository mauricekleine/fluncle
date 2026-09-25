import { oc } from "@orpc/contract";
import * as z from "zod";

export const ArtistRuleVerdictSchema = z
  .enum(["allow", "block", "unlisted"])
  .meta({ id: "ArtistRuleVerdict" });

export const LabelArtistRuleVerdictSchema = z
  .enum(["allow", "block"])
  .meta({ id: "LabelArtistRuleVerdict" });
export const ArtistRuleSourceSchema = z
  .enum(["operator", "triage"])
  .meta({ id: "ArtistRuleSource" });

const ArtistMbidSchema = z.string().uuid();
const ArtistNameSchema = z.string().trim().min(1, "Artist name cannot be blank");

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

export const ArtistRuleInputSchema = z
  .object({
    artistMbid: ArtistMbidSchema,
    artistName: ArtistNameSchema,
    verdict: LabelArtistRuleVerdictSchema,
  })
  .meta({ id: "ArtistRuleInput" });

export const AddArtistRuleInputSchema = ArtistRuleInputSchema.extend({
  artistName: ArtistNameSchema.optional(),
  verdict: ArtistRuleVerdictSchema,
}).meta({ id: "AddArtistRuleInput" });

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

export const updateArtistRule = oc
  .route({
    method: "PATCH",
    operationId: "updateArtistRule",
    path: "/admin/artist-rules/{id}",
    summary: "Stamp an artist rule's MusicBrainz drift audit (operator; no scope change)",
    tags: ["Admin"],
  })
  .input(
    z
      .object({
        checkedAt: z.string().optional(),
        id: z.string(),
        resolvedMbid: z.string().nullable().optional(),
        resolvedName: z.string().nullable().optional(),
      })
      .refine(
        (input) =>
          input.checkedAt !== undefined ||
          input.resolvedMbid !== undefined ||
          input.resolvedName !== undefined,
        { error: "Pass checkedAt, resolvedMbid, or resolvedName" },
      ),
  )
  .output(z.object({ ok: z.literal(true), rule: ArtistRuleSchema }));

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
  update_artist_rule: updateArtistRule,
};
