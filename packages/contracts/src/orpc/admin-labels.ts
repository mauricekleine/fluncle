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

/**
 * What a triage ROUND concluded — deliberately not a `LabelSeedState`, because a round never rules.
 *
 * `dnb` / `not_dnb` are what the round would have the operator rule; `dnb_partial` is the settled
 * verdict that the label stays out of the seed set while named artists are allowed in; `unclear` is
 * the round declining, which is a finding rather than a gap (a conflated MusicBrainz entity, a
 * catalogue too thin to read, a genuinely mixed one only he can call).
 */
export const LabelTriageVerdictSchema = z
  .enum(["dnb", "dnb_partial", "not_dnb", "unclear"])
  .meta({ id: "LabelTriageVerdict" });

/**
 * One label in the admin shape. `slug` is the identity + the join key back to the raw
 * `tracks.label` string (`slugify(tracks.label) = labels.slug`); `findingCount` is DERIVED,
 * never stored — computed per-page over the indexed `tracks.label_id` edge by the
 * `/admin/labels` station's read, and 0 on the countless `list_labels_admin` seed read.
 * `ruledAt` is the operator's stamp — null means no human has ruled this label yet (a machine
 * default or the one-time bootstrap). `logoImageUrl` is the label's OWN logo (its resolved
 * Discogs/Wikidata image on R2, served up the shared owned-cover ladder), absent when it has none yet.
 *
 * ── THE IDENTITY FIELDS ────────────────────────────────────────────────────────────────────
 * A ruling is an identity question — "may we crawl from THIS label?" is unanswerable when three
 * labels share the name. So the item also carries what MusicBrainz knows about which label this is:
 * `mbLabelId` (the MBID, which the station links out to), `disambiguation` (MB's parenthetical
 * comment, the one field written FOR this problem), and the founding pair `foundingDate` /
 * `foundedLocation`. All four are ADDITIVE-OPTIONAL: nullable when a read carries them and absent
 * from a read that does not, so an older client and the CLI keep working unchanged. Most labels
 * legitimately carry none — MusicBrainz only disambiguates a name that needed it — and a label
 * with none simply shows no identity line.
 */
>>>>>>> 30577a82a (feat(labels): record what a triage round found, without letting it rule)
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
    /**
     * THE TRIAGE CURSOR — what a ROUND looked at, beside `ruledAt`, which is what HE ruled.
     *
     * A label reading `unclear` with a reason is not an unread row; it is a researched one the round
     * could not settle, and the station can say which. All three are ADDITIVE-OPTIONAL, so an older
     * client and the CLI keep working unchanged, and a label no round has seen simply carries none.
     */
    triageCheckedAt: z.string().nullable().optional(),
    /** Why it could not be ruled ("conflation", "thin", "mixed"). The round owns this taxonomy. */
    triageReason: z.string().nullable().optional(),
    triageVerdict: LabelTriageVerdictSchema.nullable().optional(),
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

// ── THE TRIAGE CURSOR ──────────────────────────────────────────────────────────────
// `record_label_triage` is what a triage round writes when it has LOOKED at a label, which is a
// different act from the operator RULING one. It stamps `labels.triage_checked_at` (+ the verdict
// and the reason it could not be ruled) and stores the round's payload as a proposal.
//
// AGENT tier, deliberately, and the distinction is the whole safety argument for the sweep: this
// op CANNOT change `seed_state`, cannot write an `artist_rules` row, and cannot make anything
// crawl. It records a finding. The ruling stays `update_label` / `replace_label_artist_rules`,
// both operator tier, so a sweep running with the box's agent token is structurally incapable of
// ruling on a label however wrong it goes. The precedent is `describe_label`: enrichment the box
// authors is agent tier, the editorial act it feeds is not.
//
// It is also IDEMPOTENT per label — one proposal row per label, the newest round superseding the
// last — so a re-run or a resumed sweep re-states rather than accumulating.

/** One proposed artist rule. Advisory: nothing here fires at crawl time until the operator applies it. */
const TriageRuleProposalSchema = z.object({
  artistMbid: z.string(),
  artistName: z.string(),
  evidence: z.string().optional(),
  /** Zero means the rule could never fire; the server drops it rather than storing an inert proposal. */
  firstCreditCount: z.number().int().min(0),
  verdict: z.enum(["allow", "block"]),
});

/**
 * What a round reports about ONE label. Named and exported so the CLI and the box sweep carry the
 * round's payload without re-spelling its shape; the op adds the path `slug` on top.
 */
export const RecordLabelTriageBodySchema = z
  .object({
    censusSummary: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.string(),
    /** The RAW rail: every off-lane first credit, whether or not a global rule already stops it. */
    offLaneShare: z.number().min(0).max(1).optional(),
    /** Free text: the taxonomy of why a label could not be ruled belongs to the round. */
    reason: z.string().optional(),
    /** The same fraction ignoring credits an existing global rule stops. Reported, never a rail. */
    residualOffLaneShare: z.number().min(0).max(1).optional(),
    roundId: z.string(),
    rules: z.array(TriageRuleProposalSchema).optional(),
    verdict: LabelTriageVerdictSchema,
    verifyAgrees: z.boolean().optional(),
    verifyEvidence: z.string().optional(),
  })
  .meta({ id: "RecordLabelTriageBody" });

/**
 * `record_label_triage` → `POST /admin/labels/{slug}/triage` (operationId `recordLabelTriage`).
 *
 * Agent tier (`adminAuth`), the `describe_label` precedent. Stamps the triage cursor and stores the
 * round's proposal for the operator to ratify from. NEVER changes `seed_state` and never writes an
 * artist rule — a label's ruling is `update_label`, which 403s an agent token at `operatorGuard`.
 *
 * `offLaneShare` is the RAW rail (every off-lane first credit); `residualOffLaneShare` is the same
 * fraction ignoring credits an existing global rule already stops. When they straddle 0.15 the
 * station shows the label to the operator by name instead of burying it in the unclear pile.
 *
 * Codes: `not_found`/404.
 */
export const recordLabelTriage = oc
  .route({
    method: "POST",
    operationId: "recordLabelTriage",
    path: "/admin/labels/{slug}/triage",
    summary: "Record what a triage round found (stamps the cursor; never rules)",
    tags: ["Admin"],
  })
  .input(RecordLabelTriageBodySchema.extend({ slug: z.string() }))
  .output(
    z.object({
      /** Rules dropped for having zero first credits — they could never fire. */
      droppedInertRules: z.number().int(),
      ok: z.literal(true),
      /** `true` when this superseded an earlier round's proposal for the same label. */
      superseded: z.boolean(),
      triageCheckedAt: z.string(),
    }),
  );

/** The `admin-labels` domain's ops, merged into the root contract by `./index.ts`. */
>>>>>>> 30577a82a (feat(labels): record what a triage round found, without letting it rule)
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
  record_label_triage: recordLabelTriage,
  reject_label_alias: rejectLabelAlias,
  replace_label_artist_rules: replaceLabelArtistRules,
  update_label: updateLabel,
};
