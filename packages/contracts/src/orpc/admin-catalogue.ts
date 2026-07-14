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
 *   - `ear`        — ranked by similarity to the NEAREST finding. The telescope.
 *   - `capture`    — ranked by the pre-audio priority ladder. A track has no vector until its
 *                    audio is captured, and capture is metered, so this lens answers the one
 *                    question the `ear` lens structurally cannot: who gets captured next.
 *   - `quarantine` — the WRONG-AUDIO holding pen (docs/the-ear.md § Wrong audio): rows whose
 *                    capture landed the wrong master (a near-1.0 cross-title match), vetoed from
 *                    the ear lens and re-queued for a fresh download. Its own quiet section so a
 *                    bad capture never silently vanishes, each row force-clearable by the operator.
 *   - `dismissed`  — the operator's "not for me" restore pile (docs/the-ear.md § The operator's
 *                    actions): rows he took out of the telescope. A REVERSIBLE veto, its own quiet
 *                    lens so a dismissal is never a black hole — each row carries a Restore.
 */
export const CatalogueLensSchema = z
  .enum(["capture", "dismissed", "ear", "quarantine"])
  .meta({ id: "CatalogueLens" });

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
    /** The Apple Music listen link, when the ISRC has resolved one — the Spotify twin. */
    appleMusicUrl: z.string().nullable(),
    artists: z.array(z.string()),
    bpm: z.number().nullable(),
    capturePriority: z.number().nullable(),
    captureReason: CapturePriorityReasonSchema.nullable(),
    /**
     * The capture-verification verdict (docs/the-ear.md § Wrong audio): `preview-match` /
     * `unverified` / `mismatch`, or null (pre-gate legacy / no capture). A quiet honesty marker.
     */
    captureVerification: z.string().nullable(),
    /** ISO of when the operator dismissed this row ("not for me"); null on a live row. */
    dismissedAt: z.string().nullable(),
    /**
     * The certified finding this row is the SAME RECORDING as — "already in the archive". Set
     * two ways (docs/the-ear.md § Duplicates): the CAPTURE lens from a pre-audio ISRC match
     * (stored, and vetoed from ever being bought), the EAR lens from a near-1.0 cosine score
     * (display-only). Null on an ordinary catalogue row — a real discovery.
     */
    duplicateOf: CatalogueMatchSchema.nullable(),
    /**
     * Whether the private bucket holds this row's captured full song — the audition FALLBACK:
     * a row with no resolvable store preview (no URL, no ISRC — the small-label case) can still
     * play the bytes Fluncle owns, through the operator source-audio route.
     */
    hasCapturedAudio: z.boolean(),
    /**
     * Whether an official 30s preview can be auditioned inline (docs/the-ear.md § The operator's
     * actions) — true when the row carries a stored preview or an ISRC, so the artwork is a live
     * play control rather than a dead one.
     */
    hasPreview: z.boolean(),
    isrc: z.string().nullable(),
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
    /** Rows the operator dismissed ("not for me") — the restore pile's depth. */
    dismissed: z.number(),
    /** Rows quarantined as wrong audio, awaiting a fresh capture (docs/the-ear.md § Wrong audio). */
    quarantined: z.number(),
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
        /**
         * Rows re-pointed at a canonical catalogue sibling this tick — the same master under a
         * second MusicBrainz MBID (docs/the-ear.md § Duplicates). Missing from the schema when
         * the server first shipped it, and zod STRIPPED it silently — the field must be pinned
         * here or no client ever sees it.
         */
        catalogueDuplicates: z.number(),
        corpus: z.string(),
        embeddedFindings: z.number(),
        findings: z.number(),
        prioritized: z.number(),
        /** Rows quarantined as wrong audio this tick (docs/the-ear.md § Wrong audio). */
        quarantined: z.number(),
        remaining: z.number(),
        scored: z.number(),
      }),
    }),
  );

/**
 * `clear_wrong_audio` → `POST /admin/catalogue/wrong-audio/clear` (operationId `clearWrongAudio`).
 *
 * OPERATOR tier — the operator's override on the wrong-audio quarantine (docs/the-ear.md § Wrong
 * audio). "I disagree, this capture is fine, stop re-capturing it." It flips one quarantined row
 * from `wrong-audio` to the sticky `quarantine-cleared` state the sweep never re-quarantines, so
 * the kept audio re-embeds and re-ranks normally.
 *
 * Operator-only, not agent-allowed: overruling the machine's wrong-audio verdict is a judgement a
 * machine does not get to make about its own output — the same reasoning that keeps `update_label`
 * and `set_capture_budget` operator-tier. `{ ok, cleared }`; `cleared: false` when the row was not
 * actually quarantined (already handled, or a race).
 */
