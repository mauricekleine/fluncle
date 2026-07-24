// The `fluncle admin catalogue` commands — the catalogue's thin HTTP client.
//
// A CATALOGUE TRACK is a track the archive knows and Fluncle never certified. Four verbs, all
// admin tier (agent-allowed), all a thin wrapper over the oRPC ops — the CLI holds no crawl and
// no ranking logic, because the walk and all of the vector arithmetic happen inside the Worker.
// It is a pacer, not an engine: the Worker owns the vendor budget and the durable state.
//
//   THE EAR (docs/the-ear.md) — what makes the pile useful:
//   - `rank`   — one tick of the precompute sweep (`rank_catalogue`). This is the command the
//     periodic `--no-agent` cron drives with the box's agent token: it prints one JSON summary
//     line, and `remaining > 0` means run it again.
//   - `list`   — the ranked catalogue (`list_catalogue_tracks`), through one of the two lenses.
//
//   THE CRAWLER (docs/catalogue-crawler.md) — what makes the rows exist:
//   - `crawl`  — one bounded, resumable pass of the MusicBrainz walk (`crawl_catalogue`). Also
//     cron-driven; the frontier is the worklist, so "run again" and "resume" are the same call.
//   - `status` — the crawl frontier's state (`get_crawl_status`).

import { type CatalogueResponse, type CatalogueTrackItem } from "@fluncle/contracts";
import { adminApiGet, adminApiPost, adminApiPut } from "../api";

export type { CatalogueTrackItem };

/** The sweep's per-tick summary — the JSON line a cron reads. */
export type RankCatalogueSummary = {
  /** Rows re-pointed at a canonical catalogue sibling this tick (docs/the-ear.md § Duplicates). */
  catalogueDuplicates: number;
  corpus: string;
  embeddedFindings: number;
  findings: number;
  prioritized: number;
  /** Rows quarantined as wrong audio this tick (docs/the-ear.md § Wrong audio). */
  quarantined: number;
  remaining: number;
  scored: number;
};

/**
 * One tick of the ranking sweep. `fluncle admin catalogue rank [--limit <n>]`.
 *
 * Ranks up to `limit` STALE catalogue rows — each against every embedded finding, entirely in
 * SQL — storing each one's nearest finding + the similarity to it, or (for a row with no audio
 * yet) its capture-priority tier. Idempotent, resume-safe, and a no-op on an unchanged archive.
 */
export async function catalogueRankCommand(options: {
  countRemaining?: boolean;
  limit?: string;
}): Promise<{
  summary: RankCatalogueSummary;
  telescope?: TelescopeSyncOutcome;
}> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
  // `countRemaining` opts into the real backlog COUNT for `remaining` (the human-readable readout);
  // the default sentinel keeps the box sweep's `--json` path off the ~19s scan (server contract).
  const response = await adminApiPost<{
    ok: true;
    summary: RankCatalogueSummary;
    telescope?: TelescopeSyncOutcome;
  }>("/api/v1/admin/catalogue/rank", {
    ...(limit ? { limit } : {}),
    ...(options.countRemaining ? { countRemaining: true } : {}),
  });

  return { summary: response.summary, telescope: response.telescope };
}

/** The demand tick's summary — the JSON line the nightly cron reads. */
export type RecordDemandSummary = {
  configured: boolean;
  demandedArtists: number;
  demandedLabels: number;
  frontierPromoted: number;
  pagesRead: number;
  totalPageviews: number;
  tracksScored: number;
  unknownSlugs: number;
  window: { end: string; start: string };
};

/**
 * One demand tick. `fluncle admin catalogue demand`.
 *
 * A bare trigger (the `reach collect` shape): the WORKER reads Simple Analytics for the
 * `/artist/<slug>` + `/label/<slug>` pageviews and rewrites the two derived reorder columns
 * (`tracks.demand_score` + `crawl_frontier.demand_rank`) — a rank-order-only, idempotent,
 * within-tier reorder toward what real visitors looked at. Unprovisioned (no SA key) it is a
 * clean `configured: false` no-op. The box holds no SA key; the Worker owns it.
 */
export async function catalogueDemandCommand(): Promise<RecordDemandSummary> {
  const response = await adminApiPost<{ ok: true; summary: RecordDemandSummary }>(
    "/api/v1/admin/catalogue/demand",
    {},
  );

  return response.summary;
}

/**
 * What the Telescope playlist mirror did after the tick (docs/the-ear.md § Fluncle's
 * Telescope). The sync is best-effort server-side, so this is the operator's ONLY window
 * onto a silent Spotify failure — the command must never drop it.
 */
export type TelescopeSyncOutcome =
  | { changed: boolean; ok: true; size: number }
  | { ok: false; reason: string };

/** The lenses the CLI forwards verbatim; anything else falls back to the `ear` default. */
const CATALOGUE_LENSES = new Set(["capture", "dismissed", "failed", "quarantine", "unmatched"]);

