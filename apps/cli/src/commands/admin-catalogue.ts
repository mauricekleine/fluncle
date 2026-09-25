import { type CatalogueResponse, type CatalogueTrackItem } from "@fluncle/contracts";
import { adminApiGet, adminApiPost, adminApiPut } from "../api";

export type { CatalogueTrackItem };

export type RankCatalogueSummary = {
  catalogueDuplicates: number;
  corpus: string;
  embeddedFindings: number;
  findings: number;
  prioritized: number;

  quarantined: number;
  remaining: number;
  scored: number;
};

export async function catalogueRankCommand(options: {
  countRemaining?: boolean;
  limit?: string;
}): Promise<{
  summary: RankCatalogueSummary;
  telescope?: TelescopeSyncOutcome;
}> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

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

export async function catalogueDemandCommand(): Promise<RecordDemandSummary> {
  const response = await adminApiPost<{ ok: true; summary: RecordDemandSummary }>(
    "/api/v1/admin/catalogue/demand",
    {},
  );

  return response.summary;
}

export type TelescopeSyncOutcome =
  | { changed: boolean; ok: true; size: number }
  | { ok: false; reason: string };

const CATALOGUE_LENSES = new Set(["capture", "dismissed", "failed", "quarantine", "unmatched"]);

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

export async function clearWrongAudioCommand(trackId: string): Promise<{ cleared: boolean }> {
  return adminApiPost<{ cleared: boolean; ok: true }>("/api/v1/admin/catalogue/wrong-audio/clear", {
    trackId,
  });
}

export async function requeueUnmatchedCommand(): Promise<{
  requeued: number;
  skippedVetoed: number;
}> {
  return adminApiPost<{ ok: true; requeued: number; skippedVetoed: number }>(
    "/api/v1/admin/catalogue/captures/requeue-unmatched",
    {},
  );
}

export async function requeueAnchorCommand(trackIds: string[]): Promise<{ requeued: number }> {
  return adminApiPost<{ ok: true; requeued: number }>("/api/v1/admin/catalogue/anchor/requeue", {
    trackIds,
  });
}

export async function requeueIsrcRecoveryCommand(input: {
  dryRun: boolean;
  since: string;
}): Promise<{ dryRun: boolean; matched: number; requeued: number }> {
  return adminApiPost<{ dryRun: boolean; matched: number; ok: true; requeued: number }>(
    "/api/v1/admin/catalogue/isrc-recovery/requeue",
    input,
  );
}

export type AnchorApifyBudgetState = {
  day: string;
  dailyRows: number;
  remainingRows: number;
  rowsSent: number;
  spent: boolean;
};

export type AnchorBreakerState = {
  cooldownRemainingMs: number;
  reason: null | string;
  rungs: {
    apifyBudget: AnchorApifyBudgetState;
    apifyEnabled: boolean;
    spotifySearchEnabled: boolean;
  };
  throttlesInWindow: number;
  tripped: boolean;
  trippedAt: null | string;
};

export async function anchorApifyBudgetCommand(): Promise<AnchorApifyBudgetState> {
  return adminApiGet<AnchorApifyBudgetState & { ok: true }>(
    "/api/v1/admin/catalogue/anchor/apify-budget",
  );
}

export async function setAnchorApifyBudgetCommand(
  dailyRows: number,
): Promise<AnchorApifyBudgetState> {
  return adminApiPut<AnchorApifyBudgetState & { ok: true }>(
    "/api/v1/admin/catalogue/anchor/apify-budget",
    { dailyRows },
  );
}

export async function anchorBreakerCommand(): Promise<AnchorBreakerState> {
  return adminApiGet<AnchorBreakerState & { ok: true }>("/api/v1/admin/catalogue/anchor/breaker");
}

export async function forceCaptureCommand(trackId: string): Promise<{ forced: boolean }> {
  return adminApiPost<{ forced: boolean; ok: true }>("/api/v1/admin/catalogue/force-capture", {
    trackId,
  });
}

export async function flagWrongAudioCommand(trackId: string): Promise<{ flagged: boolean }> {
  return adminApiPost<{ flagged: boolean; ok: true }>("/api/v1/admin/catalogue/wrong-audio/flag", {
    trackId,
  });
}

export async function certifyTrackCommand(
  trackId: string,
  note?: string,
): Promise<{ logId: string }> {
  return adminApiPost<{ logId: string; ok: true }>("/api/v1/admin/catalogue/certify", {
    ...(note ? { note } : {}),
    trackId,
  });
}

export async function setTrackDismissedCommand(
  trackId: string,
  dismissed: boolean,
): Promise<{ changed: boolean }> {
  return adminApiPut<{ changed: boolean; ok: true }>("/api/v1/admin/catalogue/dismissed", {
    dismissed,
    trackId,
  });
}

export type CaptureVerifyItem = {
  artists: string[];
  certified: boolean;
  isrc: null | string;
  logId: null | string;
  sourceAudioKey: string;
  title: string;
  trackId: string;
};

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

export async function verifyCaptureCommand(
  trackId: string,
  verdict: "match" | "mismatch" | "no-preview",
): Promise<{ action: string }> {
  return adminApiPost<{ action: string; ok: true }>("/api/v1/admin/catalogue/captures/verify", {
    trackId,
    verdict,
  });
}

export type CrawlPassResult = {
  dryRun: boolean;
  expanded: number;
  failed: number;
  frontierPending: number;
  labelsDiscovered: string[];
  maxHop: number;
  nodesEnqueued: number;
  ok: boolean;

  rateLimited: boolean;

  releasesRearmed: number;
  seeded: number;

  seedsRearmed: number;
  tracksFound: number;
  tracksSkipped: number;
  tracksWritten: number;
};

export type CrawlStatusResult = {
  anchorsPending: number;
  catalogueTracks: number;
  frontier: { done: number; failed: number; pending: number; skipped: number };
  frontierByKind: { artist: number; label: number; release: number };
  labelsUndecided: number;
  ok: boolean;
  seedLabels: string[];

  storablePending: number;

  undecidedLabelsQueued: number;

  unstorablePending: number;
};

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

export async function crawlCataloguePhaseCommand<T>(body: unknown): Promise<T> {
  return adminApiPost<T>("/api/v1/admin/catalogue/crawl", body);
}

export async function commitCrawlNodesCommand<T>(body: unknown): Promise<T> {
  return adminApiPost<T>("/api/v1/admin/catalogue/crawl/commits", body);
}

export async function crawlStatusCommand(): Promise<CrawlStatusResult> {
  return adminApiGet<CrawlStatusResult>("/api/v1/admin/catalogue/crawl");
}
