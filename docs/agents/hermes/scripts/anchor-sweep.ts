#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";

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

const APIFY_API_BASE_URL = process.env.FLUNCLE_ANCHOR_APIFY_BASE_URL ?? "https://api.apify.com";

const APIFY_ACTOR = process.env.FLUNCLE_ANCHOR_ACTOR ?? "musicae~spotify-extended-scraper";

const BATCH = Number(process.env.FLUNCLE_ANCHOR_BATCH ?? "15");

const PAGE_LIMIT = 200;

const APIFY_QUERY_CHUNK = Number(process.env.FLUNCLE_ANCHOR_APIFY_CHUNK ?? "15");

const SEARCH_KEYWORD_LIMIT = Number(process.env.FLUNCLE_ANCHOR_KEYWORD_LIMIT ?? "3");

const ISRC_ASK_LIMIT = Number(process.env.FLUNCLE_ANCHOR_ISRC_ASK_LIMIT ?? "25");
const RELEASE_PROBE_LIMIT = Number(process.env.FLUNCLE_ANCHOR_RELEASE_PROBE_LIMIT ?? "40");
const RELEASE_PROBE_WALL_MS = 90_000;

const ISRC_WINDOW_UTC = process.env.FLUNCLE_ANCHOR_ISRC_WINDOW_UTC ?? "0-8";
const ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC = 9;

const DAY_FREE_RUNGS = process.env.FLUNCLE_ANCHOR_DAY_FREE_RUNGS === "1";

const ANCHOR_PROGRESS_DIR =
  process.env.FLUNCLE_ANCHOR_PROGRESS_DIR ??
  join(process.env.HOME ?? tmpdir(), ".fluncle-anchor-progress");
const ANCHOR_PAID_RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;
const ANCHOR_PAID_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const APIFY_START_GRACE_MS = 2 * 60 * 1000;
const APIFY_START_CLOCK_SKEW_MS = 20 * 60 * 1000;
const APIFY_START_LOOKUP_PAGE_SIZE = 25;
const APIFY_START_LOOKUP_MAX_RUNS = 50;

const ANCHOR_EXPECTED_INTERVAL_MS = 60 * 60 * 1000;
const ANCHOR_EXPECTED_SWEEP_MS = 15 * 60 * 1000;
const ANCHOR_CONTRACT_FAULT_ROWS = 2;
const ANCHOR_CONTRACT_FAULT_MIN_REPORTS = 15;
const ANCHOR_CONTRACT_FAULT_SHARE = 0.5;
const ANCHOR_REPORT_CONTRACT_ID = "anchor_track:v1";
const ANCHOR_BAKED_SCRIPT_SHA = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .digest("hex")
  .slice(0, 12);

const log = (message: string) => console.error(`[anchor-sweep] ${message}`);

export class AnchorAdmissionYieldError extends Error {
  constructor(readonly yieldReason: null | string) {
    super("anchor database admission yielded");
  }
}

type AnchorPhaseRequest = {
  body?: unknown;
  method: "GET" | "POST";
  path: string;
};

function directAnchorRequest(input: AnchorPhaseRequest): Promise<Response> {
  return fetch(`${API_BASE_URL}${input.path}`, {
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: input.method,
    signal: AbortSignal.timeout(30_000),
  });
}

