import { type TrackWorkItem, type TrackWorkScope } from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";
import { mapTrack, type RecentTrack, type TracksResponse } from "./recent";
import { trackUpdateCommand } from "./track";

const pageSize = 48;

async function fetchAdminTracks(options: {
  captureQueue?: boolean;
  hasContext?: boolean;
  hasEmbedding?: boolean;
  hasKey?: boolean;
  hasNote?: boolean;
  hasObservation?: boolean;
  hasVideo?: boolean;
  max: number;
  order: "asc" | "desc";
  retryEmptyContext?: boolean;
  status?: string;
}): Promise<RecentTrack[]> {
  const {
    captureQueue,
    hasContext,
    hasEmbedding,
    hasKey,
    hasNote,
    hasObservation,
    hasVideo,
    max,
    order,
    retryEmptyContext,
    status,
  } = options;
  const results: RecentTrack[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(pageSize), order });

    if (hasVideo !== undefined) {
      params.set("hasVideo", String(hasVideo));
    }

    if (hasKey !== undefined) {
      params.set("hasKey", String(hasKey));
    }

    if (hasEmbedding !== undefined) {
      params.set("hasEmbedding", String(hasEmbedding));
    }

    if (captureQueue) {
      params.set("captureQueue", "true");
    }

    if (hasContext !== undefined) {
      params.set("hasContext", String(hasContext));
    }

    if (retryEmptyContext) {
      params.set("retryEmptyContext", "true");
    }

    if (hasNote !== undefined) {
      params.set("hasNote", String(hasNote));
    }

    if (hasObservation !== undefined) {
      params.set("hasObservation", String(hasObservation));
    }

    if (status !== undefined) {
      params.set("status", status);
    }

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await adminApiGet<TracksResponse>(`/api/v1/admin/tracks?${params.toString()}`);

    for (const apiTrack of response.tracks) {
      const track = mapTrack(apiTrack);

      if (track.type === "mixtape") {
        continue;
      }

      results.push(track);

      if (results.length >= max) {
        return results;
      }
    }

    cursor = response.nextCursor;
  } while (cursor);

  return results;
}

export async function listCommand(options: {
  hasKey?: boolean;
  limit: number;
  order: "asc" | "desc";
}): Promise<RecentTrack[]> {
  return fetchAdminTracks({
    hasKey: options.hasKey,
    max: options.limit,
    order: options.order,
  });
}

export type QueueFilters = {
  hasObservation?: boolean;
};

export async function queueCommand(
  limit: number,
  filters: QueueFilters = {},
): Promise<RecentTrack[]> {
  return fetchAdminTracks({
    hasContext: true,
    hasObservation: filters.hasObservation,
    hasVideo: false,
    max: limit,
    order: "asc",
  });
}

export async function enrichQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ max: limit, order: "asc", status: "queue" });
}

export async function embedQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasEmbedding: false, max: limit, order: "asc" });
}

export async function captureQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ captureQueue: true, max: limit, order: "desc" });
}

export type TrackWorkKind = "analyze" | "capture" | "embed";
export type TrackWorkPage = {
  debtPending?: boolean;

  queued?: number;

  tracks: TrackWorkItem[];
};

export async function trackWorkCommand(options: {
  count?: boolean;
  kind: TrackWorkKind;
  limit: number;
  scope: TrackWorkScope;
}): Promise<TrackWorkPage> {
  const params = new URLSearchParams({
    kind: options.kind,
    limit: String(Math.min(Math.max(1, options.limit), 200)),
    scope: options.scope,
  });

  if (options.count) {
    params.set("count", "true");
    params.set("debtAware", "true");
  }

  const response = await adminApiGet<TrackWorkPage>(
    `/api/v1/admin/tracks/work?${params.toString()}`,
  );

  return {
    debtPending: response.debtPending,
    queued: response.queued,
    tracks: response.tracks ?? [],
  };
}

export type RequeueAnalysisRow = {
  analyzedFrom?: string;
  bpm?: number;
  hasSourceAudio: boolean;
  key?: string;
  logId?: string;
  title: string;
  trackId: string;
};

export type RequeueAnalysisResult = {
  applied: boolean;

  failed: Array<{ error: string; trackId: string }>;

  requeued: string[];

  scanned: number;

  withSourceAudio: RequeueAnalysisRow[];

  withoutSourceAudio: RequeueAnalysisRow[];
};

