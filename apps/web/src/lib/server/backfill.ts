import {
  type DiscogsFactsCandidate,
  type DiscogsFactsWork,
  type DiscogsReleaseCandidate,
  type DiscogsReleaseWork,
} from "@fluncle/contracts/orpc";
import {
  type AppleCatalogBundle,
  appleCatalogLookupByIsrc,
  appleCatalogLookupByIsrcs,
} from "./apple-music";
import {
  areAppleCallsAllowed,
  isAppleCallBudgetAvailable,
  recordAppleAuthOutcome,
  recordAppleCall,
} from "./apple-breaker";
import {
  recordAlbumDiscogsFailure,
  storeAlbumDiscogsFacts,
  storeAlbumDiscogsFactsForTrack,
} from "./albums";
import { parseArtistsJson } from "./artists";
import { resolveBeatportUrl } from "./beatport-resolve";
import { getDb, typedRows } from "./db";
import { batchDueWorkSourceMutation } from "./due-work";
import { lookupDeezerTrackByIsrc } from "./deezer";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import {
  type DiscogsEnrichment,
  type DiscogsThrottleVendor,
  discogsResolveRelease,
  fetchDiscogsReleaseFacts,
  prepareDiscogsRelease,
  releaseFacts,
  scoreDiscogsReleaseCandidates,
} from "./discogs";
import { readOptionalEnv } from "./env";
import { lastfmLove } from "./lastfm";
import {
  decodeTrackCursor,
  encodeTrackCursor,
  getTracksByIds,
  listTracks,
  type TrackListItem,
} from "./tracks";

const PAGE_SIZE = 48;

const DISCOGS_DELAY_MS = 1200;

const APPLE_MUSIC_DELAY_MS = 3000;

const MAX_BATCH = 3;

const COOLDOWN_BASE_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

type BackfillPass<T> = T & { nextCursor: string | null; rateLimited: boolean };

export type LastfmBackfillResult = BackfillPass<{
  dryRun: boolean;
  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  loved: string[];
  lovedCount: number;

  skipped: string[];
  skippedCount: number;
}>;

export type DiscogsBackfillResult = BackfillPass<{
  discogsWork: DiscogsReleaseWork[];
  dryRun: boolean;
  rateLimitedBy: DiscogsThrottleVendor | null;
  resolved: Array<{ logId: string; masterId?: number; releaseId: number; source: string }>;
  resolvedCount: number;

  skipped: string[];
  skippedCount: number;
  unresolved: string[];
  unresolvedCount: number;
}>;

export type AppleMusicBackfillResult = BackfillPass<{
  albumFactsWritten: number;

  breakerTripped: boolean;

  configured: boolean;
  dryRun: boolean;

  failed: Array<{ error: string; logId: string }>;
  failedCount: number;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;

  skipped: string[];
  skippedCount: number;

  unresolved: string[];
  unresolvedCount: number;
}>;

export type BackfillSource = "apple_music" | "beatport" | "discogs" | "lastfm" | "note";

type ReliabilityState = {
  attemptedAt: string | null;
  failures: number;
  isDone: boolean;
};

type AttemptOutcome = "done" | "failure" | "tried";

function isPublishedFinding(track: TrackListItem): boolean {
  return track.type === "finding" && track.addedToSpotify && track.postedToTelegram;
}

function columnPrefix(source: BackfillSource): string {
  return `backfill_${source}`;
}

function reliabilityTable(source: BackfillSource): "findings" | "tracks" {
  return source === "apple_music" || source === "beatport" ? "tracks" : "findings";
}

async function readReliability(trackId: string, source: BackfillSource): Promise<ReliabilityState> {
  const db = await getDb();
  const p = columnPrefix(source);

  const result = await db.execute({
    args: [trackId],
    sql: `select ${p}_attempted_at as attempted_at,
        ${p}_failures as failures,
        ${p}_done_at as done_at
      from ${reliabilityTable(source)}
      where track_id = ?
      limit 1`,
  });

  const row = result.rows[0] as
    | { attempted_at: string | null; done_at: string | null; failures: number | null }
    | undefined;

  return {
    attemptedAt: row?.attempted_at ?? null,
    failures: typeof row?.failures === "number" ? row.failures : 0,
    isDone: Boolean(row?.done_at),
  };
}

function cooldownMs(failures: number): number {
  if (failures <= 0) {
    return COOLDOWN_BASE_MS;
  }

  const scaled = COOLDOWN_BASE_MS * 2 ** Math.min(failures, 10);

  return Math.min(scaled, COOLDOWN_MAX_MS);
}

function shouldSkip(state: ReliabilityState, now: number): boolean {
  if (state.isDone) {
    return true;
  }

  if (!state.attemptedAt) {
    return false;
  }

  const last = Date.parse(state.attemptedAt);

  if (!Number.isFinite(last)) {
    return false;
  }

  return now - last < cooldownMs(state.failures);
}

