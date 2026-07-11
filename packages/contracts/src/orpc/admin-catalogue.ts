// The `admin-catalogue` domain contract module — THE EAR (docs/the-ear.md).
//
// A CATALOGUE TRACK is a row in `tracks` with NO row in `findings`: a track Fluncle knows
// about and has not certified. Two ops:
//
//   - `list_catalogue_tracks` — admin tier (agent-allowed read): the ranked catalogue, through
//     one of two lenses. `ear` is "closest to your findings, not yet logged"; `capture` is
//     "whose audio should we buy next".
//   - `rank_catalogue` — admin tier (AGENT-allowed write): one tick of the precompute sweep. It
//     writes only derived ranking columns on catalogue rows — no coordinate, no note, no
//     certification, and never a finding — so it is a machine job like `update_galaxy_map`,
//     not an editorial act like `update_galaxy`.
//
// ── WHY THE TIER IS INTERNAL-ONLY ────────────────────────────────────────────────────
// The catalogue tier has NO PUBLIC NAME (the-archive RFC, D4): it is never labelled,
// introduced, or given a noun the crew could learn. `catalogue` is the INTERNAL word — code,
// docs, `/admin` — and there is deliberately no public op here. "Finding" stays the only named
// object in Fluncle's world.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * Which question the page asks of the catalogue.
 *
 *   - `ear`     — ranked by similarity to the NEAREST finding. The telescope.
 *   - `capture` — ranked by the pre-audio priority ladder. A track has no vector until its
 *                 audio is captured, and capture is metered, so this lens answers the one
 *                 question the `ear` lens structurally cannot: who gets captured next.
 */
export const CatalogueLensSchema = z.enum(["capture", "ear"]).meta({ id: "CatalogueLens" });

/**
 * Why a not-yet-captured track sits where it does in the capture queue. The rungs, strongest
 * first: `artist` (someone on it is already on a finding), `label` (its label already carries
 * one), `seed-label` (its label is one the operator seeds from), `none`.
 *
 * `skipped-label` is the VETO, and it outranks all of them: its label is one the operator ruled
 * OUT ("not our lane"), so the track sinks to tier 0 whatever else is true of it. It is not
 * decoration — every one of the 8 disabled labels in the archive CARRIES a finding (each
 * arrived on a single crossover remix), so without the veto the `label` rung fires on all of
 * them and the metered capture budget goes on trance.
 */
export const CapturePriorityReasonSchema = z
  .object({
    kind: z.enum(["artist", "label", "none", "seed-label", "skipped-label"]),
    name: z.string().nullable(),
  })
  .meta({ id: "CapturePriorityReason" });

/** The finding a catalogue row matched — the row's WHY, hydrated. */
export const CatalogueMatchSchema = z
  .object({
    artists: z.array(z.string()),
    logId: z.string().nullable(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "CatalogueMatch" });

/**
 * One catalogue track. It carries NO certification field by construction — no Log ID, no note,
 * no video, no galaxy — because those live on `findings` and this row has no `findings` row.
 * `nearestFinding` is the WHY: a bare score is not a reason, and an instrument the operator
 * cannot interrogate is one he stops trusting.
 */
export const CatalogueTrackItemSchema = z
  .object({
    albumImageUrl: z.string().nullable(),
    artists: z.array(z.string()),
    bpm: z.number().nullable(),
    capturePriority: z.number().nullable(),
    captureReason: CapturePriorityReasonSchema.nullable(),
    key: z.string().nullable(),
    label: z.string().nullable(),
    nearestFinding: CatalogueMatchSchema.nullable(),
    nearestFindingScore: z.number().nullable(),
    rankedAt: z.string().nullable(),
    releaseDate: z.string().nullable(),
    spotifyUrl: z.string().nullable(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "CatalogueTrackItem" });

/** The catalogue's shape in four scoped counts — what the operator reads above the rows. */
export const CatalogueSummarySchema = z
  .object({
    awaitingCapture: z.number(),
    awaitingRank: z.number(),
    ranked: z.number(),
    total: z.number(),
  })
  .meta({ id: "CatalogueSummary" });

/**
 * `list_catalogue_tracks` → `GET /admin/catalogue` (operationId `listCatalogueTracks`).
 *
 * Admin tier (agent-allowed read). The ranked catalogue through one lens, plus the summary.
 *
 * NO VECTOR MATH RUNS HERE. Both lenses are an ordered walk of a column the `rank_catalogue`
 * sweep precomputed, bounded by `limit` — the cost is the page, not the corpus. Ranking the
 * catalogue against the findings at request time would be a cross join (10k × 60 cosine ops
 * on 1024-d vectors, per page load), which is exactly what the sweep exists to prevent.
 */
export const listCatalogueTracks = oc
  .route({
    method: "GET",
    operationId: "listCatalogueTracks",
    path: "/admin/catalogue",
    summary: "The ranked catalogue: closest to a finding (`ear`), or next to capture (`capture`)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      lens: CatalogueLensSchema.default("ear"),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      summary: CatalogueSummarySchema,
      tracks: z.array(CatalogueTrackItemSchema),
    }),
  );

/**
 * `rank_catalogue` → `POST /admin/catalogue/rank` (operationId `rankCatalogue`).
 *
 * Admin tier (AGENT-allowed): one tick of the precompute sweep, the job a periodic `--no-agent`
 * cron drives. It ranks up to `limit` stale catalogue rows — each against every embedded
 * finding, entirely in SQL — and stores each one's nearest finding, the cosine similarity to
 * it, and (for a row with no audio yet) its capture-priority tier.
 *
 * SELF-HEALING. Staleness is a fingerprint of the finding corpus (`"<findings>:<embedded>"`)
 * stored on each ranked row, so logging or embedding a finding makes every row disagree with it
 * and re-rank on later ticks. No invalidation call from the publish path, and a no-op on an
 * unchanged archive. `remaining` is the "run me again" signal.
 *
 * It writes DERIVED columns on catalogue rows only. It cannot mint a coordinate, write a note,
 * or touch a finding — which is why it is agent-allowed rather than operator-tier.
 * `{ ok, summary }`.
 */
export const rankCatalogue = oc
  .route({
    method: "POST",
    operationId: "rankCatalogue",
    path: "/admin/catalogue/rank",
    summary: "One tick of the catalogue ranking sweep (nearest finding + capture priority)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(250) }))
  .output(
    z.object({
      ok: z.literal(true),
      summary: z.object({
        corpus: z.string(),
        embeddedFindings: z.number(),
        findings: z.number(),
        prioritized: z.number(),
        remaining: z.number(),
        scored: z.number(),
      }),
    }),
  );

/** The `admin-catalogue` domain's ops, merged into the root contract by `./index.ts`. */
export const adminCatalogueContract = {
  list_catalogue_tracks: listCatalogueTracks,
  rank_catalogue: rankCatalogue,
};
