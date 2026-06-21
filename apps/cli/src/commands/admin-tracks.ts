import { adminApiGet, adminApiPost } from "../api";
import { mapTrack, type RecentTrack, type TracksResponse } from "./recent";

// Mirrors the /api/admin/tracks page cap. The order + hasVideo + status filters
// are applied in SQL by listTracks; the CLI just pages through the matching rows.
const pageSize = 48;

async function fetchAdminTracks(options: {
  hasVideo?: boolean;
  max: number;
  order: "asc" | "desc";
  status?: string;
}): Promise<RecentTrack[]> {
  const { hasVideo, max, order, status } = options;
  const results: RecentTrack[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(pageSize), order });

    if (hasVideo !== undefined) {
      params.set("hasVideo", String(hasVideo));
    }

    if (status !== undefined) {
      params.set("status", status);
    }

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await adminApiGet<TracksResponse>(`/api/admin/tracks?${params.toString()}`);

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

// The render queue: findings with no video yet, oldest first. The first row is
// the next finding to film (oldest-first is how the backlog is worked down).
export async function queueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasVideo: false, max: limit, order: "asc" });
}

// The ENRICHMENT queue (distinct from the VIDEO queue above): findings needing
// (re-)enrichment — pending ∪ failed ∪ stale processing — oldest first. The
// sweep re-fires these; this read just surfaces what's stuck.
export async function enrichQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ max: limit, order: "asc", status: "queue" });
}

export type EnrichSweepEntry = {
  logId: string;
  status: string;
  trackId: string;
};

export type EnrichSweepResult = {
  ok: boolean;
  reEnriched: EnrichSweepEntry[];
  reEnrichedCount: number;
  skipped: EnrichSweepEntry[];
  skippedCount: number;
};

// Trigger the self-healing sweep via the admin API — the Worker queries the
// enrich-queue and re-fires triggerEnrichment for each (idempotent on
// `enrich:${logId}`, so re-running never duplicates an in-flight run). The CLI
// stays a thin client: it holds the admin token, never the Spinup key.
export async function enrichSweepCommand(limit: number): Promise<EnrichSweepResult> {
  return adminApiPost<EnrichSweepResult>(`/api/admin/enrich-sweep?limit=${limit}`);
}

export type LastfmBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  loved: string[];
  lovedCount: number;
  // The feed cursor to resume from on the next pass, or null when the archive is
  // drained. The endpoint handles only a bounded pass per request (each love runs
  // under a rate limiter), so the CLI loops this until null.
  nextCursor: string | null;
  ok: boolean;
};

// One bounded pass of the Last.fm love backfill via the admin API — the Worker
// holds the LASTFM_* secrets and makes every signed call; the CLI stays a thin
// client. Idempotent (loving twice is a no-op) and a safe no-op until the session
// key is provisioned. `--dry-run` reports the set without firing. Pass the prior
// pass's `nextCursor` to resume; the CLI loops until it comes back null.
export async function backfillLastfmCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<LastfmBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<LastfmBackfillResult>(`/api/admin/backfill/lastfm?${params.toString()}`);
}

export type DiscogsBackfillResult = {
  dryRun: boolean;
  // The feed cursor to resume from on the next pass, or null when the archive is
  // drained. The endpoint handles only a bounded pass per request (each resolve
  // runs under a rate limiter), so the CLI loops this until null.
  nextCursor: string | null;
  ok: boolean;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;
  unresolved: string[];
  unresolvedCount: number;
};

// One bounded pass of the Discogs release-id backfill via the admin API — the
// Worker resolves (MB bridge + gated search) and writes in_release_id /
// in_master_id server-side. Rows that already have an id are skipped (idempotent).
// `--dry-run` resolves but writes nothing. Pass the prior pass's `nextCursor` to
// resume; the CLI loops until it comes back null.
export async function backfillDiscogsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<DiscogsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<DiscogsBackfillResult>(`/api/admin/backfill/discogs?${params.toString()}`);
}

export type VehicleEntry = {
  addedAt: string;
  artists: string[];
  logId?: string;
  title: string;
  vehicle?: string;
};

// Recent video vehicles, newest first — the style ledger a video agent reads to
// keep the next render from repeating a recently-used vehicle.
export async function vehiclesCommand(limit: number): Promise<VehicleEntry[]> {
  const tracks = await fetchAdminTracks({ hasVideo: true, max: limit, order: "desc" });

  return tracks.map((track) => ({
    addedAt: track.addedAt,
    artists: track.artists,
    logId: track.logId,
    title: track.title,
    vehicle: track.videoVehicle,
  }));
}