async function recordAttempt(
  trackId: string,
  source: BackfillSource,
  outcome: AttemptOutcome,
): Promise<void> {
  const db = await getDb();
  const p = columnPrefix(source);
  const now = new Date().toISOString();

  const doneClause = outcome === "done" ? `${p}_done_at = ?,` : "";
  const failuresClause =
    outcome === "failure" ? `${p}_failures = ${p}_failures + 1` : `${p}_failures = 0`;

  const args: string[] = [now];

  if (outcome === "done") {
    args.push(now);
  }

  args.push(trackId);

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args,
        sql: `update ${reliabilityTable(source)}
          set ${p}_attempted_at = ?,
            ${p}_attempts = ${p}_attempts + 1,
            ${doneClause}
            ${failuresClause}
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-attempt" },
  );
}

export async function recordNoteAttempt(trackId: string, filled: boolean): Promise<void> {
  await recordAttempt(trackId, "note", filled ? "done" : "tried");
}

async function runPublishedFindingPass(
  workKind: "apple-finding" | "beatport-finding" | "discogs-track" | "lastfm-track",
  startCursor: string | undefined,
  limit: number,

  visit: (track: TrackListItem) => Promise<boolean | "stop">,
): Promise<string | null> {
  if (await isDueWorkCutoverEnabled()) {
    return runProjectedPublishedFindingPass(workKind, startCursor, limit, visit);
  }

  let cursor = startCursor;
  let handled = 0;
  let lastVisited: { addedAt: string; trackId: string } | undefined;

  while (handled < limit) {
    const page = await listTracks({
      cursor: decodeTrackCursor(cursor ?? null),
      limit: PAGE_SIZE,
      order: "desc",
    });

    for (const track of page.tracks) {
      if (handled >= limit) {
        break;
      }

      if (!isPublishedFinding(track)) {
        continue;
      }

      lastVisited = { addedAt: track.addedAt, trackId: track.trackId };

      const outcome = await visit(track);

      if (outcome === "stop") {
        return lastVisited ? encodeTrackCursor(lastVisited) : (cursor ?? null);
      }

      if (outcome) {
        handled += 1;
      }
    }

    if (handled >= limit) {
      return lastVisited ? encodeTrackCursor(lastVisited) : (page.nextCursor ?? null);
    }

    if (!page.nextCursor) {
      return null;
    }

    cursor = page.nextCursor;
  }

  return lastVisited ? encodeTrackCursor(lastVisited) : (cursor ?? null);
}

function findingDueContinuation(
  cursor: ReturnType<typeof decodeTrackCursor>,
): { sortKey: string; subjectId: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  return {
    sortKey: encodeDueWorkOrder([
      { direction: "desc", kind: "timestamp", nulls: "last", value: cursor.addedAt },
      { direction: "desc", kind: "text", value: cursor.trackId },
    ]),
    subjectId: cursor.trackId,
  };
}

async function runProjectedPublishedFindingPass(
  workKind: "apple-finding" | "beatport-finding" | "discogs-track" | "lastfm-track",
  startCursor: string | undefined,
  limit: number,
  visit: (track: TrackListItem) => Promise<boolean | "stop">,
): Promise<string | null> {
  const db = await getDb();
  let continuation = findingDueContinuation(decodeTrackCursor(startCursor ?? null));
  let handled = 0;
  let lastVisited: { addedAt: string; trackId: string } | undefined;

  while (handled < limit) {
    const page = await readPromotedDueWorkPage(db, workKind, {
      continuation,
      limit: PAGE_SIZE,
    });
    if (page.subjectIds.length === 0) {
      return null;
    }

    const byId = await getTracksByIds(page.subjectIds);
    for (const subjectId of page.subjectIds) {
      if (handled >= limit) {
        break;
      }
      const track = byId[subjectId];
      if (track === undefined || !isPublishedFinding(track)) {
        continue;
      }

      lastVisited = { addedAt: track.addedAt, trackId: track.trackId };
      const outcome = await visit(track);
      if (outcome === "stop") {
        return encodeTrackCursor(lastVisited);
      }
      if (outcome) {
        handled += 1;
      }
    }

    if (handled >= limit) {
      return lastVisited === undefined ? null : encodeTrackCursor(lastVisited);
    }
    if (!page.hasMore) {
      return null;
    }

    const lastSubjectId = page.subjectIds.at(-1);
    if (lastSubjectId === undefined) {
      return null;
    }
    const cursorRow = await db.execute({
      args: [workKind, lastSubjectId],
      sql: `select sort_key from due_work
            where work_kind = ? and subject_id = ? and subject_type = 'track'
            limit 1`,
    });
    const sortKey = cursorRow.rows[0]?.sort_key;
    if (typeof sortKey !== "string") {
      return null;
    }
    continuation = { sortKey, subjectId: lastSubjectId };
  }

  return lastVisited === undefined ? null : encodeTrackCursor(lastVisited);
}

export async function backfillLastfmLoves(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<LastfmBackfillResult> {
  const loved: string[] = [];
  const failed: Array<{ error: string; logId: string }> = [];
  const skipped: string[] = [];
  const now = Date.now();
  let rateLimited = false;

  const nextCursor = await runPublishedFindingPass(
    "lastfm-track",
    startCursor,
    batchLimit(limit),
    async (track) => {
      const logId = track.logId ?? track.trackId;
      const artist = track.artists[0] ?? track.artists.join(", ");

      if (!artist || !track.title.trim()) {
        return false;
      }

      const state = await readReliability(track.trackId, "lastfm");

      if (shouldSkip(state, now)) {
        skipped.push(logId);
        return false;
      }

      if (dryRun) {
        loved.push(logId);
        return true;
      }

      const outcome = await lastfmLove(artist, track.title);

      if (outcome.ok) {
        await recordAttempt(track.trackId, "lastfm", "done");
        loved.push(logId);
        return true;
      }

      if (outcome.rateLimited) {
        rateLimited = true;
        return "stop";
      }

      await recordAttempt(track.trackId, "lastfm", "failure");
      failed.push({ error: outcome.error, logId });
      return true;
    },
  );

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    loved,
    lovedCount: loved.length,

    nextCursor: rateLimited ? null : nextCursor,
    rateLimited,
    skipped,
    skippedCount: skipped.length,
  };
}

export async function backfillDiscogsIds(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
  options: {
    boxFetch?: boolean;
    discogsCandidates?: DiscogsReleaseCandidate[];
  } = {},
): Promise<DiscogsBackfillResult> {
  const discogsWork: DiscogsReleaseWork[] = [];
  const resolved: DiscogsBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let first = true;
  let rateLimited = false;
  let rateLimitedBy: DiscogsThrottleVendor | null = null;
  const suppliedByTrack = new Map(
    (options.discogsCandidates ?? []).map((candidate) => [candidate.trackId, candidate.releases]),
  );

  const visit = async (track: TrackListItem): Promise<boolean | "stop"> => {
    if (track.discogsReleaseUrl) {
      return false;
    }

    if (!track.artists[0]?.trim() || !track.title.trim()) {
      return false;
    }

    const logId = track.logId ?? track.trackId;

    const state = await readReliability(track.trackId, "discogs");

    if (shouldSkip(state, now)) {
      skipped.push(logId);
      return false;
    }

    if (dryRun) {
      unresolved.push(logId);
      return true;
    }

    const input = {
      album: track.album,
      artists: track.artists,
      isrc: track.isrc,
      label: track.label,
      releaseDate: track.releaseDate,
      title: track.title,
    };

    const supplied = suppliedByTrack.get(track.trackId);

    let enrichment: DiscogsEnrichment;

    if (options.discogsCandidates !== undefined) {
      if (supplied === undefined) {
        return false;
      }

      enrichment = scoreDiscogsReleaseCandidates(input, supplied);
    } else if (options.boxFetch) {
      const preparation = await prepareDiscogsRelease(input);
      enrichment = preparation.enrichment;

      if (enrichment.rateLimited) {
        rateLimited = true;
        rateLimitedBy = enrichment.rateLimitedBy ?? null;
        return "stop";
      }

      if (!enrichment.releaseId) {
        discogsWork.push({ queries: preparation.queries, trackId: track.trackId });
        return true;
      }
    } else {
      if (!first) {
        await delay(DISCOGS_DELAY_MS);
      }
      first = false;

      enrichment = await discogsResolveRelease(input);
    }

    if (enrichment.rateLimited) {
      rateLimited = true;
      rateLimitedBy = enrichment.rateLimitedBy ?? null;
      return "stop";
    }

    if (!enrichment.releaseId) {
      await recordAttempt(track.trackId, "discogs", "tried");
      unresolved.push(logId);
      return true;
    }

    await setDiscogsIds(track.trackId, enrichment.releaseId, enrichment.masterId);
    await recordAttempt(track.trackId, "discogs", "done");

    if (enrichment.catno !== undefined || enrichment.styles !== undefined) {
      await storeAlbumDiscogsFactsForTrack(track.trackId, {
        catno: enrichment.catno,
        styles: enrichment.styles,
      });
    }

    resolved.push({
      logId,
      masterId: enrichment.masterId,
      releaseId: enrichment.releaseId,

      source: "discogs",
    });

    return true;
  };

  let nextCursor: string | null;

  if (options.discogsCandidates !== undefined) {
    const suppliedIds = [...suppliedByTrack.keys()];
    let selectedIds: string[];
    const cutoverEnabled = await isDueWorkCutoverEnabled();

    if (cutoverEnabled) {
      if (suppliedIds.length === 0) {
        selectedIds = [];
      } else {
        const db = await getDb();
        const page = await readPromotedDueWorkPage(db, "discogs-track", {
          limit: suppliedIds.length,
          subjectIds: suppliedIds,
        });
        selectedIds = page.subjectIds;
      }
    } else {
      selectedIds = suppliedIds;
    }

    const tracks = await getTracksByIds(selectedIds);

    for (const trackId of selectedIds) {
      const track = tracks[trackId];

      if (track !== undefined && (await visit(track)) === "stop") {
        break;
      }
    }

    nextCursor = null;
  } else {
    nextCursor = await runPublishedFindingPass(
      "discogs-track",
      startCursor,
      batchLimit(limit),
      visit,
    );
  }

  return {
    discogsWork,
    dryRun,

    nextCursor: rateLimited ? null : nextCursor,
    rateLimited,
    rateLimitedBy,
    resolved,
    resolvedCount: resolved.length,
    skipped,
    skippedCount: skipped.length,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

async function setDiscogsIds(
  trackId: string,
  releaseId: number,
  masterId: number | undefined,
): Promise<void> {
  const db = await getDb();

  const now = new Date().toISOString();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [releaseId, masterId ?? null, now, now, trackId],
        sql: `update tracks
          set in_release_id = ?,
            in_master_id = ?,
            backfill_discogs_attempted_at = ?,
            backfill_discogs_done_at = ?,
            backfill_discogs_attempts = backfill_discogs_attempts + 1
          where track_id = ?`,
      },
      {
        args: [now, trackId],
        sql: `update findings set updated_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-discogs-resolve" },
  );
}