export async function requeueAnalysisCommand(options: {
  apply: boolean;
  max: number;
}): Promise<RequeueAnalysisResult> {
  const findings = await fetchAdminTracks({ max: options.max, order: "asc" });

  const stale = findings.filter((track) => track.analyzedFrom !== "full");

  const rows: RequeueAnalysisRow[] = stale.map((track) => ({
    analyzedFrom: track.analyzedFrom,
    bpm: track.bpm,
    hasSourceAudio: Boolean(track.sourceAudioKey),
    key: track.key,
    logId: track.logId,
    title: track.title,
    trackId: track.trackId,
  }));

  const withSourceAudio = rows.filter((row) => row.hasSourceAudio);
  const withoutSourceAudio = rows.filter((row) => !row.hasSourceAudio);

  const requeued: string[] = [];
  const failed: Array<{ error: string; trackId: string }> = [];

  if (options.apply) {
    for (const row of rows) {
      try {
        await trackUpdateCommand(row.trackId, { status: "pending" });
        requeued.push(row.trackId);
      } catch (error) {
        failed.push({
          error: error instanceof Error ? error.message : String(error),
          trackId: row.trackId,
        });
      }
    }
  }

  return {
    applied: options.apply,
    failed,
    requeued,
    scanned: findings.length,
    withSourceAudio,
    withoutSourceAudio,
  };
}

export async function contextQueueCommand(
  limit: number,
  retryEmptyContext = false,
): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasContext: false, max: limit, order: "asc", retryEmptyContext });
}

export async function observeQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({
    hasContext: true,
    hasObservation: false,
    max: limit,
    order: "asc",
  });
}

export async function noteQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({
    hasContext: true,
    hasNote: false,
    max: limit,
    order: "asc",
  });
}

export type LastfmBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  loved: string[];
  lovedCount: number;

  nextCursor: string | null;
  ok: boolean;

  rateLimited: boolean;

  skipped: string[];
  skippedCount: number;
};

export async function backfillLastfmCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LastfmBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<LastfmBackfillResult>(`/api/v1/admin/backfill/lastfm?${params.toString()}`);
}

export type DiscogsBackfillResult = {
  dryRun: boolean;

  nextCursor: string | null;
  ok: boolean;

  rateLimited: boolean;

  rateLimitedBy: "discogs" | "musicbrainz" | null;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;

  skipped: string[];
  skippedCount: number;
  unresolved: string[];
  unresolvedCount: number;
};

export async function backfillDiscogsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<DiscogsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<DiscogsBackfillResult>(`/api/v1/admin/backfill/discogs?${params.toString()}`);
}

export type AppleMusicBackfillResult = {
  albumFactsWritten: number;

  breakerTripped: boolean;

  configured: boolean;
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;

  nextCursor: string | null;
  ok: boolean;

  rateLimited: boolean;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;

  skipped: string[];
  skippedCount: number;

  unresolved: string[];
  unresolvedCount: number;
};

export async function backfillAppleMusicCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<AppleMusicBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<AppleMusicBackfillResult>(
    `/api/v1/admin/backfill/apple-music?${params.toString()}`,
  );
}

export type DiscogsFactsBackfillResult = {
  configured: boolean;
  dryRun: boolean;

  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  none: string[];
  noneCount: number;

  rateLimited: boolean;
  resolved: Array<{ catno: string; slug: string }>;
  resolvedCount: number;
};

export async function backfillDiscogsFactsCommand(
  limit: number,
  dryRun: boolean,
): Promise<DiscogsFactsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  return adminApiPost<DiscogsFactsBackfillResult>(
    `/api/v1/admin/backfill/discogs-facts?${params.toString()}`,
  );
}

export type BeatportBackfillResult = {
  catalogueFailed: Array<{ error: string; trackId: string }>;
  catalogueFailedCount: number;
  catalogueResolved: Array<{ trackId: string; url: string }>;
  catalogueResolvedCount: number;
  catalogueUnresolved: string[];
  catalogueUnresolvedCount: number;
  configured: boolean;
  dryRun: boolean;

  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  nextCursor: null | string;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;
  skipped: string[];
  skippedCount: number;

  unresolved: string[];
  unresolvedCount: number;
};

export type DeezerBackfillResult = {
  dryRun: boolean;

  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;

  rateLimited: boolean;
  resolved: Array<{ trackId: string; url: string }>;
  resolvedCount: number;

  unresolved: string[];
  unresolvedCount: number;

  unvouchable: string[];
  unvouchableCount: number;
};

export async function backfillDeezerCommand(
  limit: number,
  dryRun: boolean,
): Promise<DeezerBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  return adminApiPost<DeezerBackfillResult>(`/api/v1/admin/backfill/deezer?${params.toString()}`);
}

