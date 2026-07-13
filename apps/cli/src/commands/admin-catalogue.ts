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
  limit?: string;
}): Promise<RankCatalogueSummary> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
  const response = await adminApiPost<{ ok: true; summary: RankCatalogueSummary }>(
    "/api/admin/catalogue/rank",
    limit ? { limit } : {},
  );

  return response.summary;
}

/**
 * The ranked catalogue. `fluncle admin catalogue list [--lens ear|capture|quarantine] [--limit <n>]`.
 *
 * `ear` (the default) is "closest to your findings, not yet logged"; `capture` is "whose audio
 * should we buy next" — the rows with no vector at all, which the ear structurally cannot rank;
 * `quarantine` is the wrong-audio holding pen (docs/the-ear.md § Wrong audio).
 */
export async function catalogueListCommand(options: {
  lens?: string;
  limit?: string;
}): Promise<CatalogueResponse> {
  const params = new URLSearchParams();

  params.set(
    "lens",
    options.lens === "capture" ? "capture" : options.lens === "quarantine" ? "quarantine" : "ear",
  );

  if (options.limit) {
    params.set("limit", options.limit);
  }

  return adminApiGet<CatalogueResponse>(`/api/admin/catalogue?${params.toString()}`);
}

/**
 * Overrule the wrong-audio quarantine on one catalogue row (operator). `fluncle admin catalogue
 * clear-wrong-audio <trackId>`. Flips the row from `wrong-audio` to the sticky `quarantine-cleared`
 * state the sweep never re-quarantines, so its kept audio re-embeds and re-ranks (docs/the-ear.md
 * § Wrong audio). `cleared: false` when the row was not actually quarantined.
 */
export async function clearWrongAudioCommand(trackId: string): Promise<{ cleared: boolean }> {
  return adminApiPost<{ cleared: boolean; ok: true }>("/api/admin/catalogue/wrong-audio/clear", {
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
  return adminApiPost<{ flagged: boolean; ok: true }>("/api/admin/catalogue/wrong-audio/flag", {
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
  return adminApiPost<{ logId: string; ok: true }>("/api/admin/catalogue/certify", {
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
  return adminApiPut<{ changed: boolean; ok: true }>("/api/admin/catalogue/dismissed", {
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
    `/api/admin/catalogue/captures/unverified?${params.toString()}`,
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
  return adminApiPost<{ action: string; ok: true }>("/api/admin/catalogue/captures/verify", {
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
  // Spotify anchors filled onto existing catalogue rows — a separate, bounded step from
  // the walk (its queue is derived, so a throttled pass loses nothing).
  anchorsFilled: number;
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
  tracksFound: number;
  tracksSkipped: number;
  tracksWritten: number;
};

/** The frontier at rest (the `get_crawl_status` envelope). */
export type CrawlStatusResult = {
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

  return adminApiPost<CrawlPassResult>(`/api/admin/catalogue/crawl?${params.toString()}`);
}

/** Read the crawl frontier's state, the catalogue's size, and the seed set. */
export async function crawlStatusCommand(): Promise<CrawlStatusResult> {
  return adminApiGet<CrawlStatusResult>("/api/admin/catalogue/crawl");
}