type DiscogsFactsWorkRow = {
  albumId: string;
  attemptedAt: null | string;
  failures: number;
  releaseId: number;
  slug: string;
};

export type DiscogsFactsBackfillResult = {
  configured: boolean;
  discogsWork: DiscogsFactsWork[];
  dryRun: boolean;

  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  none: string[];
  noneCount: number;

  rateLimited: boolean;
  resolved: Array<{ catno: string; slug: string }>;
  resolvedCount: number;
};

const DISCOGS_FACTS_MAX_BATCH = 25;

async function listDiscogsFactsWork(
  limit: number,
  slugs?: string[],
): Promise<DiscogsFactsWorkRow[]> {
  if (slugs?.length === 0) {
    return [];
  }

  const db = await getDb();
  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const slugClause = slugs ? `and a.slug in (${slugs.map(() => "?").join(", ")})` : "";
  const result = await db.execute({
    args: slugs ? [cutoff, ...slugs, limit] : [cutoff, limit],
    sql: `select a.id as album_id, a.slug as slug,
                 a.discogs_attempted_at as attempted_at,
                 a.discogs_failures as failures,
                 min(t.in_release_id) as release_id
          from tracks t
          join albums a on a.id = t.album_id
          where t.in_release_id is not null
            and a.discogs_state = 'pending'
            and (a.discogs_attempted_at is null or a.discogs_attempted_at < ?)
            ${slugClause}
          group by a.id
          order by a.id
          limit ?`,
  });

  return typedRows<{
    album_id: string;
    attempted_at: null | string;
    failures: null | number;
    release_id: number;
    slug: string;
  }>(result.rows).map((row) => ({
    albumId: row.album_id,
    attemptedAt: row.attempted_at,
    failures: typeof row.failures === "number" ? row.failures : 0,
    releaseId: row.release_id,
    slug: row.slug,
  }));
}

