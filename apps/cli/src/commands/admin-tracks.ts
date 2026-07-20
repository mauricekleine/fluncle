import { type TrackWorkItem } from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";
import { mapTrack, type RecentTrack, type TracksResponse } from "./recent";
import { trackUpdateCommand } from "./track";

// Mirrors the /api/admin/tracks page cap. The order + hasVideo + hasContext +
// hasObservation + status filters are applied in SQL by listTracks; the CLI just
// pages through the matching rows.
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

    // `captureQueue` is a boolean-ish flag (emit only when set, like
    // `retryEmptyContext`): true = the full-song capture worklist (`capture_status`
    // pending ∪ failed ∪ NULL). Server honours it as a SEPARATE queue.
    if (captureQueue) {
      params.set("captureQueue", "true");
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
// backlog the Rekordbox sync targets: `hasKey=false` lists findings whose
// stored `key` is null, `hasKey=true` those that already carry one, absent = all.
// This is what makes the backlog COUNTABLE + TARGETABLE — the sync script reads
// `list --all --json` as its input query.
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
// docs/track-lifecycle.md.
export async function embedQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ hasEmbedding: false, max: limit, order: "asc" });
}

// The CAPTURE queue: findings still needing a full-song capture (`capture_status`
// pending ∪ failed ∪ NULL) — the on-box `fluncle-capture` cron's worklist. NEWEST
// FIRST (`order: "desc"`), unlike enrich/embed: a fresh add must jump ahead of the
// whole-archive backfill instead of waiting behind it (RFC full-audio § Unit 1 / 5a).
// The cron itself reads the queue via direct HTTP (pin-independent); this CLI view is
// the operator/inspection surface. See docs/agents/hermes/scripts/capture-sweep.*.
export async function captureQueueCommand(limit: number): Promise<RecentTrack[]> {
  return fetchAdminTracks({ captureQueue: true, max: limit, order: "desc" });
}

// ── The CATALOGUE-AWARE pipeline worklist (`list_track_work`) ────────────────────────
//
// The three queues above all read `list_tracks_admin`, which drives through the FINDING
// JOIN — so every one of them is blind to a CATALOGUE track (a `tracks` row with no
// `findings` row). That is right for a feed and wrong for a pipeline: BPM, key, features
// and the MuQ vector are measurements of a RECORDING, so they apply to any track with
// captured audio, certified or not (docs/gpu-batch-embed.md).
//
// `list_track_work` is the queue that sees both halves, and it hands them back in the
// order the METERED capture budget should be spent: certified first, then the Ear's
// pre-audio `capture_priority` ladder, then newest-first. A ruled-out label is vetoed out
// of the `capture` worklist entirely. The three sweeps read it; this is the CLI mirror
// (the CLI holds no queue logic of its own).
export type TrackWorkKind = "analyze" | "capture" | "embed";
export type TrackWorkScope = "all" | "catalogue" | "findings";

export type TrackWorkPage = {
  /** The WHOLE backlog for this kind+scope — only when `--count` was asked for. */
  queued?: number;
  /** The page, capped at 200 by the server. Never "how much is left". */
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

  // `--count` asks for the backlog SIZE alongside the page. Opt-in: a page read is capped at
  // 200 rows, so counting rows in the page answers "how many did I get", never "how much is
  // left" — and at catalogue scale those differ by orders of magnitude. Emitted only when set,
  // so the box sweeps' queue reads stay byte-identical (and never pay for the count).
  if (options.count) {
    params.set("count", "true");
  }

  const response = await adminApiGet<TrackWorkPage>(`/api/admin/tracks/work?${params.toString()}`);

  return { queued: response.queued, tracks: response.tracks ?? [] };
}