async function runAnchorAdmissionRequest(input: AnchorPhaseRequest): Promise<Response> {
  if (process.env.FLUNCLE_ADMISSION_RUNNER_PID) {
    return directAnchorRequest(input);
  }
  const directory = mkdtempSync(join(tmpdir(), "fluncle-anchor-phase-"));
  const statePath = join(directory, "request.json");
  try {
    writeFileSync(statePath, JSON.stringify(input), { mode: 0o600 });
    const phase = runDatabaseAdmissionPhase({
      command: [process.execPath, import.meta.filename, "--admission-phase", statePath],
      owner: "fluncle-anchor",
      yieldRetries: 1,
    });
    if (phase.kind === "yielded") {
      throw new AnchorAdmissionYieldError(phase.yieldReason);
    }
    const result = JSON.parse(phase.stdout) as { body: string; status: number };
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
      throw new Error("anchor admission phase returned an invalid HTTP status");
    }
    return new Response(result.body, { status: result.status });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function runAnchorAdmissionChild(statePath: string): Promise<void> {
  const input = JSON.parse(readFileSync(statePath, "utf8")) as AnchorPhaseRequest;
  if (
    !["GET", "POST"].includes(input.method) ||
    !input.path.startsWith("/api/v1/admin/") ||
    input.path.includes("//")
  ) {
    throw new Error("invalid anchor admission phase request");
  }
  const response = await directAnchorRequest(input);
  console.log(JSON.stringify({ body: await response.text(), status: response.status }));
}

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

type AnchorPaidCheckpoint = {
  admittedAt?: number;
  allowPaid?: boolean;
  anchorQuery: string;
  actorQueries?: string[];
  actorStartedAt?: number;
  candidates?: AnchorCandidatePayload[];
  createdAt: number;
  evidence: string;
  paidResultToken?: string;
  receiptAt?: string;
  apifyRunId?: string;
  prepared: string;
  stage: "actor_started" | "admitted" | "commit" | "results";
  trackId: string;
};

function anchorCheckpointPath(trackId: string): string {
  const id = createHash("sha256").update(trackId).digest("hex");
  return join(ANCHOR_PROGRESS_DIR, `${id}.json`);
}

function durableAnchorCheckpoint(checkpoint: AnchorPaidCheckpoint): void {
  mkdirSync(ANCHOR_PROGRESS_DIR, { mode: 0o700, recursive: true });
  chmodSync(ANCHOR_PROGRESS_DIR, 0o700);
  const path = anchorCheckpointPath(checkpoint.trackId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(file, JSON.stringify(checkpoint));
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(ANCHOR_PROGRESS_DIR, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function createAnchorCheckpoint(checkpoint: AnchorPaidCheckpoint): void {
  mkdirSync(ANCHOR_PROGRESS_DIR, { mode: 0o700, recursive: true });
  chmodSync(ANCHOR_PROGRESS_DIR, 0o700);
  const path = anchorCheckpointPath(checkpoint.trackId);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(file, JSON.stringify(checkpoint));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    linkSync(temporary, path);
    const directory = openSync(ANCHOR_PROGRESS_DIR, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function clearAnchorCheckpoint(trackId: string): void {
  const path = anchorCheckpointPath(trackId);
  rmSync(path, { force: true });
  const directory = openSync(ANCHOR_PROGRESS_DIR, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function definitiveAnchorCommitRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

function definiteApifyStartRejection(status: number): boolean {
  return status === 429 || definitiveAnchorCommitRejection(status);
}

function readAnchorCheckpoint(trackId: string): AnchorPaidCheckpoint {
  const checkpoint = JSON.parse(
    readFileSync(anchorCheckpointPath(trackId), "utf8"),
  ) as AnchorPaidCheckpoint;
  if (
    checkpoint.trackId !== trackId ||
    !checkpoint.anchorQuery ||
    !checkpoint.prepared ||
    !checkpoint.evidence ||
    !["commit", "admitted", "actor_started", "results"].includes(checkpoint.stage) ||
    !Number.isSafeInteger(checkpoint.createdAt) ||
    (checkpoint.actorStartedAt !== undefined && !Number.isSafeInteger(checkpoint.actorStartedAt)) ||
    (checkpoint.actorQueries !== undefined &&
      (!Array.isArray(checkpoint.actorQueries) ||
        checkpoint.actorQueries.length === 0 ||
        !checkpoint.actorQueries.every((query) => typeof query === "string" && query.length > 0) ||
        !checkpoint.actorQueries.includes(checkpoint.anchorQuery)))
  ) {
    throw new Error(`invalid anchor paid checkpoint for ${trackId}`);
  }
  return checkpoint;
}

function listAnchorCheckpoints(): {
  checkpoints: AnchorPaidCheckpoint[];
  errors: { file: string; message: string }[];
} {
  mkdirSync(ANCHOR_PROGRESS_DIR, { mode: 0o700, recursive: true });
  const checkpoints: AnchorPaidCheckpoint[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const name of readdirSync(ANCHOR_PROGRESS_DIR).filter((file) => file.endsWith(".json"))) {
    try {
      const path = join(ANCHOR_PROGRESS_DIR, name);
      const checkpoint = JSON.parse(readFileSync(path, "utf8")) as AnchorPaidCheckpoint;
      if (path !== anchorCheckpointPath(checkpoint.trackId)) {
        throw new Error(`invalid anchor paid checkpoint filename ${name}`);
      }
      checkpoints.push(readAnchorCheckpoint(checkpoint.trackId));
    } catch (error) {
      errors.push({ file: name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checkpoints, errors };
}

export type AnchorVerdict = {
  anchored: boolean;
  anchoredByReleaseLink?: number;
  paidReceiptPending?: boolean;

  apifyBudgetRemaining?: number;

  apifyEligible?: boolean;

  apifyIneligibleReason?:
    | "apify_budget_spent"
    | "awaiting_free_ask"
    | "awaiting_paid_result"
    | null;

  paidResultToken?: string;

  apifyEnabled?: boolean;

  freeDurationMsOmitted?: number;

  isrcRecoveredByDeezer?: boolean;
  releaseLinkAlbumsFetched?: number;
  releaseLinkCacheHits?: number;
  releaseLinkNoAlbum?: number;
  releaseLinkBackoffSkipped?: number;
  releaseLinkAlbumFetchFailed?: number;

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

  source?:
    | "listenbrainz"
    | "listenbrainz-metadata"
    | "release-link"
    | "spotify-isrc"
    | "spotify-search"
    | null;

  spotifyIsrcAsked?: boolean;

  spotifySearchDone?: boolean;

  spotifySearchEnabled?: boolean;

  spotifyThrottled?: boolean;

  stamped?: boolean;

  verifiedBy: "isrc" | "search" | "search-subset" | null;
};

type AnchorReleaseVerdict = {
  albumFetchFailed: number;
  albumsFetched: number;
  anchored: boolean;
  anchoredCount: number;
  backoffSkipped: number;
  cacheHits: number;
  noAlbum: number;
  remainder?: null | number;
  throttled: boolean;
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
  gateReason?:
    | "breaker_quota"
    | "breaker_throttle"
    | "daily_budget"
    | "flag_off"
    | "friday_window"
    | "open"
    | "quota_hold"
    | "shared_meter";
  nextEligibleAt?: null | string;
};

export type AnchorQueuePage = {
  queueDepth: null | number;
  rows: AnchorWorkItem[];
};

export type AnchorSummary = {
  blockedReason: null | string;
  gateReason: null | string;
  nextEligibleAt: null | string;
  apifyActorErrors: number;

  apifyBudgetSkipped: number;

  rungsSkipped: string[];

  apifyBudgetRemaining: null | number;

  apifyResults: number;

  apifyRowsSent: number;

  apifySkippedAwaitingSpotify: number;

  apifySkippedAwaitingPaidResult: number;

  apifyTargetOmitted: number;

  apifyDurationMsOmitted: number;

  anchoredByIsrc: number;

  anchoredByListenbrainz: number;
  anchoredByListenbrainzMetadata: number;
  anchoredByReleaseLink: number;
  releaseLinkAlbumsFetched: number;
  releaseLinkCacheHits: number;
  releaseLinkNoAlbum: number;
  releaseLinkBackoffSkipped: number;
  releaseLinkAlbumFetchFailed: number;
  releaseLinkBudgetSkipped: number;
  releaseLinkErrors: number;
  releaseLinkProbes: number;

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
    | "database_admission"
    | "apify_disabled"
    | "apify_budget_spent"
    | "awaiting_free_ask"
    | "awaiting_paid_result"
    | "no_capable_rung"
    | null
    | typeof DUE_WORK_REPAIR_PENDING_REASON;

  skipped: number;

  spotifyIsrcAsks: number;

  spotifyIsrcDue: null | number;

  spotifyIsrcDueError: null | string;

  spotifyDeferredBudget: number;

  spotifyDeferredWindow: number;

  spotifyDeferredYield: number;
} & Partial<Omit<DueWorkRepairPendingGate, "reason">> & {
    admissionOutcome?: "phase-yielded";
    admissionYieldReason?: string;
  };

export type AnchorDeps = {
  blockedTrackIds?: ReadonlySet<string>;
  fetchQueue: (
    limit: number,
    paidMode?: "prior" | "quota",
  ) => Promise<AnchorQueuePage | AnchorWorkItem[]>;
  log: (message: string) => void;
  paidAdmissionDisabled?: boolean;

  now: () => number;
  report: (
    trackId: string,
    candidates: AnchorCandidatePayload[],
    paidResultToken?: string,
  ) => Promise<AnchorVerdict>;
  markPaidActorStarted?: (rows: readonly { trackId: string; paidResultToken?: string }[]) => void;
  cancelPaidActorStart?: (
    rows: readonly { trackId: string; paidResultToken?: string }[],
  ) => Promise<void>;
  cancelPaidActorRun?: (
    rows: readonly { trackId: string; paidResultToken?: string }[],
  ) => Promise<void>;
  resolvePaidReport?: (trackId: string) => Promise<void>;
  saveApifyRunId?: (
    rows: readonly { trackId: string; paidResultToken?: string }[],
    runId: string,
  ) => void;
  savePaidActorResults?: (
    rows: readonly { trackId: string; paidResultToken?: string }[],
    candidates: Map<string, AnchorCandidatePayload[]>,
  ) => void;
  recordInvalidFailure?: (trackId: string, status: number) => Promise<{ terminal: boolean }>;

  resolveFree: (
    trackId: string,
    deezerCandidates?: DeezerCandidatePayload[],
    options?: { allowPaid?: boolean; anchorQuery?: string; spotifySearch?: boolean },
  ) => Promise<AnchorVerdict>;
  resolveFreeBatch?: (
    rows: readonly {
      allowPaid: boolean;
      anchorQuery: string;
      deezerCandidates?: DeezerCandidatePayload[];
      spotifySearch: boolean;
      trackId: string;
    }[],
  ) => Promise<
    (
      | { status: "done"; verdict: AnchorVerdict }
      | { status: "deferred" | "error"; error?: string }
    )[]
  >;
  resolveRelease?: (trackId: string, spotifySearch: boolean) => Promise<AnchorReleaseVerdict>;
  runActor: (queries: string[], onStarted?: (runId: string) => void) => Promise<ApifyResultItem[]>;

  searchDeezer: (query: string) => Promise<DeezerCandidatePayload[] | DeezerSearchResult | null>;

  readPreflight?: () => Promise<AnchorPreflight>;
  readIsrcDue?: () => Promise<null | number>;

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

function pauseAnchorAdmission(summary: AnchorSummary, error: AnchorAdmissionYieldError): void {
  const blockedReason = summary.blockedReason ?? "database_admission";
  Object.assign(
    summary,
    databaseAdmissionYieldSummary({
      admissionYieldReason: error.yieldReason ?? undefined,
      blockedReason,
      checked: summary.checked,
      error: summary.error,
      errors: summary.errors,
      failed: summary.failed,
      ok: summary.ok,
      produced: summary.produced,
      queueDepth: summary.queueDepth,
    }),
  );
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
  const track = Array.isArray(item.tracks) ? item.tracks[0] : undefined;
  const spotifyTrackId = typeof track?.track_id === "string" ? track.track_id.trim() : "";

  if (item.success === false || !track || !spotifyTrackId) {
    return null;
  }

  const candidate: AnchorCandidatePayload = {
    albumImageUrl:
      (typeof track.track_image === "string" ? track.track_image : null) ??
      (Array.isArray(item.albums) && typeof item.albums[0]?.album_image === "string"
        ? item.albums[0].album_image
        : null),
    artists: (Array.isArray(item.artists) ? item.artists : [])
      .filter(
        (artist): artist is ApifyArtist & { artist_name: string } =>
          typeof artist?.artist_name === "string" && artist.artist_name.length > 0,
      )
      .map((artist) => ({
        id: typeof artist.artist_id === "string" ? artist.artist_id : null,
        name: artist.artist_name,
      })),
    durationMs:
      typeof track.track_duration_ms === "number" && Number.isFinite(track.track_duration_ms)
        ? track.track_duration_ms
        : null,
    isrc: typeof track.track_isrc === "string" ? track.track_isrc : null,
    spotifyTrackId,
    title: typeof track.track_name === "string" ? track.track_name : "",
  };
  if (
    candidate.spotifyTrackId.length > 64 ||
    candidate.title.length > 300 ||
    (candidate.isrc?.length ?? 0) > 64 ||
    (candidate.albumImageUrl?.length ?? 0) > 2048 ||
    candidate.artists.length > 20 ||
    candidate.artists.some((artist) => artist.name.length > 300 || (artist.id?.length ?? 0) > 64)
  ) {
    return null;
  }
  return candidate;
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
      if (bucket.length < 100) {
        bucket.push(candidate);
      }
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
  releaseProbes: number;
  releaseProbeLimit: number;
  releaseDeadline: number;
};

export function newSpotifyAskState(
  limit: number = ISRC_ASK_LIMIT,
  windowUtc: string | undefined = ISRC_WINDOW_UTC,
): SpotifyAskState {
  return {
    askWindow: parseIsrcAskWindow(windowUtc),
    asksSpent: 0,
    limit: Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 0,
    releaseDeadline: Date.now() + RELEASE_PROBE_WALL_MS,
    releaseProbeLimit:
      Number.isFinite(RELEASE_PROBE_LIMIT) && RELEASE_PROBE_LIMIT >= 0
        ? Math.trunc(RELEASE_PROBE_LIMIT)
        : 40,
    releaseProbes: 0,
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

function longAnchorThrottle(preflight: AnchorPreflight, now: Date): boolean {
  return (
    preflight.gateReason === "breaker_throttle" &&
    Date.parse(preflight.nextEligibleAt ?? "") - now.getTime() > ANCHOR_EXPECTED_SWEEP_MS
  );
}

export function anchorFiringDeferral(
  preflight: AnchorPreflight,
  askWindow: IsrcAskWindow,
  now: Date,
  dayFreeRungs: boolean = false,
): "apify_disabled" | "apify_budget_spent" | "awaiting_free_ask" | "free_rungs_only" | null {
  if (preflight.gateReason === "friday_window") {
    return "awaiting_free_ask";
  }
  if (
    preflight.gateReason !== undefined &&
    ![
      "breaker_quota",
      "breaker_throttle",
      "daily_budget",
      "flag_off",
      "friday_window",
      "open",
      "quota_hold",
      "shared_meter",
    ].includes(preflight.gateReason)
  ) {
    return "awaiting_free_ask";
  }
  if (
    preflight.gateReason === "breaker_quota" ||
    preflight.gateReason === "quota_hold" ||
    preflight.gateReason === "daily_budget" ||
    longAnchorThrottle(preflight, now)
  ) {
    return !preflight.apifyEnabled
      ? "apify_disabled"
      : preflight.apifyBudgetSpent
        ? "apify_budget_spent"
        : null;
  }
  if (!preflight.apifyEnabled) {
    return null;
  }
  if (preflight.apifyBudgetSpent) {
    return "free_rungs_only";
  }

  const deferral =
    preflight.spotifySearchEnabled && !withinIsrcAskWindow(askWindow, now)
      ? "awaiting_free_ask"
      : null;

  return deferral !== null && dayFreeRungs ? "free_rungs_only" : deferral;
}

async function fetchAnchorWorkRows(
  limit: number,
  deps: AnchorDeps,
  summary: AnchorSummary,
  paidMode?: "prior" | "quota",
): Promise<AnchorWorkItem[] | undefined> {
  try {
    const fetched = await deps.fetchQueue(limit, paidMode);
    const queue = Array.isArray(fetched) ? fetched : fetched.rows;
    summary.queueDepth = Array.isArray(fetched) ? fetched.length : fetched.queueDepth;
    summary.checked = queue.length;
    return queue;
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      pauseAnchorAdmission(summary, error);
      return undefined;
    }
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

type AnchorStrikeBuffer = {
  fault: boolean;
  reported: number;
  rows: Map<string, { status: number; summary: AnchorSummary }>;
};

function systemicAnchorContractFault(strikes: AnchorStrikeBuffer): boolean {
  return (
    strikes.rows.size > ANCHOR_CONTRACT_FAULT_ROWS &&
    strikes.rows.size / strikes.reported >= ANCHOR_CONTRACT_FAULT_SHARE
  );
}

function markAnchorContractFault(
  deps: Pick<AnchorDeps, "log">,
  strikes: AnchorStrikeBuffer,
  summary: AnchorSummary,
): void {
  if (strikes.fault) {
    return;
  }
  strikes.fault = true;
  summary.ok = false;
  summary.blockedReason = "anchor_contract_fault";
  const message = `anchor contract fault: contract=${ANCHOR_REPORT_CONTRACT_ID} build=${ANCHOR_BAKED_SCRIPT_SHA} distinctRows=${strikes.rows.size} reported=${strikes.reported}`;
  deps.log(message);
  recordRunError(summary, message);
}

async function flushAnchorStrikes(
  deps: Pick<AnchorDeps, "log" | "recordInvalidFailure">,
  strikes: AnchorStrikeBuffer,
  summary: AnchorSummary,
): Promise<{ error: null | string; terminal: number }> {
  if (systemicAnchorContractFault(strikes)) {
    markAnchorContractFault(deps, strikes, summary);
  }
  if (strikes.fault) {
    return { error: null, terminal: 0 };
  }
  let firstError: null | string = null;
  let terminal = 0;
  for (const [trackId, { status, summary }] of strikes.rows) {
    try {
      const recorded = await deps.recordInvalidFailure?.(trackId, status);
      if (recorded?.terminal) {
        settleQueueRow(summary);
        terminal += 1;
      }
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        throw error;
      }
      summary.ok = false;
      const message = error instanceof Error ? error.message : String(error);
      firstError ??= message;
      recordRunError(summary, message);
    }
  }
  return { error: firstError, terminal };
}

// oxlint-disable-next-line complexity
async function runApifyFallback(
  apifyRows: readonly { anchorQuery: string; paidResultToken?: string; trackId: string }[],
  actorChunkSize: number,
  deps: AnchorDeps,
  summary: AnchorSummary,
  strikes: AnchorStrikeBuffer,
  flushStrikes: boolean,
): Promise<void> {
  for (const batch of chunk(apifyRows, actorChunkSize)) {
    if (strikes.fault) {
      break;
    }
    let items: ApifyResultItem[];

    try {
      deps.markPaidActorStarted?.(batch);
    } catch (error) {
      summary.ok = false;
      summary.blockedReason = "paid_result_recovery";
      recordRunError(summary, error instanceof Error ? error.message : String(error));
      return;
    }

    try {
      items = await deps.runActor(
        batch.map((row) => row.anchorQuery),
        (runId) => deps.saveApifyRunId?.(batch, runId),
      );
    } catch (error) {
      deps.log(`actor run failed: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof ApifyStartError || error instanceof ApifyTerminalRunError) {
        try {
          if (error instanceof ApifyStartError) {
            await deps.cancelPaidActorStart?.(batch);
          } else {
            await deps.cancelPaidActorRun?.(batch);
          }
        } catch (cancelError) {
          if (cancelError instanceof AnchorAdmissionYieldError) {
            throw cancelError;
          }
          summary.blockedReason = "paid_result_recovery";
          summary.ok = false;
          recordRunError(
            summary,
            cancelError instanceof Error ? cancelError.message : String(cancelError),
          );
        }
      } else {
        summary.blockedReason = "paid_result_recovery";
        summary.ok = false;
        recordRunError(summary, error instanceof Error ? error.message : String(error));
      }
      summary.apifyActorErrors += 1;
      summary.skipped += batch.length;
      summary.deferred += batch.length;
      return;
    }
    summary.apifyResults += items.length;
    const byTarget = groupCandidatesByTarget(items);
    try {
      deps.savePaidActorResults?.(
        batch,
        new Map(batch.map((row) => [row.trackId, byTarget.get(row.anchorQuery) ?? []])),
      );
    } catch (error) {
      summary.ok = false;
      summary.blockedReason = "paid_result_recovery";
      recordRunError(summary, error instanceof Error ? error.message : String(error));
      return;
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
        strikes.reported += 1;
        const verdict = await deps.report(row.trackId, candidates, row.paidResultToken);
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
        if (error instanceof AnchorAdmissionYieldError) {
          throw error;
        }
        if (error instanceof AnchorReportError && (error.status === 404 || error.status === 409)) {
          try {
            if (!deps.resolvePaidReport) {
              throw new Error(`anchor ${row.trackId} has no exact paid report resolver`);
            }
            await deps.resolvePaidReport(row.trackId);
            summary.deferred += 1;
            continue;
          } catch (resolveError) {
            if (resolveError instanceof AnchorAdmissionYieldError) {
              throw resolveError;
            }
            deps.log(
              `${row.trackId}: ${resolveError instanceof Error ? resolveError.message : String(resolveError)}`,
            );
            summary.blockedReason = "paid_result_recovery";
            summary.deferred += 1;
            continue;
          }
        }
        deps.log(`${row.trackId}: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof AnchorReportError && (error.status === 400 || error.status === 422)) {
          if (!strikes.fault) {
            strikes.rows.set(row.trackId, { status: error.status, summary });
          }
          if (
            !strikes.fault &&
            strikes.reported >= ANCHOR_CONTRACT_FAULT_MIN_REPORTS &&
            systemicAnchorContractFault(strikes)
          ) {
            markAnchorContractFault(deps, strikes, summary);
          }
        }
        summary.skipped += 1;
        recordFailure(summary);
      }
    }
  }
  if (flushStrikes) {
    await flushAnchorStrikes(deps, strikes, summary);
  }
}

async function finishAnchorTick(input: {
  actorChunkSize: number;
  apifyEnabled: boolean;
  apifyRows: {
    anchorQuery: string;
    paidResultToken?: string;
    stamped?: boolean;
    trackId: string;
  }[];
  deps: AnchorDeps;
  flushStrikes: boolean;
  freeRungsOnly: boolean;
  spotifySearchEnabled: boolean | undefined;
  strikes: AnchorStrikeBuffer;
  summary: AnchorSummary;
}): Promise<void> {
  const {
    actorChunkSize,
    apifyEnabled,
    apifyRows,
    deps,
    flushStrikes,
    freeRungsOnly,
    spotifySearchEnabled,
    strikes,
    summary,
  } = input;
  if (apifyEnabled === false && spotifySearchEnabled === false && summary.produced === 0) {
    summary.reason = "no_capable_rung";
  }
  if (apifyRows.length === 0) {
    return;
  }
  if (settleUnspentRows({ apifyEnabled, apifyRows, freeRungsOnly, summary })) {
    return;
  }
  await runApifyFallback(apifyRows, actorChunkSize, deps, summary, strikes, flushStrikes);
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
  summary.anchoredByReleaseLink += verdict.anchoredByReleaseLink ?? 0;
  summary.releaseLinkAlbumsFetched += verdict.releaseLinkAlbumsFetched ?? 0;
  summary.releaseLinkCacheHits += verdict.releaseLinkCacheHits ?? 0;
  summary.releaseLinkNoAlbum += verdict.releaseLinkNoAlbum ?? 0;
  summary.releaseLinkBackoffSkipped += verdict.releaseLinkBackoffSkipped ?? 0;
  summary.releaseLinkAlbumFetchFailed += verdict.releaseLinkAlbumFetchFailed ?? 0;
  summary.produced += verdict.anchoredByReleaseLink ?? 0;
  if (summary.queueDepth !== null) {
    summary.queueDepth = Math.max(0, summary.queueDepth - (verdict.anchoredByReleaseLink ?? 0));
  }

  if (!verdict.anchored) {
    return false;
  }

  if (verdict.source === "release-link") {
    return true;
  }
  if (verdict.source === "listenbrainz-metadata") {
    summary.anchoredByListenbrainzMetadata += 1;
  } else if (verdict.source === "spotify-isrc") {
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

function tallyApifyDeferral(summary: AnchorSummary, verdict: AnchorVerdict): void {
  if (verdict.apifyIneligibleReason === "apify_budget_spent") {
    summary.apifyBudgetSkipped += 1;
  } else if (verdict.apifyIneligibleReason === "awaiting_paid_result") {
    summary.apifySkippedAwaitingPaidResult += 1;
  } else {
    summary.apifySkippedAwaitingSpotify += 1;
  }
  summary.deferred += 1;
}

// oxlint-disable-next-line complexity
async function runAnchorTickBatched(input: {
  actorChunkSize: number;
  askState: SpotifyAskState;
  deps: AnchorDeps;
  flushStrikes: boolean;
  freeRungsOnly: boolean;
  rows: (AnchorWorkItem & { anchorQuery: string; trackId: string })[];
  strikes: AnchorStrikeBuffer;
  summary: AnchorSummary;
}): Promise<AnchorSummary> {
  const { actorChunkSize, askState, deps, flushStrikes, freeRungsOnly, rows, strikes, summary } =
    input;
  if (!deps.resolveFreeBatch) {
    throw new Error("anchor batch resolver is unavailable");
  }
  let apifyEnabled = true;
  let paidDisabled = freeRungsOnly;
  let spotifySearchEnabled: boolean | undefined;
  for (const batch of chunk(rows, 15)) {
    const apifyRows: {
      anchorQuery: string;
      paidResultToken?: string;
      stamped?: boolean;
      trackId: string;
    }[] = [];
    const requests: {
      allowPaid: boolean;
      anchorQuery: string;
      deezerCandidates?: DeezerCandidatePayload[];
      spotifySearch: boolean;
      trackId: string;
    }[] = [];
    for (const row of batch) {
      if (deps.blockedTrackIds?.has(row.trackId)) {
        summary.deferred += 1;
        continue;
      }
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
      const deferral = spotifyAskDeferral(askState, new Date(deps.now()));
      const spotifySearch =
        deferral === null && askState.asksSpent + requests.length < askState.limit;
      if (!spotifySearch) {
        if (deferral === "window") {
          summary.spotifyDeferredWindow += 1;
        } else if (deferral === "yield") {
          summary.spotifyDeferredYield += 1;
        } else {
          summary.spotifyDeferredBudget += 1;
        }
      }
      requests.push({
        allowPaid: !paidDisabled && summary.blockedReason !== "paid_result_recovery",
        anchorQuery: row.anchorQuery,
        deezerCandidates,
        spotifySearch,
        trackId: row.trackId,
      });
    }
    let outcomes: Awaited<ReturnType<NonNullable<AnchorDeps["resolveFreeBatch"]>>>;
    try {
      const settled = new Map<number, (typeof outcomes)[number]>();
      const releaseFields = new Map<
        number,
        Pick<
          AnchorVerdict,
          | "anchoredByReleaseLink"
          | "releaseLinkAlbumsFetched"
          | "releaseLinkCacheHits"
          | "releaseLinkNoAlbum"
          | "releaseLinkBackoffSkipped"
          | "releaseLinkAlbumFetchFailed"
        >
      >();
      const phaseRequests: typeof requests = [];
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        if (!request) {
          continue;
        }
        if (!deps.resolveRelease) {
          phaseRequests.push(request);
          continue;
        }
        if (
          askState.releaseProbes >= askState.releaseProbeLimit ||
          Date.now() >= askState.releaseDeadline
        ) {
          summary.releaseLinkBudgetSkipped += 1;
          phaseRequests.push(request);
          continue;
        }
        askState.releaseProbes += 1;
        summary.releaseLinkProbes += 1;
        try {
          const release = await deps.resolveRelease(
            request.trackId,
            request.spotifySearch && !askState.yielded,
          );
          const fields = {
            anchoredByReleaseLink: release.anchoredCount,
            releaseLinkAlbumFetchFailed: release.albumFetchFailed,
            releaseLinkAlbumsFetched: release.albumsFetched,
            releaseLinkBackoffSkipped: release.backoffSkipped,
            releaseLinkCacheHits: release.cacheHits,
            releaseLinkNoAlbum: release.noAlbum,
          };
          releaseFields.set(index, fields);
          if (release.throttled && !askState.yielded) {
            askState.yielded = true;
            deps.log("spotify throttled — yielding the rest of the tick's Spotify asks");
          }
          if (release.anchored) {
            settled.set(index, {
              status: "done",
              verdict: {
                anchored: release.anchored,
                apifyEligible: false,
                ...fields,
                listenbrainzOutcome: "not-attempted",
                source: release.anchored ? "release-link" : null,
                spotifyThrottled: release.throttled,
                verifiedBy: release.verifiedBy,
              },
            });
          } else {
            phaseRequests.push(request);
          }
        } catch (error) {
          if (error instanceof AnchorAdmissionYieldError) {
            throw error;
          }
          summary.releaseLinkErrors += 1;
          deps.log(
            `release rung ${request.trackId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          phaseRequests.push(request);
        }
      }
      if (askState.yielded) {
        for (const request of phaseRequests) {
          request.spotifySearch = false;
        }
      }
      const phaseOutcomes =
        phaseRequests.length > 0 ? await deps.resolveFreeBatch(phaseRequests) : [];
      let phaseIndex = 0;
      outcomes = requests.map((_request, index) => {
        const done = settled.get(index);
        if (done) {
          return done;
        }
        const phase = phaseOutcomes[phaseIndex++];
        if (!phase || phase.status !== "done") {
          return phase ?? { status: "deferred" };
        }
        return {
          status: "done",
          verdict: { ...phase.verdict, ...releaseFields.get(index) },
        };
      });
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        pauseAnchorAdmission(summary, error);
        return summary;
      }
      summary.ok = false;
      recordRunError(summary, error instanceof Error ? error.message : String(error));
      return summary;
    }
    if (outcomes.length !== requests.length) {
      summary.ok = false;
      recordRunError(summary, "anchor batch resolver returned a different row count");
      return summary;
    }
    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i];
      const outcome = outcomes[i];
      if (!request || !outcome) {
        continue;
      }
      if (outcome.status === "deferred") {
        summary.deferred += 1;
        continue;
      }
      if (outcome.status === "error") {
        if (outcome.error?.includes("already has a paid checkpoint")) {
          summary.deferred += 1;
          summary.blockedReason = "paid_result_recovery";
          paidDisabled = true;
          continue;
        }
        deps.log(`free rung ${request.trackId}: ${outcome.error ?? "batch error"}`);
        summary.freeRungErrors += 1;
        summary.skipped += 1;
        recordFailure(summary);
        continue;
      }
      const verdict = outcome.verdict;
      apifyEnabled = verdict.apifyEnabled ?? apifyEnabled;
      spotifySearchEnabled = verdict.spotifySearchEnabled ?? spotifySearchEnabled;
      if (typeof verdict.apifyBudgetRemaining === "number") {
        summary.apifyBudgetRemaining = verdict.apifyBudgetRemaining;
      }
      if (tallyFreeVerdict(verdict, summary, askState, deps)) {
        continue;
      }
      if (verdict.apifyEligible === false) {
        tallyApifyDeferral(summary, verdict);
        continue;
      }
      apifyRows.push({
        anchorQuery: request.anchorQuery,
        paidResultToken: verdict.paidResultToken,
        stamped: verdict.stamped,
        trackId: request.trackId,
      });
    }
    try {
      await finishAnchorTick({
        actorChunkSize,
        apifyEnabled,
        apifyRows,
        deps,
        flushStrikes: false,
        freeRungsOnly: paidDisabled || summary.blockedReason === "paid_result_recovery",
        spotifySearchEnabled,
        strikes,
        summary,
      });
      if (
        summary.apifyActorErrors > 0 ||
        summary.blockedReason === "paid_result_recovery" ||
        strikes.fault
      ) {
        paidDisabled = true;
      }
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        pauseAnchorAdmission(summary, error);
        return summary;
      }
      throw error;
    }
  }
  if (flushStrikes && strikes.rows.size > 0) {
    try {
      await flushAnchorStrikes(deps, strikes, summary);
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        pauseAnchorAdmission(summary, error);
      } else {
        throw error;
      }
    }
  }
  return summary;
}

// oxlint-disable-next-line complexity
export async function runAnchorTick(
  limit: number,
  deps: AnchorDeps,
  actorChunkSize: number = APIFY_QUERY_CHUNK,
  askState: SpotifyAskState = newSpotifyAskState(),

  freeRungsOnly: boolean = false,
  paidMode?: "prior" | "quota",
  strikes: AnchorStrikeBuffer = { fault: false, reported: 0, rows: new Map() },
  flushStrikes: boolean = true,
): Promise<AnchorSummary> {
  const summary: AnchorSummary = {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredByListenbrainzMetadata: 0,
    anchoredByReleaseLink: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    apifyActorErrors: 0,
    apifyBudgetRemaining: null,
    apifyBudgetSkipped: 0,
    apifyDurationMsOmitted: 0,
    apifyResults: 0,
    apifyRowsSent: 0,
    apifySkippedAwaitingPaidResult: 0,
    apifySkippedAwaitingSpotify: 0,
    apifyTargetOmitted: 0,
    blockedReason: null,
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
    gateReason: null,
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
    nextEligibleAt: null,
    ok: true,
    produced: 0,
    queueDepth: null,
    reason: null,
    releaseLinkAlbumFetchFailed: 0,
    releaseLinkAlbumsFetched: 0,
    releaseLinkBackoffSkipped: 0,
    releaseLinkBudgetSkipped: 0,
    releaseLinkCacheHits: 0,
    releaseLinkErrors: 0,
    releaseLinkNoAlbum: 0,
    releaseLinkProbes: 0,
    rungsSkipped: [],
    skipped: 0,
    spotifyDeferredBudget: 0,
    spotifyDeferredWindow: 0,
    spotifyDeferredYield: 0,
    spotifyIsrcAsks: 0,
    spotifyIsrcDue: null,
    spotifyIsrcDueError: null,
  };

  const queue = await fetchAnchorWorkRows(limit, deps, summary, paidMode);
  if (queue === undefined) {
    return summary;
  }

  const { invalidRows, rows: actionableRows } = actionableAnchorRows(queue);
  summary.skipped += invalidRows;
  summary.failed += invalidRows;
  const rows = actionableRows.filter((row) => !deps.blockedTrackIds?.has(row.trackId));
  summary.deferred += actionableRows.length - rows.length;

  if (rows.length === 0) {
    return summary;
  }

  const apifyRows: {
    anchorQuery: string;
    paidResultToken?: string;
    stamped?: boolean;
    trackId: string;
  }[] = [];
  let lastSearchStartMs: null | number = null;

  let apifyEnabled = true;

  let spotifySearchEnabled: boolean | undefined;

  if (deps.resolveFreeBatch) {
    return runAnchorTickBatched({
      actorChunkSize,
      askState,
      deps,
      flushStrikes,
      freeRungsOnly,
      rows,
      strikes,
      summary,
    });
  }

  for (const row of rows) {
    if (deps.blockedTrackIds?.has(row.trackId)) {
      summary.deferred += 1;
      continue;
    }
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
    let verdictPaidResultToken: string | undefined;

    try {
      const verdict = await deps.resolveFree(row.trackId, deezerCandidates, {
        anchorQuery: row.anchorQuery,
        ...(freeRungsOnly ? { allowPaid: false } : {}),
        ...(deferral === null ? {} : { spotifySearch: false }),
      });

      rowStamped = verdict.stamped;
      verdictPaidResultToken = verdict.paidResultToken;

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
        tallyApifyDeferral(summary, verdict);
        continue;
      }
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        pauseAnchorAdmission(summary, error);
        return summary;
      }
      deps.log(
        `free rung ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.freeRungErrors += 1;
      recordFailure(summary);

      summary.skipped += 1;
      continue;
    }

    apifyRows.push({
      ...row,
      paidResultToken: verdictPaidResultToken,
      stamped: rowStamped,
    });
  }

  try {
    await finishAnchorTick({
      actorChunkSize,
      apifyEnabled,
      apifyRows,
      deps,
      flushStrikes,
      freeRungsOnly,
      spotifySearchEnabled,
      strikes,
      summary,
    });
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      pauseAnchorAdmission(summary, error);
    } else {
      throw error;
    }
  }

  return summary;
}

async function fetchAnchorQueue(
  limit: number,
  paidMode?: "prior" | "quota",
): Promise<AnchorQueuePage> {
  const mode = paidMode ? `&paidMode=${paidMode}` : "";
  const attempt = () =>
    runAnchorAdmissionRequest({
      method: "GET",
      path: `/api/v1/admin/tracks/work?kind=anchor&limit=${limit}&count=${paidMode ? "false" : "true"}&debtAware=true${mode}`,
    });
  let res: Response | undefined;
  try {
    res = await attempt();
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      throw error;
    }
  }

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
    (!paidMode && typeof body.queued !== "number") ||
    (typeof body.queued === "number" &&
      (!Number.isInteger(body.queued) || body.queued < body.tracks.length))
  ) {
    throw new Error("anchor queue read returned an invalid whole-queue count");
  }

  return {
    queueDepth: typeof body.queued === "number" ? body.queued : null,
    rows: body.tracks as AnchorWorkItem[],
  };
}

export async function readAnchorIsrcDue(fetcher?: typeof fetch): Promise<number> {
  const path = "/api/v1/admin/tracks/work?kind=anchor&limit=1&count=false&paidMode=unasked";
  const response = fetcher
    ? await fetcher(`${API_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      })
    : await runAnchorAdmissionRequest({ method: "GET", path });
  if (!response.ok) {
    throw new Error(`anchor ISRC due probe failed (${response.status})`);
  }
  const body = (await response.json()) as { tracks?: unknown };
  if (!Array.isArray(body.tracks) || body.tracks.length > 1) {
    throw new Error("anchor ISRC due probe returned an invalid worklist");
  }
  return body.tracks.length;
}

export class ApifyStartError extends Error {}
export class ApifyTerminalRunError extends Error {}

export async function runApifyActor(
  queries: string[],
  onStarted?: (runId: string) => void,
): Promise<ApifyResultItem[]> {
  const url = `${APIFY_API_BASE_URL}/v2/acts/${APIFY_ACTOR}/runs`;
  const res = await fetch(url, {
    body: JSON.stringify({
      searchKeywordLimit: SEARCH_KEYWORD_LIMIT,
      tracks: queries,
      tracksIncludeAlbum: true,
      tracksIncludeArtists: true,
      tracksIncludeAudioFeatures: false,
    }),
    headers: { Authorization: `Bearer ${APIFY_API_TOKEN}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const message = `apify actor start failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
    if (definiteApifyStartRejection(res.status)) {
      throw new ApifyStartError(message);
    }
    throw new Error(message);
  }

  const body = (await res.json()) as { data?: { id?: unknown } };
  const runId = body.data?.id;
  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("apify actor start returned no usable run ID");
  }
  onStarted?.(runId);
  return recoverApifyActor(runId);
}

async function readApifyActorOnce(runId: string): Promise<ApifyResultItem[] | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("invalid Apify run ID in anchor checkpoint");
  }
  const statusResponse = await fetch(
    `${APIFY_API_BASE_URL}/v2/actor-runs/${runId}?waitForFinish=30`,
    {
      headers: { Authorization: `Bearer ${APIFY_API_TOKEN}` },
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!statusResponse.ok) {
    throw new Error(`apify run ${runId} read failed (${statusResponse.status})`);
  }
  const statusBody = (await statusResponse.json()) as { data?: { status?: unknown } };
  const status = statusBody.data?.status;
  if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
    throw new ApifyTerminalRunError(`apify run ${runId} ended with ${status}`);
  }
  if (
    status === "READY" ||
    status === "RUNNING" ||
    status === "TIMING-OUT" ||
    status === "ABORTING"
  ) {
    return null;
  }
  if (status !== "SUCCEEDED") {
    throw new Error(`apify run ${runId} ended with ${String(status)}`);
  }

  const datasetResponse = await fetch(
    `${APIFY_API_BASE_URL}/v2/actor-runs/${runId}/dataset/items`,
    {
      headers: { Authorization: `Bearer ${APIFY_API_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!datasetResponse.ok) {
    throw new Error(`apify run ${runId} dataset read failed (${datasetResponse.status})`);
  }

  const items = (await datasetResponse.json()) as unknown;

  if (!Array.isArray(items)) {
    const preview = JSON.stringify(items) ?? String(items);

    throw new Error(
      `apify run ${runId} dataset failed (200): expected an array, got ${preview.slice(0, 200)}`,
    );
  }

  return items as ApifyResultItem[];
}

export async function recoverApifyActor(runId: string): Promise<ApifyResultItem[]> {
  const deadline = Date.now() + 25 * 60 * 1000;
  while (true) {
    const items = await readApifyActorOnce(runId);
    if (items !== null) {
      return items;
    }
    if (Date.now() >= deadline) {
      throw new Error(`apify run ${runId} did not finish within 25 minutes`);
    }
    await Bun.sleep(1000);
  }
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
  const res = await runAnchorAdmissionRequest({
    method: "GET",
    path: "/api/v1/admin/catalogue/anchor/breaker",
  });

  if (!res.ok) {
    throw new Error(`anchor preflight read failed (${res.status})`);
  }

  const body = (await res.json()) as {
    rungs?: {
      apifyBudget?: { remainingRows?: number; spent?: boolean };
      apifyEnabled?: boolean;
      gateReason?: AnchorPreflight["gateReason"];
      nextEligibleAt?: null | string;
      spotifySearchEnabled?: boolean;
    };
  };

  const budget = body.rungs?.apifyBudget;

  return {
    apifyBudgetRemaining: typeof budget?.remainingRows === "number" ? budget.remainingRows : 0,

    apifyBudgetSpent: budget?.spent === true,
    apifyEnabled: body.rungs?.apifyEnabled !== false,
    gateReason: body.rungs?.gateReason,
    nextEligibleAt: body.rungs?.nextEligibleAt ?? null,
    spotifySearchEnabled: body.rungs?.spotifySearchEnabled === true,
  };
}

async function reportAnchor(
  trackId: string,
  candidates: AnchorCandidatePayload[],
  paidResultToken?: string,
): Promise<AnchorVerdict> {
  const res = await runAnchorAdmissionRequest({
    body: { candidates, trackId, ...(paidResultToken ? { paidResultToken } : {}) },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor",
  });

  if (!res.ok) {
    throw new AnchorReportError(
      `anchor_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      res.status,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  if (paidResultToken) {
    clearAnchorCheckpoint(trackId);
  }

  return { anchored: Boolean(body.anchored), verifiedBy: body.verifiedBy ?? null };
}

export class AnchorReportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function recordInvalidFailure(
  trackId: string,
  status: number,
): Promise<{ terminal: boolean }> {
  const res = await runAnchorAdmissionRequest({
    body: { status, trackId },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/failure",
  });
  if (!res.ok) {
    throw new Error(`anchor failure receipt failed (${res.status})`);
  }
  const outcome = (await res.json()) as { terminal: boolean };
  if (outcome.terminal && existsSync(anchorCheckpointPath(trackId))) {
    let checkpoint = readAnchorCheckpoint(trackId);
    if (checkpoint.stage !== "results" || !checkpoint.paidResultToken) {
      throw new Error(`anchor ${trackId} terminal invalid result has no saved paid evidence`);
    }
    if (Date.now() - checkpoint.createdAt >= ANCHOR_PAID_RESULT_TTL_MS) {
      const receipt = await readAnchorReceiptStatus(checkpoint);
      if (receipt?.admitted !== true || receipt.paidState !== "pending") {
        throw new Error(`anchor ${trackId} terminal invalid receipt is not pending`);
      }
      checkpoint = { ...checkpoint, paidResultToken: await readAnchorPendingPaidToken(checkpoint) };
      durableAnchorCheckpoint(checkpoint);
    }
    const cancel = await runAnchorAdmissionRequest({
      body: { paidResultToken: checkpoint.paidResultToken, trackId },
      method: "POST",
      path: "/api/v1/admin/catalogue/anchor/paid-result/cancel",
    });
    if (!cancel.ok) {
      throw new Error(`anchor ${trackId} terminal invalid cancel failed (${cancel.status})`);
    }
    const settled = (await cancel.json()) as { settled?: boolean };
    if (settled.settled !== true) {
      throw new Error(`anchor ${trackId} terminal invalid cancel was not settled`);
    }
    clearAnchorCheckpoint(trackId);
  }
  return outcome;
}

function savePaidActorResults(
  rows: readonly { trackId: string; paidResultToken?: string }[],
  candidates: Map<string, AnchorCandidatePayload[]>,
): void {
  for (const row of rows) {
    if (!row.paidResultToken) {
      continue;
    }
    const checkpoint = readAnchorCheckpoint(row.trackId);
    if (
      checkpoint.stage !== "actor_started" ||
      checkpoint.paidResultToken !== row.paidResultToken
    ) {
      throw new Error(`anchor ${row.trackId} lost its paid admission checkpoint`);
    }
    durableAnchorCheckpoint({
      ...checkpoint,
      candidates: candidates.get(row.trackId) ?? [],
      stage: "results",
    });
  }
}

function markPaidActorStarted(
  rows: readonly { trackId: string; paidResultToken?: string }[],
): void {
  const actorStartedAt = Date.now();
  const actorQueries = rows.map((row) => readAnchorCheckpoint(row.trackId).anchorQuery);
  for (const row of rows) {
    if (!row.paidResultToken) {
      throw new Error(`anchor ${row.trackId} has no paid result token before actor start`);
    }
    const checkpoint = readAnchorCheckpoint(row.trackId);
    if (checkpoint.stage !== "admitted" || checkpoint.paidResultToken !== row.paidResultToken) {
      throw new Error(`anchor ${row.trackId} lost its paid admission checkpoint`);
    }
    durableAnchorCheckpoint({
      ...checkpoint,
      actorQueries,
      actorStartedAt,
      stage: "actor_started",
    });
  }
}

function saveApifyRunId(
  rows: readonly { trackId: string; paidResultToken?: string }[],
  runId: string,
): void {
  for (const row of rows) {
    const checkpoint = readAnchorCheckpoint(row.trackId);
    if (
      checkpoint.stage !== "actor_started" ||
      checkpoint.paidResultToken !== row.paidResultToken
    ) {
      throw new Error(`anchor ${row.trackId} lost its actor start checkpoint`);
    }
    durableAnchorCheckpoint({ ...checkpoint, apifyRunId: runId });
  }
}

async function cancelPaidActorStart(
  rows: readonly { trackId: string; paidResultToken?: string }[],
): Promise<void> {
  for (const row of rows) {
    let checkpoint = readAnchorCheckpoint(row.trackId);
    if (
      checkpoint.stage !== "actor_started" ||
      checkpoint.apifyRunId ||
      !checkpoint.paidResultToken ||
      checkpoint.paidResultToken !== row.paidResultToken
    ) {
      throw new Error(`anchor ${row.trackId} cannot settle an ambiguous Apify start`);
    }
    if (Date.now() - checkpoint.createdAt >= ANCHOR_PAID_RESULT_TTL_MS) {
      const receipt = await readAnchorReceiptStatus(checkpoint);
      if (receipt?.admitted !== true || receipt.paidState !== "pending") {
        throw new Error(`anchor ${row.trackId} unpaid actor receipt is not pending`);
      }
      checkpoint = { ...checkpoint, paidResultToken: await readAnchorPendingPaidToken(checkpoint) };
      durableAnchorCheckpoint(checkpoint);
    }
    const response = await runAnchorAdmissionRequest({
      body: { paidResultToken: checkpoint.paidResultToken, refundCap: true, trackId: row.trackId },
      method: "POST",
      path: "/api/v1/admin/catalogue/anchor/paid-result/cancel",
    });
    if (!response.ok) {
      throw new Error(`anchor ${row.trackId} paid start cancel failed (${response.status})`);
    }
    const body = (await response.json()) as { settled?: boolean };
    if (body.settled !== true) {
      throw new Error(`anchor ${row.trackId} paid start cancel was not settled`);
    }
    clearAnchorCheckpoint(row.trackId);
  }
}

async function cancelPaidActorRun(
  rows: readonly { trackId: string; paidResultToken?: string }[],
): Promise<void> {
  for (const row of rows) {
    let checkpoint = readAnchorCheckpoint(row.trackId);
    if (checkpoint.stage !== "actor_started" || !checkpoint.apifyRunId) {
      throw new Error(`anchor ${row.trackId} has no confirmed terminal actor run`);
    }
    if (Date.now() - checkpoint.createdAt >= ANCHOR_PAID_RESULT_TTL_MS) {
      const receipt = await readAnchorReceiptStatus(checkpoint);
      if (receipt?.admitted !== true || receipt.paidState !== "pending") {
        throw new Error(`anchor ${row.trackId} terminal actor receipt is not pending`);
      }
      checkpoint = { ...checkpoint, paidResultToken: await readAnchorPendingPaidToken(checkpoint) };
      durableAnchorCheckpoint(checkpoint);
    }
    if (!checkpoint.paidResultToken) {
      throw new Error(`anchor ${row.trackId} terminal actor has no paid result token`);
    }
    const response = await runAnchorAdmissionRequest({
      body: { paidResultToken: checkpoint.paidResultToken, trackId: row.trackId },
      method: "POST",
      path: "/api/v1/admin/catalogue/anchor/paid-result/cancel",
    });
    if (!response.ok) {
      throw new Error(`anchor ${row.trackId} terminal actor cancel failed (${response.status})`);
    }
    const body = (await response.json()) as { settled?: boolean };
    if (body.settled !== true) {
      throw new Error(`anchor ${row.trackId} terminal actor cancel was not settled`);
    }
    clearAnchorCheckpoint(row.trackId);
  }
}

async function resolvePaidReport(trackId: string): Promise<void> {
  const checkpoint = readAnchorCheckpoint(trackId);
  if (checkpoint.stage !== "results" || !checkpoint.receiptAt) {
    throw new Error(`anchor ${trackId} cannot resolve a report without its exact paid receipt`);
  }
  await resolveExactPaidReceipt(checkpoint);
}

async function resolveExactPaidReceipt(checkpoint: AnchorPaidCheckpoint): Promise<void> {
  const { trackId } = checkpoint;
  if (!checkpoint.receiptAt) {
    throw new Error(`anchor ${trackId} cannot resolve a result without its exact paid receipt`);
  }
  const response = await runAnchorAdmissionRequest({
    body: { receiptAt: checkpoint.receiptAt, trackId },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/paid-result/resolve",
  });
  if (!response.ok) {
    throw new Error(`anchor ${trackId} paid report resolve failed (${response.status})`);
  }
  const body = (await response.json()) as { reason?: unknown };
  if (body.reason !== "unavailable" && body.reason !== "missing" && body.reason !== "settled") {
    throw new Error(`anchor ${trackId} paid report resolve returned no terminal reason`);
  }
  clearAnchorCheckpoint(trackId);
}

async function settleCommitCheckpoint(
  checkpoint: AnchorPaidCheckpoint,
  paidReceiptPending?: boolean,
): Promise<void> {
  if (paidReceiptPending === true) {
    await resolveExactPaidReceipt(checkpoint);
    return;
  }
  if (paidReceiptPending === false) {
    clearAnchorCheckpoint(checkpoint.trackId);
    return;
  }
  const receipt = await readAnchorReceiptStatus(checkpoint);
  if (receipt?.admitted === true && receipt.paidState === "pending") {
    await resolveExactPaidReceipt(checkpoint);
    return;
  }
  if (receipt?.admitted === false || receipt?.paidState === "settled") {
    clearAnchorCheckpoint(checkpoint.trackId);
    return;
  }
  throw new Error(`anchor ${checkpoint.trackId} commit receipt cannot be safely released`);
}

export async function resolveAnchorPhased(
  trackId: string,
  deezerCandidates?: DeezerCandidatePayload[],
  options?: { allowPaid?: boolean; anchorQuery?: string; spotifySearch?: boolean },
): Promise<AnchorVerdict> {
  const anchorQuery = options?.anchorQuery;
  if (!anchorQuery) {
    throw new Error(`anchor ${trackId} is missing its paid replay query`);
  }
  if (existsSync(anchorCheckpointPath(trackId))) {
    throw new Error(`anchor ${trackId} already has a paid checkpoint`);
  }
  const preparedResponse = await runAnchorAdmissionRequest({
    body: { trackId, ...(deezerCandidates ? { deezerCandidates } : {}) },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/prepare",
  });
  if (!preparedResponse.ok) {
    throw new Error(
      `prepare_anchor ${trackId} failed (${preparedResponse.status}): ${(await preparedResponse.text()).slice(0, 200)}`,
    );
  }
  const preparedBody = (await preparedResponse.json()) as {
    prepared?: unknown;
    receiptAt?: unknown;
  };
  if (typeof preparedBody.prepared !== "string" || preparedBody.prepared.length === 0) {
    throw new Error("prepare_anchor returned no prepared envelope");
  }
  const prepared = preparedBody.prepared;
  const preparedAt = Date.now();
  const probeResponse = await fetch(
    `${API_BASE_URL}/api/v1/admin/catalogue/anchor/candidates/resolve`,
    {
      body: JSON.stringify({
        prepared,
        ...(options?.spotifySearch === false ? { spotifySearch: false } : {}),
      }),
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(300_000),
    },
  );
  if (!probeResponse.ok) {
    throw new Error(
      `probe_anchor ${trackId} failed (${probeResponse.status}): ${(await probeResponse.text()).slice(0, 200)}`,
    );
  }
  const probed = (await probeResponse.json()) as { evidence?: unknown };
  if (typeof probed.evidence !== "string" || probed.evidence.length === 0) {
    throw new Error("probe_anchor returned no evidence envelope");
  }
  const checkpoint: AnchorPaidCheckpoint = {
    allowPaid: options?.allowPaid !== false,
    anchorQuery,
    createdAt: preparedAt,
    evidence: probed.evidence,
    prepared,
    receiptAt: typeof preparedBody.receiptAt === "string" ? preparedBody.receiptAt : undefined,
    stage: "commit",
    trackId,
  };
  createAnchorCheckpoint(checkpoint);
  const commitResponse = await runAnchorAdmissionRequest({
    body: {
      evidence: probed.evidence,
      prepared,
      ...(options?.allowPaid === false ? { allowPaid: false } : {}),
    },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/commit",
  });
  if (!commitResponse.ok) {
    if (definitiveAnchorCommitRejection(commitResponse.status)) {
      await settleCommitCheckpoint(checkpoint);
    }
    throw new Error(
      `commit_anchor ${trackId} failed (${commitResponse.status}): ${(await commitResponse.text()).slice(0, 200)}`,
    );
  }
  const verdict = (await commitResponse.json()) as AnchorVerdict;
  if (verdict.apifyEligible && verdict.apifyEnabled !== false && !verdict.anchored) {
    if (!verdict.paidResultToken) {
      throw new Error(`anchor ${trackId} paid admission has no result token`);
    }
    durableAnchorCheckpoint({
      ...checkpoint,
      admittedAt: Date.now(),
      paidResultToken: verdict.paidResultToken,
      stage: "admitted",
    });
  } else {
    await settleCommitCheckpoint(checkpoint, verdict.paidReceiptPending);
  }
  return verdict;
}

type AnchorBatchInput = {
  allowPaid: boolean;
  anchorQuery: string;
  deezerCandidates?: DeezerCandidatePayload[];
  spotifySearch: boolean;
  trackId: string;
};

// oxlint-disable-next-line complexity
async function resolveAnchorPhasedBatch(
  rows: readonly AnchorBatchInput[],
  onCheckpointCreated?: (trackId: string) => void,
  paceState: { lastProbeAt: null | number } = { lastProbeAt: null },
): Promise<
  ({ status: "done"; verdict: AnchorVerdict } | { status: "deferred" | "error"; error?: string })[]
> {
  if (rows.length === 0) {
    return [];
  }
  if (rows.length > 15) {
    throw new Error("anchor admission batch exceeds 15 rows");
  }
  const blocked = rows.map((row) => existsSync(anchorCheckpointPath(row.trackId)));
  if (blocked.some(Boolean)) {
    rows.forEach((row, index) => {
      if (blocked[index]) {
        onCheckpointCreated?.(row.trackId);
      }
    });
    const activeRows = rows
      .filter((_row, index) => !blocked[index])
      .map((row) => ({ ...row, allowPaid: false }));
    const activeResults = await resolveAnchorPhasedBatch(
      activeRows,
      onCheckpointCreated,
      paceState,
    );
    let activeIndex = 0;
    return rows.map((row, index) =>
      blocked[index]
        ? { error: `anchor ${row.trackId} already has a paid checkpoint`, status: "error" }
        : (activeResults[activeIndex++] ?? { error: "missing batch result", status: "error" }),
    );
  }
  const preparedResponse = await runAnchorAdmissionRequest({
    body: {
      items: rows.map((row) => ({
        trackId: row.trackId,
        ...(row.deezerCandidates ? { deezerCandidates: row.deezerCandidates } : {}),
      })),
    },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/prepares",
  });
  if (!preparedResponse.ok) {
    throw new Error(
      `prepare_anchors failed (${preparedResponse.status}): ${(await preparedResponse.text()).slice(0, 200)}`,
    );
  }
  const preparedBody = (await preparedResponse.json()) as {
    items?: {
      error?: string;
      prepared?: string;
      receiptAt?: string;
      status: string;
      trackId: string;
    }[];
  };
  if (!Array.isArray(preparedBody.items) || preparedBody.items.length !== rows.length) {
    throw new Error("prepare_anchors returned an incomplete batch");
  }
  const outcomes: (
    | { status: "done"; verdict: AnchorVerdict }
    | { status: "deferred" | "error"; error?: string }
  )[] = rows.map(() => ({ status: "deferred" }));
  const commitments: { evidence: string; prepared: string; trackId: string; allowPaid: boolean }[] =
    [];
  let blockedCheckpoint = false;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const prepared = preparedBody.items[i];
    if (!row || !prepared || prepared.trackId !== row.trackId) {
      throw new Error("prepare_anchors returned rows out of order");
    }
    if (prepared.status !== "done") {
      outcomes[i] = {
        error: prepared.error,
        status: prepared.status === "error" ? "error" : "deferred",
      };
      continue;
    }
    if (!prepared.prepared) {
      throw new Error(`prepare_anchors ${row.trackId} returned no envelope`);
    }
    if (row.spotifySearch && paceState.lastProbeAt !== null) {
      const waitMs = spotifySearchPaceMs(paceState.lastProbeAt, Date.now());
      if (waitMs > 0) {
        await Bun.sleep(waitMs);
      }
    }
    const probeAt = Date.now();
    if (row.spotifySearch) {
      paceState.lastProbeAt = probeAt;
    }
    let probeResponse: Response;
    try {
      probeResponse = await fetch(
        `${API_BASE_URL}/api/v1/admin/catalogue/anchor/candidates/resolve`,
        {
          body: JSON.stringify({
            prepared: prepared.prepared,
            ...(row.spotifySearch ? {} : { spotifySearch: false }),
          }),
          headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(300_000),
        },
      );
    } catch (error) {
      outcomes[i] = {
        error: error instanceof Error ? error.message : String(error),
        status: "error",
      };
      continue;
    }
    if (!probeResponse.ok) {
      outcomes[i] = { error: `probe_anchor failed (${probeResponse.status})`, status: "error" };
      continue;
    }
    const probed = (await probeResponse.json()) as { evidence?: unknown };
    if (typeof probed.evidence !== "string" || !probed.evidence) {
      outcomes[i] = { error: "probe_anchor returned no evidence", status: "error" };
      continue;
    }
    const checkpoint: AnchorPaidCheckpoint = {
      allowPaid: row.allowPaid,
      anchorQuery: row.anchorQuery,
      createdAt: probeAt,
      evidence: probed.evidence,
      prepared: prepared.prepared,
      receiptAt: prepared.receiptAt,
      stage: "commit",
      trackId: row.trackId,
    };
    try {
      createAnchorCheckpoint(checkpoint);
      onCheckpointCreated?.(row.trackId);
    } catch (error) {
      blockedCheckpoint ||= existsSync(anchorCheckpointPath(row.trackId));
      outcomes[i] = {
        error: existsSync(anchorCheckpointPath(row.trackId))
          ? `anchor ${row.trackId} already has a paid checkpoint`
          : error instanceof Error
            ? error.message
            : String(error),
        status: "error",
      };
      continue;
    }
    commitments.push({
      allowPaid: row.allowPaid,
      evidence: probed.evidence,
      prepared: prepared.prepared,
      trackId: row.trackId,
    });
  }
  if (commitments.length === 0) {
    return outcomes;
  }
  if (blockedCheckpoint) {
    for (const commitment of commitments) {
      commitment.allowPaid = false;
      const checkpoint = readAnchorCheckpoint(commitment.trackId);
      durableAnchorCheckpoint({ ...checkpoint, allowPaid: false });
    }
  }
  const committedResponse = await runAnchorAdmissionRequest({
    body: { items: commitments },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/commits",
  });
  if (!committedResponse.ok) {
    throw new Error(
      `commit_anchors failed (${committedResponse.status}): ${(await committedResponse.text()).slice(0, 200)}`,
    );
  }
  const committedBody = (await committedResponse.json()) as {
    items?: ({
      error?: string;
      httpStatus?: number;
      status: string;
      trackId: string;
    } & AnchorVerdict)[];
  };
  if (!Array.isArray(committedBody.items) || committedBody.items.length !== commitments.length) {
    throw new Error("commit_anchors returned an incomplete batch");
  }
  for (let i = 0; i < commitments.length; i += 1) {
    const item = commitments[i];
    const committed = committedBody.items[i];
    if (!item || !committed || committed.trackId !== item.trackId) {
      throw new Error("commit_anchors returned rows out of order");
    }
    const index = rows.findIndex((row) => row.trackId === item.trackId);
    if (index < 0) {
      throw new Error(`commit_anchors returned unknown row ${item.trackId}`);
    }
    if (committed.status !== "done") {
      if (
        committed.status === "error" &&
        typeof committed.httpStatus === "number" &&
        definitiveAnchorCommitRejection(committed.httpStatus)
      ) {
        try {
          await settleCommitCheckpoint(readAnchorCheckpoint(item.trackId));
        } catch (error) {
          outcomes[index] = {
            error: error instanceof Error ? error.message : String(error),
            status: "error",
          };
          continue;
        }
      }
      outcomes[index] = {
        error: committed.error,
        status: committed.status === "error" ? "error" : "deferred",
      };
      continue;
    }
    const checkpoint = readAnchorCheckpoint(item.trackId);
    if (committed.apifyEligible && committed.apifyEnabled !== false && !committed.anchored) {
      if (!item.allowPaid || !committed.paidResultToken) {
        outcomes[index] = {
          error: "paid admission violated the local spend gate",
          status: "error",
        };
        continue;
      }
      durableAnchorCheckpoint({
        ...checkpoint,
        admittedAt: Date.now(),
        paidResultToken: committed.paidResultToken,
        stage: "admitted",
      });
    } else {
      try {
        await settleCommitCheckpoint(checkpoint, committed.paidReceiptPending);
      } catch (error) {
        outcomes[index] = {
          error: error instanceof Error ? error.message : String(error),
          status: "error",
        };
        continue;
      }
    }
    outcomes[index] = { status: "done", verdict: committed };
  }
  return outcomes;
}

async function resolveAnchorReleaseOnBox(
  trackId: string,
  spotifySearch: boolean,
): Promise<AnchorReleaseVerdict> {
  const probeResponse = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor/release/probe`, {
    body: JSON.stringify({ spotifySearch, trackId }),
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  if (!probeResponse.ok) {
    throw new Error(`probe_anchor_release ${trackId} failed (${probeResponse.status})`);
  }
  const body = (await probeResponse.json()) as {
    ok?: boolean;
    proof?: string;
    probe?: {
      evidence: { checkedAt: null | string; siblingTrackIds: string[] }[];
      result: AnchorReleaseVerdict;
      trackId: string;
    };
  };
  if (
    body.ok !== true ||
    body.probe?.trackId !== trackId ||
    typeof body.proof !== "string" ||
    !Array.isArray(body.probe.evidence)
  ) {
    throw new Error("probe_anchor_release returned an invalid result");
  }
  const result = body.probe.result;
  if (
    body.probe.evidence.every(
      (evidence) => !evidence.checkedAt && evidence.siblingTrackIds.length === 0,
    )
  ) {
    return result;
  }
  let cursor = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await runAnchorAdmissionRequest({
      body: { cursor, probe: body.probe, proof: body.proof },
      method: "POST",
      path: "/api/v1/admin/catalogue/anchor/release/commit",
    });
    if (!response.ok) {
      throw new Error(`commit_anchor_release ${trackId} failed (${response.status})`);
    }
    const committed = (await response.json()) as AnchorReleaseVerdict & { ok?: boolean };
    if (committed.ok !== true || typeof committed.anchoredCount !== "number") {
      throw new Error("commit_anchor_release returned an invalid result");
    }
    result.anchoredCount += committed.anchoredCount;
    result.anchored ||= committed.anchored;
    result.verifiedBy ??= committed.verifiedBy;
    if (committed.remainder === null || committed.remainder === undefined) {
      break;
    }
    cursor = committed.remainder;
  }
  return result;
}

async function classifyAnchorFiring(
  deps: AnchorDeps,
  askState: SpotifyAskState,
): Promise<{
  askArmed: boolean;
  deferral: ReturnType<typeof anchorFiringDeferral>;
  freeRungsOnly: boolean;
  paidMode?: "prior" | "quota";
  preflight?: AnchorPreflight;
}> {
  if (!deps.readPreflight) {
    return { askArmed: false, deferral: null, freeRungsOnly: false };
  }
  const preflight = await deps.readPreflight().catch((error: unknown) => {
    if (error instanceof AnchorAdmissionYieldError) {
      throw error;
    }
    deps.log(`preflight read failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (!preflight) {
    return { askArmed: false, deferral: null, freeRungsOnly: false };
  }
  const now = new Date(deps.now());
  const deferral = anchorFiringDeferral(preflight, askState.askWindow, now, DAY_FREE_RUNGS);
  const paidMode =
    preflight.gateReason === "breaker_quota" ||
    (preflight.gateReason === "daily_budget" &&
      now.getUTCHours() >= ANCHOR_QUOTA_EXCEPTION_START_HOUR_UTC)
      ? "quota"
      : preflight.gateReason === "quota_hold" ||
          preflight.gateReason === "daily_budget" ||
          longAnchorThrottle(preflight, now)
        ? "prior"
        : undefined;
  return {
    askArmed:
      deferral !== "free_rungs_only" && preflight.apifyEnabled && preflight.spotifySearchEnabled,
    deferral,
    freeRungsOnly: deferral === "free_rungs_only",
    paidMode,
    preflight,
  };
}

function anchorSweepFiringMode(
  firing: Awaited<ReturnType<typeof classifyAnchorFiring>>,
  paidAdmissionDisabled: boolean,
): {
  askArmed: boolean;
  deferral: typeof firing.deferral;
  freeRungsOnly: boolean;
  paidMode?: "prior" | "quota";
} {
  return {
    askArmed: firing.askArmed,
    deferral: firing.deferral === "free_rungs_only" ? null : firing.deferral,
    freeRungsOnly: firing.freeRungsOnly || paidAdmissionDisabled,
    paidMode: firing.paidMode,
  };
}

function sweepBlockedReason(summary: AnchorSummary, paidMode?: "prior" | "quota"): null | string {
  const mostlyDeferred = summary.checked > 0 && summary.deferred / summary.checked >= 0.8;
  const paidResultPending =
    summary.checked > 0 && summary.apifySkippedAwaitingPaidResult / summary.checked >= 0.8;
  const noProgress =
    summary.produced === 0 &&
    (summary.deferred > 0 || summary.reason !== null || (paidMode && summary.checked === 0));
  return mostlyDeferred || noProgress
    ? (summary.reason ??
        (paidResultPending ? "awaiting_paid_result" : null) ??
        (summary.gateReason === "open" ? "mostly_deferred" : summary.gateReason) ??
        "awaiting_free_ask")
    : null;
}

async function measureAnchorIsrcDue(
  ok: boolean,
  preflight: AnchorPreflight | undefined,
  askState: SpotifyAskState,
  queueDepth: null | number,
  deps: AnchorDeps,
): Promise<{ error: null | string; due: null | number }> {
  if (!ok || !preflight || !deps.readIsrcDue) {
    return { due: null, error: null };
  }
  if (queueDepth === 0) {
    return { due: 0, error: null };
  }
  const slots =
    preflight.spotifySearchEnabled && withinIsrcAskWindow(askState.askWindow, new Date(deps.now()))
      ? Math.max(0, askState.limit - askState.asksSpent)
      : 0;
  if (slots === 0) {
    return { due: 0, error: null };
  }
  try {
    const due = await deps.readIsrcDue();
    if (due === null || !Number.isSafeInteger(due) || due < 0) {
      throw new Error("invalid ISRC due probe result");
    }
    return { due: Math.min(due, slots), error: null };
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`ISRC due probe failed: ${message}`);
    return { due: null, error: message };
  }
}

type AnchorSweepSummary = AnchorSummary & { pages: number; pulled: number };

async function finalizeAnchorSweep(
  merged: AnchorSweepSummary,
  deps: AnchorDeps,
  strikes: AnchorStrikeBuffer,
  preflight: AnchorPreflight | undefined,
  askState: SpotifyAskState,
  paidMode?: "prior" | "quota",
): Promise<AnchorSweepSummary> {
  let strikeResult: Awaited<ReturnType<typeof flushAnchorStrikes>>;
  try {
    strikeResult = await flushAnchorStrikes(deps, strikes, merged);
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      pauseAnchorAdmission(merged, error);
      return merged;
    }
    throw error;
  }
  const { error, terminal } = strikeResult;
  if (error !== null) {
    merged.ok = false;
    merged.error ??= error;
    merged.errors += 1;
  }
  if (merged.queueDepth !== null) {
    merged.queueDepth = Math.max(0, merged.queueDepth - terminal);
  }
  merged.blockedReason = strikes.fault
    ? "anchor_contract_fault"
    : merged.blockedReason === "paid_result_recovery"
      ? "paid_result_recovery"
      : sweepBlockedReason(merged, paidMode);
  let dueProbe: Awaited<ReturnType<typeof measureAnchorIsrcDue>>;
  try {
    dueProbe = await measureAnchorIsrcDue(merged.ok, preflight, askState, merged.queueDepth, deps);
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      pauseAnchorAdmission(merged, error);
      return merged;
    }
    throw error;
  }
  merged.spotifyIsrcDue = dueProbe.due;
  merged.spotifyIsrcDueError = dueProbe.error;
  return merged;
}

async function flushPausedAnchorStrikes(
  merged: AnchorSweepSummary,
  deps: AnchorDeps,
  strikes: AnchorStrikeBuffer,
): Promise<void> {
  try {
    const strikeResult = await flushAnchorStrikes(deps, strikes, merged);
    if (strikeResult.error !== null) {
      merged.ok = false;
      merged.error ??= strikeResult.error;
      merged.errors += 1;
    }
    if (merged.queueDepth !== null) {
      merged.queueDepth = Math.max(0, merged.queueDepth - strikeResult.terminal);
    }
  } catch (error) {
    if (!(error instanceof AnchorAdmissionYieldError)) {
      throw error;
    }
  }
}

function newAnchorSweepSummary(): AnchorSweepSummary {
  return {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredByListenbrainzMetadata: 0,
    anchoredByReleaseLink: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    apifyActorErrors: 0,
    apifyBudgetRemaining: null as null | number,
    apifyBudgetSkipped: 0,
    apifyDurationMsOmitted: 0,
    apifyResults: 0,
    apifyRowsSent: 0,
    apifySkippedAwaitingPaidResult: 0,
    apifySkippedAwaitingSpotify: 0,
    apifyTargetOmitted: 0,
    blockedReason: null as null | string,
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
    gateReason: null as null | string,
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
    nextEligibleAt: null as null | string,
    ok: true,
    pages: 0,
    produced: 0,
    pulled: 0,
    queueDepth: null as null | number,
    reason: null as AnchorSummary["reason"],
    releaseLinkAlbumFetchFailed: 0,
    releaseLinkAlbumsFetched: 0,
    releaseLinkBackoffSkipped: 0,
    releaseLinkBudgetSkipped: 0,
    releaseLinkCacheHits: 0,
    releaseLinkErrors: 0,
    releaseLinkNoAlbum: 0,
    releaseLinkProbes: 0,
    rungsSkipped: [] as string[],
    skipped: 0,
    spotifyDeferredBudget: 0,
    spotifyDeferredWindow: 0,
    spotifyDeferredYield: 0,
    spotifyIsrcAsks: 0,
    spotifyIsrcDue: null as null | number,
    spotifyIsrcDueError: null as null | string,
  };
}

// oxlint-disable-next-line complexity
export async function runAnchorSweep(
  total: number,
  deps: AnchorDeps,
  pageLimit: number = PAGE_LIMIT,
): Promise<AnchorSweepSummary> {
  const merged = newAnchorSweepSummary();

  const askState = newSpotifyAskState();
  const strikes: AnchorStrikeBuffer = { fault: false, reported: 0, rows: new Map() };

  let firing: Awaited<ReturnType<typeof classifyAnchorFiring>>;
  try {
    firing = await classifyAnchorFiring(deps, askState);
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      pauseAnchorAdmission(merged, error);
      return merged;
    }
    throw error;
  }
  const { askArmed, deferral, freeRungsOnly, paidMode } = anchorSweepFiringMode(
    firing,
    deps.paidAdmissionDisabled === true,
  );
  const { preflight } = firing;
  if (preflight) {
    merged.apifyBudgetRemaining = preflight.apifyBudgetRemaining;
    merged.gateReason = preflight.gateReason ?? null;
    merged.nextEligibleAt = preflight.nextEligibleAt ?? null;
  }
  if (deferral !== null) {
    merged.reason = deferral;
    merged.blockedReason = deferral;
    merged.rungsSkipped = [
      "release-links",
      "listenbrainz",
      "deezer-isrc-recovery",
      "spotify-search",
      "apify",
    ];
    return merged;
  }

  let remaining = Math.max(0, Math.trunc(total));

  if (askArmed) {
    remaining = Math.min(remaining, askState.limit);
  }
  if (paidMode && merged.apifyBudgetRemaining !== null) {
    remaining = Math.min(remaining, merged.apifyBudgetRemaining);
  }

  let noCapableRung = false;
  let paidDisabled = freeRungsOnly;

  while (remaining > 0) {
    const ask = Math.min(pageLimit, remaining);
    const page = await runAnchorTick(
      ask,
      deps,
      APIFY_QUERY_CHUNK,
      askState,
      paidDisabled,
      paidMode,
      strikes,
      false,
    );
    const pulled = page.checked;

    merged.pages += 1;
    merged.pulled += pulled;
    merged.checked += page.checked;
    merged.produced += page.produced;
    merged.blockedReason ??= page.blockedReason;
    if (page.blockedReason === "paid_result_recovery" || page.apifyActorErrors > 0) {
      paidDisabled = true;
    }

    merged.queueDepth = page.gateState === "paused" ? merged.queueDepth : page.queueDepth;
    merged.apifyActorErrors += page.apifyActorErrors;
    merged.apifyResults += page.apifyResults;
    merged.apifyRowsSent += page.apifyRowsSent;
    merged.apifySkippedAwaitingPaidResult += page.apifySkippedAwaitingPaidResult;
    merged.apifySkippedAwaitingSpotify += page.apifySkippedAwaitingSpotify;
    merged.apifyBudgetSkipped += page.apifyBudgetSkipped;

    if (page.rungsSkipped.length > 0) {
      merged.rungsSkipped = page.rungsSkipped;
    }

    merged.apifyBudgetRemaining = page.apifyBudgetRemaining ?? merged.apifyBudgetRemaining;
    merged.anchoredByIsrc += page.anchoredByIsrc;
    merged.anchoredByListenbrainz += page.anchoredByListenbrainz;
    merged.anchoredByListenbrainzMetadata += page.anchoredByListenbrainzMetadata;
    merged.anchoredByReleaseLink += page.anchoredByReleaseLink;
    merged.releaseLinkAlbumsFetched += page.releaseLinkAlbumsFetched;
    merged.releaseLinkCacheHits += page.releaseLinkCacheHits;
    merged.releaseLinkNoAlbum += page.releaseLinkNoAlbum;
    merged.releaseLinkBackoffSkipped += page.releaseLinkBackoffSkipped;
    merged.releaseLinkAlbumFetchFailed += page.releaseLinkAlbumFetchFailed;
    merged.releaseLinkBudgetSkipped += page.releaseLinkBudgetSkipped;
    merged.releaseLinkErrors += page.releaseLinkErrors;
    merged.releaseLinkProbes += page.releaseLinkProbes;
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
      merged.ok = page.ok && merged.ok;
      merged.error ??= page.error;
      await flushPausedAnchorStrikes(merged, deps, strikes);
      if (page.reason === "database_admission") {
        Object.assign(merged, {
          admissionOutcome: page.admissionOutcome,
          ...(page.admissionYieldReason ? { admissionYieldReason: page.admissionYieldReason } : {}),
          blockedReason: page.blockedReason ?? "database_admission",
          gateState: "paused",
          reason: "database_admission",
          throttled: true,
        });
      } else {
        Object.assign(merged, dueWorkRepairPendingGate(merged));
      }
      return merged;
    }

    if (!page.ok) {
      merged.ok = false;
      merged.error ??= page.error;
      merged.blockedReason = page.blockedReason ?? merged.blockedReason;
      break;
    }

    if (pulled < ask || page.apifyActorErrors > 0) {
      break;
    }

    remaining -= pulled;
  }

  if (merged.reason === null && noCapableRung && merged.produced === 0) {
    merged.reason = "no_capable_rung";
  }

  return finalizeAnchorSweep(merged, deps, strikes, preflight, askState, paidMode);
}

export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function readAnchorReceiptStatus(
  checkpoint: AnchorPaidCheckpoint,
): Promise<{ admitted?: boolean; paidState?: null | string } | null> {
  if (!checkpoint.receiptAt) {
    return null;
  }
  const response = await runAnchorAdmissionRequest({
    body: { receiptAt: checkpoint.receiptAt, trackId: checkpoint.trackId },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/receipt",
  });
  if (!response.ok) {
    throw new Error(`anchor ${checkpoint.trackId} receipt read failed (${response.status})`);
  }
  return (await response.json()) as { admitted?: boolean; paidState?: null | string };
}

async function readAnchorPendingPaidToken(checkpoint: AnchorPaidCheckpoint): Promise<string> {
  if (!checkpoint.receiptAt) {
    throw new Error(
      `anchor ${checkpoint.trackId} has no receipt timestamp for paid token recovery`,
    );
  }
  const response = await runAnchorAdmissionRequest({
    body: { receiptAt: checkpoint.receiptAt, trackId: checkpoint.trackId },
    method: "POST",
    path: "/api/v1/admin/catalogue/anchor/paid-result/token",
  });
  if (!response.ok) {
    throw new Error(`anchor ${checkpoint.trackId} paid token refresh failed (${response.status})`);
  }
  const body = (await response.json()) as { paidResultToken?: unknown };
  if (typeof body.paidResultToken !== "string" || !body.paidResultToken) {
    throw new Error(`anchor ${checkpoint.trackId} paid token refresh returned no token`);
  }
  return body.paidResultToken;
}

type ApifyStartResolution = { runId: string } | "pending" | "unpaid";

async function resolveAmbiguousApifyStart(
  checkpoint: AnchorPaidCheckpoint,
): Promise<ApifyStartResolution> {
  const startedAt = checkpoint.actorStartedAt;
  const queries = checkpoint.actorQueries;
  if (startedAt === undefined || queries === undefined) {
    throw new Error(`anchor ${checkpoint.trackId} lacks full actor start coordinates`);
  }
  const since = startedAt - APIFY_START_CLOCK_SKEW_MS;
  const until = Date.now() + APIFY_START_CLOCK_SKEW_MS;
  const runs: { id: string; startedAt: number }[] = [];
  let previousStartedAt = Number.POSITIVE_INFINITY;
  for (
    let offset = 0;
    offset <= APIFY_START_LOOKUP_MAX_RUNS;
    offset += APIFY_START_LOOKUP_PAGE_SIZE
  ) {
    const response = await fetch(
      `${APIFY_API_BASE_URL}/v2/actors/${APIFY_ACTOR}/runs?desc=1&limit=${APIFY_START_LOOKUP_PAGE_SIZE}&offset=${offset}`,
      {
        headers: { Authorization: `Bearer ${APIFY_API_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`apify recent runs read failed (${response.status})`);
    }
    const body = (await response.json()) as {
      data?: { items?: { id?: unknown; startedAt?: unknown }[] };
    };
    const page = body.data?.items;
    if (!Array.isArray(page) || page.length > APIFY_START_LOOKUP_PAGE_SIZE) {
      throw new Error("apify recent runs list is incomplete");
    }
    let crossedLowerBound = false;
    for (const run of page) {
      const runAt = Date.parse(typeof run.startedAt === "string" ? run.startedAt : "");
      if (
        typeof run.id !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(run.id) ||
        !Number.isFinite(runAt) ||
        runAt > previousStartedAt
      ) {
        throw new Error("apify recent runs list has invalid coordinates");
      }
      previousStartedAt = runAt;
      if (runAt < since) {
        crossedLowerBound = true;
        break;
      }
      if (runAt <= until) {
        runs.push({ id: run.id, startedAt: runAt });
      }
    }
    if (
      runs.length > APIFY_START_LOOKUP_MAX_RUNS ||
      (offset === APIFY_START_LOOKUP_MAX_RUNS &&
        !crossedLowerBound &&
        page.length === APIFY_START_LOOKUP_PAGE_SIZE)
    ) {
      throw new Error("apify recent runs list exceeds lookup limit");
    }
    if (crossedLowerBound || page.length < APIFY_START_LOOKUP_PAGE_SIZE) {
      break;
    }
  }
  const matches = await Promise.all(
    runs.map(async (run): Promise<{ id: string; startedAt: number } | "unreadable" | null> => {
      try {
        const inputResponse = await fetch(
          `${APIFY_API_BASE_URL}/v2/actor-runs/${run.id}/key-value-store/records/INPUT`,
          {
            headers: { Authorization: `Bearer ${APIFY_API_TOKEN}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!inputResponse.ok) {
          return "unreadable";
        }
        const input = (await inputResponse.json()) as { tracks?: unknown };
        return JSON.stringify(input.tracks) === JSON.stringify(queries) ? run : null;
      } catch {
        return "unreadable";
      }
    }),
  );
  const matched = matches
    .filter((run): run is { id: string; startedAt: number } => run !== null && run !== "unreadable")
    .sort(
      (first, second) => first.startedAt - second.startedAt || first.id.localeCompare(second.id),
    );
  const earliest = matched[0];
  if (earliest) {
    return { runId: earliest.id };
  }
  if (matches.includes("unreadable")) {
    throw new Error(`anchor ${checkpoint.trackId} actor run input is unreadable`);
  }
  return Date.now() - startedAt >= APIFY_START_GRACE_MS ? "unpaid" : "pending";
}

// oxlint-disable-next-line complexity
async function replayAnchorPaidCheckpoint(
  stored: AnchorPaidCheckpoint,
  summary: AnchorSweepSummary,
  allowPaid: boolean,
  apifyEnabled: boolean,
  strikes: AnchorStrikeBuffer,
  runResults: Map<string, Promise<ApifyResultItem[] | null>>,
  startResults: Map<string, Promise<ApifyStartResolution>>,
): Promise<void> {
  let checkpoint = stored;
  if (checkpoint.stage === "commit") {
    if (Date.now() - checkpoint.createdAt >= ANCHOR_PAID_RECEIPT_TTL_MS) {
      const receipt = await readAnchorReceiptStatus(checkpoint);
      if (receipt?.admitted === false) {
        clearAnchorCheckpoint(checkpoint.trackId);
        summary.deferred += 1;
        return;
      }
      if (receipt?.paidState === "settled") {
        clearAnchorCheckpoint(checkpoint.trackId);
        return;
      }
      if (receipt?.admitted !== true || receipt.paidState !== "pending") {
        throw new Error(
          `anchor ${checkpoint.trackId} commit evidence expired before reconciliation`,
        );
      }
      checkpoint = {
        ...checkpoint,
        admittedAt: Date.now(),
        paidResultToken: await readAnchorPendingPaidToken(checkpoint),
        stage: "admitted",
      };
      durableAnchorCheckpoint(checkpoint);
    } else {
      const response = await runAnchorAdmissionRequest({
        body: {
          evidence: checkpoint.evidence,
          prepared: checkpoint.prepared,
          ...(checkpoint.allowPaid === false || !allowPaid ? { allowPaid: false } : {}),
        },
        method: "POST",
        path: "/api/v1/admin/catalogue/anchor/commit",
      });
      if (!response.ok) {
        if (definitiveAnchorCommitRejection(response.status)) {
          const receipt = await readAnchorReceiptStatus(checkpoint);
          if (receipt?.admitted === false || receipt?.paidState === "settled") {
            clearAnchorCheckpoint(checkpoint.trackId);
            summary.deferred += 1;
            return;
          }
        }
        throw new Error(`anchor ${checkpoint.trackId} commit replay failed (${response.status})`);
      }
      const verdict = (await response.json()) as AnchorVerdict;
      if (verdict.anchored) {
        await settleCommitCheckpoint(checkpoint, verdict.paidReceiptPending);
        summary.produced += 1;
        return;
      }
      let paidResultToken = verdict.paidResultToken;
      if (!paidResultToken && verdict.paidReceiptPending === true) {
        paidResultToken = await readAnchorPendingPaidToken(checkpoint);
      } else if (
        !paidResultToken &&
        checkpoint.receiptAt &&
        verdict.paidReceiptPending === undefined
      ) {
        const receipt = await readAnchorReceiptStatus(checkpoint);
        if (receipt?.admitted === true && receipt.paidState === "pending") {
          paidResultToken = await readAnchorPendingPaidToken(checkpoint);
        } else if (receipt?.paidState === "settled") {
          clearAnchorCheckpoint(checkpoint.trackId);
          return;
        } else if (receipt?.admitted === true) {
          throw new Error(`anchor ${checkpoint.trackId} paid receipt differs from its checkpoint`);
        }
      }
      if (!paidResultToken) {
        if (verdict.apifyIneligibleReason === "awaiting_paid_result") {
          throw new Error(`anchor ${checkpoint.trackId} paid receipt differs from its checkpoint`);
        }
        await settleCommitCheckpoint(checkpoint, verdict.paidReceiptPending);
        summary.deferred += 1;
        return;
      }
      checkpoint = {
        ...checkpoint,
        admittedAt: Date.now(),
        paidResultToken,
        stage: "admitted",
      };
      durableAnchorCheckpoint(checkpoint);
    }
  }
  if (checkpoint.stage === "actor_started" && !checkpoint.apifyRunId) {
    const receipt = await readAnchorReceiptStatus(checkpoint);
    if (receipt?.paidState === "settled") {
      clearAnchorCheckpoint(checkpoint.trackId);
      return;
    }
    const key = JSON.stringify([
      checkpoint.actorStartedAt ?? checkpoint.createdAt,
      checkpoint.actorQueries ?? [checkpoint.anchorQuery],
    ]);
    let resolution = startResults.get(key);
    if (!resolution) {
      resolution = resolveAmbiguousApifyStart(checkpoint);
      startResults.set(key, resolution);
    }
    const outcome = await resolution;
    if (outcome === "pending") {
      return;
    }
    if (outcome === "unpaid") {
      await cancelPaidActorStart([checkpoint]);
      summary.deferred += 1;
      return;
    }
    checkpoint = { ...checkpoint, apifyRunId: outcome.runId };
    durableAnchorCheckpoint(checkpoint);
  }
  if (!checkpoint.paidResultToken) {
    throw new Error(`anchor ${checkpoint.trackId} has no paid result token`);
  }
  if (Date.now() - checkpoint.createdAt >= ANCHOR_PAID_RESULT_TTL_MS) {
    const receipt = await readAnchorReceiptStatus(checkpoint);
    if (receipt?.paidState === "settled") {
      clearAnchorCheckpoint(checkpoint.trackId);
      return;
    }
    if (!checkpoint.receiptAt || receipt?.admitted !== true || receipt.paidState !== "pending") {
      throw new Error(
        `anchor ${checkpoint.trackId} paid result token expired without a pending receipt`,
      );
    }
    checkpoint = { ...checkpoint, paidResultToken: await readAnchorPendingPaidToken(checkpoint) };
    durableAnchorCheckpoint(checkpoint);
  }
  if (checkpoint.stage === "actor_started" && checkpoint.apifyRunId) {
    let items: ApifyResultItem[];
    try {
      let task = runResults.get(checkpoint.apifyRunId);
      if (!task) {
        task = readApifyActorOnce(checkpoint.apifyRunId);
        runResults.set(checkpoint.apifyRunId, task);
      }
      const recovered = await task;
      if (recovered === null) {
        return;
      }
      items = recovered;
    } catch (error) {
      if (!(error instanceof ApifyTerminalRunError)) {
        throw error;
      }
      await cancelPaidActorRun([checkpoint]);
      summary.apifyActorErrors += 1;
      summary.deferred += 1;
      return;
    }
    const candidates = groupCandidatesByTarget(items).get(checkpoint.anchorQuery) ?? [];
    summary.apifyResults += items.length;
    summary.apifyRowsSent += 1;
    checkpoint = { ...checkpoint, candidates, stage: "results" };
    durableAnchorCheckpoint(checkpoint);
  }
  if (checkpoint.stage === "admitted") {
    if (!apifyEnabled) {
      return;
    }
    checkpoint = {
      ...checkpoint,
      actorQueries: [checkpoint.anchorQuery],
      actorStartedAt: Date.now(),
      stage: "actor_started",
    };
    durableAnchorCheckpoint(checkpoint);
    let items: ApifyResultItem[];
    try {
      items = await runApifyActor([checkpoint.anchorQuery], (runId) => {
        checkpoint = { ...checkpoint, apifyRunId: runId };
        durableAnchorCheckpoint(checkpoint);
      });
    } catch (error) {
      if (error instanceof ApifyStartError) {
        await cancelPaidActorStart([checkpoint]);
        summary.apifyActorErrors += 1;
        summary.deferred += 1;
        return;
      }
      if (error instanceof ApifyTerminalRunError) {
        await cancelPaidActorRun([checkpoint]);
        summary.apifyActorErrors += 1;
        summary.deferred += 1;
        return;
      }
      throw error;
    }
    const candidates = groupCandidatesByTarget(items).get(checkpoint.anchorQuery) ?? [];
    summary.apifyResults += items.length;
    summary.apifyRowsSent += 1;
    checkpoint = { ...checkpoint, candidates, stage: "results" };
    durableAnchorCheckpoint(checkpoint);
  }
  if (checkpoint.stage === "results") {
    if (!Array.isArray(checkpoint.candidates)) {
      throw new Error(`anchor ${checkpoint.trackId} result checkpoint is incomplete`);
    }
    let verdict: AnchorVerdict;
    try {
      strikes.reported += 1;
      verdict = await reportAnchor(
        checkpoint.trackId,
        checkpoint.candidates,
        checkpoint.paidResultToken,
      );
    } catch (error) {
      if (error instanceof AnchorReportError && (error.status === 404 || error.status === 409)) {
        await resolvePaidReport(checkpoint.trackId);
        summary.deferred += 1;
        return;
      }
      if (error instanceof AnchorReportError && (error.status === 400 || error.status === 422)) {
        strikes.rows.set(checkpoint.trackId, { status: error.status, summary });
        summary.failed += 1;
        summary.skipped += 1;
        summary.deferred += 1;
        return;
      }
      throw error;
    }
    if (verdict.anchored) {
      summary.produced += 1;
    } else {
      summary.missed += 1;
    }
  }
}

async function recoverAnchorPaidWork(
  summary: AnchorSweepSummary,
  blockedTrackIds: Set<string>,
  apifyEnabled: boolean,
): Promise<boolean> {
  let checkpoints: AnchorPaidCheckpoint[];
  let readErrors: { file: string; message: string }[];
  try {
    const listed = listAnchorCheckpoints();
    checkpoints = listed.checkpoints.sort((left, right) => left.createdAt - right.createdAt);
    readErrors = listed.errors;
  } catch (error) {
    log(`paid checkpoint read blocked: ${error instanceof Error ? error.message : String(error)}`);
    summary.blockedReason = "paid_result_recovery";
    return false;
  }
  for (const checkpoint of checkpoints) {
    blockedTrackIds.add(checkpoint.trackId);
  }
  let recoveryFailed = readErrors.length > 0;
  for (const error of readErrors) {
    log(`paid checkpoint ${error.file} blocked: ${error.message}`);
  }
  if (recoveryFailed) {
    summary.blockedReason = "paid_result_recovery";
  }
  const strikes: AnchorStrikeBuffer = { fault: false, reported: 0, rows: new Map() };
  const runResults = new Map<string, Promise<ApifyResultItem[] | null>>();
  const startResults = new Map<string, Promise<ApifyStartResolution>>();
  let blockedPaid = recoveryFailed;
  for (const checkpoint of checkpoints) {
    summary.checked += 1;
    try {
      if (!apifyEnabled && checkpoint.stage === "admitted") {
        recoveryFailed = true;
        continue;
      }
      await replayAnchorPaidCheckpoint(
        checkpoint,
        summary,
        !recoveryFailed && !blockedPaid,
        apifyEnabled,
        strikes,
        runResults,
        startResults,
      );
      blockedPaid ||= existsSync(anchorCheckpointPath(checkpoint.trackId));
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        pauseAnchorAdmission(summary, error);
        return false;
      }
      recoveryFailed = true;
      log(
        `paid checkpoint ${checkpoint.trackId} blocked: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.blockedReason = "paid_result_recovery";
    }
  }
  if (strikes.rows.size > 0) {
    try {
      const result = await flushAnchorStrikes({ log, recordInvalidFailure }, strikes, summary);
      summary.deferred = Math.max(0, summary.deferred - result.terminal);
      if (strikes.fault) {
        return false;
      }
      if (result.error) {
        recoveryFailed = true;
        summary.blockedReason = "paid_result_recovery";
      }
    } catch (error) {
      if (error instanceof AnchorAdmissionYieldError) {
        pauseAnchorAdmission(summary, error);
        return false;
      }
      recoveryFailed = true;
      log(`paid strike flush blocked: ${error instanceof Error ? error.message : String(error)}`);
      summary.blockedReason = "paid_result_recovery";
    }
  }
  if (recoveryFailed) {
    summary.blockedReason = "paid_result_recovery";
    return false;
  }
  const remaining = listAnchorCheckpoints();
  if (remaining.checkpoints.length > 0 || remaining.errors.length > 0) {
    summary.blockedReason = "awaiting_paid_result";
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const phaseIndex = process.argv.indexOf("--admission-phase");
  if (phaseIndex >= 0) {
    const statePath = process.argv[phaseIndex + 1];
    if (!statePath) {
      throw new Error("anchor admission phase requires request state");
    }
    await runAnchorAdmissionChild(statePath);
    return;
  }
  const started = Date.now();
  if (process.env.FLUNCLE_ANCHOR_TICK_LOCK_HELD !== "1") {
    mkdirSync(ANCHOR_PROGRESS_DIR, { mode: 0o700, recursive: true });
    chmodSync(ANCHOR_PROGRESS_DIR, 0o700);
    const child = Bun.spawn(
      [
        "flock",
        "-n",
        "-E",
        "75",
        join(ANCHOR_PROGRESS_DIR, "tick.lock"),
        process.execPath,
        import.meta.path,
        ...process.argv.slice(2),
      ],
      {
        env: { ...process.env, FLUNCLE_ANCHOR_TICK_LOCK_HELD: "1" },
        stderr: "inherit",
        stdout: "inherit",
      },
    );
    const exitCode = await child.exited;
    if (exitCode === 75) {
      console.log(
        JSON.stringify({
          ...newAnchorSweepSummary(),
          blockedReason: "anchor_tick_busy",
          elapsedMs: Date.now() - started,
        }),
      );
      return;
    }
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

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

  const recovered = newAnchorSweepSummary();
  const blockedTrackIds = new Set<string>();
  const probePaceState = { lastProbeAt: null as null | number };
  let apifyEnabledForRecovery = false;
  try {
    apifyEnabledForRecovery = (await readAnchorPreflight()).apifyEnabled;
  } catch (error) {
    if (error instanceof AnchorAdmissionYieldError) {
      pauseAnchorAdmission(recovered, error);
      console.log(JSON.stringify({ ...recovered, elapsedMs: Date.now() - started }));
      return;
    }
    log(
      `paid recovery preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const recoveredAll = await recoverAnchorPaidWork(
    recovered,
    blockedTrackIds,
    apifyEnabledForRecovery,
  );
  if (!recoveredAll && recovered.gateState === "paused") {
    console.log(JSON.stringify({ ...recovered, elapsedMs: Date.now() - started }));
    if (!recovered.ok) {
      process.exit(1);
    }
    return;
  }

  const summary = await runAnchorSweep(limit, {
    blockedTrackIds,
    cancelPaidActorRun,
    cancelPaidActorStart,
    fetchQueue: (pageLimit, paidMode) =>
      fetchAnchorQueue(
        recoveredAll ? pageLimit : Math.min(250, pageLimit + blockedTrackIds.size),
        paidMode,
      ),
    log,
    markPaidActorStarted,
    now: () => Date.now(),
    paidAdmissionDisabled: !recoveredAll,
    readIsrcDue: readAnchorIsrcDue,
    readPreflight: readAnchorPreflight,
    recordInvalidFailure,
    report: reportAnchor,
    resolveFree: async (trackId, deezerCandidates, options) => {
      try {
        return await resolveAnchorPhased(trackId, deezerCandidates, {
          ...options,
          allowPaid: recoveredAll && options?.allowPaid !== false,
        });
      } finally {
        if (existsSync(anchorCheckpointPath(trackId))) {
          blockedTrackIds.add(trackId);
        }
      }
    },
    resolveFreeBatch: async (rows) => {
      try {
        return await resolveAnchorPhasedBatch(
          rows,
          (trackId) => blockedTrackIds.add(trackId),
          probePaceState,
        );
      } finally {
        for (const row of rows) {
          if (existsSync(anchorCheckpointPath(row.trackId))) {
            blockedTrackIds.add(row.trackId);
          }
        }
      }
    },
    resolvePaidReport,
    resolveRelease: resolveAnchorReleaseOnBox,
    runActor: runApifyActor,
    saveApifyRunId,
    savePaidActorResults,
    searchDeezer: searchDeezerOnBox,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  summary.checked += recovered.checked;
  summary.produced += recovered.produced;
  summary.apifyResults += recovered.apifyResults;
  summary.apifyRowsSent += recovered.apifyRowsSent;
  summary.deferred += recovered.deferred;
  summary.missed += recovered.missed;
  summary.ok = summary.ok && recovered.ok;
  summary.errors += recovered.errors;
  summary.error ??= recovered.error;
  summary.failed += recovered.failed;
  summary.skipped += recovered.skipped;
  summary.blockedReason = recovered.blockedReason ?? summary.blockedReason;
  summary.reason ??= recovered.reason;
  if (!recoveredAll && !summary.rungsSkipped.includes("apify")) {
    summary.rungsSkipped.push("apify");
  }

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