export async function backfillDiscogsFacts(
  limit: number,
  dryRun: boolean,
  options: {
    boxFetch?: boolean;
    discogsCandidates?: DiscogsFactsCandidate[];
  } = {},
): Promise<DiscogsFactsBackfillResult> {
  const discogsWork: DiscogsFactsWork[] = [];
  const resolved: DiscogsFactsBackfillResult["resolved"] = [];
  const none: string[] = [];
  const failed: DiscogsFactsBackfillResult["failed"] = [];
  const now = Date.now();

  const summarize = (over: Partial<DiscogsFactsBackfillResult>): DiscogsFactsBackfillResult => ({
    configured,
    discogsWork,
    dryRun,
    failed,
    failedCount: failed.length,
    none,
    noneCount: none.length,
    rateLimited: false,
    resolved,
    resolvedCount: resolved.length,
    ...over,
  });

  const token = await readOptionalEnv("DISCOGS_USER_TOKEN");
  const configured =
    Boolean(token) || options.boxFetch === true || options.discogsCandidates !== undefined;

  if (options.discogsCandidates !== undefined && options.discogsCandidates.length === 0) {
    return summarize({});
  }

  const page = Math.max(1, Math.min(limit, DISCOGS_FACTS_MAX_BATCH));
  const suppliedSlugs = options.discogsCandidates?.map((candidate) => candidate.slug);
  const candidates = await listDiscogsFactsWork(
    page,
    suppliedSlugs && suppliedSlugs.length > 0 ? suppliedSlugs : undefined,
  );

  const eligible = candidates.filter(
    (candidate) =>
      !shouldSkip(
        { attemptedAt: candidate.attemptedAt, failures: candidate.failures, isDone: false },
        now,
      ),
  );

  if (eligible.length === 0) {
    return summarize({});
  }

  if (dryRun) {
    for (const candidate of eligible) {
      none.push(candidate.slug);
    }

    return summarize({});
  }

  if (options.boxFetch && options.discogsCandidates === undefined) {
    for (const candidate of eligible) {
      discogsWork.push({ releaseId: candidate.releaseId, slug: candidate.slug });
    }

    return summarize({});
  }

  if (options.discogsCandidates !== undefined) {
    const suppliedBySlug = new Map(
      options.discogsCandidates.map((candidate) => [candidate.slug, candidate]),
    );

    for (const candidate of eligible) {
      const supplied = suppliedBySlug.get(candidate.slug);

      if (!supplied) {
        continue;
      }

      if (supplied.release.id !== candidate.releaseId) {
        failed.push({
          error: `Discogs release evidence did not match DB release ${candidate.releaseId}`,
          slug: candidate.slug,
        });
        continue;
      }

      const facts = releaseFacts(supplied.release);
      await storeAlbumDiscogsFacts(candidate.albumId, facts);

      if (facts.catno) {
        resolved.push({ catno: facts.catno, slug: candidate.slug });
      } else {
        none.push(candidate.slug);
      }
    }

    return summarize({});
  }

  if (!token) {
    return summarize({});
  }

  for (const candidate of eligible) {
    const outcome = await fetchDiscogsReleaseFacts(candidate.releaseId, token);

    if (outcome.rateLimited) {
      return summarize({ rateLimited: true });
    }

    if (!outcome.found || !outcome.facts) {
      await recordAlbumDiscogsFailure(candidate.albumId);
      failed.push({
        error: `Discogs release ${candidate.releaseId} could not be read`,
        slug: candidate.slug,
      });
      continue;
    }

    await storeAlbumDiscogsFacts(candidate.albumId, outcome.facts);

    if (outcome.facts.catno) {
      resolved.push({ catno: outcome.facts.catno, slug: candidate.slug });
    } else {
      none.push(candidate.slug);
    }
  }

  return summarize({});
}

