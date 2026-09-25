import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  ArtistRuleInputSchema,
  ArtistRuleSchema,
  ArtistRuleSourceSchema,
} from "./admin-artist-rules.js";

export const LabelSeedStateSchema = z
  .enum(["disabled", "enabled", "undecided"])
  .meta({ id: "LabelSeedState" });

export const LabelAdminItemSchema = z
  .object({
    createdAt: z.string(),

    disambiguation: z.string().nullable().optional(),
    findingCount: z.number(),

    foundedLocation: z.string().nullable().optional(),

    foundingDate: z.string().nullable().optional(),
    id: z.string(),
    logoImageUrl: z.string().optional(),

    mbLabelId: z.string().nullable().optional(),
    name: z.string(),
    ruledAt: z.string().nullable(),

    scopeChangedAt: z.string().nullable().optional(),
    seedState: LabelSeedStateSchema,
    slug: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "LabelAdminItem" });

export const listLabelsAdmin = oc
  .route({
    method: "GET",
    operationId: "listLabelsAdmin",
    path: "/admin/labels",
    summary: "Every label with its crawl-seed state (the countless seed-set read)",
    tags: ["Admin"],
  })
  .input(z.object({ seedState: LabelSeedStateSchema.optional() }))
  .output(z.object({ labels: z.array(LabelAdminItemSchema), ok: z.literal(true) }));

export const updateLabel = oc
  .route({
    method: "PATCH",
    operationId: "updateLabel",
    path: "/admin/labels/{id}",
    summary: "Update a label's crawl scope or arm a re-walk (operator; never storage)",
    tags: ["Admin"],
  })
  .input(
    z
      .object({
        id: z.string(),
        rewalk: z.boolean().optional(),
        seedState: LabelSeedStateSchema.optional(),
      })
      .refine((input) => input.seedState !== undefined || input.rewalk === true, {
        error: "Pass seedState or set rewalk to true",
      }),
  )
  .output(z.object({ label: LabelAdminItemSchema, ok: z.literal(true) }));

export const listLabelArtistRules = oc
  .route({
    method: "GET",
    operationId: "listLabelArtistRules",
    path: "/admin/labels/{id}/artists",
    summary: "List one label's artist rules for future catalogue acquisition",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true), rules: z.array(ArtistRuleSchema) }));

export const replaceLabelArtistRules = oc
  .route({
    method: "PUT",
    operationId: "replaceLabelArtistRules",
    path: "/admin/labels/{id}/artists",
    summary: "Replace one label's complete artist-rule set (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      id: z.string(),
      rules: z
        .array(ArtistRuleInputSchema)
        .max(100)
        .superRefine((rules, context) => {
          const seen = new Set<string>();

          for (const [index, rule] of rules.entries()) {
            if (seen.has(rule.artistMbid)) {
              context.addIssue({
                code: "custom",
                message: "Each artist MBID may appear only once",
                path: [index, "artistMbid"],
              });
            }

            seen.add(rule.artistMbid);
          }
        }),
      source: ArtistRuleSourceSchema.default("operator"),
    }),
  )
  .output(z.object({ ok: z.literal(true), rules: z.array(ArtistRuleSchema) }));

export const MergeLabelResultSchema = z
  .object({
    aliasWritten: z.object({ alias: z.string(), aliasSlug: z.string() }),
    canonicalName: z.string(),
    canonicalSlug: z.string(),

    droppedRules: z.number(),
    losingName: z.string(),
    losingSlug: z.string(),

    reconciled: z.array(z.string()),

    repointed: z.object({
      aliases: z.number(),
      childLabels: z.number(),
      tracks: z.number(),
    }),

    seedState: LabelSeedStateSchema,
  })
  .meta({ id: "MergeLabelResult" });

export const mergeLabel = oc
  .route({
    method: "POST",
    operationId: "mergeLabel",
    path: "/admin/labels/{slug}/merge",
    summary: "Merge a slug-split label into its canonical row (operator; re-points + redirects)",
    tags: ["Admin"],
  })
  .input(z.object({ canonicalSlug: z.string(), slug: z.string() }))
  .output(z.object({ ok: z.literal(true), result: MergeLabelResultSchema }));

export const MB_LABEL_MBID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MintLabelOutcomeSchema = z
  .enum(["minted", "adopted", "known", "taken_over"])
  .meta({ id: "MintLabelOutcome" });

export const LabelTakeOverResultSchema = z
  .object({
    clearedFacts: z.array(z.string()),

    droppedRules: z.number(),

    previousMbLabelId: z.string().nullable(),

    rearmedSeedNode: z.boolean(),

    retiredFrontierNodes: z.number(),

    slug: z.string(),
  })
  .meta({ id: "LabelTakeOverResult" });

