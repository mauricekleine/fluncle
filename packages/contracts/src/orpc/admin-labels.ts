// The `admin-labels` domain contract module — the record-label entity's admin
// surface, and the operator's CRAWL-SEED control. Two ops, on the `admin-galaxies`
// pattern (an agent-allowed full read + an operator-tier editorial write):
//
//   - `list_labels_admin` — admin tier (agent-allowed read): every label with its
//     seed state and finding count, optionally scoped to one state. `?seedState=enabled`
//     IS the crawler's seed-set read: this is where the catalogue crawler asks what
//     it may seed from, with its agent token. Named `_admin` (the
//     `list_galaxies_admin` precedent) so the public `list_labels` / `get_label` names
//     stay free for the public `/label/<slug>` surface.
//   - `update_label` — OPERATOR tier: the ruling. Ruling on a label is an editorial act
//     that steers what Fluncle crawls next, so an agent token 403s at `operatorGuard`
//     (the `update_galaxy` precedent).
//
// ── `seedState` IS CRAWL SCOPE, NEVER STORAGE ──────────────────────────────────────
// A label's seed state answers exactly one question: MAY THE CATALOGUE CRAWLER
// SEED FROM THIS LABEL? Setting it to `disabled` removes the label from the NEXT crawl's
// seed set and touches NOTHING already stored — no deletion, no hiding, no retroactive
// effect on tracks, on findings, or on anything a previous crawl already brought in.
// "What we crawl FROM" and "what we KEEP" are separate concepts, and no consumer of this
// contract may blur them. See docs/label-entity.md.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A label's crawl-seed state — the operator's ruling, and CRAWL SCOPE ONLY.
 *
 *   - `enabled`   — the next crawl may seed from this label.
 *   - `disabled`  — the next crawl may not. Nothing already stored changes.
 *   - `undecided` — nobody has ruled. Where a brand-new label enters: never silently
 *                   crawled, never silently dropped. It surfaces in the attention queue.
 */
export const LabelSeedStateSchema = z
  .enum(["disabled", "enabled", "undecided"])
  .meta({ id: "LabelSeedState" });

/**
 * One label in the admin shape. `slug` is the identity + the join key back to the raw
 * `tracks.label` string (`slugify(tracks.label) = labels.slug`); `findingCount` is
 * DERIVED, never stored. `ruledAt` is the operator's stamp — null means no human has
 * ruled this label yet (a machine default or the one-time bootstrap). `logoImageUrl` is the
 * label's OWN logo (its resolved Discogs/Wikidata image on R2), absent when it has none yet.
 */
export const LabelAdminItemSchema = z
  .object({
    createdAt: z.string(),
    findingCount: z.number(),
    id: z.string(),
    logoImageUrl: z.string().optional(),
    name: z.string(),
    ruledAt: z.string().nullable(),
    seedState: LabelSeedStateSchema,
    slug: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "LabelAdminItem" });

/**
 * `list_labels_admin` → `GET /admin/labels` (operationId `listLabelsAdmin`).
 *
 * Admin tier (agent-allowed read, the `list_galaxies_admin` precedent). Every label
 * Fluncle's archive knows, with its crawl-seed state and its finding count. The optional
 * `seedState` filter is the clean exposure of the seed set: the catalogue crawler
 * reads `?seedState=enabled` with its agent token and gets exactly the labels it may seed
 * from. `{ ok, labels }`.
 */
export const listLabelsAdmin = oc
  .route({
    method: "GET",
    operationId: "listLabelsAdmin",
    path: "/admin/labels",
    summary: "Every label with its crawl-seed state and finding count (the seed-set read)",
    tags: ["Admin"],
  })
  .input(z.object({ seedState: LabelSeedStateSchema.optional() }))
  .output(z.object({ labels: z.array(LabelAdminItemSchema), ok: z.literal(true) }));

