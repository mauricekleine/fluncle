#!/usr/bin/env bun

import {
  DUE_WORK_REPAIR_PENDING_REASON,
  type DueWorkRepairPendingGate,
  dueWorkRepairPendingGate,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
  throwIfPageRepairPending,
} from "./due-work-repair-pending";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

const APIFY_ACTOR = process.env.FLUNCLE_ANCHOR_ACTOR ?? "musicae~spotify-extended-scraper";

const BATCH = Number(process.env.FLUNCLE_ANCHOR_BATCH ?? "15");

const PAGE_LIMIT = 200;

const APIFY_QUERY_CHUNK = Number(process.env.FLUNCLE_ANCHOR_APIFY_CHUNK ?? "15");

const SEARCH_KEYWORD_LIMIT = Number(process.env.FLUNCLE_ANCHOR_KEYWORD_LIMIT ?? "3");

const ISRC_ASK_LIMIT = Number(process.env.FLUNCLE_ANCHOR_ISRC_ASK_LIMIT ?? "25");

const ISRC_WINDOW_UTC = process.env.FLUNCLE_ANCHOR_ISRC_WINDOW_UTC ?? "0-8";

const DAY_FREE_RUNGS = process.env.FLUNCLE_ANCHOR_DAY_FREE_RUNGS === "1";

const ANCHOR_EXPECTED_INTERVAL_MS = 60 * 60 * 1000;

const log = (message: string) => console.error(`[anchor-sweep] ${message}`);

export type AnchorWorkItem = {
  anchorQuery?: string;

  deezerQuery?: string;
  trackId?: string;
};

export type DeezerCandidatePayload = {
  artistName: string;

  deezerTrackId?: string;

  durationMs: number;
  isrc: string;
  title: string;
};

type ApifyArtist = { artist_id?: string; artist_name?: string };

export type ApifyResultItem = {
  albums?: { album_image?: string }[];
  artists?: ApifyArtist[];
  error?: null | string;
  success?: boolean;
  target?: string;
  tracks?: {
    track_duration_ms?: number;
    track_id?: string;
    track_image?: string;
    track_isrc?: string;
    track_name?: string;
    track_uri?: string;
    track_url?: string;
  }[];
};

export type AnchorCandidatePayload = {
  albumImageUrl?: null | string;
  artists: { id?: null | string; name: string }[];
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
};

export type AnchorVerdict = {
  anchored: boolean;

  apifyBudgetRemaining?: number;

  apifyEligible?: boolean;

  apifyIneligibleReason?: "apify_budget_spent" | "awaiting_free_ask" | null;

  apifyEnabled?: boolean;

  freeDurationMsOmitted?: number;

  isrcRecoveredByDeezer?: boolean;

  listenbrainzOutcome?:
    | "anchored"
    | "empty-ids"
    | "gate-rejected"
    | "metadata-failed"
    | "no-map"
    | "no-mbid"
    | "not-attempted"
    | "request-failed"
    | "yielded-on-breaker";

  source?: "listenbrainz" | "spotify-isrc" | "spotify-search" | null;

  spotifyIsrcAsked?: boolean;

  spotifySearchDone?: boolean;

  spotifySearchEnabled?: boolean;

  spotifyThrottled?: boolean;

  stamped?: boolean;

  verifiedBy: "isrc" | "search" | "search-subset" | null;
};

export type DeezerSearchResult = {
  candidates: DeezerCandidatePayload[];

  droppedIncomplete: number;
};

export type AnchorPreflight = {
  apifyBudgetRemaining: number;
  apifyBudgetSpent: boolean;
  apifyEnabled: boolean;
  spotifySearchEnabled: boolean;
};

export type AnchorQueuePage = {
  queueDepth: number;
  rows: AnchorWorkItem[];
};

