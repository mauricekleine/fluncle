// The `admin-catalogue` domain contract module — THE CATALOGUE, both halves.
//
// A CATALOGUE TRACK is a row in `tracks` with NO row in `findings`: a track Fluncle knows
// about and has not certified. The domain carries two complementary jobs, and they arrived as
// two PRs. THE CRAWLER makes the rows exist; THE EAR makes the pile useful.
//
//   THE CRAWLER (docs/catalogue-crawler.md) — metadata acquisition, and nothing else:
//   - `crawl_catalogue`  — admin tier (agent-allowed write): one bounded, resumable pass of the
//     MusicBrainz walk outward from the labels the OPERATOR enabled. It writes catalogue rows
//     and never a `findings` row, and it captures no audio.
//   - `get_crawl_status` — admin tier (agent-allowed read): the crawl frontier's state.
//
//   THE EAR (docs/the-ear.md) — the ranked read over what the crawler brought back:
//   - `list_catalogue_tracks` — admin tier (agent-allowed read): the ranked catalogue, through
//     one of two lenses. `ear` is "closest to your findings, not yet logged"; `capture` is
//     "whose audio should we buy next".
//   - `rank_catalogue` — admin tier (AGENT-allowed write): one tick of the precompute sweep. It
//     writes only derived ranking columns on catalogue rows — no coordinate, no note, no
//     certification, and never a finding — so it is a machine job like `update_galaxy_map`,
//     not an editorial act like `update_galaxy`.
//
//   THE CAPTURE BUDGET (docs/the-ear.md § The capture budget) — the brake on what the two
//   above lead to. The crawler is free (it moves metadata) and the Ear is free (it moves
//   vectors), but the audio CAPTURE those rows queue up for is metered: a residential proxy
//   bills per GB, and the queue drains whatever it is given.
//   - `get_capture_budget` — admin tier (agent-allowed read): the spend readout.
//   - `set_capture_budget` — OPERATOR tier: the caps and the kill switch. The one op in this
//     domain an agent may never call — a machine does not get to raise its own budget.
//
// Every op here EXCEPT `set_capture_budget` is agent-allowed, and that is not an oversight:
// none of them can certify anything, and none of them spends money. The two acts that steer
// the catalogue are the exceptions — RULING on a seed label (`update_label`, which decides
// what may be crawled at all) and SETTING the capture budget (which decides what may be
// bought) — and both stay OPERATOR tier.
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
 * OUT ("not our lane"), so the track sinks to tier −1 whatever else is true of it. It is not
 * decoration — every one of the 8 disabled labels in the archive CARRIES a finding (each
 * arrived on a single crossover remix), so without the veto the `label` rung fires on all of
 * them and the metered capture budget goes on trance.
 *
 * Its OWN tier (−1, strictly below `none`) is what makes it enforceable rather than merely
 * decorative: the capture work queue excludes it in SQL (`capture_priority >= 0`). A veto that
 * only sorts last is not a veto — the queue drains, and last arrives (docs/gpu-batch-embed.md).
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
    /**
     * The certified finding this row is the SAME RECORDING as — "already in the archive". Set
     * two ways (docs/the-ear.md § Duplicates): the CAPTURE lens from a pre-audio ISRC match
     * (stored, and vetoed from ever being bought), the EAR lens from a near-1.0 cosine score
     * (display-only). Null on an ordinary catalogue row — a real discovery.
     */
    duplicateOf: CatalogueMatchSchema.nullable(),
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

// ─────────────────────────────────────────────────────────────────────────────
// THE CRAWLER — what makes the rows above exist. docs/catalogue-crawler.md.
// ─────────────────────────────────────────────────────────────────────────────