export async function backfillAppleMusicUrls(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<AppleMusicBackfillResult> {
  const resolved: AppleMusicBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const failed: AppleMusicBackfillResult["failed"] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let first = true;
  let rateLimited = false;
  let breakerTripped = false;
  let configured = true;
  let albumFactsWritten = 0;

  const nextCursor = await runPublishedFindingPass(
    "apple-finding",
    startCursor,
    batchLimit(limit),
    async (track) => {
      if (track.appleMusicUrl) {
        return false;
      }

      if (!track.isrc?.trim()) {
        return false;
      }

      const logId = track.logId ?? track.trackId;

      const state = await readReliability(track.trackId, "apple_music");

      if (shouldSkip(state, now)) {
        skipped.push(logId);
        return false;
      }

      if (dryRun) {
        unresolved.push(logId);
        return true;
      }

      if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
        breakerTripped = true;
        return "stop";
      }

      if (!first) {
        await delay(APPLE_MUSIC_DELAY_MS);
      }
      first = false;

      await recordAppleCall(now);
      const outcome = await appleCatalogLookupByIsrc(track.isrc);

      if (!outcome.configured) {
        configured = false;
        return "stop";
      }

      if (!outcome.ok) {
        await recordAppleAuthOutcome(appleOutcomeKind(outcome), now);

        if (outcome.rateLimited) {
          rateLimited = true;
          return "stop";
        }

        await recordAttempt(track.trackId, "apple_music", "failure");
        failed.push({ error: outcome.error, logId });
        return true;
      }

      await recordAppleAuthOutcome("ok", now);

      if (!outcome.bundle) {
        await recordAttempt(track.trackId, "apple_music", "tried");
        unresolved.push(logId);
        return true;
      }

      await setAppleMusicUrl(track.trackId, outcome.bundle.songUrl, true);
      await recordAttempt(track.trackId, "apple_music", "done");
      resolved.push({ logId, url: outcome.bundle.songUrl });

      if (await storeAlbumFactsForTrack(track.trackId, outcome.bundle)) {
        albumFactsWritten += 1;
      }

      return true;
    },
  );

  return {
    albumFactsWritten,
    breakerTripped,
    configured,
    dryRun,
    failed,
    failedCount: failed.length,

    nextCursor: rateLimited || breakerTripped || !configured ? null : nextCursor,
    rateLimited,
    resolved,
    resolvedCount: resolved.length,
    skipped,
    skippedCount: skipped.length,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

function appleOutcomeKind(outcome: {
  authFailed?: boolean;
  rateLimited: boolean;
}): "auth_failure" | "other" {
  return outcome.authFailed ? "auth_failure" : "other";
}

async function setAppleMusicUrl(trackId: string, url: string, bumpFinding: boolean): Promise<void> {
  const db = await getDb();

  const statements = [
    {
      args: [url, trackId],
      sql: `update tracks set apple_music_url = ? where track_id = ?`,
    },
  ];

  if (bumpFinding) {
    statements.push({
      args: [new Date().toISOString(), trackId],
      sql: `update findings set updated_at = ? where track_id = ?`,
    });
  }

  await batchDueWorkSourceMutation(db, statements, [{ subjectId: trackId, subjectType: "track" }], {
    producer: "backfill-apple-resolve",
  });
}

export async function storeAlbumFactsForTrack(
  trackId: string,
  bundle: AppleCatalogBundle,
): Promise<boolean> {
  const album = bundle.canonicalAlbum;

  if (!album) {
    return false;
  }

  const db = await getDb();

  const target = await db.execute({
    args: [trackId],
    sql: `select a.id as id
          from tracks t
          join albums a on a.id = t.album_id
          where t.track_id = ? and a.apple_album_id is null
          limit 1`,
  });

  const albumId = typedRows<{ id: string }>(target.rows)[0]?.id;

  if (typeof albumId !== "string") {
    return false;
  }

  const artwork = album.artwork;
  const updated = await db.execute({
    args: [
      album.id,
      album.upc ?? null,
      album.recordLabel ?? null,
      artwork?.urlTemplate ?? null,
      artwork?.width ?? null,
      artwork?.height ?? null,
      artwork?.bgColor ?? null,
      artwork?.textColor1 ?? null,
      artwork?.textColor2 ?? null,
      artwork?.textColor3 ?? null,
      artwork?.textColor4 ?? null,
      new Date().toISOString(),
      albumId,
    ],
    sql: `update albums
          set apple_album_id = ?,
              upc = ?,
              record_label_raw = ?,
              artwork_url_template = ?,
              artwork_width = ?,
              artwork_height = ?,
              artwork_bg_color = ?,
              artwork_text_color1 = ?,
              artwork_text_color2 = ?,
              artwork_text_color3 = ?,
              artwork_text_color4 = ?,
              updated_at = ?
          where id = ? and apple_album_id is null`,
  });

  return updated.rowsAffected > 0;
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
  ok: boolean;
  resolved: Array<{ logId: string; url: string }>;
  resolvedCount: number;

  skipped: string[];
  skippedCount: number;

  unresolved: string[];
  unresolvedCount: number;
};

async function setBeatportUrl(trackId: string, url: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [url, new Date().toISOString(), trackId],
        sql: `update tracks
          set beatport_url = ?, beatport_verified_at = ?
          where track_id = ? and beatport_url is null`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-beatport-resolve" },
  );
}

export async function backfillBeatportUrls(
  limit: number,
  dryRun: boolean,
  startCursor?: string,
): Promise<BeatportBackfillResult> {
  const resolved: BeatportBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const failed: BeatportBackfillResult["failed"] = [];
  const skipped: string[] = [];
  const now = Date.now();
  let configured = true;

  const nextCursor = await runPublishedFindingPass(
    "beatport-finding",
    startCursor,
    batchLimit(limit),
    async (track) => {
      if (!track.isrc?.trim()) {
        return false;
      }

      const logId = track.logId ?? track.trackId;
      const state = await readReliability(track.trackId, "beatport");

      if (shouldSkip(state, now)) {
        skipped.push(logId);

        return false;
      }

      if (dryRun) {
        unresolved.push(logId);

        return true;
      }

      const outcome = await resolveBeatportUrl({
        artists: track.artists,
        isrc: track.isrc,
        title: track.title,
      });

      if (!outcome.configured) {
        configured = false;

        return "stop";
      }

      if (!outcome.ok) {
        await recordAttempt(track.trackId, "beatport", "failure");
        failed.push({ error: outcome.error, logId });

        return true;
      }

      if (!outcome.url) {
        await recordAttempt(track.trackId, "beatport", "tried");
        unresolved.push(logId);

        return true;
      }

      await setBeatportUrl(track.trackId, outcome.url);
      await recordAttempt(track.trackId, "beatport", "done");
      resolved.push({ logId, url: outcome.url });

      return true;
    },
  );

  const catalogue =
    configured && nextCursor === null
      ? await drainBeatportCatalogue(dryRun)
      : { failed: [], resolved: [], unresolved: [] };

  return {
    catalogueFailed: catalogue.failed,
    catalogueFailedCount: catalogue.failed.length,
    catalogueResolved: catalogue.resolved,
    catalogueResolvedCount: catalogue.resolved.length,
    catalogueUnresolved: catalogue.unresolved,
    catalogueUnresolvedCount: catalogue.unresolved.length,
    configured,
    dryRun,
    failed,
    failedCount: failed.length,
    nextCursor,
    ok: failed.length === 0 && catalogue.failed.length === 0,
    resolved,
    resolvedCount: resolved.length,
    skipped,
    skippedCount: skipped.length,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

type BeatportCatalogueCandidate = {
  artists: string[];
  attemptedAt: null | string;
  failures: number;
  isrc: string;
  title: string;
  trackId: string;
};

const BEATPORT_CATALOGUE_DEFAULT_LIMIT = 5;

const BEATPORT_CATALOGUE_MAX_LIMIT = 50;

async function beatportCatalogueLimit(): Promise<number> {
  const raw = await readOptionalEnv("FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT");

  if (raw === undefined) {
    return BEATPORT_CATALOGUE_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return BEATPORT_CATALOGUE_DEFAULT_LIMIT;
  }

  return Math.min(parsed, BEATPORT_CATALOGUE_MAX_LIMIT);
}

async function listBeatportCatalogueWork(limit: number): Promise<BeatportCatalogueCandidate[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "beatport-catalogue", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }
    const placeholders = page.subjectIds.map(() => "?").join(", ");
    const result = await db.execute({
      args: page.subjectIds,
      sql: `select t.track_id, t.isrc, t.title, t.artists_json,
                   t.backfill_beatport_attempted_at as attempted_at,
                   t.backfill_beatport_failures as failures
            from tracks t
            where t.track_id in (${placeholders})`,
    });
    const byId = new Map(
      typedRows<{
        artists_json: null | string;
        attempted_at: null | string;
        failures: null | number;
        isrc: string;
        title: string;
        track_id: string;
      }>(result.rows).map((row) => [
        row.track_id,
        {
          artists: parseArtistsJson(row.artists_json ?? "[]"),
          attemptedAt: row.attempted_at,
          failures: typeof row.failures === "number" ? row.failures : 0,
          isrc: row.isrc,
          title: row.title,
          trackId: row.track_id,
        },
      ]),
    );
    return page.subjectIds
      .map((trackId) => byId.get(trackId))
      .filter((candidate): candidate is BeatportCatalogueCandidate => candidate !== undefined);
  }

  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const result = await db.execute({
    args: [cutoff, limit],

    sql: `select t.track_id, t.isrc, t.title, t.artists_json,
                 t.backfill_beatport_attempted_at as attempted_at,
                 t.backfill_beatport_failures as failures
          from tracks t
          where t.is_catalogue = 1
            and t.beatport_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_beatport_done_at is null
            and (t.backfill_beatport_attempted_at is null
                 or (t.backfill_beatport_failures > 0
                     and t.backfill_beatport_attempted_at < ?))
          order by t.capture_priority desc, t.track_id desc
          limit ?`,
  });

  return typedRows<{
    artists_json: null | string;
    attempted_at: null | string;
    failures: null | number;
    isrc: string;
    title: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json ?? "[]"),
    attemptedAt: row.attempted_at,
    failures: typeof row.failures === "number" ? row.failures : 0,
    isrc: row.isrc,
    title: row.title,
    trackId: row.track_id,
  }));
}