export const mintLabel = oc
  .route({
    method: "POST",
    operationId: "mintLabel",
    path: "/admin/labels",
    summary: "Mint a label from its MusicBrainz identity (operator; connect-or-create, idempotent)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      mbLabelId: z.string().regex(MB_LABEL_MBID_PATTERN, {
        error: "mbLabelId must be a MusicBrainz label MBID",
      }),
      seedState: LabelSeedStateSchema.optional(),
      takeOverSlug: z.string().min(1).optional(),
    }),
  )
  .output(
    z.object({
      label: LabelAdminItemSchema,
      ok: z.literal(true),
      outcome: MintLabelOutcomeSchema,
      takenOver: LabelTakeOverResultSchema.optional(),
    }),
  );

export const LabelAliasSourceSchema = z
  .enum(["operator", "apple", "musicbrainz", "discogs", "spotify"])
  .meta({ id: "LabelAliasSource" });

export const LabelAliasKindSchema = z.enum(["name", "hint"]).meta({ id: "LabelAliasKind" });

export const LabelAliasCandidateSchema = z
  .object({
    alias: z.string(),
    aliasSlug: z.string(),
    createdAt: z.string(),
    id: z.string(),
    kind: LabelAliasKindSchema,
    labelId: z.string(),
    labelName: z.string(),
    labelSlug: z.string(),
    source: LabelAliasSourceSchema,
  })
  .meta({ id: "LabelAliasCandidate" });

export const listLabelAliases = oc
  .route({
    method: "GET",
    operationId: "listLabelAliases",
    path: "/admin/labels/aliases",
    summary: "Every open label-alias candidate awaiting the operator's ruling",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ aliases: z.array(LabelAliasCandidateSchema), ok: z.literal(true) }));

export const confirmLabelAlias = oc
  .route({
    method: "POST",
    operationId: "confirmLabelAlias",
    path: "/admin/labels/aliases/{id}/confirm",
    summary: "Confirm a label-alias candidate (candidate → confirmed; folds into the label)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const rejectLabelAlias = oc
  .route({
    method: "DELETE",
    operationId: "rejectLabelAlias",
    path: "/admin/labels/aliases/{id}",
    summary: "Reject a label-alias candidate (discard the proposed spelling)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

const DescribeLabelBodySchema = z.looseObject({
  bio: z.unknown().optional(),
  dryRun: z.unknown().optional(),
  finalAttempt: z.boolean().optional(),
  promptVersion: z.number().int().min(0).optional(),
});

export const describeLabel = oc
  .route({
    method: "POST",
    operationId: "describeLabel",
    path: "/admin/labels/{slug}/bio",
    summary: "Auto-author a label's voiced bio (fills an empty bio only)",
    tags: ["Admin"],
  })
  .input(DescribeLabelBodySchema.extend({ slug: z.string() }))
  .output(
    z.object({
      bio: z.string(),

      dryRun: z.literal(true).optional(),

      gateBypassed: z.literal(true).optional(),
      ok: z.literal(true),

      skipped: z.boolean().optional(),
      slug: z.string(),

      voiceViolations: z.array(z.string()).optional(),
    }),
  );

export const draftLabelBio = oc
  .route({
    method: "GET",
    operationId: "draftLabelBio",
    path: "/admin/labels/{slug}/bio-draft",
    summary: "Assemble a ready-to-author bio prompt for a label (Worker-side grounding)",
    tags: ["Admin"],
  })
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      findingCount: z.number(),
      found: z.boolean(),
      hasFacts: z.boolean(),
      name: z.string(),
      prompt: z.string(),
      promptVersion: z.number(),
    }),
  );

const LabelBioWorkItemSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ id: "LabelBioWorkItem" });

export const listLabelsMissingBio = oc
  .route({
    method: "GET",
    operationId: "listLabelsMissingBio",
    path: "/admin/labels/bio-queue",
    summary: "List labels with findings but no bio yet, oldest first (the bio worklist)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(z.object({ labels: z.array(LabelBioWorkItemSchema), ok: z.literal(true) }));

export const adminLabelsContract = {
  confirm_label_alias: confirmLabelAlias,
  describe_label: describeLabel,
  draft_label_bio: draftLabelBio,
  list_label_aliases: listLabelAliases,
  list_label_artist_rules: listLabelArtistRules,
  list_labels_admin: listLabelsAdmin,
  list_labels_missing_bio: listLabelsMissingBio,
  merge_label: mergeLabel,
  mint_label: mintLabel,
  reject_label_alias: rejectLabelAlias,
  replace_label_artist_rules: replaceLabelArtistRules,
  update_label: updateLabel,
};