export type AnchorSummary = {
  apifyActorErrors: number;

  apifyBudgetSkipped: number;

  rungsSkipped: string[];

  apifyBudgetRemaining: null | number;

  apifyResults: number;

  apifyRowsSent: number;

  apifySkippedAwaitingSpotify: number;

  apifyTargetOmitted: number;

  apifyDurationMsOmitted: number;

  anchoredByIsrc: number;

  anchoredByListenbrainz: number;

  anchoredBySearch: number;

  anchoredBySpotifyIsrc: number;

  anchoredBySpotifySearch: number;

  checked: number;

  deezerSearchFailed: number;

  deezerHitsDroppedIncomplete: number;

  error: null | string;

  errors: number;

  expectedIntervalMs: number;

  failed: number;

  freeDurationMsOmitted: number;

  freeRungErrors: number;

  isrcRecoveredByDeezer: number;

  lbEmptyIds: number;

  lbGateRejected: number;

  lbMetadataFailed: number;

  lbNoMbid: number;

  lbNoMap: number;

  lbNotAttempted: number;

  lbRequestFailed: number;

  lbYieldedOnBreaker: number;

  missed: number;
  ok: boolean;

  produced: number;

  queueDepth: null | number;

  deferred: number;

  reason:
    | "apify_budget_spent"
    | "awaiting_free_ask"
    | "no_capable_rung"
    | null
    | typeof DUE_WORK_REPAIR_PENDING_REASON;

  skipped: number;

  spotifyIsrcAsks: number;

  spotifyDeferredBudget: number;

  spotifyDeferredWindow: number;

  spotifyDeferredYield: number;
} & Partial<Omit<DueWorkRepairPendingGate, "reason">>;

export type AnchorDeps = {
  fetchQueue: (limit: number) => Promise<AnchorQueuePage | AnchorWorkItem[]>;
  log: (message: string) => void;

  now: () => number;
  report: (trackId: string, candidates: AnchorCandidatePayload[]) => Promise<AnchorVerdict>;

  resolveFree: (
    trackId: string,
    deezerCandidates?: DeezerCandidatePayload[],
    options?: { spotifySearch?: boolean },
  ) => Promise<AnchorVerdict>;
  runActor: (queries: string[]) => Promise<ApifyResultItem[]>;

  searchDeezer: (query: string) => Promise<DeezerCandidatePayload[] | DeezerSearchResult | null>;

  readPreflight?: () => Promise<AnchorPreflight>;

  sleep: (ms: number) => Promise<void>;
};

function recordFailure(summary: AnchorSummary): void {
  summary.failed += 1;
}

function recordRunError(summary: AnchorSummary, message?: string): void {
  summary.errors += 1;

  if (summary.error === null && message) {
    summary.error = message;
  }
}

function settleQueueRow(summary: AnchorSummary): void {
  if (summary.queueDepth !== null && summary.queueDepth > 0) {
    summary.queueDepth -= 1;
  }
}

function tallyListenBrainzOutcome(summary: AnchorSummary, verdict: AnchorVerdict): void {
  switch (verdict.listenbrainzOutcome) {
    case "empty-ids":
      summary.lbEmptyIds += 1;
      break;
    case "gate-rejected":
      summary.lbGateRejected += 1;
      break;
    case "metadata-failed":
      summary.lbMetadataFailed += 1;
      recordFailure(summary);
      break;
    case "no-mbid":
      summary.lbNoMbid += 1;
      break;
    case "no-map":
      summary.lbNoMap += 1;
      break;
    case "not-attempted":
      summary.lbNotAttempted += 1;
      break;
    case "request-failed":
      summary.lbRequestFailed += 1;
      recordFailure(summary);
      break;
    case "yielded-on-breaker":
      summary.lbYieldedOnBreaker += 1;
      break;
    case "anchored":
    case undefined:
      break;
  }
}

export const SPOTIFY_SEARCH_MIN_INTERVAL_MS = 2000;

export type IsrcAskWindow = "always" | "invalid" | { endHour: number; startHour: number };

export function parseIsrcAskWindow(raw: string | undefined): IsrcAskWindow {
  const value = (raw ?? "").trim();

  if (!value) {
    return "always";
  }

  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  const startHour = Number(match?.[1]);
  const endHour = Number(match?.[2]);

  if (!match || !(startHour >= 0 && startHour <= 23) || !(endHour >= 0 && endHour <= 24)) {
    return "invalid";
  }

  return { endHour, startHour };
}

