import { adminApiGet, adminApiPost } from "../api";
import { mapTrack, type RecentTrack, type TracksResponse } from "./recent";

// Mirrors the /api/admin/tracks page cap. The order + hasVideo + hasContext +
// hasObservation + status filters are applied in SQL by listTracks; the CLI just
// pages through the matching rows.
const pageSize = 48;

async function fetchAdminTracks(options: {
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

    if (hasContext !== undefined) {
      params.set("hasContext", String(hasContext));
    }

    // `retryEmptyContext` widens the `hasContext=false` context queue to also
    // re-pick CONFIRMED-EMPTY finds (`context_status = 'empty'`). Honoured
    // server-side only alongside `hasContext=false`; emit it only when set so the
    // routine queue read stays byte-identical to before.
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

// A filterable admin listing of findings. Currently the missing-musical-key
// backlog the Rekordbox key-backfill targets: `hasKey=false` lists findings whose
// stored `key` is null, `hasKey=true` those that already carry one, absent = all.
// This is what makes the backlog COUNTABLE + TARGETABLE — the backfill script reads
// `list --no-key --json` as its input query.
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

// The render queue: findings with no video yet, oldest first. The first row is
// the next finding to film (oldest-first is how the backlog is worked down).
//
// HARD-GATED on `hasContext=true`: the queue only ever surfaces findings that
// already carry a stored `context_note`. The video render reads that note (the
// `Texture:` line) as creative fuel via `tracks context <id>`, and that read —
// on a note-less finding — would TRIGGER a Firecrawl+distil (a read that writes).
// Filming only context'd findings makes the render's context read a guaranteed
// cached no-op, the same safety the observation queues already have. A finding's
// video therefore waits until it's context-noted — fine: the context cron runs
// every ~5 min, and a render with the Texture fuel is the one worth filming.
//
// `hasContext=true` is hard-set here (not overridable). The optional `hasObservation`
// filter still narrows it (so a cron can ask "what's context'd but still needs a voice?").
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

// The ENRICHMENT queue (distinct from the VIDEO queue above): findings needing
// (re-)enrichment — pending ∪ failed ∪ stale processing — oldest first. The
// sweep re-fires these; this read just surfaces what's stuck.
export async function enrichQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ max: limit, order: "asc", status: "queue" });
}

// The EMBED queue: findings with no MuQ audio embedding yet (`hasEmbedding=false`),
// oldest first — the on-box `fluncle-embed` cron's worklist (each row is a finding to
// embed on the box, then write back via `tracks update <id> --embedding-file`). See
// docs/audio-embedding-rfc.md.
export async function embedQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasEmbedding: false, max: limit, order: "asc" });
}

// The CONTEXT queue: findings whose factual field notes haven't been gathered yet
// (`hasContext=false`), oldest first — the `context` cron's worklist (each row is a
// `tracks context <id>` to run).
//
// `retryEmptyContext` (the CLI's `--retry-empty`) WIDENS the queue to also re-pick
// finds the prior pass confirmed empty (`context_status = 'empty'`) — the
// widen-the-net occasional pass, off by default so the every-tick routine sweep
// never re-burns Firecrawl + the distil LLM on a hopeless find. The server honours
// it only because this queue is `hasContext=false`.
export async function contextQueueCommand(
  limit: number,
  retryEmptyContext = false,
): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasContext: false, max: limit, order: "asc", retryEmptyContext });
}

// The OBSERVATION queue: findings with field notes on file but no spoken
// observation yet (`hasContext=true AND hasObservation=false`), oldest first — the
// `observe` cron's worklist (each row is a `tracks observe <id>` to run).
export async function observeQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({
    hasContext: true,
    hasObservation: false,
    max: limit,
    order: "asc",
  });
}

// The AUTO-NOTE queue: findings with the context_note fuel on file but no editorial
// note yet (`hasContext=true AND hasNote=false`), oldest first — the `note` cron's
// worklist (each row is a `tracks note <id> --script-file <path>` to author + post).
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
  // The feed cursor to resume from on the next pass, or null when the archive is
  // drained. The endpoint handles only a bounded pass per request (each love runs
  // under a rate limiter), so the CLI loops this until null.
  nextCursor: string | null;
  ok: boolean;
  // True when the pass STOPPED on the Last.fm rate-limit circuit breaker: the CLI
  // must stop looping the cursor (the next tick resumes with a fresh window) rather
  // than re-firing into the same wall until the cron's 120s timeout kills it.
  rateLimited: boolean;
  // Findings the per-finding reliability gate held back this pass (already loved,
  // or cooling down after a recent attempt/failure). They didn't burn the batch.
  skipped: string[];
  skippedCount: number;
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
  // True when the pass STOPPED on the Discogs rate-limit circuit breaker: the CLI
  // must stop looping the cursor (the next tick resumes with a fresh window) rather
  // than re-firing into the same 429 wall until the cron's 120s timeout kills it.
  rateLimited: boolean;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;
  // Findings the per-finding reliability gate held back this pass (already
  // resolved, or cooling down after a recent attempt/failure). Didn't burn budget.
  skipped: string[];
  skippedCount: number;
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
  grain?: string;
  register?: string;
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
    grain: track.videoGrain,
    logId: track.logId,
    register: track.videoRegister,
    title: track.title,
    vehicle: track.videoVehicle,
  }));
}