/** One bounded crawl pass's real numbers. Nothing here is an estimate. */
export const CrawlPassSchema = z
  .object({
    /**
     * Spotify `spotify_uri`/`spotify_url` anchors filled onto existing catalogue rows.
     * A SEPARATE, bounded step from the walk — Spotify's 429 is a hard wall (the pilot hit
     * it), and its queue is derived (`isrc is not null and spotify_uri is null`), so an
     * anchor a throttled pass missed is simply picked up by the next tick.
     */
    anchorsFilled: z.number(),
    dryRun: z.boolean(),
    /** Frontier nodes expanded this pass. */
    expanded: z.number(),
    /** Nodes that failed a vendor call and were backed off (retried by a later tick). */
    failed: z.number(),
    /** Nodes still waiting. 0 means the reachable graph is drained. */
    frontierPending: z.number(),
    /**
     * Labels the walk DISCOVERED and minted as `undecided` — the operator's next
     * rulings. A discovered label is never crawled until he enables it.
     */
    labelsDiscovered: z.array(z.string()),
    /** The graph-distance limit this pass honoured (hop 0 = a release on a seed label). */
    maxHop: z.number(),
    /** New frontier nodes enqueued — the walk's outward edge. */
    nodesEnqueued: z.number(),
    /**
     * True when MusicBrainz actively throttled us and the pass STOPPED on its circuit
     * breaker. The cron must not re-fire: the next tick resumes from durable state in a
     * fresh rate window (the shipped `backfill_*` discipline).
     */
    rateLimited: z.boolean(),
    /** Seed nodes minted from the operator's `enabled` labels this pass. */
    seeded: z.number(),
    /** Catalogue tracks the walk saw on the releases it expanded. */
    tracksFound: z.number(),
    /** Tracks the archive already held (by ISRC, or by MB recording id) — the idempotence. */
    tracksSkipped: z.number(),
    /** Catalogue rows written into `tracks`. Never a `findings` row. */
    tracksWritten: z.number(),
  })
  .meta({ id: "CrawlPass" });

/** The frontier at rest. */
export const CrawlStatusSchema = z
  .object({
    /** Catalogue rows with an ISRC still awaiting their Spotify anchor (the derived queue). */
    anchorsPending: z.number(),
    /** `tracks` rows with NO `findings` row — the catalogue, counted by its definition. */
    catalogueTracks: z.number(),
    frontier: z.object({
      done: z.number(),
      failed: z.number(),
      pending: z.number(),
      skipped: z.number(),
    }),
    frontierByKind: z.object({
      artist: z.number(),
      label: z.number(),
      release: z.number(),
    }),
    /** Labels the crawl has minted that nobody has ruled on yet. */
    labelsUndecided: z.number(),
    /** What the NEXT crawl would seed from. */
    seedLabels: z.array(z.string()),
  })
  .meta({ id: "CrawlStatus" });

/**
 * `crawl_catalogue` → `POST /admin/catalogue/crawl` (operationId `crawlCatalogue`).
 *
 * Admin tier (agent-allowed). One bounded pass: seed from the enabled labels, expand
 * `limit` frontier nodes breadth-first, write what it finds, stop. Resumable by
 * construction — all walk state is durable, so the next tick continues the walk.
 *
 * `?dryRun=true` reports the seed plan and writes nothing at all.
 */
export const crawlCatalogue = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "crawlCatalogue",
    path: "/admin/catalogue/crawl",
    summary: "Run one bounded, resumable pass of the catalogue crawler",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        dryRun: z.string().optional(),
        /** Frontier nodes to expand this pass (default 10, clamped to 50). */
        limit: z.string().optional(),
        /** Graph distance from a seed label (default 2, clamped to 3). */
        maxHop: z.string().optional(),
      }),
    }),
  )
  .output(CrawlPassSchema.extend({ ok: z.literal(true) }));

/**
 * `get_crawl_status` → `GET /admin/catalogue/crawl` (operationId `getCrawlStatus`).
 *
 * Admin tier (agent-allowed read). The frontier's shape at rest: node counts by state and
 * kind, how many catalogue tracks the archive holds, the enabled seed set, and how many
 * discovered labels are still waiting on the operator.
 */
