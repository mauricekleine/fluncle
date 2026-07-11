// The `fluncle admin catalogue` commands — THE EAR's thin HTTP client (docs/the-ear.md).
//
// A CATALOGUE TRACK is a track the archive knows and Fluncle never certified. Two verbs, both
// admin tier (agent-allowed), both a thin wrapper over the oRPC ops — the CLI holds no ranking
// logic, because all of the arithmetic happens in SQL inside the Worker:
//
//   - `rank`  — one tick of the precompute sweep (`rank_catalogue`). This is the command the
//     periodic `--no-agent` cron drives with the box's agent token: it prints one JSON summary
//     line, and `remaining > 0` means run it again.
//   - `list`  — the ranked catalogue (`list_catalogue_tracks`), through one of the two lenses.

import { type CatalogueResponse, type CatalogueTrackItem } from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";

export type { CatalogueTrackItem };

/** The sweep's per-tick summary — the JSON line a cron reads. */
export type RankCatalogueSummary = {
  corpus: string;
  embeddedFindings: number;
  findings: number;
  prioritized: number;
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
 * The ranked catalogue. `fluncle admin catalogue list [--lens ear|capture] [--limit <n>]`.
 *
 * `ear` (the default) is "closest to your findings, not yet logged"; `capture` is "whose audio
 * should we buy next" — the rows with no vector at all, which the ear structurally cannot rank.
 */
export async function catalogueListCommand(options: {
  lens?: string;
  limit?: string;
}): Promise<CatalogueResponse> {
  const params = new URLSearchParams();

  params.set("lens", options.lens === "capture" ? "capture" : "ear");

  if (options.limit) {
    params.set("limit", options.limit);
  }

  return adminApiGet<CatalogueResponse>(`/api/admin/catalogue?${params.toString()}`);
}