/**
 * `update_label` → `PATCH /admin/labels/{id}` (operationId `updateLabel`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). The ruling: set a label's crawl-seed
 * state. It steers what Fluncle crawls NEXT — an editorial act, like naming a galaxy —
 * so an agent token 403s here. Stamps `ruledAt`, which permanently exempts the row from
 * the one-time bootstrap seed.
 *
 * It changes the next crawl's seed set. It touches NOTHING already stored. `{ ok, label }`.
 */
export const updateLabel = oc
  .route({
    method: "PATCH",
    operationId: "updateLabel",
    path: "/admin/labels/{id}",
    summary: "Rule on a label's crawl-seed state (operator; next crawl only, never storage)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string(), seedState: LabelSeedStateSchema }))
  .output(z.object({ label: LabelAdminItemSchema, ok: z.literal(true) }));

// ── Label aliases: two spellings, one label (RFC musickit-second-authority, U2a) ──────────
// A second metadata authority (Apple's album `recordLabel`, corroborated by MusicBrainz over a
// shared ISRC) proposes that "Med School Recordings" is the same label as "Medschool". These
// three ops are the operator's low-priority review of those proposals — DELIBERATELY a page
// section on `/admin/labels`, never a new attention-queue source (alias candidates are
// crawl-volume, and the `label-review` queue is capped at 25 precisely because an uncapped
// crawl-volume source drowns the other five). CONFIRM promotes a candidate onto resolution +
// the public `alternateName` JSON-LD; REJECT discards it. See docs/label-entity.md.

/** Where an alias spelling came from. `apple` is the U2a writer; `operator` is hand-added. */
export const LabelAliasSourceSchema = z
  .enum(["operator", "apple", "musicbrainz", "discogs", "spotify"])
  .meta({ id: "LabelAliasSource" });

/**
 * `name` — a corroborated alternate spelling (Apple AND MusicBrainz agree on the same label
 * over the ISRC). `hint` — a weaker lead (Apple names a label the archive does not recognise as
 * this one). Only the operator's confirm promotes either to the public graph.
 */
export const LabelAliasKindSchema = z.enum(["name", "hint"]).meta({ id: "LabelAliasKind" });

/**
 * One open alias candidate in the review shape: the alternative spelling, its provenance, and
 * the canonical label it is proposed FOR (name + slug, so the section can name and deep-link the
 * label). `status` is always `candidate` here — this read is the open queue.
 */
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

/**
 * `list_label_aliases` → `GET /admin/labels/aliases` (operationId `listLabelAliases`).
 *
 * Admin tier (agent-allowed read, the `list_labels_admin` precedent). Every OPEN alias
 * candidate (`status = 'candidate'`), newest-first, each joined to its canonical label.
 * The `/admin/labels` review section reads this. `{ ok, aliases }`.
 */
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

/**
 * `confirm_label_alias` → `POST /admin/labels/aliases/{id}/confirm` (operationId
 * `confirmLabelAlias`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`, the `confirm_artist_social` precedent). Rule a
 * candidate spelling the SAME label: `status → confirmed`. Only then does it fold in resolution
 * (`ensureLabel`/`reconcileLabels` stop re-minting its slug) and join the public
 * `alternateName` JSON-LD. An agent token 403s — deciding two spellings are one label is an
 * editorial act. Idempotent. `{ ok }`.
 */
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

/**
 * `reject_label_alias` → `DELETE /admin/labels/aliases/{id}` (operationId `rejectLabelAlias`).
 *
 * OPERATOR tier (the `remove_artist_social` precedent). Rule a candidate NOT the same label:
 * delete the row. It never touched `tracks.label` or `labels.name`, so there is nothing to
 * unwind. Idempotent. `{ ok }`.
 */
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

// ── The voiced bio: the entity-bio engine (agent-tier author + its worklist) ──────────
// `describe_label` is the entity sibling of `note_track`: the on-box sweep authors the
// label's short Fluncle-voiced bio (grounded in Firecrawl facts + the tracks Fluncle has
// logged on it), and this step VOICE-GATES it and writes it FILL-EMPTY-ONLY — an operator
// bio is never clobbered. `list_labels_missing_bio` is its worklist. Both agent tier: the
// box's agent token drives them, the `note_track` / `list_labels_admin` precedent. This is
// deliberately AGENT tier, unlike `update_label` (the crawl-seed ruling): authoring a bio
// is enrichment, not an editorial ruling that steers the crawl.

/**
 * The describe body (POST /admin/labels/{slug}/bio). LOOSE: the live route voice-gates
 * `bio` itself and length-bounds it. `promptVersion` is the bio's provenance (0 = the
 * registry's baked default, N = operator override N); `dryRun` runs the voice gate and
 * stores nothing.
 */
const DescribeLabelBodySchema = z.looseObject({
  bio: z.unknown().optional(),
  dryRun: z.unknown().optional(),
  promptVersion: z.number().int().min(0).optional(),
});

/**
 * `describe_label` → `POST /admin/labels/{slug}/bio` (operationId `describeLabel`).
 *
 * Agent tier (`adminAuth`), the `note_track` precedent: the on-box sweep has authored the
 * label's bio in Fluncle's voice (grounded in the gathered facts + the tracks Fluncle has
 * logged on it); this VOICE-GATES it (the note gate's shared scan + the bio's length
 * ceiling) and stores it into `bio` with its `bio_prompt_version` provenance + `bio_status =
 * 'resolved'`, atomically.
 *
 * SAFETY (the cardinal guarantee): it fills an EMPTY bio ONLY. A label that already carries
 * a bio — operator-written OR previously auto-authored — is a no-op (`skipped: true`); the
 * agent NEVER clobbers an existing bio. `dryRun` runs the gate and stores nothing. Codes:
 * `not_found`/404, `no_bio`/400, `bio_too_short`/422, `bio_too_long`/422, `voice_gate`/422.
 */
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
      // `true` when `dryRun` was set: the voice gate ran, NOTHING was stored.
      dryRun: z.literal(true).optional(),
      ok: z.literal(true),
      // `true` when a bio already existed and the fill-empty-only guard refused to
      // clobber it; absent on a fresh fill.
      skipped: z.boolean().optional(),
      slug: z.string(),
    }),
  );