export function withinIsrcAskWindow(window: IsrcAskWindow, now: Date): boolean {
  if (window === "always") {
    return true;
  }

  if (window === "invalid") {
    return false;
  }

  const hour = now.getUTCHours();

  return window.startHour <= window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

export function spotifySearchPaceMs(
  lastSearchStartMs: null | number,
  nowMs: number,
  minIntervalMs: number = SPOTIFY_SEARCH_MIN_INTERVAL_MS,
): number {
  if (lastSearchStartMs === null) {
    return 0;
  }

  const elapsed = nowMs - lastSearchStartMs;

  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

export function itemToCandidate(item: ApifyResultItem): AnchorCandidatePayload | null {
  const track = item.tracks?.[0];
  const spotifyTrackId = track?.track_id?.trim();

  if (item.success === false || !track || !spotifyTrackId) {
    return null;
  }

  return {
    albumImageUrl: track.track_image ?? item.albums?.[0]?.album_image ?? null,
    artists: (item.artists ?? [])
      .filter((artist): artist is ApifyArtist & { artist_name: string } =>
        Boolean(artist.artist_name),
      )
      .map((artist) => ({ id: artist.artist_id ?? null, name: artist.artist_name })),
    durationMs: typeof track.track_duration_ms === "number" ? track.track_duration_ms : null,
    isrc: track.track_isrc ?? null,
    spotifyTrackId,
    title: track.track_name ?? "",
  };
}

export function groupCandidatesByTarget(
  items: ApifyResultItem[],
): Map<string, AnchorCandidatePayload[]> {
  const byTarget = new Map<string, AnchorCandidatePayload[]>();

  for (const item of items) {
    const target = item.target;

    if (typeof target !== "string") {
      continue;
    }

    const candidate = itemToCandidate(item);

    if (!candidate) {
      continue;
    }

    const bucket = byTarget.get(target);

    if (bucket) {
      bucket.push(candidate);
    } else {
      byTarget.set(target, [candidate]);
    }
  }

  return byTarget;
}

export type SpotifyAskState = {
  askWindow: IsrcAskWindow;

  asksSpent: number;

  limit: number;

  yielded: boolean;
};

export function newSpotifyAskState(
  limit: number = ISRC_ASK_LIMIT,
  windowUtc: string | undefined = ISRC_WINDOW_UTC,
): SpotifyAskState {
  return {
    askWindow: parseIsrcAskWindow(windowUtc),
    asksSpent: 0,
    limit: Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 0,
    yielded: false,
  };
}

export function spotifyAskDeferral(
  state: SpotifyAskState,
  now: Date,
): "budget" | "window" | "yield" | null {
  if (state.yielded) {
    return "yield";
  }

  if (!withinIsrcAskWindow(state.askWindow, now)) {
    return "window";
  }

  return state.asksSpent >= state.limit ? "budget" : null;
}

export function anchorFiringDeferral(
  preflight: AnchorPreflight,
  askWindow: IsrcAskWindow,
  now: Date,
  dayFreeRungs: boolean = false,
): "apify_budget_spent" | "awaiting_free_ask" | "free_rungs_only" | null {
  if (!preflight.apifyEnabled) {
    return null;
  }

  const deferral = preflight.apifyBudgetSpent
    ? "apify_budget_spent"
    : preflight.spotifySearchEnabled && !withinIsrcAskWindow(askWindow, now)
      ? "awaiting_free_ask"
      : null;

  return deferral !== null && dayFreeRungs ? "free_rungs_only" : deferral;
}

async function fetchAnchorWorkRows(
  limit: number,
  deps: AnchorDeps,
  summary: AnchorSummary,
): Promise<AnchorWorkItem[] | undefined> {
  try {
    const fetched = await deps.fetchQueue(limit);
    const queue = Array.isArray(fetched) ? fetched : fetched.rows;
    summary.queueDepth = Array.isArray(fetched) ? fetched.length : fetched.queueDepth;
    summary.checked = queue.length;
    return queue;
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      deps.log(error.message);
      Object.assign(summary, dueWorkRepairPendingGate(summary));
      return undefined;
    }

    summary.ok = false;
    recordRunError(summary, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function actionableAnchorRows(queue: AnchorWorkItem[]): {
  invalidRows: number;
  rows: (AnchorWorkItem & { anchorQuery: string; trackId: string })[];
} {
  const rows = queue.filter(
    (row): row is AnchorWorkItem & { anchorQuery: string; trackId: string } =>
      Boolean(row.trackId) && Boolean(row.anchorQuery),
  );
  return { invalidRows: queue.length - rows.length, rows };
}

function settleUnspentRows(input: {
  apifyEnabled: boolean;
  apifyRows: readonly { stamped?: boolean }[];
  freeRungsOnly: boolean;
  summary: AnchorSummary;
}): boolean {
  const { apifyEnabled, apifyRows, freeRungsOnly, summary } = input;

  if (freeRungsOnly) {
    summary.deferred += apifyRows.length;
    summary.rungsSkipped = ["apify"];

    return true;
  }

  if (apifyEnabled) {
    return false;
  }

  for (const row of apifyRows) {
    if (row.stamped === false) {
      summary.deferred += 1;
    } else {
      summary.missed += 1;
      settleQueueRow(summary);
    }
  }

  return true;
}

async function runApifyFallback(
  apifyRows: readonly { anchorQuery: string; trackId: string }[],
  actorChunkSize: number,
  deps: AnchorDeps,
  summary: AnchorSummary,
): Promise<void> {
  for (const batch of chunk(apifyRows, actorChunkSize)) {
    let byTarget: Map<string, AnchorCandidatePayload[]>;

    try {
      const items = await deps.runActor(batch.map((row) => row.anchorQuery));

      summary.apifyResults += items.length;
      byTarget = groupCandidatesByTarget(items);
    } catch (error) {
      deps.log(`actor run failed: ${error instanceof Error ? error.message : String(error)}`);
      summary.ok = false;
      summary.apifyActorErrors += 1;
      recordRunError(summary, error instanceof Error ? error.message : String(error));
      summary.skipped += batch.length;
      continue;
    }

    for (const row of batch) {
      const candidates = byTarget.get(row.anchorQuery) ?? [];
      if (!byTarget.has(row.anchorQuery)) {
        summary.apifyTargetOmitted += 1;
      }
      summary.apifyDurationMsOmitted += candidates.filter(
        (candidate) => typeof candidate.durationMs !== "number",
      ).length;

      try {
        summary.apifyRowsSent += 1;
        const verdict = await deps.report(row.trackId, candidates);
        if (verdict.anchored && verdict.verifiedBy === "isrc") {
          summary.anchoredByIsrc += 1;
          summary.produced += 1;
          settleQueueRow(summary);
        } else if (verdict.anchored) {
          summary.anchoredBySearch += 1;
          summary.produced += 1;
          settleQueueRow(summary);
        } else {
          summary.missed += 1;
          settleQueueRow(summary);
        }
      } catch (error) {
        deps.log(`${row.trackId}: ${error instanceof Error ? error.message : String(error)}`);
        summary.skipped += 1;
        recordFailure(summary);
      }
    }
  }
}

function tallyFreeVerdict(
  verdict: AnchorVerdict,
  summary: AnchorSummary,
  askState: SpotifyAskState,
  deps: AnchorDeps,
): boolean {
  if (verdict.spotifyIsrcAsked) {
    askState.asksSpent += 1;
    summary.spotifyIsrcAsks += 1;
  }

  if (verdict.spotifyThrottled && !askState.yielded) {
    askState.yielded = true;
    deps.log("spotify throttled — yielding the rest of the tick's Spotify asks");
  }

  if (typeof verdict.freeDurationMsOmitted === "number") {
    summary.freeDurationMsOmitted += verdict.freeDurationMsOmitted;
  }

  if (verdict.isrcRecoveredByDeezer) {
    summary.isrcRecoveredByDeezer += 1;
  }

  tallyListenBrainzOutcome(summary, verdict);

  if (!verdict.anchored) {
    return false;
  }

  if (verdict.source === "spotify-isrc") {
    summary.anchoredBySpotifyIsrc += 1;
  } else if (verdict.source === "spotify-search") {
    summary.anchoredBySpotifySearch += 1;
  } else {
    summary.anchoredByListenbrainz += 1;
  }

  summary.produced += 1;
  settleQueueRow(summary);

  return true;
}

export async function runAnchorTick(
  limit: number,
  deps: AnchorDeps,
  actorChunkSize: number = APIFY_QUERY_CHUNK,
  askState: SpotifyAskState = newSpotifyAskState(),

  freeRungsOnly: boolean = false,
): Promise<AnchorSummary> {
  const summary: AnchorSummary = {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    apifyActorErrors: 0,
    apifyBudgetRemaining: null,
    apifyBudgetSkipped: 0,
    apifyDurationMsOmitted: 0,
    apifyResults: 0,
    apifyRowsSent: 0,
    apifySkippedAwaitingSpotify: 0,
    apifyTargetOmitted: 0,
    checked: 0,
    deezerHitsDroppedIncomplete: 0,
    deezerSearchFailed: 0,
    deferred: 0,
    error: null,
    errors: 0,
    expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
    failed: 0,
    freeDurationMsOmitted: 0,
    freeRungErrors: 0,
    isrcRecoveredByDeezer: 0,
    lbEmptyIds: 0,
    lbGateRejected: 0,
    lbMetadataFailed: 0,
    lbNoMap: 0,
    lbNoMbid: 0,
    lbNotAttempted: 0,
    lbRequestFailed: 0,
    lbYieldedOnBreaker: 0,
    missed: 0,
    ok: true,
    produced: 0,
    queueDepth: null,
    reason: null,
    rungsSkipped: [],
    skipped: 0,
    spotifyDeferredBudget: 0,
    spotifyDeferredWindow: 0,
    spotifyDeferredYield: 0,
    spotifyIsrcAsks: 0,
  };

  const queue = await fetchAnchorWorkRows(limit, deps, summary);
  if (queue === undefined) {
    return summary;
  }

  const { invalidRows, rows } = actionableAnchorRows(queue);
  summary.skipped += invalidRows;
  summary.failed += invalidRows;

  if (rows.length === 0) {
    return summary;
  }

  const apifyRows: { anchorQuery: string; stamped?: boolean; trackId: string }[] = [];
  let lastSearchStartMs: null | number = null;

  let apifyEnabled = true;

  let spotifySearchEnabled: boolean | undefined;

  for (const row of rows) {
    let deezerCandidates: DeezerCandidatePayload[] | undefined;

    if (row.deezerQuery) {
      const hits = await deps.searchDeezer(row.deezerQuery).catch(() => null);

      if (hits === null) {
        summary.deezerSearchFailed += 1;
        recordFailure(summary);
      } else if (Array.isArray(hits)) {
        deezerCandidates = hits;
      } else {
        deezerCandidates = hits.candidates;
        summary.deezerHitsDroppedIncomplete += hits.droppedIncomplete;
      }

      deezerCandidates ??= [];
    }

    const waitMs = spotifySearchPaceMs(lastSearchStartMs, deps.now());

    if (waitMs > 0) {
      await deps.sleep(waitMs);
    }

    const startMs = deps.now();

    const deferral = spotifyAskDeferral(askState, new Date(startMs));

    if (deferral === "budget") {
      summary.spotifyDeferredBudget += 1;
    } else if (deferral === "window") {
      summary.spotifyDeferredWindow += 1;
    } else if (deferral === "yield") {
      summary.spotifyDeferredYield += 1;
    }

    let rowStamped: boolean | undefined;

    try {
      const verdict = await deps.resolveFree(
        row.trackId,
        deezerCandidates,

        deferral === null ? undefined : { spotifySearch: false },
      );

      rowStamped = verdict.stamped;

      if (verdict.spotifySearchDone) {
        lastSearchStartMs = startMs;
      }

      apifyEnabled = verdict.apifyEnabled ?? apifyEnabled;
      spotifySearchEnabled = verdict.spotifySearchEnabled ?? spotifySearchEnabled;

      if (typeof verdict.apifyBudgetRemaining === "number") {
        summary.apifyBudgetRemaining = verdict.apifyBudgetRemaining;
      }

      if (tallyFreeVerdict(verdict, summary, askState, deps)) {
        continue;
      }

      if (verdict.apifyEligible === false) {
        if (verdict.apifyIneligibleReason === "apify_budget_spent") {
          summary.apifyBudgetSkipped += 1;
        } else {
          summary.apifySkippedAwaitingSpotify += 1;
        }

        summary.deferred += 1;
        continue;
      }
    } catch (error) {
      deps.log(
        `free rung ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.freeRungErrors += 1;
      recordFailure(summary);

      summary.skipped += 1;
      continue;
    }

    apifyRows.push({ ...row, stamped: rowStamped });
  }

  if (apifyEnabled === false && spotifySearchEnabled === false && summary.produced === 0) {
    summary.reason = "no_capable_rung";
  }

  if (apifyRows.length === 0) {
    return summary;
  }

  if (settleUnspentRows({ apifyEnabled, apifyRows, freeRungsOnly, summary })) {
    return summary;
  }

  await runApifyFallback(apifyRows, actorChunkSize, deps, summary);

  return summary;
}

async function fetchAnchorQueue(limit: number): Promise<AnchorQueuePage> {
  const attempt = () =>
    fetch(
      `${API_BASE_URL}/api/v1/admin/tracks/work?kind=anchor&limit=${limit}&count=true&debtAware=true`,
      {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  let res = await attempt().catch(() => undefined);

  if (res !== undefined && !res.ok) {
    await failureBodyUnlessRepairPending(res, "anchor queue read");
  }

  if (!res?.ok) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    res = await attempt();
  }

  if (!res.ok) {
    const body = await failureBodyUnlessRepairPending(res, "anchor queue read");
    throw new Error(`anchor queue read failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as { queued?: unknown; tracks?: unknown };

  throwIfPageRepairPending("anchor queue read", body);

  if (!Array.isArray(body.tracks)) {
    throw new Error("anchor queue read returned a non-array tracks body");
  }

  if (
    typeof body.queued !== "number" ||
    !Number.isInteger(body.queued) ||
    body.queued < body.tracks.length
  ) {
    throw new Error("anchor queue read returned an invalid whole-queue count");
  }

  return { queueDepth: body.queued, rows: body.tracks as AnchorWorkItem[] };
}

export async function runApifyActor(queries: string[]): Promise<ApifyResultItem[]> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  const res = await fetch(url, {
    body: JSON.stringify({
      searchKeywordLimit: SEARCH_KEYWORD_LIMIT,
      tracks: queries,
      tracksIncludeAlbum: true,
      tracksIncludeArtists: true,
      tracksIncludeAudioFeatures: false,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",

    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(`apify actor run failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as unknown;

  if (!Array.isArray(body)) {
    const preview = JSON.stringify(body) ?? String(body);

    throw new Error(
      `apify actor run failed (200): expected an array, got ${preview.slice(0, 200)}`,
    );
  }

  return body as ApifyResultItem[];
}

const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const DEEZER_TIMEOUT_MS = 10_000;

const DEEZER_SEARCH_LIMIT = 5;

const DEEZER_QUOTA_ERROR_CODE = 4;

const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

type DeezerAttempt =
  | ({ outcome: "ok" } & DeezerSearchResult)
  | { outcome: "failed" }
  | { outcome: "quota" };

async function attemptDeezerSearch(query: string): Promise<DeezerAttempt> {
  let res: Response;

  try {
    res = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch {
    return { outcome: "failed" };
  }

  if (!res.ok) {
    return { outcome: "failed" };
  }

  let body: unknown;

  try {
    body = await res.json();
  } catch {
    return { outcome: "failed" };
  }

  const parsed = body as {
    data?: {
      artist?: { name?: string };
      duration?: number;
      id?: number;
      isrc?: string;
      title?: string;
    }[];
    error?: { code?: unknown };
  };

  if (parsed.error) {
    return parsed.error.code === DEEZER_QUOTA_ERROR_CODE
      ? { outcome: "quota" }
      : { outcome: "failed" };
  }

  if (!Array.isArray(parsed.data)) {
    return { outcome: "failed" };
  }

  const candidates: DeezerCandidatePayload[] = [];
  let droppedIncomplete = 0;

  for (const hit of parsed.data) {
    const isrc = hit.isrc?.trim() ?? "";
    const title = hit.title?.trim() ?? "";
    const artistName = hit.artist?.name?.trim() ?? "";

    if (!isrc || !title || !artistName || typeof hit.duration !== "number" || hit.duration <= 0) {
      droppedIncomplete += 1;
      continue;
    }

    candidates.push({
      artistName,

      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title,
    });
  }

  return { candidates, droppedIncomplete, outcome: "ok" };
}

export async function searchDeezerOnBox(
  query: string,
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerSearchResult | null> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query);

    if (result.outcome === "ok") {
      return { candidates: result.candidates, droppedIncomplete: result.droppedIncomplete };
    }

    const delay = result.outcome === "quota" ? retryDelaysMs[attempt] : undefined;

    if (delay === undefined) {
      log(
        result.outcome === "quota"
          ? `deezer quota exhausted after ${attempt + 1} attempts`
          : "deezer search failed",
      );

      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function readAnchorPreflight(): Promise<AnchorPreflight> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor/breaker`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`anchor preflight read failed (${res.status})`);
  }

  const body = (await res.json()) as {
    rungs?: {
      apifyBudget?: { remainingRows?: number; spent?: boolean };
      apifyEnabled?: boolean;
      spotifySearchEnabled?: boolean;
    };
  };

  const budget = body.rungs?.apifyBudget;

  return {
    apifyBudgetRemaining: typeof budget?.remainingRows === "number" ? budget.remainingRows : 0,

    apifyBudgetSpent: budget?.spent === true,
    apifyEnabled: body.rungs?.apifyEnabled !== false,
    spotifySearchEnabled: body.rungs?.spotifySearchEnabled === true,
  };
}

async function reportAnchor(
  trackId: string,
  candidates: AnchorCandidatePayload[],
): Promise<AnchorVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor`, {
    body: JSON.stringify({ candidates, trackId }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `anchor_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  return { anchored: Boolean(body.anchored), verifiedBy: body.verifiedBy ?? null };
}

async function resolveAnchorFree(
  trackId: string,
  deezerCandidates?: DeezerCandidatePayload[],
  options?: { spotifySearch?: boolean },
): Promise<AnchorVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor/resolve`, {
    body: JSON.stringify({
      trackId,
      ...(deezerCandidates ? { deezerCandidates } : {}),
      ...(options?.spotifySearch === false ? { spotifySearch: false } : {}),
    }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `resolve_anchor ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  return {
    anchored: Boolean(body.anchored),
    apifyBudgetRemaining: body.apifyBudgetRemaining,

    apifyEligible: body.apifyEligible === undefined ? true : Boolean(body.apifyEligible),

    apifyEnabled: body.apifyEnabled === undefined ? true : Boolean(body.apifyEnabled),
    apifyIneligibleReason: body.apifyIneligibleReason ?? null,
    isrcRecoveredByDeezer: Boolean(body.isrcRecoveredByDeezer),
    listenbrainzOutcome: body.listenbrainzOutcome,
    source: body.source ?? null,
    spotifyIsrcAsked: Boolean(body.spotifyIsrcAsked),
    spotifySearchDone: Boolean(body.spotifySearchDone),
    spotifyThrottled: Boolean(body.spotifyThrottled),
    verifiedBy: body.verifiedBy ?? null,
  };
}

export async function runAnchorSweep(
  total: number,
  deps: AnchorDeps,
  pageLimit: number = PAGE_LIMIT,
): Promise<AnchorSummary & { pages: number; pulled: number }> {
  const merged = {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    apifyActorErrors: 0,
    apifyBudgetRemaining: null as null | number,
    apifyBudgetSkipped: 0,
    apifyDurationMsOmitted: 0,
    apifyResults: 0,
    apifyRowsSent: 0,
    apifySkippedAwaitingSpotify: 0,
    apifyTargetOmitted: 0,
    checked: 0,
    deezerHitsDroppedIncomplete: 0,
    deezerSearchFailed: 0,
    deferred: 0,
    error: null as null | string,
    errors: 0,
    expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
    failed: 0,
    freeDurationMsOmitted: 0,
    freeRungErrors: 0,
    isrcRecoveredByDeezer: 0,
    lbEmptyIds: 0,
    lbGateRejected: 0,
    lbMetadataFailed: 0,
    lbNoMap: 0,
    lbNoMbid: 0,
    lbNotAttempted: 0,
    lbRequestFailed: 0,
    lbYieldedOnBreaker: 0,
    missed: 0,
    ok: true,
    pages: 0,
    produced: 0,
    pulled: 0,
    queueDepth: null as null | number,
    reason: null as AnchorSummary["reason"],
    rungsSkipped: [] as string[],
    skipped: 0,
    spotifyDeferredBudget: 0,
    spotifyDeferredWindow: 0,
    spotifyDeferredYield: 0,
    spotifyIsrcAsks: 0,
  };

  const askState = newSpotifyAskState();

  let askArmed = false;

  let freeRungsOnly = false;

  if (deps.readPreflight) {
    const preflight = await deps.readPreflight().catch((error: unknown) => {
      deps.log(`preflight read failed: ${error instanceof Error ? error.message : String(error)}`);

      return undefined;
    });

    if (preflight) {
      merged.apifyBudgetRemaining = preflight.apifyBudgetRemaining;
      askArmed = preflight.apifyEnabled && preflight.spotifySearchEnabled;
      const deferral = anchorFiringDeferral(
        preflight,
        askState.askWindow,
        new Date(deps.now()),
        DAY_FREE_RUNGS,
      );

      if (deferral === "free_rungs_only") {
        freeRungsOnly = true;
        askArmed = false;
      } else if (deferral !== null) {
        merged.reason = deferral;
        merged.rungsSkipped = ["listenbrainz", "deezer-isrc-recovery", "spotify-search", "apify"];

        return merged;
      }
    }
  }

  let remaining = Math.max(0, Math.trunc(total));

  if (askArmed) {
    remaining = Math.min(remaining, askState.limit);
  }

  let noCapableRung = false;

  while (remaining > 0) {
    const ask = Math.min(pageLimit, remaining);
    const page = await runAnchorTick(ask, deps, APIFY_QUERY_CHUNK, askState, freeRungsOnly);
    const pulled = page.checked;

    merged.pages += 1;
    merged.pulled += pulled;
    merged.checked += page.checked;
    merged.produced += page.produced;

    merged.queueDepth = page.gateState === "paused" ? merged.queueDepth : page.queueDepth;
    merged.apifyActorErrors += page.apifyActorErrors;
    merged.apifyResults += page.apifyResults;
    merged.apifyRowsSent += page.apifyRowsSent;
    merged.apifySkippedAwaitingSpotify += page.apifySkippedAwaitingSpotify;
    merged.apifyBudgetSkipped += page.apifyBudgetSkipped;

    if (page.rungsSkipped.length > 0) {
      merged.rungsSkipped = page.rungsSkipped;
    }

    merged.apifyBudgetRemaining = page.apifyBudgetRemaining ?? merged.apifyBudgetRemaining;
    merged.anchoredByIsrc += page.anchoredByIsrc;
    merged.anchoredByListenbrainz += page.anchoredByListenbrainz;
    merged.anchoredBySearch += page.anchoredBySearch;
    merged.anchoredBySpotifyIsrc += page.anchoredBySpotifyIsrc;
    merged.anchoredBySpotifySearch += page.anchoredBySpotifySearch;
    merged.isrcRecoveredByDeezer += page.isrcRecoveredByDeezer;
    merged.lbEmptyIds += page.lbEmptyIds;
    merged.lbGateRejected += page.lbGateRejected;
    merged.lbMetadataFailed += page.lbMetadataFailed;
    merged.lbNoMbid += page.lbNoMbid;
    merged.lbNoMap += page.lbNoMap;
    merged.lbNotAttempted += page.lbNotAttempted;
    merged.lbRequestFailed += page.lbRequestFailed;
    merged.lbYieldedOnBreaker += page.lbYieldedOnBreaker;

    merged.apifyTargetOmitted += page.apifyTargetOmitted;
    merged.apifyDurationMsOmitted += page.apifyDurationMsOmitted;
    merged.deezerHitsDroppedIncomplete += page.deezerHitsDroppedIncomplete;
    merged.deezerSearchFailed += page.deezerSearchFailed;
    merged.failed += page.failed;
    merged.freeDurationMsOmitted += page.freeDurationMsOmitted;
    merged.freeRungErrors += page.freeRungErrors;
    merged.errors += page.errors;
    merged.missed += page.missed;
    merged.deferred += page.deferred;
    merged.skipped += page.skipped;

    if (page.reason === "no_capable_rung") {
      noCapableRung = true;
    }

    merged.spotifyDeferredBudget += page.spotifyDeferredBudget;
    merged.spotifyDeferredWindow += page.spotifyDeferredWindow;
    merged.spotifyDeferredYield += page.spotifyDeferredYield;
    merged.spotifyIsrcAsks += page.spotifyIsrcAsks;

    if (page.gateState === "paused") {
      Object.assign(merged, dueWorkRepairPendingGate(merged));
      break;
    }

    if (!page.ok) {
      merged.ok = false;
      merged.error ??= page.error;
      break;
    }

    if (pulled < ask) {
      break;
    }

    remaining -= pulled;
  }

  if (merged.reason === null && noCapableRung && merged.produced === 0) {
    merged.reason = "no_capable_rung";
  }

  return merged;
}

export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
        ok: false,
        produced: 0,
        queueDepth: null,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }

  if (!APIFY_API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
        ok: false,
        produced: 0,
        queueDepth: null,
        reason: "missing_apify_token",
      }),
    );
    process.exit(1);
  }

  const limit = parseLimitArg(
    process.argv.slice(2),
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 15,
  );

  const summary = await runAnchorSweep(limit, {
    fetchQueue: fetchAnchorQueue,
    log,
    now: () => Date.now(),
    readPreflight: readAnchorPreflight,
    report: reportAnchor,
    resolveFree: resolveAnchorFree,
    runActor: runApifyActor,
    searchDeezer: searchDeezerOnBox,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`anchor-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: 0,
        error: message,
        errors: 1,
        expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
        ok: false,
        produced: 0,
        queueDepth: null,
        reason: "anchor_failed",
      }),
    );
    process.exit(1);
  });
}