async function drainBeatportCatalogue(dryRun: boolean): Promise<{
  failed: Array<{ error: string; trackId: string }>;
  resolved: Array<{ trackId: string; url: string }>;
  unresolved: string[];
}> {
  const resolved: Array<{ trackId: string; url: string }> = [];
  const unresolved: string[] = [];
  const failed: Array<{ error: string; trackId: string }> = [];
  const limit = await beatportCatalogueLimit();

  if (limit === 0) {
    return { failed, resolved, unresolved };
  }

  const now = Date.now();
  const candidates = await listBeatportCatalogueWork(limit);

  const eligible = candidates.filter(
    (candidate) =>
      !shouldSkip(
        { attemptedAt: candidate.attemptedAt, failures: candidate.failures, isDone: false },
        now,
      ),
  );

  if (dryRun) {
    for (const candidate of eligible) {
      unresolved.push(candidate.trackId);
    }

    return { failed, resolved, unresolved };
  }

  for (const candidate of eligible) {
    const outcome = await resolveBeatportUrl({
      artists: candidate.artists,
      isrc: candidate.isrc,
      title: candidate.title,
    });

    if (!outcome.configured) {
      break;
    }

    if (!outcome.ok) {
      await recordAttempt(candidate.trackId, "beatport", "failure");
      failed.push({ error: outcome.error, trackId: candidate.trackId });
      continue;
    }

    if (!outcome.url) {
      await recordAttempt(candidate.trackId, "beatport", "tried");
      unresolved.push(candidate.trackId);
      continue;
    }

    await setBeatportUrl(candidate.trackId, outcome.url);
    await recordAttempt(candidate.trackId, "beatport", "done");
    resolved.push({ trackId: candidate.trackId, url: outcome.url });
  }

  return { failed, resolved, unresolved };
}

type CatalogueAppleCandidate = {
  albumId: null | string;
  attemptedAt: null | string;
  failures: number;
  isrc: string;
  trackId: string;
};

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

const CATALOGUE_APPLE_MAX_BATCH = 100;

const CATALOGUE_FACTS_MAX_PER_PASS = 10;

async function listCatalogueAppleWork(limit: number): Promise<CatalogueAppleCandidate[]> {
  const db = await getDb();

  if (await isDueWorkCutoverEnabled()) {
    const page = await readPromotedDueWorkPage(db, "apple-catalogue", { limit });
    if (page.subjectIds.length === 0) {
      return [];
    }
    const placeholders = page.subjectIds.map(() => "?").join(", ");
    const result = await db.execute({
      args: page.subjectIds,
      sql: `select t.track_id, t.isrc, t.album_id,
                   t.backfill_apple_music_attempted_at as attempted_at,
                   t.backfill_apple_music_failures as failures
            from tracks t
            where t.track_id in (${placeholders})`,
    });
    const byId = new Map(
      typedRows<{
        album_id: null | string;
        attempted_at: null | string;
        failures: null | number;
        isrc: string;
        track_id: string;
      }>(result.rows).map((row) => [
        row.track_id,
        {
          albumId: row.album_id,
          attemptedAt: row.attempted_at,
          failures: typeof row.failures === "number" ? row.failures : 0,
          isrc: row.isrc,
          trackId: row.track_id,
        },
      ]),
    );
    return page.subjectIds
      .map((trackId) => byId.get(trackId))
      .filter((candidate): candidate is CatalogueAppleCandidate => candidate !== undefined);
  }

  const cutoff = new Date(Date.now() - COOLDOWN_BASE_MS).toISOString();
  const result = await db.execute({
    args: [cutoff, limit],
    sql: `select t.track_id, t.isrc, t.album_id,
                 t.backfill_apple_music_attempted_at as attempted_at,
                 t.backfill_apple_music_failures as failures
          from tracks t
          where t.is_catalogue = 1
            and t.apple_music_url is null
            and t.isrc is not null and trim(t.isrc) <> ''
            and t.backfill_apple_music_done_at is null
            and (t.backfill_apple_music_attempted_at is null
                 or t.backfill_apple_music_attempted_at < ?)
          -- The full tracks_vendor_worklist_idx includes nullable capture priorities and carries
          -- this exact is_catalogue/order/tiebreak shape. Never-ranked NULL rows remain eligible and
          -- sort last without restoring the redundant capture-priority singleton.
          order by t.capture_priority desc, t.track_id desc
          limit ?`,
  });

  return typedRows<{
    album_id: null | string;
    attempted_at: null | string;
    failures: null | number;
    isrc: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    albumId: row.album_id,
    attemptedAt: row.attempted_at,
    failures: typeof row.failures === "number" ? row.failures : 0,
    isrc: row.isrc,
    trackId: row.track_id,
  }));
}