/**
 * `draft_label_bio` → `GET /admin/labels/{slug}/bio-draft` (operationId `draftLabelBio`).
 *
 * Agent tier (`adminAuth`), the `describe_label` sibling: the Worker-paced grounding seam.
 * The box holds no Firecrawl key and cannot enumerate the tracks it has logged on a label;
 * this READ runs the Firecrawl gather (with the Worker's key) + pulls the logged finding
 * titles (with the Worker's DB) and assembles the registered bio prompt, handing the box a
 * ready-to-author PROMPT. The box then runs `claude -p` on it and writes back via
 * `describe_label`. A pure read — it publishes nothing, and it returns only public facts
 * (web snippets + finding titles), never a secret or an internal id beyond the slug/name/count.
 *
 * `found:false` when the slug does not resolve (it never throws on a missing entity).
 * `hasFacts` reports whether Firecrawl returned any facts (false = the prompt's no-facts arm).
 */
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

/** One row of the bio worklist: a label with findings but no bio yet. */
const LabelBioWorkItemSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ id: "LabelBioWorkItem" });

/**
 * `list_labels_missing_bio` → `GET /admin/labels/bio-queue` (operationId
 * `listLabelsMissingBio`).
 *
 * Agent tier (`adminAuth`), the `list_labels_admin` precedent. The bio worklist: labels
 * with at least one coordinate-bearing finding but no bio yet, oldest-first — the worklist
 * the future `describe_label` cron drains. A pure read; it publishes nothing.
 */
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

/** The `admin-labels` domain's ops, merged into the root contract by `./index.ts`. */
export const adminLabelsContract = {
  confirm_label_alias: confirmLabelAlias,
  describe_label: describeLabel,
  draft_label_bio: draftLabelBio,
  list_label_aliases: listLabelAliases,
  list_labels_admin: listLabelsAdmin,
  list_labels_missing_bio: listLabelsMissingBio,
  reject_label_alias: rejectLabelAlias,
  update_label: updateLabel,
};