// One stale finding in the analysis-provenance requeue (RFC bpm-key-accuracy): its
// coordinate, its stored BPM/key, the audio class it was last analyzed from, and whether a
// captured full song is on file (so a re-derive would upgrade from full audio, not a preview).
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
  // Whether statuses were actually flipped (`--apply`) or this was a dry-run preview.
  applied: boolean;
  // Findings whose flip to `enrichment_status = pending` failed (only populated with --apply).
  failed: Array<{ error: string; trackId: string }>;
  // trackIds actually re-queued (empty on a dry-run).
  requeued: string[];
  // The archive walk cap that bounded this pass (so the caller can warn if it was hit).
  scanned: number;
  // Stale findings WITH a captured full song — a re-enrich re-derives from full audio (a
  // strict upgrade over the preview-grade value).
  withSourceAudio: RequeueAnalysisRow[];
  // Stale findings WITHOUT a captured full song — a re-enrich re-derives from the 30s preview
  // (still an upgrade with the fixed estimator, but called out; capture may land later and
  // re-queue them again for the full-audio pass).
  withoutSourceAudio: RequeueAnalysisRow[];
};

// The archive-wide analysis-provenance repair (RFC bpm-key-accuracy): find every finding
// whose BPM/key are preview-grade (`analyzedFrom != "full"` — NULL legacy rows included) and
// re-queue it (`enrichment_status = pending`) so the on-box `fluncle-enrich` sweep re-derives
// it deterministically. PURE CLI orchestration over the existing admin ops — it walks the
// `admin tracks list` cursor chain (which surfaces `analyzedFrom`/`sourceAudioKey`) and flips
// each stale row via the existing `update_track` op; it adds no new API surface.
//
// DRY-RUN by default (`apply: false`): it only reports the would-be-requeued set. `apply:
// true` flips the statuses. Findings without a captured full song are reported SEPARATELY —
// re-queueing them re-derives from a preview (an upgrade, but not the full-audio pass) — never
// silently skipped.
export async function requeueAnalysisCommand(options: {
  apply: boolean;
  max: number;
}): Promise<RequeueAnalysisResult> {
  const findings = await fetchAdminTracks({ max: options.max, order: "asc" });

  // Stale = not confirmed full-audio: NULL/undefined legacy rows ("assume preview-grade") and
  // explicit "preview" rows. A finding already analyzed from full audio is left alone.
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

export type AppleMusicBackfillResult = {
  // Album-fact rows written once this pass (recordLabel/upc/artwork/palette) off the
  // single-ISRC oracle's canonical album — the second half of the Apple read (RFC U1).
  albumFactsWritten: number;
  // True when the pass STOPPED on the cross-cutting Apple breaker (a suspended token / a spent
  // call budget) rather than a 429.
  breakerTripped: boolean;
  // False when the Worker's MusicKit secrets are unset — the leg is a no-op this tick.
  configured: boolean;
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  // The feed cursor to resume from on the next pass, or null when the archive is
  // drained (or the leg is unconfigured / throttled). The endpoint handles only a
  // bounded pass per request (each resolve runs under a rate limiter), so the CLI
  // loops this until null.
  nextCursor: string | null;
  ok: boolean;
  // True when the pass STOPPED on the Apple Music rate-limit circuit breaker: the CLI
  // must stop looping the cursor (the next tick resumes with a fresh window).
  rateLimited: boolean;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;
  // Findings the per-finding reliability gate held back this pass (already resolved,
  // or cooling down after a recent attempt/failure). Didn't burn budget.
  skipped: string[];
  skippedCount: number;
  // Findings whose ISRC Apple has no song for (a clean no-match, re-checkable later).
  unresolved: string[];
  unresolvedCount: number;
};

// One bounded pass of the Apple Music URL backfill via the admin API — the Worker holds
// the MusicKit secrets, mints the developer token, and resolves each finding EXACTLY by
// ISRC, writing apple_music_url server-side. Rows that already have a URL are skipped
// (idempotent). A safe no-op until the secrets are provisioned. `--dry-run` reports the
// eligible set without resolving. Pass the prior pass's `nextCursor` to resume; the CLI
// loops until it comes back null.
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
    `/api/admin/backfill/apple-music?${params.toString()}`,
  );
}