export const clearWrongAudio = oc
  .route({
    method: "POST",
    operationId: "clearWrongAudio",
    path: "/admin/catalogue/wrong-audio/clear",
    summary: "Overrule the wrong-audio quarantine on one catalogue row (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string().min(1) }))
  .output(z.object({ cleared: z.boolean(), ok: z.literal(true) }));

/**
 * `requeue_unmatched_captures` → `POST /admin/catalogue/captures/requeue-unmatched`
 * (operationId `requeueUnmatchedCaptures`).
 *
 * OPERATOR tier — the terminal-`unmatched` rescue (the 2026-07-14 unmatched audit). An
 * `unmatched` capture verdict is terminal by design so the metered budget never re-burns a
 * hopeless search — but when the SEARCH itself improves (the music-search ladder, the
 * normalized query variant), the old verdicts describe the old matcher, not the tracks: the
 * spike recovered 66% of the terminal set with the new ladder. This op flips every
 * catalogue row still marked `unmatched` back to `pending` in one deliberate act, EXCLUDING
 * the rows the duration vetoes would immediately re-refuse (missing/short/long — those stay
 * terminal; re-queueing them buys guaranteed-unmatched searches), and resets their failure
 * count so the re-attempt starts clean.
 *
 * Operator-only: it re-arms metered spend across hundreds of rows at once — the same
 * money-judgement tier as `set_capture_budget`. Idempotent: a second call finds zero
 * `unmatched` rows and returns `{ requeued: 0 }`.
 */
export const requeueUnmatchedCaptures = oc
  .route({
    method: "POST",
    operationId: "requeueUnmatchedCaptures",
    path: "/admin/catalogue/captures/requeue-unmatched",
    summary:
      "Re-queue terminal-unmatched catalogue captures after a matcher improvement (operator)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ ok: z.literal(true), requeued: z.number(), skippedVetoed: z.number() }));

/**
 * `flag_wrong_audio` → `POST /admin/catalogue/wrong-audio/flag` (operationId `flagWrongAudio`).
 *
 * OPERATOR tier — `clear_wrong_audio`'s counterpart: "the FINDING's capture is the wrong one"
 * (docs/the-ear.md § Wrong audio). The auto-quarantine can only ever accuse the CATALOGUE side of
 * a cross-title collision, but six-nines cosine proves same-recording, not which title is lying.
 * When the operator auditions the catalogue row's captured bytes and hears the row's OWN song,
 * the poisoned capture is the finding's — this is how he says so. The finding's vector drops out
 * of the ranking corpus, its analysis provenance resets (bpm/key were measured off the wrong
 * song), and it re-enters the capture queue with the bad bytes hash-rejected.
 *
 * Operator-only, not agent-allowed: it rewinds a PUBLIC finding's enrichment on the strength of a
 * human listen — a judgement a machine does not get to make (the `clear_wrong_audio` reasoning).
 * `{ ok, flagged }`; `flagged: false` when the track is not a captured finding (or already
 * flagged), so a double-click reports honestly.
 */
export const flagWrongAudio = oc
  .route({
    method: "POST",
    operationId: "flagWrongAudio",
    path: "/admin/catalogue/wrong-audio/flag",
    summary: "Flag a finding's captured audio as the wrong recording (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string().min(1) }))
  .output(z.object({ flagged: z.boolean(), ok: z.literal(true) }));

/**
 * `force_capture` → `POST /admin/catalogue/force-capture` (operationId `forceCapture`).
 *
 * OPERATOR tier — the dupe-veto escape hatch (docs/the-ear.md § Duplicates). "This row is NOT the
 * duplicate the sweep thinks it is." A duplicate veto (`duplicate_of_track_id` + the −2 tier) can
 * be WRONG — a shared/mis-assigned ISRC, a `matchKey` collision on a genuinely different recording
 * — and it is self-sealing: an uncaptured vetoed row is excluded from capture forever, so the
 * post-audio check that would exonerate it never runs. This lifts the veto STICKILY (a
 * `capture_status` sentinel all three duplicate detectors respect before re-stamping) and puts the
 * row back on the pre-audio ladder at its honest tier; the next open-budget capture tick buys it.
 * It bypasses the DUPLICATE veto, never the VERIFICATION gate — a re-captured forced row still runs
 * the fingerprint gate at ingest.
 *
 * Operator-only, not agent-allowed: overruling the machine's duplicate verdict is a judgement a
 * machine does not get to make about its own output — the same reasoning that keeps `clear_wrong_audio`,
 * `update_label`, and `set_capture_budget` operator-tier. `{ ok, forced }`; `forced: false` when the
 * row was not actually vetoed as a duplicate (already handled, a non-duplicate, or a finding).
 */
export const forceCapture = oc
  .route({
    method: "POST",
    operationId: "forceCapture",
    path: "/admin/catalogue/force-capture",
    summary: "Overrule the duplicate veto on one catalogue row so it can be captured (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string().min(1) }))
  .output(z.object({ forced: z.boolean(), ok: z.literal(true) }));

/**
 * `certify_track` → `POST /admin/catalogue/certify` (operationId `certifyTrack`).
 *
 * OPERATOR tier — the "Log it" the Ear's workstation fires (docs/the-ear.md § The operator's
 * actions). It turns an EXISTING catalogue row (a `tracks` row with no `findings` row) into a
 * finding by minting the certification half in place — the SAME coordinate mint the Spotify add
 * uses — and never creates a new track. The fresh finding enters the enrichment chain (its
 * `enrichment_status` defaults to `pending`), so the operator lands on it with the pipeline
 * already moving and finishes note / galaxy / publish from there.
 *
 * Operator-only, NOT agent-allowed: certifying is the one act the whole catalogue domain forbids a
 * machine — the agent-tier sweep is agent-allowed precisely BECAUSE it can never certify. Same rule
 * that keeps `update_label` and `set_capture_budget` operator-tier. Returns the minted `logId`.
 * 404 when the track does not exist; 409 when it is already certified.
 */
export const certifyTrack = oc
  .route({
    method: "POST",
    operationId: "certifyTrack",
    path: "/admin/catalogue/certify",
    summary: "Certify an existing catalogue track in place — mint its finding (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ note: z.string().optional(), trackId: z.string().min(1) }))
  .output(z.object({ logId: z.string(), ok: z.literal(true) }));

/**
 * `set_track_dismissed` → `PUT /admin/catalogue/dismissed` (operationId `setTrackDismissed`).
 *
 * OPERATOR tier — the "not for me" / restore toggle (docs/the-ear.md § The operator's actions), the
 * `set_capture_budget` shape (one op, both directions). `dismissed: true` stamps `dismissed_at` so
 * the row drops out of the ear/capture reads AND the capture work queue (the ruled-out-label veto's
 * class — a metered download is never spent on a dismissed row); `dismissed: false` restores it, so
 * it re-enters the ranking on the next sweep tick.
 *
 * Operator-only for the same reason `update_label` is: steering what the telescope keeps pointing at
 * is a taste ruling, not a machine job. `changed: false` is an idempotent no-op (already in that
 * state, or a finding trackId — a finding is never dismissed).
 */
export const setTrackDismissed = oc
  .route({
    method: "PUT",
    operationId: "setTrackDismissed",
    path: "/admin/catalogue/dismissed",
    summary: "Dismiss a catalogue track ('not for me') or restore it (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ dismissed: z.boolean(), trackId: z.string().min(1) }))
  .output(z.object({ changed: z.boolean(), ok: z.literal(true) }));

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE VERIFICATION — the historic backfill's two ops. docs/the-ear.md § Wrong audio.
// ─────────────────────────────────────────────────────────────────────────────

/** One captured row the verification backfill still has to fingerprint-check. */
export const CaptureVerifyItemSchema = z
  .object({
    artists: z.array(z.string()),
    certified: z.boolean(),
    durationMs: z.number(),
    isrc: z.string().nullable(),
    logId: z.string().nullable(),
    sourceAudioKey: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "CaptureVerifyItem" });

/**
 * `list_unverified_captures` → `GET /admin/catalogue/captures/unverified` (operationId
 * `listUnverifiedCaptures`).
 *
 * Admin tier (agent-allowed read), the `list_track_work` precedent. The verification backfill's
 * worklist: captured rows (findings + catalogue) whose bytes have never been checked against their
 * ISRC preview. Bounded + resumable — a verified row leaves the set, so re-running drains what is
 * left, no cursor. A pure read; it publishes nothing. The `fluncle-verify-captures` box cron drives it.
 */
export const listUnverifiedCaptures = oc
  .route({
    method: "GET",
    operationId: "listUnverifiedCaptures",
    path: "/admin/catalogue/captures/unverified",
    summary:
      "Captured rows not yet fingerprint-verified against their preview (the backfill worklist)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }))
  .output(z.object({ ok: z.literal(true), tracks: z.array(CaptureVerifyItemSchema) }));

/**
 * `verify_capture` → `POST /admin/catalogue/captures/verify` (operationId `verifyCapture`).
 *
 * Admin tier (AGENT-allowed WRITE), the `rank_catalogue` precedent. The box fingerprints a captured
 * file against the track's ISRC-resolved official preview and reports one of three verdicts; the
 * SERVER routes it (docs/the-ear.md § Wrong audio): `match` → stamp `preview-match`; `no-preview` →
 * stamp `unverified`; `mismatch` on a CATALOGUE row → quarantine it (drop the vector, re-queue for
 * capture, remember the bad sha); `mismatch` on a FINDING → stamp `mismatch` only, raising an
 * /admin attention item — a machine never rewinds a public finding, so the operator rules with
 * `flag_wrong_audio`. It writes only derived/measurement columns and never certifies, so the box's
 * agent token drives it. `{ ok, action }`.
 *
 * `verify` is a new verb, added deliberately (docs/naming-conventions.md): it is not `enrich`
 * (deriving an entity's own attributes), not `rank` (ordering a corpus), not `resolve` (fixing an
 * external identity) — it CHECKS a stored artifact against a reference and records the verdict.
 */
export const verifyCapture = oc
  .route({
    method: "POST",
    operationId: "verifyCapture",
    path: "/admin/catalogue/captures/verify",
    summary: "Record a capture's fingerprint verdict against its preview, and route it",
    tags: ["Admin"],
  })
  .input(
    z.object({
      trackId: z.string().min(1),
      verdict: z.enum(["match", "mismatch", "no-preview"]),
    }),
  )
  .output(
    z.object({
      action: z.enum([
        "flagged-finding",
        "not-captured",
        "preview-match",
        "quarantined-catalogue",
        "unverified",
      ]),
      ok: z.literal(true),
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

// ─────────────────────────────────────────────────────────────────────────────
// THE APPLE BREAKER — the operator's reset for the cross-cutting Apple failure-regime breaker
// (RFC musickit-second-authority, Cross-cutting). docs/track-lifecycle.md.
// ─────────────────────────────────────────────────────────────────────────────

/** The Apple breaker's readout — what the reset returns, and observability shows. */
export const AppleBreakerStateSchema = z
  .object({
    /** Consecutive 401/403 responses seen since the last success (0 after a reset / a success). */
    consecutiveAuthFailures: z.number(),
    /** Milliseconds left on the cooldown while tripped; 0 when not tripped. */
    cooldownRemainingMs: z.number(),
    /** True ⇒ every Apple-touching path short-circuits (no call) until the cooldown / a reset. */
    tripped: z.boolean(),
    /** ISO of when it last tripped, or null when not tripped. */
    trippedAt: z.string().nullable(),
  })
  .meta({ id: "AppleBreakerState" });

/**
 * `reset_apple_breaker` → `POST /admin/catalogue/apple-breaker/reset` (operationId
 * `resetAppleBreaker`).
 *
 * OPERATOR tier. Clears the cross-cutting Apple failure-regime breaker: K consecutive 401/403
 * responses (a suspended developer token) trip it, and while tripped EVERY Apple-touching path —
 * the two sweeps here, and later the live preview rung + editorial fuel — short-circuits until a
 * cooldown elapses. This lifts the trip early (once the token is fixed) and zeroes the streak,
 * returning the breaker's state. Operator tier because it re-arms a spend-adjacent external
 * integration a machine should not silently un-brake — the `set_capture_budget` neighbour's rule.
 */
export const resetAppleBreaker = oc
  .route({
    method: "POST",
    operationId: "resetAppleBreaker",
    path: "/admin/catalogue/apple-breaker/reset",
    summary: "Clear the Apple failure-regime breaker (operator)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(AppleBreakerStateSchema.extend({ ok: z.literal(true) }));

/** The `admin-catalogue` domain's ops, merged into the root contract by `./index.ts`. */
export const adminCatalogueContract = {
  certify_track: certifyTrack,
  clear_wrong_audio: clearWrongAudio,
  crawl_catalogue: crawlCatalogue,
  flag_wrong_audio: flagWrongAudio,
  force_capture: forceCapture,
  get_capture_budget: getCaptureBudget,
  get_crawl_status: getCrawlStatus,
  list_catalogue_tracks: listCatalogueTracks,
  list_unverified_captures: listUnverifiedCaptures,
  rank_catalogue: rankCatalogue,
  requeue_unmatched_captures: requeueUnmatchedCaptures,
  reset_apple_breaker: resetAppleBreaker,
  set_capture_budget: setCaptureBudget,
  set_track_dismissed: setTrackDismissed,
  verify_capture: verifyCapture,
};
