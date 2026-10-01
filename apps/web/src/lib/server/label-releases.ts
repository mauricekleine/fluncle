import { ensureAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import { getDb, typedRows } from "./db";
import { batchDueWorkSourceMutation } from "./due-work";
import { relinkTracksToEntity } from "./hub-counts";
import { hasIsrc } from "./isrc";
import { labelFold } from "./labels";
import { logEvent } from "./log";
import { getSetting, setSetting } from "./settings";
import { getSpotifyAnchorBreakerState } from "./spotify-anchor-breaker";
import { ApiError } from "./api-error";
import { getSpotifyAccessToken, SPOTIFY_REAUTH_REQUIRED, spotifyFetch } from "./spotify";
import {
  chargeSpotifyTapDailyCall,
  readSpotifyCallCount,
  readSpotifyQuotaHoldUntil,
  readSpotifyTapDailyBudget,
  readSpotifyTapDailyCallsSpent,
  recordSpotifyCall,
  SPOTIFY_CALL_WINDOW_MAX,
} from "./spotify-budget";
import { insertTrackDuplicateKeyStatement } from "./track-duplicate-keys";

const PROBE_LABELS_PER_PASS = 5;

const REPROBE_INTERVAL_MS = 20 * 60 * 60 * 1000;

const FAILURE_COOLDOWN_BASE_MS = 6 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const WORKLIST_OVERSCAN = PROBE_LABELS_PER_PASS * 4;
const QUOTA_UNTIL_KEY = "spotify_label_releases_quota_until";
const THROTTLE_UNTIL_KEY = "spotify_label_releases_throttle_until";

const SEARCH_LIMIT = 10;

const MAX_ALBUMS_PER_LABEL = 40;

const MAX_FETCHES_PER_PASS = 150;

export const TAP_BUDGET_CEILING = Math.floor(SPOTIFY_CALL_WINDOW_MAX / 2);

type LabelProbeRow = {
  attemptedAt: null | string;
  checkedAt: null | string;
  failures: number;
  id: string;
  name: string;
  progressJson: null | string;
  slug: string;
};

type LabelProgress = { albumIds: string[]; albumIndex: number; trackIndex: number };

function parseProgress(raw: null | string): LabelProgress | null {
  if (!raw) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return null;
    }
    const progress = value as Partial<LabelProgress>;
    if (
      !Array.isArray(progress.albumIds) ||
      !progress.albumIds.every((id) => typeof id === "string") ||
      !Number.isSafeInteger(progress.albumIndex) ||
      !Number.isSafeInteger(progress.trackIndex) ||
      (progress.albumIndex ?? -1) < 0 ||
      (progress.trackIndex ?? -1) < 0
    ) {
      return null;
    }
    return progress as LabelProgress;
  } catch {
    return null;
  }
}

export type ProbeAlbum = {
  copyrights: string[];
  id: string;
  name: null | string;
  releaseDate: null | string;

  spotifyArtistIds: string[];
  trackIds: string[];
};

export type ProbeTrack = {
  artistNames: string[];

  spotifyArtistIds: string[];
  durationMs: number;
  isrc: null | string;
  spotifyTrackId: string;
  spotifyUri: string;
  spotifyUrl: string;
  title: string;
};