export const getCrawlStatus = oc
  .route({
    method: "GET",
    operationId: "getCrawlStatus",
    path: "/admin/catalogue/crawl",
    summary: "The crawl frontier's state, the catalogue size, and the seed set",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(CrawlStatusSchema.extend({ ok: z.literal(true) }));

// ─────────────────────────────────────────────────────────────────────────────
// THE CAPTURE BUDGET — the brake on what the two above cost. docs/the-ear.md.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The capture budget's whole readout: the kill switch, the two caps, what the catalogue has
 * actually spent in the rolling 24h, and the verdict the capture queue obeys.
 *
 * `spend.tracks` counts ATTEMPTS (done + unmatched + failed) — every one of them was a billed
 * proxy request, and a budget that only counted successes would let a day of failures spend
 * real money against a meter reading zero. `spend.bytes` sums only what LANDED: a failed
 * download's partial transfer is genuinely unknowable from the server, so it is under-counted
 * rather than guessed at.
 */
export const CaptureBudgetStateSchema = z
  .object({
    budget: z.object({ dailyBytes: z.number(), dailyTracks: z.number() }),
    /** Null exactly when `open`. `paused` (the kill switch) wins over either cap. */
    closedReason: z.enum(["bytes_spent", "paused", "tracks_spent"]).nullable(),
    /** True ⇒ the capture queue may hand out catalogue rows right now. */
    open: z.boolean(),
    paused: z.boolean(),
    remainingBytes: z.number(),
    remainingTracks: z.number(),
    spend: z.object({ bytes: z.number(), tracks: z.number() }),
    windowHours: z.number(),
  })
  .meta({ id: "CaptureBudgetState" });

/**
 * `get_capture_budget` → `GET /admin/catalogue/capture-budget` (operationId
 * `getCaptureBudget`).
 *
 * Admin tier (agent-allowed READ, the `get_crawl_status` precedent) — the spend readout.
 * A metered thing the operator cannot see is a thing he cannot control, so this is what
 * `/admin/catalogue` and `fluncle admin capture budget` render: what it captured in the last
 * 24h, how many GB that was, and how much budget is left.
 *
 * It is the SAME code path the capture queue's brake consults, deliberately — a budget
 * display that can disagree with the budget is worse than no display at all.
 */
export const getCaptureBudget = oc
  .route({
    method: "GET",
    operationId: "getCaptureBudget",
    path: "/admin/catalogue/capture-budget",
    summary: "The catalogue capture budget: the switch, the caps, the 24h spend, what is left",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(CaptureBudgetStateSchema.extend({ ok: z.literal(true) }));

/**
 * `set_capture_budget` → `PUT /admin/catalogue/capture-budget` (operationId
 * `setCaptureBudget`).
 *
 * OPERATOR tier — the `set_publish_advance` shape, on the same `settings` KV. This is the one
 * op in the domain the agent may never touch, and the reason is that every other op here is
 * free: the crawler moves metadata and the Ear moves vectors, while THIS decides how much of
 * the operator's money a residential proxy may spend on his behalf. A machine does not get to
 * raise its own budget.
 *
 * Every field is optional, so one call is either a flip of the switch, a change to a cap, or
 * both. `paused: true` is the KILL SWITCH and stops the spend on the next queue read, with no
 * deploy. Both caps are non-negative integers; `0` is legal and means "capture nothing", which
 * is a different statement from paused (the cap can be raised back without touching the switch).
 */
export const setCaptureBudget = oc
  .route({
    method: "PUT",
    operationId: "setCaptureBudget",
    path: "/admin/catalogue/capture-budget",
    summary: "Set the catalogue capture budget / flip its kill switch (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      dailyBytes: z.number().int().min(0).optional(),
      dailyTracks: z.number().int().min(0).optional(),
      paused: z.boolean().optional(),
    }),
  )
  .output(CaptureBudgetStateSchema.extend({ ok: z.literal(true) }));

/** The `admin-catalogue` domain's ops, merged into the root contract by `./index.ts`. */
export const adminCatalogueContract = {
  crawl_catalogue: crawlCatalogue,
  get_capture_budget: getCaptureBudget,
  get_crawl_status: getCrawlStatus,
  list_catalogue_tracks: listCatalogueTracks,
  rank_catalogue: rankCatalogue,
  set_capture_budget: setCaptureBudget,
};