export async function backfillBeatportCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<BeatportBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<BeatportBackfillResult>(
    `/api/v1/admin/backfill/beatport?${params.toString()}`,
  );
}

export type AppleCatalogueBackfillResult = {
  albumFactsWritten: number;

  breakerTripped: boolean;
  configured: boolean;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;

  rateLimited: boolean;
  resolved: Array<{ trackId: string; url: string }>;
  resolvedCount: number;

  unresolved: string[];
  unresolvedCount: number;
};

export async function backfillAppleCatalogueCommand(
  limit: number,
  dryRun: boolean,
): Promise<AppleCatalogueBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  return adminApiPost<AppleCatalogueBackfillResult>(
    `/api/v1/admin/backfill/apple-catalogue?${params.toString()}`,
  );
}

export type RecordingMbidsBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;

  isrcRefreshMissed: string[];
  isrcRefreshMissedCount: number;

  isrcRefreshed: string[];
  isrcRefreshedCount: number;

  missed: string[];
  missedCount: number;

  nextCursor: string | null;
  ok: boolean;

  prefixStripped: number;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;
};

export async function backfillRecordingMbidsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
  isrcRefreshLimit?: number,
): Promise<RecordingMbidsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  if (isrcRefreshLimit !== undefined) {
    params.set("isrcRefreshLimit", String(isrcRefreshLimit));
  }

  return adminApiPost<RecordingMbidsBackfillResult>(
    `/api/v1/admin/backfill/recording-mbids?${params.toString()}`,
  );
}

export type ArtistEdgesBackfillResult = {
  dryRun: boolean;

  edgesWritten: number;

  fullyMatched: string[];
  fullyMatchedCount: number;

  nextCursor: string | null;
  ok: boolean;

  partiallyMatched: string[];
  partiallyMatchedCount: number;

  queueDepth: number;

  scanned: number;

  unmatchedNames: number;

  zeroMatched: string[];
  zeroMatchedCount: number;
};

export async function backfillArtistEdgesCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistEdgesBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistEdgesBackfillResult>(
    `/api/v1/admin/backfill/artist-edges?${params.toString()}`,
  );
}

export type ArtistCreditsBackfillResult = {
  adoptedArtists: number;
  dryRun: boolean;

  edgesWritten: number;

  matchedArtists: number;

  mintedArtists: number;

  nextCursor: string | null;
  ok: boolean;

  rateLimited: boolean;

  scanned: number;

  skippedNoIdentity: number;
};

export async function backfillArtistCreditsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistCreditsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<ArtistCreditsBackfillResult>(
    `/api/v1/admin/backfill/artist-credits?${params.toString()}`,
  );
}

export type VehicleEntry = {
  addedAt: string;
  artists: string[];
  logId?: string;
  grain?: string;
  register?: string;

  palette?: string;
  title: string;
  vehicle?: string;
};

export async function vehiclesCommand(limit: number): Promise<VehicleEntry[]> {
  const tracks = await fetchAdminTracks({ hasVideo: true, max: limit, order: "desc" });

  return tracks.map((track) => ({
    addedAt: track.addedAt,
    artists: track.artists,
    grain: track.videoGrain,
    logId: track.logId,
    palette: track.videoPalette,
    register: track.videoRegister,
    title: track.title,
    vehicle: track.videoVehicle,
  }));
}

export type MixOrderStop = {
  artists: string[];
  bpm?: number;
  flagged: boolean;
  key?: string;
  logId: string;
  title: string;
  transitionReason?: { kind: "key" | "bpm" | "sonic"; relationship: string };
  transitionScore?: number;
};

export type MixableOrderResult = {
  algorithm: "held-karp" | "greedy-2opt";
  ok: true;
  order: MixOrderStop[];
  totalCost: number;
};

export async function mixableOrderCommand(
  logIds: string[],
  seed?: string,
): Promise<MixableOrderResult> {
  const params = new URLSearchParams({ ids: logIds.join(",") });

  if (seed) {
    params.set("seed", seed);
  }

  return adminApiGet<MixableOrderResult>(`/api/v1/admin/tracks/mixable-order?${params.toString()}`);
}

export async function prepareTrackCapturesCommand<T>(body: unknown): Promise<T> {
  return adminApiPost<T>("/api/v1/admin/tracks/captures/prepare", body);
}

export async function commitTrackCapturesCommand<T>(body: unknown): Promise<T> {
  return adminApiPost<T>("/api/v1/admin/tracks/captures/commit", body);
}

export async function updateTrackEmbeddingsCommand<T>(body: unknown): Promise<T> {
  return adminApiPost<T>("/api/v1/admin/tracks/embeddings", body);
}