export type LabelReleasesProbeResult = {
  albumsMatched: number;

  albumsSeen: number;

  budgetPaused: boolean;

  configured: boolean;
  dryRun: boolean;

  failedLabels: string[];

  labelSlugs: string[];

  failedFetches: number;

  fetchCeilingHit: boolean;

  labelsProbed: number;
  labelsDue: number;
  neverChecked: number;

  newRows: number;

  newTrackIds: string[];

  rateLimited: boolean;
  quotaExceeded: boolean;
  retryAfterMs: number;
  blockedReason:
    | null
    | "spotify_breaker"
    | "spotify_budget"
    | "spotify_budget_spent"
    | "spotify_quota"
    | "spotify_throttle";

  tapDailyBudget: number;
  tapDailyCallsSpent: number;

  skippedKnown: number;

  tracksSkippedArtistRule: number;

  skippedUndated: number;

  skippedUngrounded: number;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseLabelAlbumSearch(body: unknown): string[] {
  const items = (body as { albums?: { items?: unknown[] } } | null | undefined)?.albums?.items;
  const ids: string[] = [];

  for (const raw of Array.isArray(items) ? items : []) {
    const id = asString((raw as { id?: unknown }).id);

    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

export function parseProbeAlbum(body: unknown): ProbeAlbum | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const album = body as {
    artists?: Array<{ id?: unknown }>;
    copyrights?: Array<{ text?: unknown }>;
    id?: unknown;
    name?: unknown;
    release_date?: unknown;
    tracks?: { items?: Array<{ id?: unknown }> };
  };
  const id = asString(album.id);

  if (!id) {
    return null;
  }

  return {
    copyrights: (Array.isArray(album.copyrights) ? album.copyrights : [])
      .map((entry) => asString(entry?.text))
      .filter((text): text is string => Boolean(text)),
    id,
    name: asString(album.name),
    releaseDate: asString(album.release_date),
    spotifyArtistIds: (Array.isArray(album.artists) ? album.artists : [])
      .map((artist) => asString(artist?.id))
      .filter((aid): aid is string => Boolean(aid)),
    trackIds: (Array.isArray(album.tracks?.items) ? album.tracks.items : [])
      .map((track) => asString(track?.id))
      .filter((tid): tid is string => Boolean(tid)),
  };
}

export function parseProbeTrack(body: unknown): ProbeTrack | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const track = body as {
    artists?: Array<{ id?: unknown; name?: unknown }>;
    duration_ms?: unknown;
    external_ids?: { isrc?: unknown };
    external_urls?: { spotify?: unknown };
    id?: unknown;
    name?: unknown;
    uri?: unknown;
  };
  const spotifyTrackId = asString(track.id);
  const title = asString(track.name);

  if (!spotifyTrackId || !title) {
    return null;
  }

  const duration = track.duration_ms;

  return {
    artistNames: (Array.isArray(track.artists) ? track.artists : [])
      .map((artist) => asString(artist?.name))
      .filter((name): name is string => Boolean(name)),
    durationMs:
      typeof duration === "number" && Number.isFinite(duration) ? Math.round(duration) : 0,
    isrc: asString(track.external_ids?.isrc),
    spotifyArtistIds: (Array.isArray(track.artists) ? track.artists : [])
      .map((artist) => asString(artist?.id))
      .filter((id): id is string => Boolean(id)),
    spotifyTrackId,
    spotifyUri: asString(track.uri) ?? `spotify:track:${spotifyTrackId}`,
    spotifyUrl:
      asString(track.external_urls?.spotify) ?? `https://open.spotify.com/track/${spotifyTrackId}`,
    title,
  };
}

export function stripCopyrightPrefix(text: string): string {
  return text.replace(/^\s*(?:[℗©]\s*|\((?:p|c)\)\s*)*(?:\d{4}\s+)?/iu, "").trim();
}

export function copyrightMatchesLabel(copyrights: string[], seedLabelName: string): boolean {
  const want = labelFold(seedLabelName);

  if (!want) {
    return false;
  }

  return copyrights.some((text) => labelFold(stripCopyrightPrefix(text)) === want);
}

export function labelReleaseTrackId(spotifyTrackId: string): string {
  return `sp_${spotifyTrackId}`;
}

async function writeLabelReleaseTracks(
  tracks: ProbeTrack[],
  blocked: BlockedSpotifyArtists,
  ctx: {
    albumId: null | string;
    albumName: null | string;
    labelId: string;
    labelName: string;
    releaseDate: null | string;
  },
): Promise<{ skipped: number; skippedArtistRule: number; written: number; writtenIds: string[] }> {
  if (tracks.length === 0) {
    return { skipped: 0, skippedArtistRule: 0, written: 0, writtenIds: [] };
  }

  const db = await getDb();

  const idKeys = tracks.flatMap((track) => [
    labelReleaseTrackId(track.spotifyTrackId),
    track.spotifyTrackId,
  ]);
  const uris = tracks.map((track) => track.spotifyUri);
  const isrcs = tracks.map((track) => track.isrc).filter((isrc): isrc is string => Boolean(isrc));

  const existing = await db.execute({
    args: [...idKeys, ...uris, ...isrcs],
    sql: `select track_id, spotify_uri, isrc from tracks
          where track_id in (${idKeys.map(() => "?").join(", ")})
             or spotify_uri in (${uris.map(() => "?").join(", ")})
          ${isrcs.length > 0 ? `or isrc in (${isrcs.map(() => "?").join(", ")})` : ""}`,
  });

  const heldIds = new Set<string>();
  const heldUris = new Set<string>();
  const heldIsrcs = new Set<string>();

  for (const row of typedRows<{
    isrc: null | string;
    spotify_uri: null | string;
    track_id: string;
  }>(existing.rows)) {
    heldIds.add(row.track_id);

    if (row.spotify_uri) {
      heldUris.add(row.spotify_uri);
    }

    if (row.isrc) {
      heldIsrcs.add(row.isrc);
    }
  }

  const albumTitleFolds = await existingAlbumTitleFolds(ctx.albumId);

  let written = 0;
  let skipped = 0;
  let skippedArtistRule = 0;
  const writtenIds: string[] = [];

  const writtenAt = new Date().toISOString();

  for (const track of tracks) {
    if (isBlockedByArtistRule(track, blocked)) {
      skippedArtistRule += 1;
      continue;
    }

    const trackId = labelReleaseTrackId(track.spotifyTrackId);
    const titleFold = foldTrackTitle(track.title);

    if (
      heldIds.has(trackId) ||
      heldIds.has(track.spotifyTrackId) ||
      heldUris.has(track.spotifyUri) ||
      (track.isrc && heldIsrcs.has(track.isrc)) ||
      (ctx.albumId && titleFold && albumTitleFolds.has(titleFold))
    ) {
      skipped += 1;
      continue;
    }

    const artists = track.artistNames.length > 0 ? track.artistNames : ["Unknown"];
    const artistsJson = JSON.stringify(artists);
    const insertTrack = {
      args: [
        trackId,
        track.title,
        artistsJson,
        track.durationMs,
        ctx.albumName,
        track.isrc,

        hasIsrc(track.isrc),
        ctx.labelName,
        ctx.releaseDate,
        track.spotifyUri,
        track.spotifyUrl,

        writtenAt,
      ],

      sql: `insert into tracks
              (track_id, title, artists_json, duration_ms, album, isrc, has_isrc, label,
               release_date, spotify_uri, spotify_url, isrc_attempted_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (track_id) do nothing`,
    };
    const results = await batchDueWorkSourceMutation(
      db,
      [
        insertTrack,
        insertTrackDuplicateKeyStatement({
          artistsJson,
          isrc: track.isrc,
          title: track.title,
          trackId,
        }),
      ],
      [{ subjectId: trackId, subjectType: "track" }],
      { onlyIfLastSourceStatementChanged: true, producer: "label-release-track-mint" },
    );
    const result = results[0];

    if (!result) {
      throw new Error("Freshness track insert batch returned no track result");
    }

    if (result.rowsAffected > 0) {
      written += 1;
      writtenIds.push(trackId);
      heldIds.add(trackId);
      heldUris.add(track.spotifyUri);

      if (track.isrc) {
        heldIsrcs.add(track.isrc);
      }

      if (titleFold) {
        albumTitleFolds.set(titleFold, trackId);
      }
    } else {
      skipped += 1;
    }
  }

  if (writtenIds.length > 0) {
    await relinkTracksToEntity("labels", ctx.labelId, writtenIds);

    if (ctx.albumId) {
      await relinkTracksToEntity("albums", ctx.albumId, writtenIds);
    }

    await linkTracksToArtistEntities(writtenIds);
  }

  return { skipped, skippedArtistRule, written, writtenIds };
}

async function unmintedSpotifyTrackIds(spotifyTrackIds: string[]): Promise<string[]> {
  if (spotifyTrackIds.length === 0) {
    return [];
  }

  const db = await getDb();
  const idKeys = spotifyTrackIds.flatMap((id) => [labelReleaseTrackId(id), id]);
  const uris = spotifyTrackIds.map((id) => `spotify:track:${id}`);

  const existing = await db.execute({
    args: [...idKeys, ...uris],
    sql: `select track_id, spotify_uri from tracks
          where track_id in (${idKeys.map(() => "?").join(", ")})
             or spotify_uri in (${uris.map(() => "?").join(", ")})`,
  });

  const held = new Set<string>();

  for (const row of typedRows<{ spotify_uri: null | string; track_id: string }>(existing.rows)) {
    held.add(row.track_id);

    if (row.spotify_uri) {
      held.add(row.spotify_uri);
    }
  }

  return spotifyTrackIds.filter(
    (id) => !held.has(labelReleaseTrackId(id)) && !held.has(id) && !held.has(`spotify:track:${id}`),
  );
}

async function knownSpotifyArtistIds(spotifyArtistIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(spotifyArtistIds.filter(Boolean))];

  if (ids.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const result = await db.execute({
    args: ids,
    sql: `select spotify_artist_id from artists
          where spotify_artist_id in (${ids.map(() => "?").join(", ")})`,
  });

  return new Set(
    typedRows<{ spotify_artist_id: string }>(result.rows).map((row) => row.spotify_artist_id),
  );
}

function failureCooldownMs(failures: number): number {
  if (failures <= 0) {
    return FAILURE_COOLDOWN_BASE_MS;
  }

  return Math.min(FAILURE_COOLDOWN_BASE_MS * 2 ** Math.min(failures, 10), FAILURE_COOLDOWN_MAX_MS);
}

async function markLabelChecked(slug: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update labels
          set label_releases_checked_at = ?, label_releases_failures = 0, label_releases_progress_json = null
          where slug = ?`,
  });
}

async function recordLabelFailure(slug: string, priorFailures: number): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [priorFailures + 1, new Date().toISOString(), slug],
    sql: `update labels
          set label_releases_failures = ?, label_releases_attempted_at = ?
          where slug = ?`,
  });
}

async function deferLabel(slug: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: "update labels set label_releases_attempted_at = ? where slug = ? and label_releases_failures = 0",
  });
}

async function saveProgress(slug: string, progress: LabelProgress): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [JSON.stringify(progress), slug],
    sql: "update labels set label_releases_progress_json = ? where slug = ?",
  });
}

export function nextSpotifyQuotaWindow(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

async function dueCounts(now: number): Promise<{ labelsDue: number; neverChecked: number }> {
  const db = await getDb();
  const result = await db.execute({
    args: [new Date(now - REPROBE_INTERVAL_MS).toISOString(), Math.floor(now / 1000)],
    sql: `select count(*) as labels_due,
                 sum(case when label_releases_checked_at is null then 1 else 0 end) as never_checked
          from labels
          where seed_state = 'enabled'
            and (label_releases_checked_at is null or label_releases_checked_at <= ?)
            and (label_releases_failures = 0 or label_releases_attempted_at is null
                 or unixepoch(label_releases_attempted_at) <= ? - min(604800, 21600 * (1 << min(label_releases_failures, 10))))`,
  });
  return {
    labelsDue: Number(result.rows[0]?.labels_due ?? 0),
    neverChecked: Number(result.rows[0]?.never_checked ?? 0),
  };
}

async function listProbeLabels(now: number): Promise<LabelProbeRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [
      new Date(now - REPROBE_INTERVAL_MS).toISOString(),
      Math.floor(now / 1000),
      WORKLIST_OVERSCAN,
    ],
    sql: `select id, slug, name, label_releases_checked_at, label_releases_attempted_at,
                 label_releases_failures, label_releases_progress_json
          from labels
          where seed_state = 'enabled'
            and (label_releases_checked_at is null or label_releases_checked_at <= ?)
            and (label_releases_failures = 0 or label_releases_attempted_at is null
                 or unixepoch(label_releases_attempted_at) <= ? - min(604800, 21600 * (1 << min(label_releases_failures, 10))))
          order by label_releases_checked_at asc, label_releases_attempted_at asc, slug asc
          limit ?`,
  });

  return typedRows<{
    id: string;
    label_releases_attempted_at: null | string;
    label_releases_checked_at: null | string;
    label_releases_failures: null | number;
    name: string;
    label_releases_progress_json: null | string;
    slug: string;
  }>(result.rows).map((row) => ({
    attemptedAt: row.label_releases_attempted_at,
    checkedAt: row.label_releases_checked_at,
    failures: typeof row.label_releases_failures === "number" ? row.label_releases_failures : 0,
    id: row.id,
    name: row.name,
    progressJson: row.label_releases_progress_json,
    slug: row.slug,
  }));
}

function isEligible(label: LabelProbeRow, now: number): boolean {
  if (label.failures > 0 && label.attemptedAt) {
    const last = Date.parse(label.attemptedAt);

    if (Number.isFinite(last) && now - last < failureCooldownMs(label.failures)) {
      return false;
    }
  }

  if (!label.checkedAt) {
    return true;
  }

  const last = Date.parse(label.checkedAt);

  return !Number.isFinite(last) || now - last >= REPROBE_INTERVAL_MS;
}

type SpotifyGet =
  | { body: unknown; kind: "ok" }
  | { kind: "budget" }
  | { kind: "daily-budget" }
  | { kind: "failed" }
  | { kind: "ratelimited"; quotaExceeded: boolean; retryAfterMs: number }
  | { kind: "unauthorized" };

async function tapHasBudgetHeadroom(): Promise<boolean> {
  try {
    return (await readSpotifyCallCount(Date.now())) < TAP_BUDGET_CEILING;
  } catch {
    return false;
  }
}

async function recordTapCall(): Promise<boolean> {
  try {
    return await recordSpotifyCall(Date.now());
  } catch {
    return false;
  }
}

async function spotifyGet(
  path: string,
  accessToken: string,
  result: LabelReleasesProbeResult,
): Promise<SpotifyGet> {
  if (!(await tapHasBudgetHeadroom())) {
    return { kind: "budget" };
  }

  try {
    const holdUntil = await readSpotifyQuotaHoldUntil();
    if (holdUntil) {
      return {
        kind: "ratelimited",
        quotaExceeded: true,
        retryAfterMs: Math.max(1000, Date.parse(holdUntil) - Date.now()),
      };
    }
  } catch {
    return { kind: "budget" };
  }

  if (!(await chargeSpotifyTapDailyCall(result.tapDailyBudget))) {
    return { kind: "daily-budget" };
  }
  result.tapDailyCallsSpent += 1;

  let response: Response;
  try {
    response = await spotifyFetch(path, accessToken, {}, false, false, "label_tap");
  } catch (error) {
    if (!(await recordTapCall())) {
      return { kind: "budget" };
    }

    if (
      error instanceof ApiError &&
      (error.code === "spotify_not_authenticated" || error.code === SPOTIFY_REAUTH_REQUIRED)
    ) {
      return { kind: "unauthorized" };
    }

    if (error instanceof Error && error.message.includes("429")) {
      const details = error as Error & { quotaExceeded?: boolean; retryAfterMs?: number };
      return {
        kind: "ratelimited",
        quotaExceeded: details.quotaExceeded === true || error.message.includes("QUOTA_EXCEEDED"),
        retryAfterMs: Math.max(1000, details.retryAfterMs ?? 30_000),
      };
    }

    return { kind: "failed" };
  }

  await recordTapCall();

  try {
    return { body: await response.json(), kind: "ok" };
  } catch {
    return { kind: "failed" };
  }
}

function labelSearchPath(labelName: string): string {
  const q = `label:"${labelName}" tag:new`;
  const params = new URLSearchParams({ limit: String(SEARCH_LIMIT), q, type: "album" });

  return `/search?${params.toString()}`;
}

type LabelSignal = "continue" | "stop-budget" | "stop-meter" | "stop-rate" | "stop-unauth";

async function stopOnBudget(
  label: LabelProbeRow,
  result: LabelReleasesProbeResult,
  reason: "spotify_budget" | "spotify_budget_spent",
): Promise<LabelSignal> {
  await deferLabel(label.slug);
  result.budgetPaused = true;
  result.blockedReason = reason;
  return "stop-meter";
}

type FetchBudget = { fetches: number };

type BlockedSpotifyArtists = {
  global: Set<string>;
  label: Set<string>;
};

async function stopOnThrottle(
  label: LabelProbeRow,
  outcome: Extract<SpotifyGet, { kind: "ratelimited" }>,
  result: LabelReleasesProbeResult,
): Promise<LabelSignal> {
  await deferLabel(label.slug);
  result.rateLimited = true;
  result.quotaExceeded = outcome.quotaExceeded;
  result.retryAfterMs = outcome.retryAfterMs;
  result.blockedReason = outcome.quotaExceeded ? "spotify_quota" : "spotify_throttle";
  if (outcome.quotaExceeded) {
    await setSetting(QUOTA_UNTIL_KEY, nextSpotifyQuotaWindow(new Date()));
  } else {
    await setSetting(THROTTLE_UNTIL_KEY, new Date(Date.now() + outcome.retryAfterMs).toISOString());
  }
  return "stop-rate";
}

async function blockedSpotifyArtistsForLabel(labelId: string): Promise<BlockedSpotifyArtists> {
  try {
    const db = await getDb();
    const result = await db.execute({
      args: [labelId],
      sql: `select artist_spotify_id, label_id from artist_rules
            where verdict = 'block'
              and artist_spotify_id is not null
              and (label_id is null or label_id = ?)`,
    });
    const blocked: BlockedSpotifyArtists = { global: new Set(), label: new Set() };

    for (const row of typedRows<{ artist_spotify_id: string; label_id: null | string }>(
      result.rows,
    )) {
      if (row.label_id === null) {
        blocked.global.add(row.artist_spotify_id);
      } else {
        blocked.label.add(row.artist_spotify_id);
      }
    }

    return blocked;
  } catch (error) {
    logEvent("warn", "tap.artist-rules-read-failed", {
      error: error instanceof Error ? error.message : String(error),
      labelId,
    });

    return { global: new Set(), label: new Set() };
  }
}

function isBlockedByArtistRule(track: ProbeTrack, blocked: BlockedSpotifyArtists): boolean {
  const firstSpotifyArtistId = track.spotifyArtistIds[0];

  if (!firstSpotifyArtistId) {
    return false;
  }

  if (blocked.label.has(firstSpotifyArtistId)) {
    return true;
  }

  return blocked.global.has(firstSpotifyArtistId);
}

async function probeAlbumTrack(
  label: LabelProbeRow,
  album: ProbeAlbum,
  trackId: string,
  albumId: null | string,
  blocked: BlockedSpotifyArtists,
  accessToken: string,
  result: LabelReleasesProbeResult,
  budget: FetchBudget,
): Promise<LabelSignal> {
  if (budget.fetches >= MAX_FETCHES_PER_PASS) {
    result.fetchCeilingHit = true;
    await deferLabel(label.slug);
    return "stop-budget";
  }
  budget.fetches += 1;
  const outcome = await spotifyGet(`/tracks/${encodeURIComponent(trackId)}`, accessToken, result);
  if (outcome.kind === "unauthorized") {
    return "stop-unauth";
  }
  if (outcome.kind === "ratelimited") {
    return stopOnThrottle(label, outcome, result);
  }
  if (outcome.kind === "budget" || outcome.kind === "daily-budget") {
    return stopOnBudget(
      label,
      result,
      outcome.kind === "budget" ? "spotify_budget" : "spotify_budget_spent",
    );
  }
  if (outcome.kind === "failed") {
    result.failedFetches += 1;
    return "continue";
  }
  const track = parseProbeTrack(outcome.body);
  if (!track) {
    return "continue";
  }
  const write = await writeLabelReleaseTracks([track], blocked, {
    albumId,
    albumName: album.name,
    labelId: label.id,
    labelName: label.name,
    releaseDate: album.releaseDate,
  });
  result.newRows += write.written;
  result.skippedKnown += write.skipped;
  result.tracksSkippedArtistRule += write.skippedArtistRule;
  result.newTrackIds.push(...write.writtenIds);
  return "continue";
}

async function probeOneLabel(
  label: LabelProbeRow,
  accessToken: string,
  result: LabelReleasesProbeResult,
  budget: FetchBudget,
): Promise<LabelSignal> {
  let progress = parseProgress(label.progressJson);
  if (!progress) {
    const search = await spotifyGet(labelSearchPath(label.name), accessToken, result);
    if (search.kind === "unauthorized") {
      return "stop-unauth";
    }
    if (search.kind === "ratelimited") {
      return stopOnThrottle(label, search, result);
    }
    if (search.kind === "budget" || search.kind === "daily-budget") {
      return stopOnBudget(
        label,
        result,
        search.kind === "budget" ? "spotify_budget" : "spotify_budget_spent",
      );
    }
    if (search.kind === "failed") {
      await recordLabelFailure(label.slug, label.failures);
      result.failedLabels.push(label.slug);
      return "continue";
    }
    progress = {
      albumIds: [...new Set(parseLabelAlbumSearch(search.body))].slice(0, MAX_ALBUMS_PER_LABEL),
      albumIndex: 0,
      trackIndex: 0,
    };
    result.albumsSeen += progress.albumIds.length;
    await saveProgress(label.slug, progress);
  }

  const blocked = await blockedSpotifyArtistsForLabel(label.id);

  for (
    let albumIndex = progress.albumIndex;
    albumIndex < progress.albumIds.length;
    albumIndex += 1
  ) {
    const id = progress.albumIds[albumIndex];
    if (!id) {
      continue;
    }
    if (budget.fetches >= MAX_FETCHES_PER_PASS) {
      result.fetchCeilingHit = true;
      await deferLabel(label.slug);
      return "stop-budget";
    }
    budget.fetches += 1;
    const outcome = await spotifyGet(`/albums/${encodeURIComponent(id)}`, accessToken, result);
    if (outcome.kind === "unauthorized") {
      return "stop-unauth";
    }
    if (outcome.kind === "ratelimited") {
      return stopOnThrottle(label, outcome, result);
    }
    if (outcome.kind === "budget" || outcome.kind === "daily-budget") {
      return stopOnBudget(
        label,
        result,
        outcome.kind === "budget" ? "spotify_budget" : "spotify_budget_spent",
      );
    }
    if (outcome.kind === "failed") {
      result.failedFetches += 1;
    } else {
      const album = parseProbeAlbum(outcome.body);
      if (album) {
        if (!album.releaseDate) {
          result.skippedUndated += 1;
        } else if (copyrightMatchesLabel(album.copyrights, label.name)) {
          const known = await knownSpotifyArtistIds(album.spotifyArtistIds);
          if (album.spotifyArtistIds.some((artistId) => known.has(artistId))) {
            result.albumsMatched += 1;
            const unminted = new Set(await unmintedSpotifyTrackIds(album.trackIds));
            const albumId = (await ensureAlbum(album.name, null)) ?? null;
            let skippedSinceSave = false;
            for (
              let trackIndex: number = albumIndex === progress.albumIndex ? progress.trackIndex : 0;
              trackIndex < album.trackIds.length;
              trackIndex += 1
            ) {
              const trackId = album.trackIds[trackIndex];
              if (!trackId || !unminted.has(trackId)) {
                progress = { ...progress, albumIndex, trackIndex: trackIndex + 1 };
                skippedSinceSave = true;
                continue;
              }
              const signal = await probeAlbumTrack(
                label,
                album,
                trackId,
                albumId,
                blocked,
                accessToken,
                result,
                budget,
              );
              if (signal !== "continue") {
                if (skippedSinceSave) {
                  await saveProgress(label.slug, progress);
                }
                return signal;
              }
              progress = { ...progress, albumIndex, trackIndex: trackIndex + 1 };
              await saveProgress(label.slug, progress);
              skippedSinceSave = false;
            }
          } else {
            result.skippedUngrounded += 1;
          }
        }
      }
    }
    progress = { ...progress, albumIndex: albumIndex + 1, trackIndex: 0 };
    await saveProgress(label.slug, progress);
  }

  await markLabelChecked(label.slug);
  result.labelsProbed += 1;
  result.labelSlugs.push(label.slug);

  return "continue";
}

export async function probeLabelReleases({
  dryRun = false,
  limit = PROBE_LABELS_PER_PASS,
}: { dryRun?: boolean; limit?: number } = {}): Promise<LabelReleasesProbeResult> {
  const now = Date.now();
  const result: LabelReleasesProbeResult = {
    albumsMatched: 0,
    albumsSeen: 0,
    blockedReason: null,
    budgetPaused: false,
    configured: true,
    dryRun,
    failedFetches: 0,
    failedLabels: [],
    fetchCeilingHit: false,
    labelSlugs: [],
    labelsDue: 0,
    labelsProbed: 0,
    neverChecked: 0,
    newRows: 0,
    newTrackIds: [],
    quotaExceeded: false,
    rateLimited: false,
    retryAfterMs: 0,
    skippedKnown: 0,
    skippedUndated: 0,
    skippedUngrounded: 0,
    tapDailyBudget: await readSpotifyTapDailyBudget().catch(() => 0),
    tapDailyCallsSpent: await readSpotifyTapDailyCallsSpent(now).catch(() => 0),
    tracksSkippedArtistRule: 0,
  };

  const cap = Math.max(1, Math.min(limit, PROBE_LABELS_PER_PASS));
  const counts = await dueCounts(now);
  result.labelsDue = counts.labelsDue;
  result.neverChecked = counts.neverChecked;
  const candidates = await listProbeLabels(now);
  const eligible = candidates.filter((label) => isEligible(label, now)).slice(0, cap);

  if (eligible.length === 0) {
    return result;
  }

  if (dryRun) {
    result.labelSlugs = eligible.map((label) => label.slug);

    return result;
  }

  const quotaUntil = await getSetting(QUOTA_UNTIL_KEY).catch(() => undefined);
  if (quotaUntil && Date.parse(quotaUntil) > now) {
    result.quotaExceeded = true;
    result.blockedReason = "spotify_quota";
    return result;
  }

  const throttleUntil = await getSetting(THROTTLE_UNTIL_KEY).catch(() => undefined);
  if (throttleUntil && Date.parse(throttleUntil) > now) {
    result.rateLimited = true;
    result.retryAfterMs = Date.parse(throttleUntil) - now;
    result.blockedReason = "spotify_throttle";
    return result;
  }

  try {
    const breaker = await getSpotifyAnchorBreakerState(now);
    if (breaker.tripped) {
      result.quotaExceeded = breaker.reason === "quota_exceeded";
      result.blockedReason = result.quotaExceeded ? "spotify_quota" : "spotify_breaker";
      return result;
    }
  } catch {
    result.blockedReason = "spotify_breaker";
    return result;
  }

  let accessToken: string;

  try {
    accessToken = await getSpotifyAccessToken();
  } catch {
    return { ...result, configured: false };
  }

  const budget: FetchBudget = { fetches: 0 };

  for (const label of eligible) {
    if (result.tapDailyCallsSpent >= result.tapDailyBudget) {
      result.budgetPaused = true;
      result.blockedReason = "spotify_budget_spent";
      break;
    }
    if (!(await tapHasBudgetHeadroom())) {
      result.budgetPaused = true;
      result.blockedReason = "spotify_budget";
      break;
    }

    const signal = await probeOneLabel(label, accessToken, result, budget);

    if (signal === "stop-unauth") {
      return { ...result, configured: false };
    }

    if (signal === "stop-rate" || signal === "stop-budget" || signal === "stop-meter") {
      break;
    }
  }

  return result;
}
