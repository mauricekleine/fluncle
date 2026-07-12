// The `admin-labels` domain contract module — the record-label entity's admin
// surface, and the operator's CRAWL-SEED control. Two ops, on the `admin-galaxies`
// pattern (an agent-allowed full read + an operator-tier editorial write):
//
//   - `list_labels_admin` — admin tier (agent-allowed read): every label with its
//     seed state and finding count, optionally scoped to one state. `?seedState=enabled`
//     IS the crawler's seed-set read: when the catalogue crawler exists, this is where
//     it asks what it may seed from, with its agent token. Named `_admin` (the
//     `list_galaxies_admin` precedent) so the public `list_labels` / `get_label` names
//     stay free for the coming `/label/<slug>` pages.
//   - `update_label` — OPERATOR tier: the ruling. Ruling on a label is an editorial act
//     that steers what Fluncle crawls next, so an agent token 403s at `operatorGuard`
//     (the `update_galaxy` precedent).
//
// ── `seedState` IS CRAWL SCOPE, NEVER STORAGE ──────────────────────────────────────
// A label's seed state answers exactly one question: MAY THE FUTURE CATALOGUE CRAWLER
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
 * `seedState` filter is the clean exposure of the seed set: the future catalogue crawler
 * reads `?seedState=enabled` with its agent token and gets exactly the labels it may seed
 * from. Nothing consumes it yet — the crawler does not exist. `{ ok, labels }`.
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

/** The `admin-labels` domain's ops, merged into the root contract by `./index.ts`. */
export const adminLabelsContract = {
  list_labels_admin: listLabelsAdmin,
  update_label: updateLabel,
};