/**
 * The ranked catalogue.
 * `fluncle admin catalogue list [--lens ear|capture|quarantine|unmatched|failed|dismissed] [--limit <n>]`.
 *
 * `ear` (the default) is "closest to your findings, not yet logged"; `capture` is "whose audio
 * should we buy next" — the rows with no vector at all, which the ear structurally cannot rank;
 * `quarantine` is the wrong-audio holding pen (docs/the-ear.md § Wrong audio); `unmatched` and
 * `failed` are the capture-outcome observability windows (newest attempt first); `dismissed` is
 * the operator's restore pile.
 */
export async function catalogueListCommand(options: {
  lens?: string;
  limit?: string;
}): Promise<CatalogueResponse> {
  const params = new URLSearchParams();

  params.set("lens", options.lens && CATALOGUE_LENSES.has(options.lens) ? options.lens : "ear");

  if (options.limit) {
    params.set("limit", options.limit);
  }

  return adminApiGet<CatalogueResponse>(`/api/v1/admin/catalogue?${params.toString()}`);
}

/**
 * Overrule the wrong-audio quarantine on one catalogue row (operator). `fluncle admin catalogue
 * clear-wrong-audio <trackId>`. Flips the row from `wrong-audio` to the sticky `quarantine-cleared`
 * state the sweep never re-quarantines, so its kept audio re-embeds and re-ranks (docs/the-ear.md
 * § Wrong audio). `cleared: false` when the row was not actually quarantined.
 */
export async function clearWrongAudioCommand(trackId: string): Promise<{ cleared: boolean }> {
  return adminApiPost<{ cleared: boolean; ok: true }>("/api/v1/admin/catalogue/wrong-audio/clear", {
    trackId,
  });
}

/**
 * Re-queue every terminal-`unmatched` catalogue capture after a matcher improvement (operator).
 * `fluncle admin catalogue requeue-unmatched`. Flips `unmatched` rows back to `pending` so the
 * upgraded search ladder re-attempts them; rows the duration vetoes would immediately re-refuse
 * stay terminal and are reported as `skippedVetoed`. One deliberate operator act — it re-arms
 * metered spend across hundreds of rows.
 */
export async function requeueUnmatchedCommand(): Promise<{
  requeued: number;
  skippedVetoed: number;
}> {
  return adminApiPost<{ ok: true; requeued: number; skippedVetoed: number }>(
    "/api/v1/admin/catalogue/captures/requeue-unmatched",
    {},
  );
}

/**
 * Overrule the duplicate veto on one catalogue row so it can be captured (operator). `fluncle
 * admin catalogue force-capture <trackId>` — the dupe-veto escape hatch (docs/the-ear.md §
 * Duplicates). Lifts a WRONG `duplicate_of` + −2 veto stickily and puts the row back on the
 * pre-audio ladder at its honest tier; the next open-budget capture tick buys it. It bypasses the
 * duplicate veto, never the verification gate. `forced: false` when the row was not actually vetoed.
 */
export async function forceCaptureCommand(trackId: string): Promise<{ forced: boolean }> {
  return adminApiPost<{ forced: boolean; ok: true }>("/api/v1/admin/catalogue/force-capture", {
    trackId,
  });
}

/**
 * Flag a FINDING's captured audio as the wrong recording (operator). `fluncle admin catalogue
 * flag-wrong-audio <trackId>` — `clear-wrong-audio`'s counterpart (docs/the-ear.md § Wrong
 * audio). The finding's vector drops out of the ranking corpus, its analysis provenance resets,
 * and it re-enters the capture queue with the bad bytes hash-rejected. `flagged: false` when the
 * track is not a captured finding (or already flagged).
 */
export async function flagWrongAudioCommand(trackId: string): Promise<{ flagged: boolean }> {
  return adminApiPost<{ flagged: boolean; ok: true }>("/api/v1/admin/catalogue/wrong-audio/flag", {
    trackId,
  });
}

/**
 * Certify an existing catalogue track in place — mint its finding, without creating a new track
 * (operator). `fluncle admin catalogue certify <trackId> [--note <text>]`. Returns the minted Log
 * ID (docs/the-ear.md § The operator's actions). 409 when the track is already logged.
 */
export async function certifyTrackCommand(
  trackId: string,
  note?: string,
): Promise<{ logId: string }> {
  return adminApiPost<{ logId: string; ok: true }>("/api/v1/admin/catalogue/certify", {
    ...(note ? { note } : {}),
    trackId,
  });
}

/**
 * Dismiss a catalogue track ("not for me") or restore it (operator). `fluncle admin catalogue
 * dismiss <trackId>` / `restore <trackId>`. A dismissed row drops out of the ear/capture reads and
 * the capture ladder; restore puts it back (docs/the-ear.md § The operator's actions). `changed:
 * false` is an idempotent no-op (already in that state, or a finding trackId).
 */