export type AppleCatalogueBackfillResult = {
  albumFactsWritten: number;
  // True when the pass STOPPED on the cross-cutting Apple breaker (suspended token / spent budget).
  breakerTripped: boolean;
  configured: boolean;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  // True when the pass STOPPED on the Apple 429 rate-limit circuit breaker.
  rateLimited: boolean;
  resolved: Array<{ trackId: string; url: string }>;
  resolvedCount: number;
  // Catalogue ISRCs Apple has no song for (a clean no-match, re-checkable later).
  unresolved: string[];
  unresolvedCount: number;
};

// One bounded pass of the Apple CATALOGUE drain (RFC U1) — the catalogue sibling of
// `backfillAppleMusicCommand`. The Worker batches uncertified rows' ISRCs (≤25/request) into the
// catalog oracle for the URL, and resolves each NEW album's facts once. No cursor: the worklist is
// a fresh reliability-gated anti-join each tick, so the CLI loops until a pass resolves nothing.
export async function backfillAppleCatalogueCommand(
  limit: number,
  dryRun: boolean,
): Promise<AppleCatalogueBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  return adminApiPost<AppleCatalogueBackfillResult>(
    `/api/admin/backfill/apple-catalogue?${params.toString()}`,
  );
}

// The freshness tap (D8) has no CLI helper: its box sweep POSTs the agent-tier
// `backfill_label_releases` op over HTTP directly, avoiding the pinned-CLI version coupling that
// broke an earlier run. See docs/agents/hermes/scripts/label-releases-sweep.ts.

export type RecordingMbidsBackfillResult = {
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  // Track ids whose ISRC MusicBrainz has no recording for — attempt-stamped so they drain.
  missed: string[];
  missedCount: number;
  // The track-id cursor to resume the ISRC drain from, or null when it is drained (or a throttle).
  nextCursor: string | null;
  ok: boolean;
  // Crawler-history rows filled from their PK this pass (the free no-vendor strip).
  prefixStripped: number;
  rateLimited: boolean;
  resolved: string[];
  resolvedCount: number;
};

// One bounded pass of the recording-MBID fill sweep (the MusicBrainz identity layer) via the admin
// API. The Worker fills crawler-born rows from their PK for free, then resolves findings/Spotify-born
// rows' MBID by ISRC through the shared MusicBrainz client (1 req/s, circuit-broken on a throttle).
// `--dry-run` reports both worklists without a vendor call or write. Pass the prior `nextCursor` to
// resume the ISRC drain; the CLI loops until it comes back null.
export async function backfillRecordingMbidsCommand(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<RecordingMbidsBackfillResult> {
  const params = new URLSearchParams({ dryRun: String(dryRun), limit: String(limit) });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return adminApiPost<RecordingMbidsBackfillResult>(
    `/api/admin/backfill/recording-mbids?${params.toString()}`,
  );
}

export type VehicleEntry = {
  addedAt: string;
  artists: string[];
  logId?: string;
  grain?: string;
  register?: string;
  // The coarse palette hue-bucket tag (palette ledger) — the axis assigner reads it to
  // steer the next render off a worn hue. Absent on rows shipped before palette provenance.
  palette?: string;
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
    palette: track.videoPalette,
    register: track.videoRegister,
    title: track.title,
    vehicle: track.videoVehicle,
  }));
}

// `fluncle admin tracks mixable-order <logId...> [--seed <logId>]` — the dream-weaver
// (RFC mixability-engine). Orders a pool of findings into a smooth PROPOSED mix the
// operator copy-pastes into Rekordbox; a pure admin read (it never writes — the mint
// stays `recordings promote`). The Worker runs Held-Karp exact for ≤16, greedy + 2-opt
// to 64. A smoothness-optimized chain, NOT an energy-shaped set — stated honestly.
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

  return adminApiGet<MixableOrderResult>(`/api/admin/tracks/mixable-order?${params.toString()}`);
}