export async function backfillAppleMusicCatalogue(
  limit: number,
  dryRun: boolean,
): Promise<AppleCatalogueBackfillResult> {
  const resolved: AppleCatalogueBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const failed: AppleCatalogueBackfillResult["failed"] = [];
  const now = Date.now();
  let albumFactsWritten = 0;

  const empty = (over: Partial<AppleCatalogueBackfillResult>): AppleCatalogueBackfillResult => ({
    albumFactsWritten,
    breakerTripped: false,
    configured: true,
    dryRun,
    failed,
    failedCount: failed.length,
    rateLimited: false,
    resolved,
    resolvedCount: resolved.length,
    unresolved,
    unresolvedCount: unresolved.length,
    ...over,
  });

  const page = Math.max(1, Math.min(limit, CATALOGUE_APPLE_MAX_BATCH));
  const candidates = await listCatalogueAppleWork(page);

  const eligible = candidates.filter(
    (candidate) =>
      !shouldSkip(
        { attemptedAt: candidate.attemptedAt, failures: candidate.failures, isDone: false },
        now,
      ),
  );

  if (eligible.length === 0) {
    return empty({});
  }

  if (dryRun) {
    for (const candidate of eligible) {
      unresolved.push(candidate.trackId);
    }

    return empty({});
  }

  if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
    return empty({ breakerTripped: true });
  }

  const byIsrc = new Map<string, CatalogueAppleCandidate>();

  for (const candidate of eligible) {
    if (!byIsrc.has(candidate.isrc)) {
      byIsrc.set(candidate.isrc, candidate);
    }
  }

  const chunks = Math.ceil(byIsrc.size / 25);

  for (let i = 0; i < chunks; i += 1) {
    await recordAppleCall(now);
  }

  const outcome = await appleCatalogLookupByIsrcs([...byIsrc.keys()]);

  if (!outcome.configured) {
    return empty({ configured: false });
  }

  if (!outcome.ok) {
    await recordAppleAuthOutcome(appleOutcomeKind(outcome), now);

    return empty({ breakerTripped: Boolean(outcome.authFailed), rateLimited: outcome.rateLimited });
  }

  await recordAppleAuthOutcome("ok", now);

  const factsQueue: CatalogueAppleCandidate[] = [];
  const albumsSeen = new Set<string>();

  for (const [isrc, candidate] of byIsrc) {
    const bundle = outcome.bundles.get(isrc);

    if (!bundle) {
      await recordAttempt(candidate.trackId, "apple_music", "tried");
      unresolved.push(candidate.trackId);
      continue;
    }

    await setAppleMusicUrl(candidate.trackId, bundle.songUrl, false);
    await recordAttempt(candidate.trackId, "apple_music", "done");
    resolved.push({ trackId: candidate.trackId, url: bundle.songUrl });

    if (candidate.albumId && !albumsSeen.has(candidate.albumId)) {
      albumsSeen.add(candidate.albumId);
      factsQueue.push(candidate);
    }
  }

  albumFactsWritten += await drainCatalogueAlbumFacts(factsQueue, now);

  return empty({});
}

async function drainCatalogueAlbumFacts(
  candidates: CatalogueAppleCandidate[],
  now: number,
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }

  const db = await getDb();
  const byTrack = new Map(candidates.map((candidate) => [candidate.trackId, candidate]));
  const placeholders = candidates.map(() => "?").join(", ");
  const need = await db.execute({
    args: candidates.map((candidate) => candidate.trackId),
    sql: `select t.track_id
          from tracks t
          join albums a on a.id = t.album_id
          where t.track_id in (${placeholders}) and a.apple_album_id is null`,
  });

  const needing = typedRows<{ track_id: string }>(need.rows)
    .map((row) => byTrack.get(row.track_id))
    .filter((candidate): candidate is CatalogueAppleCandidate => candidate !== undefined)
    .slice(0, CATALOGUE_FACTS_MAX_PER_PASS);

  let written = 0;
  let first = true;

  for (const candidate of needing) {
    if (!(await areAppleCallsAllowed(now)) || !(await isAppleCallBudgetAvailable(now))) {
      break;
    }

    if (!first) {
      await delay(APPLE_MUSIC_DELAY_MS);
    }
    first = false;

    await recordAppleCall(now);
    const outcome = await appleCatalogLookupByIsrc(candidate.isrc);

    if (!outcome.configured) {
      break;
    }

    if (!outcome.ok) {
      await recordAppleAuthOutcome(appleOutcomeKind(outcome), now);
      break;
    }

    await recordAppleAuthOutcome("ok", now);

    if (outcome.bundle && (await storeAlbumFactsForTrack(candidate.trackId, outcome.bundle))) {
      written += 1;
    }
  }

  return written;
}