export async function setTrackDismissedCommand(
  trackId: string,
  dismissed: boolean,
): Promise<{ changed: boolean }> {
  return adminApiPut<{ changed: boolean; ok: true }>("/api/v1/admin/catalogue/dismissed", {
    dismissed,
    trackId,
  });
}

// ── Capture verification (`list_unverified_captures` / `verify_capture`) ─────
//
// The historic backfill's two halves (docs/the-ear.md § Wrong audio). The box's
// `fluncle-verify-captures` sweep does the FINGERPRINTING (fpcalc against the official preview,
// off the private R2 bytes) and reports plain verdicts; the Worker owns the ROUTING (stamp /
// quarantine / attention item). The CLI is the same thin pacer shape as `rank`/`crawl`.

/** One captured row still awaiting fingerprint verification (the backfill worklist). */
export type CaptureVerifyItem = {
  artists: string[];
  certified: boolean;
  isrc: null | string;
  logId: null | string;
  sourceAudioKey: string;
  title: string;
  trackId: string;
};

/**
 * The verification backfill's worklist. `fluncle admin catalogue verify --queue [--limit <n>]`.
 * Captured rows (findings + catalogue) whose bytes were never checked against their preview;
 * a verified row leaves the set, so the read is resumable by construction.
 */
export async function listUnverifiedCapturesCommand(options: {
  limit?: string;
}): Promise<{ tracks: CaptureVerifyItem[] }> {
  const params = new URLSearchParams();

  if (options.limit) {
    params.set("limit", options.limit);
  }

  return adminApiGet<{ ok: true; tracks: CaptureVerifyItem[] }>(
    `/api/v1/admin/catalogue/captures/unverified?${params.toString()}`,
  );
}

/**
 * Record one capture's fingerprint verdict and let the server ROUTE it. `fluncle admin catalogue
 * verify <trackId> --verdict match|mismatch|no-preview`. A `match` stamps `preview-match`;
 * `no-preview` stamps `unverified`; a `mismatch` quarantines a catalogue row or raises the
 * operator attention item on a finding (never an auto-rewind). Returns the action taken.
 */
export async function verifyCaptureCommand(
  trackId: string,
  verdict: "match" | "mismatch" | "no-preview",
): Promise<{ action: string }> {
  return adminApiPost<{ action: string; ok: true }>("/api/v1/admin/catalogue/captures/verify", {
    trackId,
    verdict,
  });
}

// ── The crawler (`crawl_catalogue` / `get_crawl_status`) ─────────────────────
//
// The Worker holds the vendor budget, does the MusicBrainz walk, and owns the durable
// frontier. The CLI just PACES it — one bounded pass per invocation — which is what lets
// the on-box `fluncle-crawl` sweep drive the whole crawl with an agent token and no keys.

/** One bounded crawl pass's real numbers (the `crawl_catalogue` envelope). */
export type CrawlPassResult = {
  dryRun: boolean;
  expanded: number;
  failed: number;
  frontierPending: number;
  labelsDiscovered: string[];
  maxHop: number;
  nodesEnqueued: number;
  ok: boolean;
  // True when MusicBrainz actively throttled us and the pass stopped on its circuit
  // breaker. The driver must NOT loop: the next tick resumes from durable state.
  rateLimited: boolean;
  seeded: number;
  // Stale enabled seed labels re-armed this pass — an enabled label is a subscription, so its
  // later releases surface. Bounded per pass so a mass re-arm spreads over ticks.
  seedsRearmed: number;
  tracksFound: number;
  tracksSkipped: number;
  tracksWritten: number;
};

/** The frontier at rest (the `get_crawl_status` envelope). */
export type CrawlStatusResult = {
  // The ISRC-bearing gauge of the un-anchored catalogue (the wider anchor worklist the box's Apify
  // sweep drains — every un-anchored catalogue row — is not counted here; see docs/catalogue-crawler.md).
  anchorsPending: number;
  catalogueTracks: number;
  frontier: { done: number; failed: number; pending: number; skipped: number };
  frontierByKind: { artist: number; label: number; release: number };
  labelsUndecided: number;
  ok: boolean;
  seedLabels: string[];
};

/**
 * Run ONE bounded crawl pass: seed from the operator's enabled labels, expand `limit`
 * frontier nodes breadth-first, write the catalogue rows found, stop. Resumable — the
 * next call continues the walk from where this one left it.
 */
export async function crawlCatalogueCommand(
  limit: number,
  maxHop: number,
  dryRun: boolean,
): Promise<CrawlPassResult> {
  const params = new URLSearchParams({ limit: String(limit), maxHop: String(maxHop) });

  if (dryRun) {
    params.set("dryRun", "true");
  }

  return adminApiPost<CrawlPassResult>(`/api/v1/admin/catalogue/crawl?${params.toString()}`);
}

/** Read the crawl frontier's state, the catalogue's size, and the seed set. */
export async function crawlStatusCommand(): Promise<CrawlStatusResult> {
  return adminApiGet<CrawlStatusResult>("/api/v1/admin/catalogue/crawl");
}