type DeezerCandidate = {
  durationMs: number;
  isrc: string;
  trackId: string;
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

const DEEZER_MAX_BATCH = 25;

const DEEZER_DELAY_MS = 250;

const DEEZER_MAX_FAILURES = 3;

const DEEZER_WORK_GATE = `t.deezer_track_id is null
  and t.backfill_deezer_attempted_at is null
  and t.backfill_deezer_failures < ?
  and t.isrc is not null and trim(t.isrc) <> ''
  and t.duration_ms > 0`;

async function listDeezerWork(limit: number): Promise<DeezerCandidate[]> {
  const db = await getDb();

  const toCandidates = (rows: Parameters<typeof typedRows>[0]): DeezerCandidate[] =>
    typedRows<{ duration_ms: number; isrc: string; track_id: string }>(rows).map((row) => ({
      durationMs: Number(row.duration_ms),
      isrc: row.isrc,
      trackId: row.track_id,
    }));

  if (await isDueWorkCutoverEnabled()) {
    const findingPage = await readPromotedDueWorkPage(db, "deezer-finding", { limit });
    const subjectIds = [...findingPage.subjectIds];
    const remaining = limit - subjectIds.length;
    if (remaining > 0) {
      const cataloguePage = await readPromotedDueWorkPage(db, "deezer-catalogue", {
        limit: remaining,
      });
      subjectIds.push(...cataloguePage.subjectIds);
    }
    if (subjectIds.length === 0) {
      return [];
    }
    const placeholders = subjectIds.map(() => "?").join(", ");
    const result = await db.execute({
      args: subjectIds,
      sql: `select t.track_id, t.isrc, t.duration_ms
            from tracks t
            where t.track_id in (${placeholders})`,
    });
    const byId = new Map(
      toCandidates(result.rows).map((candidate) => [candidate.trackId, candidate]),
    );
    return subjectIds
      .map((trackId) => byId.get(trackId))
      .filter((candidate): candidate is DeezerCandidate => candidate !== undefined);
  }

  const certified = await db.execute({
    args: [DEEZER_MAX_FAILURES, limit],

    sql: `select t.track_id, t.isrc, t.duration_ms
          from findings f
          join tracks t on t.track_id = f.track_id
          where ${DEEZER_WORK_GATE}
          order by f.added_at desc, t.track_id
          limit ?`,
  });

  const candidates = toCandidates(certified.rows);

  if (candidates.length >= limit) {
    return candidates;
  }

  const catalogue = await db.execute({
    args: [DEEZER_MAX_FAILURES, limit - candidates.length],

    sql: `select t.track_id, t.isrc, t.duration_ms
          from tracks t
          where t.is_catalogue = 1
            and ${DEEZER_WORK_GATE}
          order by t.capture_priority desc, t.track_id desc
          limit ?`,
  });

  return [...candidates, ...toCandidates(catalogue.rows)];
}

async function setDeezerTrackId(trackId: string, deezerTrackId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [deezerTrackId, "isrc", now, now, now, trackId],
        sql: `update tracks
          set deezer_track_id = coalesce(deezer_track_id, ?),
            deezer_verified_by = coalesce(deezer_verified_by, ?),
            deezer_verified_at = coalesce(deezer_verified_at, ?),
            backfill_deezer_attempted_at = ?,
            backfill_deezer_attempts = backfill_deezer_attempts + 1,
            backfill_deezer_done_at = coalesce(backfill_deezer_done_at, ?),
            backfill_deezer_failures = 0
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-deezer-resolve" },
  );
}

async function recordDeezerMiss(trackId: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [new Date().toISOString(), trackId],
        sql: `update tracks
          set backfill_deezer_attempted_at = ?,
            backfill_deezer_attempts = backfill_deezer_attempts + 1,
            backfill_deezer_failures = 0
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-deezer-miss" },
  );
}

async function recordDeezerFailure(trackId: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [trackId],
        sql: `update tracks
          set backfill_deezer_failures = backfill_deezer_failures + 1
          where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "backfill-deezer-failure" },
  );
}

export async function backfillDeezer(
  limit: number,
  dryRun: boolean,
): Promise<DeezerBackfillResult> {
  const resolved: DeezerBackfillResult["resolved"] = [];
  const unresolved: string[] = [];
  const unvouchable: string[] = [];
  const failed: DeezerBackfillResult["failed"] = [];

  const summarize = (over: Partial<DeezerBackfillResult>): DeezerBackfillResult => ({
    dryRun,
    failed,
    failedCount: failed.length,
    rateLimited: false,
    resolved,
    resolvedCount: resolved.length,
    unresolved,
    unresolvedCount: unresolved.length,
    unvouchable,
    unvouchableCount: unvouchable.length,
    ...over,
  });

  const page = Math.max(1, Math.min(limit, DEEZER_MAX_BATCH));
  const candidates = await listDeezerWork(page);

  if (candidates.length === 0) {
    return summarize({});
  }

  if (dryRun) {
    for (const candidate of candidates) {
      unresolved.push(candidate.trackId);
    }

    return summarize({});
  }

  let first = true;

  for (const candidate of candidates) {
    if (!first) {
      await delay(DEEZER_DELAY_MS);
    }
    first = false;

    const outcome = await lookupDeezerTrackByIsrc(candidate.isrc, candidate.durationMs);

    if (outcome.outcome === "quota") {
      return summarize({ rateLimited: true });
    }

    if (outcome.outcome === "failed") {
      await recordDeezerFailure(candidate.trackId);
      failed.push({ error: outcome.error, trackId: candidate.trackId });
      continue;
    }

    if (outcome.outcome === "unvouchable") {
      await recordDeezerFailure(candidate.trackId);
      unvouchable.push(candidate.trackId);
      continue;
    }

    if (outcome.outcome === "absent") {
      await recordDeezerMiss(candidate.trackId);
      unresolved.push(candidate.trackId);
      continue;
    }

    await setDeezerTrackId(candidate.trackId, outcome.deezerTrackId);
    resolved.push({
      trackId: candidate.trackId,
      url: `https://www.deezer.com/track/${encodeURIComponent(outcome.deezerTrackId)}`,
    });
  }

  return summarize({});
}

function batchLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MAX_BATCH));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
