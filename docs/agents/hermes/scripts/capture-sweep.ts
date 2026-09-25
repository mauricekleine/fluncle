#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingSummary,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
} from "./due-work-repair-pending";

import {
  appendRejectedSource,
  fetchPreviewFingerprint,
  fold,
  fpcalcFingerprint,
  maxBer,
  mutualWindowMatch,
  normalizeArtists,
  parseRejectedSources,
  type RejectedSource,
  rejectedShas,
  rejectedVideoIds,
  slidingWindowMatch,
  splitTitle,
} from "./fingerprint-match";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const PROXY_HOST = process.env.FLUNCLE_YTDLP_PROXY_HOST ?? "";
const PROXY_PORT = process.env.FLUNCLE_YTDLP_PROXY_PORT ?? "";
const PROXY_USERNAME = process.env.FLUNCLE_YTDLP_PROXY_USERNAME ?? "";
const PROXY_PASSWORD = process.env.FLUNCLE_YTDLP_PROXY_PASSWORD ?? "";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";

const YT_DLP_BIN = process.env.YT_DLP_BIN ?? "yt-dlp";
const FFPROBE_BIN = process.env.FFPROBE_BIN ?? "ffprobe";
const BUN_BIN = process.env.BUN_BIN ?? "bun";
const CAPTURE_PROGRESS_DIR =
  process.env.FLUNCLE_CAPTURE_PROGRESS_DIR ??
  join(process.env.HOME ?? tmpdir(), ".fluncle-capture-progress");

const FLAT_SEARCH = (process.env.FLUNCLE_CAPTURE_FLAT_SEARCH ?? "1") !== "0";

const QUEUE_LIMIT = Number(process.env.FLUNCLE_CAPTURE_QUEUE_LIMIT ?? "8");
export const DEFAULT_CAPTURE_BATCH_CAP = 4;

export const MAX_CAPTURE_BATCH_CAP = 24;

export const resolveCaptureBatchCap = (raw: string | undefined): number => {
  const trimmed = raw?.trim() ?? "";

  if (trimmed === "") {
    return DEFAULT_CAPTURE_BATCH_CAP;
  }

  const parsed = Number(trimmed);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CAPTURE_BATCH_CAP) {
    console.error(
      `[capture-sweep] FLUNCLE_CAPTURE_BATCH_CAP=${JSON.stringify(raw)} is not an integer 1-${MAX_CAPTURE_BATCH_CAP} — using ${DEFAULT_CAPTURE_BATCH_CAP}`,
    );

    return DEFAULT_CAPTURE_BATCH_CAP;
  }

  return parsed;
};

const BATCH_CAP = resolveCaptureBatchCap(process.env.FLUNCLE_CAPTURE_BATCH_CAP);

const CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.FLUNCLE_CAPTURE_CONCURRENCY ?? "1")) || 1,
);

const TOLERANCE_SEC = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_SEC ?? "3");
const TOLERANCE_PCT = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_PCT ?? "0.03");

const DOWNLOAD_ATTEMPTS = Number(process.env.FLUNCLE_CAPTURE_DOWNLOAD_ATTEMPTS ?? "3");

export const DEFAULT_QUERY_VARIANTS = 4;
const QUERY_VARIANTS = Number(
  process.env.FLUNCLE_CAPTURE_QUERY_VARIANTS ?? String(DEFAULT_QUERY_VARIANTS),
);

const PROVENANCE_LIMIT = Number(process.env.FLUNCLE_CAPTURE_PROVENANCE_LIMIT ?? "2");

const PROVENANCE_CATALOGUE_LIMIT = Number(
  process.env.FLUNCLE_CAPTURE_PROVENANCE_CATALOGUE_LIMIT ?? "0",
);

const PROVENANCE_SEARCH_FACTOR = Number(
  process.env.FLUNCLE_CAPTURE_PROVENANCE_SEARCH_FACTOR ?? "5",
);

const PROVENANCE_SEGMENT_ATTEMPTS = Number(
  process.env.FLUNCLE_CAPTURE_PROVENANCE_SEGMENT_ATTEMPTS ?? "2",
);

const PROVENANCE_SEGMENT_RANGE = process.env.FLUNCLE_CAPTURE_SEGMENT_RANGE ?? "*00:30-01:00";

const REVERDICT_LIMIT = Number(process.env.FLUNCLE_CAPTURE_REVERDICT_LIMIT ?? "5");

const YT_SEARCH_TIMEOUT_MS = 60_000;
const YT_DOWNLOAD_TIMEOUT_MS = 180_000;

const log = (message: string) => console.error(`[capture-sweep] ${message}`);

export type CaptureFinding = {
  analyzedFrom?: "preview" | "full";

  anchored?: boolean;
  artists?: string[];

  artistYoutubeChannelIds?: string[];
  bpm?: number | null;

  captureSourcePin?: string;

  captureSourcePinAllowDuration?: boolean;

  certified?: boolean;
  durationMs?: number;

  label?: string;
  logId?: string;

  sourceAudioFailures?: number;

  sourceAudioKey?: string;

  sourceAudioRejected?: unknown;
  title?: string;
  trackId: string;
};

export type CaptureReconciliationKind = "capture" | "youtube-provenance" | "youtube-reverdict";
export type CaptureExternalResult =
  | {
      attemptedAt: string;
      kind: "capture";
      outcome: "failed" | "unmatched";
      sourceAudioRejected?: string;
    }
  | {
      attemptedAt: string;
      bodyBase64: string;
      bytes: number;
      capturedAt: string;
      captureVerification:
        | "consensus-verified"
        | "operator-verified"
        | "preview-match"
        | "unverified";
      contentType: string;
      kind: "capture";
      outcome: "done";
      sourceAudioKey: string;
      sourceAudioRejected?: string;
      verifiedAt: string;
      youtubeVideoId?: string;
    }
  | {
      kind: "youtube-provenance";
      outcome: "none";
      verification: "inconclusive" | "no-match";
    }
  | {
      kind: "youtube-provenance";
      outcome: "source-found";
      sourceVerification: "soundcloud-archive-match" | "soundcloud-preview-match";
    }
  | {
      kind: "youtube-provenance";
      outcome: "youtube-found";
      verification: "archive-match" | "metadata-match" | "preview-match";
      youtubeVideoId: string;
    }
  | { kind: "youtube-reverdict"; outcome: "reverdict" };

export type ReceiptCoordinates = {
  commitToken: string;
  operationId: "track.capture";
  operationKey: string;
  requestDigest: string;
};

export type CaptureCommitRequest = ReceiptCoordinates & { trackId: string };

export type CaptureAttemptProgress = {
  attempt: {
    attemptedAt: string;
    completion?: CaptureProviderCompletion;
    finding: CaptureFinding;
    kind: "capture" | "youtube-provenance";
    localDownload?: { bytes: number; fileName: string };
    state:
      | "local-download-present"
      | "provider-ambiguous"
      | "provider-completed"
      | "provider-intent";
    workDirectory: string;
  };
  snapshotToken: string;
  trackId: string;
};

type CaptureProviderCompletion =
  | {
      completedAt: string;
      outcome: "none";
      rejectedSources?: string;
    }
  | {
      completedAt: string;
      digest: string;
      ext: string;
      fileName: string;
      outcome: "accepted";
      rejectedSources?: string;
      source: CaptureSearchSource;
      verdict: "consensus" | "match" | "no-reference" | "operator";
      videoId: string;
    };

export type CaptureResultProgress = {
  receipt?: ReceiptCoordinates;
  result: CaptureExternalResult;
  snapshotToken: string;
  trackId: string;
};

export type CaptureProgress = CaptureAttemptProgress | CaptureResultProgress;

export type PreparedSnapshot =
  | { prepared: false; reason: "ineligible" | "not-found" | "stale" }
  | { prepared: true; snapshotToken: string; track: CaptureFinding };

export type ProgressDisposition = "committed" | "deferred" | "failed" | "pending" | "rejected";

export function preparedCaptureFinding(
  queued: CaptureFinding,
  current: CaptureFinding,
): CaptureFinding {
  return {
    ...current,
    ...(queued.artistYoutubeChannelIds
      ? { artistYoutubeChannelIds: queued.artistYoutubeChannelIds }
      : {}),
  };
}

export function buildStickyProxyUrl(options: {
  host: string;
  password: string;
  port: string;
  sessionId: string;
  username: string;
}): string {
  const session = options.sessionId.replace(/[^0-9A-Za-z.]/g, "");
  const userWithSession = `${options.username}__sessid.${session}`;
  const user = encodeURIComponent(userWithSession);
  const pass = encodeURIComponent(options.password);

  return `http://${user}:${pass}@${options.host}:${options.port}`;
}

export function isBotChallengeStderr(stderr: string): boolean {
  const soundCloudRateLimit =
    /soundcloud/i.test(stderr) &&
    /HTTP Error 429|status code 429|Too Many Requests|reached the API rate limit/i.test(stderr);

  return /Sign in to confirm|not a bot|Please sign in/i.test(stderr) || soundCloudRateLimit;
}

export type DownloadErrorFlags = {
  is403?: boolean;
  isBotChallenge?: boolean;
  isRecoverable?: boolean;
};

export function classifyDownloadFailure(stderr: string): DownloadErrorFlags {
  const soundCloudFailure = /soundcloud/i.test(stderr);
  const soundCloudCandidateFailure =
    soundCloudFailure &&
    /HTTP Error 429|status code 429|Too Many Requests|reached the API rate limit|geo(?:graphically)? restricted|not available in your country|not publicly available|private track|track is private/i.test(
      stderr,
    );

  return {
    is403: /HTTP Error 403|status code 403/.test(stderr),
    isBotChallenge: isBotChallengeStderr(stderr),

    isRecoverable:
      /DRM protected|Sign in to confirm|not a bot/i.test(stderr) || soundCloudCandidateFailure,
  };
}

export type DownloadRecovery = "reroll" | "player-client-fallback" | "give-up";

export function chooseDownloadRecovery(
  flags: DownloadErrorFlags,
  canReroll: boolean,
  source: CaptureSearchSource = "youtube",
): DownloadRecovery {
  if (flags.isBotChallenge && canReroll) {
    return "reroll";
  }
  if (flags.is403 && source !== "soundcloud") {
    return "player-client-fallback";
  }
  return "give-up";
}

export function rerollSessionId(sessionId: string): string {
  return `${sessionId}.r1`;
}

export function captureSessionSeed(idOrLogId: string, priorFailures: number): string {
  return priorFailures > 0 ? `${idOrLogId}.a${priorFailures}` : idOrLogId;
}

export function durationWithinTolerance(
  candidateSec: number,
  targetMs: number | undefined,
  options: { tolerancePct: number; toleranceSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
  },
): boolean {
  if (!Number.isFinite(candidateSec) || candidateSec <= 0) {
    return false;
  }

  if (!targetMs || !Number.isFinite(targetMs) || targetMs <= 0) {
    return false;
  }

  const targetSec = targetMs / 1000;
  const allowed = Math.max(options.toleranceSec, targetSec * options.tolerancePct);

  return Math.abs(candidateSec - targetSec) <= allowed;
}

export function buildSourceAudioKey(keyRoot: string, sha256Hex: string, ext: string): string {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();

  return `${keyRoot}/${sha256Hex}.${cleanExt}`;
}

export function extractSourceAudioSha256(key: string | undefined): null | string {
  if (!key) {
    return null;
  }

  const base = key.split("/").pop() ?? "";
  const dot = base.indexOf(".");
  const hash = (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();

  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

const WRONG_VERSION_MARKERS_ALL =
  /\b(remix|bootleg|live|sped[\s-]?up|slowed|nightcore|8d audio|cover|karaoke|instrumental|mashup|edit|rework|vip mix)\b/gi;

export function hasForeignVersionMarker(candidateTitle: string, findingTitle?: string): boolean {
  const candidateMarkers = candidateTitle.match(WRONG_VERSION_MARKERS_ALL);

  if (!candidateMarkers) {
    return false;
  }

  const own = new Set(
    (findingTitle?.match(WRONG_VERSION_MARKERS_ALL) ?? []).map((m) => m.toLowerCase()),
  );

  return candidateMarkers.some((marker) => !own.has(marker.toLowerCase()));
}
const OFFICIAL_MARKERS = /(-\s*topic\b|official audio|official video|official music video)/i;

const TOPIC_CHANNEL_MARKER = /-\s*topic\s*$/i;

export function isTopicChannel(channel: string | undefined): boolean {
  return channel ? TOPIC_CHANNEL_MARKER.test(channel.trim()) : false;
}

export const METADATA_TOLERANCE_SEC = Number(
  process.env.FLUNCLE_CAPTURE_METADATA_TOLERANCE_SEC ?? "3",
);

export function metadataDurationAgrees(
  candidateSec: number,
  targetMs: number | undefined,
): boolean {
  if (!Number.isFinite(candidateSec) || candidateSec <= 0 || !targetMs || targetMs <= 0) {
    return false;
  }

  return Math.abs(candidateSec - targetMs / 1000) <= METADATA_TOLERANCE_SEC;
}

export function topicChannelArtist(channel: string | undefined): string {
  return (channel ?? "").trim().replace(TOPIC_CHANNEL_MARKER, "").trim();
}

function creditedBy(claimed: ReadonlySet<string>, credited: ReadonlySet<string>): boolean {
  return claimed.size > 0 && [...claimed].every((name) => credited.has(name));
}

export type MetadataSignal = "channel" | "title";

const TITLE_ARTIST_SEPARATOR = /\s[-–—]\s/;

export function metadataIdentityMatch(
  candidate: YtCandidate,
  row: { artists?: readonly string[]; title?: string },
): MetadataSignal | null {
  const want = splitTitle(row.title ?? "");
  const credited = normalizeArtists([...(row.artists ?? [])]);

  if (!want.base || credited.size === 0) {
    return null;
  }

  const titleAgrees = (value: string) => {
    const got = splitTitle(value);

    return got.base === want.base && got.descriptor === want.descriptor;
  };

  if (
    isTopicChannel(candidate.channel) &&
    titleAgrees(candidate.title) &&
    creditedBy(normalizeArtists(topicChannelArtist(candidate.channel)), credited)
  ) {
    return "channel";
  }

  const parts = candidate.title.split(TITLE_ARTIST_SEPARATOR);

  for (let cut = 1; cut < parts.length; cut += 1) {
    const left = parts.slice(0, cut).join(" - ");
    const right = parts.slice(cut).join(" - ");

    if (titleAgrees(right) && creditedBy(normalizeArtists(left), credited)) {
      return "title";
    }
  }

  return null;
}

type MetadataHit = { candidate: YtCandidate; delta: number; signal: MetadataSignal };

function metadataHits(
  candidates: readonly YtCandidate[],
  row: { artists?: readonly string[]; durationMs?: number; title?: string },
): MetadataHit[] {
  const targetSec = (row.durationMs ?? 0) / 1000;
  const hits: MetadataHit[] = [];

  for (const candidate of candidates) {
    if (!metadataDurationAgrees(candidate.durationSec, row.durationMs)) {
      continue;
    }

    const signal = metadataIdentityMatch(candidate, row);

    if (signal) {
      hits.push({ candidate, delta: Math.abs(candidate.durationSec - targetSec), signal });
    }
  }

  return hits.sort((a, b) => a.delta - b.delta);
}

export function pickTopicCandidate(
  candidates: readonly YtCandidate[],
  row: { artists?: readonly string[]; durationMs?: number; title?: string },
): YtCandidate | null {
  const hits = metadataHits(candidates, row).filter(({ candidate }) =>
    isTopicChannel(candidate.channel),
  );

  if (hits.length === 0) {
    return null;
  }

  const primary = fold(row.artists?.[0] ?? "");
  const preferred = primary
    ? hits.find(({ candidate }) => fold(topicChannelArtist(candidate.channel)) === primary)
    : undefined;

  return (preferred ?? hits[0])?.candidate ?? null;
}

export function pickSegmentCandidates(
  candidates: readonly YtCandidate[],
  row: { artists?: readonly string[]; durationMs?: number; title?: string },
  rejectedIds: ReadonlySet<string>,
  attempts: number,
): YtCandidate[] {
  return metadataHits(candidates, row)
    .filter(({ candidate }) => !isTopicChannel(candidate.channel) && !rejectedIds.has(candidate.id))
    .slice(0, Math.max(0, attempts))
    .map(({ candidate }) => candidate);
}

const TRAILING_VERSION_PAREN = /\s*[([][^)\]]*[)\]]\s*$/;

export function buildSearchQuery(
  finding: { artists?: readonly string[]; title?: string },
  variant: 0 | 1,
): string {
  const artists = finding.artists ?? [];
  const title = finding.title ?? "";
  const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

  if (variant === 0) {
    return collapse(`${artists.join(" ")} ${title}`);
  }

  const primaryArtist = artists[0] ?? "";
  const cleanedTitle = title.replace(TRAILING_VERSION_PAREN, "").trim();

  return collapse(`${primaryArtist} ${cleanedTitle}`);
}

export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[‐‒–—]/g, "-")
    .replace(/(?<=\w)[.:](?=\w)/g, "")
    .replace(/[.:](?=\s|$)/g, "")
    .replace(/&/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export type CaptureSearchSource = "music" | "soundcloud" | "youtube";

export type CaptureSearchRung = {
  query: string;
  source: CaptureSearchSource;
};

export function buildCaptureSearchLadder(
  finding: { artists?: readonly string[]; title?: string },
  queryVariants = QUERY_VARIANTS,
): CaptureSearchRung[] {
  const primaryQuery = buildSearchQuery(finding, 0);
  const fallbackQuery = normalizeSearchQuery(buildSearchQuery(finding, 1));

  return [
    { query: primaryQuery, source: "youtube" },
    { query: primaryQuery, source: "music" },
    ...(fallbackQuery && fallbackQuery !== primaryQuery
      ? [{ query: fallbackQuery, source: "music" as const }]
      : []),
    { query: primaryQuery, source: "soundcloud" },
  ].slice(0, Math.max(1, queryVariants));
}

export function buildCaptureSearchTarget(source: CaptureSearchSource, query: string): string[] {
  if (source === "music") {
    return [
      "--playlist-items",
      "1:5",
      `https://music.youtube.com/search?q=${encodeURIComponent(query)}`,
    ];
  }

  return [`${source === "soundcloud" ? "scsearch5" : "ytsearch5"}:${query}`];
}

export function buildCaptureDownloadUrl(source: CaptureSearchSource, id: string): string {
  return source === "soundcloud"
    ? `https://api.soundcloud.com/tracks/${encodeURIComponent(id)}`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

export function normalizeChannelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(
      /\b(records?|recordings?|music|audio|drum\s*(?:and|n)?\s*bass|dnb|official|channel|tv|ltd)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, "");
}

const TRUSTED_CHANNEL_NAMES = new Set(
  [
    "UKF",
    "UKF Drum & Bass",
    "Liquicity",
    "Liquicity Records",
    "Hospital Records",
    "Hospitality",
    "Shogun Audio",
    "RAM Records",
    "Critical Music",
    "Blackout Music",
    "Vision Recordings",
    "Overview Music",
    "Korsakov Music",
    "Flashover Recordings",
    "Sofa Sound",
    "Metalheadz",
    "V Recordings",
    "Hospital Records TV",
    "Monstercat",
    "Monstercat Uncaged",
  ].map(normalizeChannelName),
);
const TRUSTED_CHANNEL_IDS = new Set<string>(["UCr8oc-LOaApCXWLjL7vdsgw"]);

export type TrustTier = 0 | 1 | 2;

export function classifyChannelTrust(
  candidate: YtCandidate,
  context: { artistYoutubeChannelIds?: readonly string[]; label?: string },
): TrustTier {
  const channelId = candidate.channelId ?? "";
  const channelKey = normalizeChannelName(candidate.channel ?? "");

  if (channelId && context.artistYoutubeChannelIds?.includes(channelId)) {
    return 2;
  }
  if (channelId && TRUSTED_CHANNEL_IDS.has(channelId)) {
    return 2;
  }

  if (isTopicChannel(candidate.channel)) {
    return 2;
  }
  if (channelKey && TRUSTED_CHANNEL_NAMES.has(channelKey)) {
    return 2;
  }
  const labelKey = normalizeChannelName(context.label ?? "");
  if (labelKey && channelKey && labelKey === channelKey) {
    return 2;
  }
  return candidate.verified ? 1 : 0;
}

export type YtCandidate = {
  channel?: string;
  channelId?: string;
  durationSec: number;
  id: string;

  source?: CaptureSearchSource;
  title: string;
  verified?: boolean;
};

export function rankCandidates(
  candidates: readonly YtCandidate[],
  context: {
    artistYoutubeChannelIds?: readonly string[];
    durationMs?: number;
    label?: string;
    title?: string;
  },
  options: { tolerancePct: number; toleranceSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
  },
): { candidate: YtCandidate; trust: TrustTier }[] {
  const targetSec = context.durationMs && context.durationMs > 0 ? context.durationMs / 1000 : 0;
  const scored = candidates
    .map((candidate) => ({ candidate, trust: classifyChannelTrust(candidate, context) }))
    .filter(({ candidate }) =>
      durationWithinTolerance(candidate.durationSec, context.durationMs, options),
    )
    .map(({ candidate, trust }) => ({
      candidate,
      clean: hasForeignVersionMarker(candidate.title, context.title) ? 0 : 1,
      delta: Math.abs(candidate.durationSec - targetSec),

      official: OFFICIAL_MARKERS.test(candidate.title) || isTopicChannel(candidate.channel) ? 1 : 0,
      trust,
      verified: candidate.verified ? 1 : 0,
    }));

  scored.sort(
    (a, b) =>
      b.clean - a.clean ||
      b.trust - a.trust ||
      b.official - a.official ||
      b.verified - a.verified ||
      a.delta - b.delta,
  );

  return scored.map(({ candidate, trust }) => ({ candidate, trust }));
}

export function findFirstRankedCaptureRung(
  rungs: readonly CaptureSearchRung[],
  context: Parameters<typeof rankCandidates>[1],
  search: (rung: CaptureSearchRung, step: number) => readonly YtCandidate[],
): { ranked: ReturnType<typeof rankCandidates>; rung: CaptureSearchRung } | null {
  for (const [step, rung] of rungs.entries()) {
    const ranked = rankCandidates(search(rung, step), context);
    if (ranked.length > 0) {
      return { ranked, rung };
    }
  }

  return null;
}

export function pickCandidate(
  candidates: readonly YtCandidate[],
  context: {
    artistYoutubeChannelIds?: readonly string[];
    durationMs?: number;
    label?: string;
    title?: string;
  },
  options?: { tolerancePct: number; toleranceSec: number },
): { candidate: YtCandidate; trust: TrustTier } | null {
  return rankCandidates(candidates, context, options)[0] ?? null;
}

export function bpmIsMissing(bpm: number | null | undefined): boolean {
  return bpm == null || !Number.isFinite(bpm) || bpm <= 0;
}

export function needsReenrichAfterCapture(
  bpm: number | null | undefined,
  analyzedFrom: "preview" | "full" | undefined,
): boolean {
  return bpmIsMissing(bpm) || analyzedFrom !== "full";
}

export function shouldReenrichAfterCapture(
  certified: boolean | undefined,
  bpm: number | null | undefined,
  analyzedFrom: "preview" | "full" | undefined,
): boolean {
  return certified === true && needsReenrichAfterCapture(bpm, analyzedFrom);
}

export function contentTypeForExt(ext: string): string {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const map: Record<string, string> = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    webm: "audio/webm",
  };

  return map[cleanExt] ?? "application/octet-stream";
}

export function filterRejectedCandidates<T extends { candidate: { id: string } }>(
  ranked: readonly T[],
  rejectedIds: ReadonlySet<string>,
  attempts: number,
): T[] {
  return ranked.filter((entry) => !rejectedIds.has(entry.candidate.id)).slice(0, attempts);
}

export type CaptureVerdict = "match" | "mismatch" | "no-reference";

export function verifyCaptureFile(
  previewFp: number[] | null,
  captureFilePath: string,
): CaptureVerdict {
  return verifyCaptureFileDetailed(previewFp, captureFp(captureFilePath)).verdict;
}

function captureFp(captureFilePath: string): null | number[] {
  return fpcalcFingerprint(captureFilePath);
}

export function verifyCaptureFileDetailed(
  previewFp: readonly number[] | null,
  captureFingerprint: readonly number[] | null,
): { ber?: number; verdict: CaptureVerdict } {
  if (previewFp === null || captureFingerprint === null) {
    return { verdict: "no-reference" };
  }

  const result = slidingWindowMatch(previewFp, captureFingerprint);

  if (result === null) {
    return { verdict: "no-reference" };
  }

  return { ber: result.ber, verdict: result.match ? "match" : "mismatch" };
}

const encoder = new TextEncoder();

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = webCryptoBytes(typeof data === "string" ? encoder.encode(data) : data);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof ArrayBuffer ? key : webCryptoBytes(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function canonicalUri(pathname: string): string {
  return pathname.split("/").map(encodeRfc3986).join("/");
}
async function signS3Request(options: {
  accessKeyId: string;
  body?: Uint8Array;
  contentType?: string;
  method: string;
  now: Date;
  region: string;
  secretAccessKey: string;
  service: string;
  url: string;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const stamp = options.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array());
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    options.method,
    canonicalUri(url.pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${options.secretAccessKey}`);
  for (const part of [dateStamp, options.region, options.service, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = toHex(await hmac(signingKey, stringToSign));
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export type CaptureFailureKind = "proxy" | "r2" | "track-update" | "unknown" | "yt-dlp";

export type CaptureFailureMeter = {
  failureRecording: number;
  proxy: number;
  r2: number;
  trackUpdate: number;
  unknown: number;
  ytDlp: number;
};

export function createCaptureFailureMeter(): CaptureFailureMeter {
  return {
    failureRecording: 0,
    proxy: 0,
    r2: 0,
    trackUpdate: 0,
    unknown: 0,
    ytDlp: 0,
  };
}

export function classifyCaptureFailure(error: unknown): CaptureFailureKind {
  const tagged = (error as { captureFailureKind?: unknown } | null)?.captureFailureKind;
  if (
    tagged === "proxy" ||
    tagged === "r2" ||
    tagged === "track-update" ||
    tagged === "unknown" ||
    tagged === "yt-dlp"
  ) {
    return tagged;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (
    /Unable to connect to proxy|ProxyError|Tunnel connection failed|Proxy Authentication Required|HTTP Error 407|status code 407|407 TRAFFIC_EXHAUSTED/i.test(
      message,
    )
  ) {
    return "proxy";
  }
  if (/^R2 (?:GET|PUT)\b/i.test(message)) {
    return "r2";
  }
  if (/^update_track\b/i.test(message)) {
    return "track-update";
  }
  if (/^yt-dlp\b/i.test(message)) {
    return "yt-dlp";
  }
  return "unknown";
}

function tagCaptureFailure(kind: CaptureFailureKind, error: unknown): Error {
  const tagged = error instanceof Error ? error : new Error(String(error));
  Object.assign(tagged, { captureFailureKind: kind });
  return tagged;
}

export function noteCaptureFailure(meter: CaptureFailureMeter, error: unknown): CaptureFailureKind {
  const kind = classifyCaptureFailure(error);
  if (kind === "track-update") {
    meter.trackUpdate += 1;
  } else if (kind === "yt-dlp") {
    meter.ytDlp += 1;
  } else {
    meter[kind] += 1;
  }
  return kind;
}

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function r2Put(key: string, body: Uint8Array, contentType: string): Promise<void> {
  try {
    const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
    const headers = await signS3Request({
      accessKeyId: R2_ACCESS_KEY_ID,
      body,
      contentType,
      method: "PUT",
      now: new Date(),
      region: "auto",
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: "s3",
      url,
    });
    const res = await fetch(url, {
      body,
      headers: { ...headers, "content-type": contentType },
      method: "PUT",
    });
    if (!res.ok) {
      throw new Error(`R2 PUT ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  } catch (error) {
    throw tagCaptureFailure("r2", error);
  }
}

async function r2Exists(key: string, expectedBytes: number): Promise<boolean> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2_ACCESS_KEY_ID,
    method: "HEAD",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    url,
  });
  const response = await fetch(url, { headers, method: "HEAD" });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw tagCaptureFailure("r2", new Error(`R2 HEAD ${key} failed (${response.status})`));
  }
  if (Number(response.headers.get("content-length")) !== expectedBytes) {
    throw tagCaptureFailure("r2", new Error(`R2 HEAD ${key} returned an unexpected size`));
  }
  return true;
}

async function r2Get(key: string): Promise<null | Uint8Array> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2_ACCESS_KEY_ID,
    method: "GET",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    url,
  });
  const res = await fetch(url, { headers, method: "GET" });

  if (!res.ok) {
    log(`R2 GET ${key} did not answer (${res.status}) — rung 2 has no reference for this row`);

    return null;
  }

  return new Uint8Array(await res.arrayBuffer());
}

async function fetchTrackWork(options: {
  kind: "capture" | "youtube-provenance" | "youtube-reverdict";
  limit: number;
  scope: "all" | "catalogue" | "findings";

  withCapabilities?: boolean;
}): Promise<CaptureFinding[] | { capabilities?: unknown; tracks: CaptureFinding[] }> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/work?kind=${options.kind}&scope=${options.scope}&limit=${options.limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },

    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const failure = await failureBodyUnlessRepairPending(res, `${options.kind} queue read`);
    throw new Error(`${options.kind} queue read failed (${res.status}): ${failure.slice(0, 200)}`);
  }
  const body = (await res.json()) as { capabilities?: unknown; tracks?: CaptureFinding[] };
  const tracks = Array.isArray(body.tracks) ? body.tracks : [];
  return options.withCapabilities === true ? { capabilities: body.capabilities, tracks } : tracks;
}

async function fetchCaptureQueue(): Promise<CaptureFinding[]> {
  const page = await fetchTrackWork({ kind: "capture", limit: QUEUE_LIMIT, scope: "all" });
  return Array.isArray(page) ? page : page.tracks;
}

async function adminApiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw tagCaptureFailure(
      "track-update",
      new Error(`${path} failed (${response.status}): ${(await response.text()).slice(0, 200)}`),
    );
  }
  return (await response.json()) as T;
}

function progressPath(trackId: string, kind: CaptureReconciliationKind): string {
  const id = createHash("sha256").update(`${kind}\u0000${trackId}`).digest("hex");
  return join(CAPTURE_PROGRESS_DIR, `${id}.json`);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  chmodSync(parent, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  const file = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(file, JSON.stringify(value), { encoding: "utf8" });
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  const directory = openSync(parent, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function readProgress(path: string): CaptureProgress {
  return JSON.parse(readFileSync(path, "utf8")) as CaptureProgress;
}

export function isCaptureAttemptProgress(
  progress: CaptureProgress,
): progress is CaptureAttemptProgress {
  return "attempt" in progress;
}

export type JournaledCaptureProviderResult<T> =
  | { disposition: "pending" }
  | { disposition: "completed"; value: T; workDirectory: string };

export async function runJournaledCaptureProvider<T>(options: {
  afterProvider?: (value: T) => void | Promise<void>;
  beforeProvider?: () => void | Promise<void>;
  completion?: (value: T, workDirectory: string) => CaptureProviderCompletion;
  finding: CaptureFinding;
  kind: "capture" | "youtube-provenance";
  progressPath?: typeof progressPath;
  provider: (workDirectory: string) => Promise<T>;
  snapshotToken: string;
}): Promise<JournaledCaptureProviderResult<T>> {
  const path = (options.progressPath ?? progressPath)(options.finding.trackId, options.kind);
  if (existsSync(path)) {
    return { disposition: "pending" };
  }
  const workDirectory = `${path}.work`;
  rmSync(workDirectory, { force: true, recursive: true });
  mkdirSync(workDirectory, { mode: 0o700, recursive: true });
  chmodSync(workDirectory, 0o700);
  writeJsonAtomic(path, {
    attempt: {
      attemptedAt: new Date().toISOString(),
      finding: options.finding,
      kind: options.kind,
      state: "provider-intent",
      workDirectory,
    },
    snapshotToken: options.snapshotToken,
    trackId: options.finding.trackId,
  } satisfies CaptureAttemptProgress);
  await options.beforeProvider?.();
  const value = await options.provider(workDirectory);
  await options.afterProvider?.(value);
  if (options.completion) {
    const completion = options.completion(value, workDirectory);
    if (completion.outcome === "accepted") {
      if (
        completion.fileName !== basename(completion.fileName) ||
        !/^audio\.[A-Za-z0-9]+$/.test(completion.fileName)
      ) {
        throw new Error(
          `provider returned an unsafe completed file for ${options.finding.trackId}`,
        );
      }
      const completedFile = join(workDirectory, completion.fileName);
      chmodSync(completedFile, 0o600);
      const file = openSync(completedFile, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      const directory = openSync(workDirectory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    const progress = readProgress(path);
    if (!isCaptureAttemptProgress(progress)) {
      throw new Error(`provider attempt journal disappeared for ${options.finding.trackId}`);
    }
    writeJsonAtomic(path, {
      ...progress,
      attempt: {
        ...progress.attempt,
        completion,
        state: "provider-completed",
      },
    } satisfies CaptureAttemptProgress);
  }
  return { disposition: "completed", value, workDirectory };
}

function externalResultForWire(result: CaptureExternalResult): Record<string, unknown> {
  if (result.kind !== "capture" || result.outcome !== "done") {
    return result;
  }
  const { bodyBase64: _bodyBase64, contentType: _contentType, ...wire } = result;
  return wire;
}

type CaptureAdmissionAction =
  | "commit"
  | "commit-batch"
  | "prepare"
  | "prepare-batch"
  | "queue"
  | "reconcile";

export const CAPTURE_ADMISSION_ACTIONS = [
  "commit",
  "commit-batch",
  "prepare",
  "prepare-batch",
  "queue",
  "reconcile",
] as const satisfies readonly CaptureAdmissionAction[];

export function isCaptureAdmissionAction(value: string): value is CaptureAdmissionAction {
  return (CAPTURE_ADMISSION_ACTIONS as readonly string[]).includes(value);
}

function phaseCommand(action: CaptureAdmissionAction, statePath: string): string[] {
  return [BUN_BIN, import.meta.filename, "--admission-phase", action, "--phase-state", statePath];
}

let admittedPhaseCount = 0;

function admittedPhase(action: CaptureAdmissionAction, statePath: string): "completed" | "yielded" {
  admittedPhaseCount += 1;

  return runDatabaseAdmissionPhase({
    command: phaseCommand(action, statePath),
    owner: "fluncle-capture",
    yieldRetries: 0,
  }).kind;
}

export type CaptureCapabilities = {
  commitTrackCaptures?: number;
  prepareTrackCaptures?: number;
};

export function captureBatchPhasesEnabled(): boolean {
  return (process.env.FLUNCLE_CAPTURE_BATCH_PHASES ?? "1") !== "0";
}

export function parseCaptureCapabilities(value: unknown): CaptureCapabilities | undefined {
  if (!captureBatchPhasesEnabled() || !isRecord(value)) {
    return undefined;
  }
  const width = (key: "commitTrackCaptures" | "prepareTrackCaptures"): number | undefined => {
    const raw = value[key];
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : undefined;
  };
  const commitTrackCaptures = width("commitTrackCaptures");
  const prepareTrackCaptures = width("prepareTrackCaptures");
  return commitTrackCaptures === undefined && prepareTrackCaptures === undefined
    ? undefined
    : {
        ...(commitTrackCaptures === undefined ? {} : { commitTrackCaptures }),
        ...(prepareTrackCaptures === undefined ? {} : { prepareTrackCaptures }),
      };
}

async function runCaptureAdmissionChild(
  action: CaptureAdmissionAction,
  statePath: string,
): Promise<void> {
  const request = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  let result: unknown;
  if (action === "queue") {
    try {
      const page =
        typeof request.kind === "string"
          ? await fetchTrackWork({
              kind: request.kind as "capture" | "youtube-provenance" | "youtube-reverdict",
              limit: Number(request.limit),
              scope: request.scope as "all" | "catalogue" | "findings",
              withCapabilities: true,
            })
          : { tracks: await fetchCaptureQueue() };
      result = page;
    } catch (error) {
      if (!isDueWorkRepairPending(error)) {
        throw error;
      }

      log(error.message);
      result = { dueWorkRepairPending: true };
    }
  } else if (action === "prepare") {
    const trackId = typeof request.trackId === "string" ? request.trackId : "";
    result = await adminApiPost<PreparedSnapshot>(
      `/api/v1/admin/tracks/${encodeURIComponent(trackId)}/capture/prepare`,
      request,
    );
  } else if (action === "prepare-batch") {
    result = await adminApiPost("/api/v1/admin/tracks/captures/prepare", request);
  } else if (action === "commit-batch") {
    result = await adminApiPost("/api/v1/admin/tracks/captures/commit", request);
  } else if (action === "commit") {
    const body = captureCommitRequestFromState(request);
    if (!body) {
      throw new Error("capture commit phase state does not carry a valid receipt");
    }
    result = await adminApiPost(
      `/api/v1/admin/tracks/${encodeURIComponent(body.trackId)}/capture/commit`,
      body,
    );
  } else {
    result = await adminApiPost("/api/v1/admin/operation-receipts/resolve", request);
  }
  writeJsonAtomic(`${statePath}.result`, result);
}

function validOptionalPreparedString(
  track: Record<string, unknown>,
  key: string,
  max: number,
): boolean {
  const value = track[key];
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function validOptionalPreparedBoolean(track: Record<string, unknown>, key: string): boolean {
  const value = track[key];
  return value === undefined || typeof value === "boolean";
}

const PREPARED_TRACK_KEYS = new Set([
  "analyzedFrom",
  "anchored",
  "artists",
  "bpm",
  "captureSourcePin",
  "captureSourcePinAllowDuration",
  "certified",
  "durationMs",
  "label",
  "logId",
  "sourceAudioFailures",
  "sourceAudioKey",
  "sourceAudioRejected",
  "title",
  "trackId",
]);

function unknownPreparedTrackKeys(track: unknown): string[] {
  return isRecord(track) ? Object.keys(track).filter((key) => !PREPARED_TRACK_KEYS.has(key)) : [];
}

function validPreparedTrack(value: unknown, expectedTrackId: string): value is CaptureFinding {
  if (!isRecord(value)) {
    return false;
  }
  const allowedKeys = PREPARED_TRACK_KEYS;
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    value.trackId === expectedTrackId &&
    expectedTrackId.length >= 1 &&
    expectedTrackId.length <= 256 &&
    typeof value.title === "string" &&
    value.title.length <= 2_048 &&
    typeof value.certified === "boolean" &&
    Array.isArray(value.artists) &&
    value.artists.length <= 64 &&
    value.artists.every((artist) => typeof artist === "string" && artist.length <= 512) &&
    (value.analyzedFrom === undefined ||
      value.analyzedFrom === "full" ||
      value.analyzedFrom === "preview") &&
    validOptionalPreparedBoolean(value, "anchored") &&
    (value.bpm === undefined || (typeof value.bpm === "number" && Number.isFinite(value.bpm))) &&
    (value.durationMs === undefined ||
      (Number.isInteger(value.durationMs) && Number(value.durationMs) >= 1)) &&
    (value.sourceAudioFailures === undefined ||
      (Number.isInteger(value.sourceAudioFailures) && Number(value.sourceAudioFailures) >= 0)) &&
    validOptionalPreparedString(value, "captureSourcePin", 64) &&
    validOptionalPreparedBoolean(value, "captureSourcePinAllowDuration") &&
    validOptionalPreparedString(value, "label", 1_024) &&
    validOptionalPreparedString(value, "logId", 64) &&
    validOptionalPreparedString(value, "sourceAudioKey", 1_024) &&
    validOptionalPreparedString(value, "sourceAudioRejected", 16_384)
  );
}

function parsedPreparedSnapshot(
  response: unknown,
  expectedTrackId: string,
): PreparedSnapshot | undefined {
  if (!isRecord(response) || response.ok !== true) {
    return undefined;
  }
  if (response.prepared === false) {
    return hasExactKeys(response, ["ok", "prepared", "reason"]) &&
      (response.reason === "ineligible" ||
        response.reason === "not-found" ||
        response.reason === "stale")
      ? { prepared: false, reason: response.reason }
      : undefined;
  }
  return response.prepared === true &&
    hasExactKeys(response, ["ok", "prepared", "snapshotToken", "track"]) &&
    typeof response.snapshotToken === "string" &&
    response.snapshotToken.length >= 1 &&
    response.snapshotToken.length <= 65_536 &&
    validPreparedTrack(response.track, expectedTrackId)
    ? { prepared: true, snapshotToken: response.snapshotToken, track: response.track }
    : undefined;
}

function validPreparedSnapshotValue(
  value: unknown,
  expectedTrackId: string,
): value is PreparedSnapshot {
  if (!isRecord(value) || typeof value.prepared !== "boolean") {
    return false;
  }
  return value.prepared
    ? hasExactKeys(value, ["prepared", "snapshotToken", "track"]) &&
        typeof value.snapshotToken === "string" &&
        value.snapshotToken.length >= 1 &&
        value.snapshotToken.length <= 65_536 &&
        validPreparedTrack(value.track, expectedTrackId)
    : hasExactKeys(value, ["prepared", "reason"]) &&
        (value.reason === "ineligible" || value.reason === "not-found" || value.reason === "stale");
}

function prepareCurrentSnapshot(
  trackId: string,
  kind: CaptureReconciliationKind,
  priorSnapshotToken?: string,
): PreparedSnapshot | "yielded" {
  const path = progressPath(trackId, `${kind}` as CaptureReconciliationKind) + ".prepare";
  writeJsonAtomic(path, { kind, priorSnapshotToken, trackId });
  rmSync(`${path}.result`, { force: true });
  const phase = admittedPhase("prepare", path);
  if (phase === "yielded") {
    return "yielded";
  }
  const response = parsedPreparedSnapshot(
    JSON.parse(readFileSync(`${path}.result`, "utf8")),
    trackId,
  );
  rmSync(path, { force: true });
  rmSync(`${path}.result`, { force: true });
  if (!response) {
    throw new Error(`capture prepare returned an invalid response for ${trackId}`);
  }
  return response;
}

export type CapturePrepareBatchPage = {
  elapsedMs: number[];
  prepared: Map<string, PreparedSnapshot>;

  reserved: number;

  unreached: string[];
};

function prepareBatchSnapshots(
  trackIds: readonly string[],
  kind: CaptureReconciliationKind,
  reservedThisTick: number,
  phase: typeof admittedPhase = admittedPhase,
): CapturePrepareBatchPage | undefined {
  const path = join(CAPTURE_PROGRESS_DIR, `prepare-batch-${kind}-${process.pid}.json`);
  writeJsonAtomic(path, {
    items: trackIds.map((trackId) => ({ kind, trackId })),
    reservedThisTick,
  });
  rmSync(`${path}.result`, { force: true });
  if (phase("prepare-batch", path) === "yielded") {
    return undefined;
  }
  let response: unknown;
  try {
    response = JSON.parse(readFileSync(`${path}.result`, "utf8"));
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.result`, { force: true });
  }
  if (!isRecord(response) || response.ok !== true || !Array.isArray(response.results)) {
    throw new Error("capture batch prepare returned an invalid response");
  }
  const prepared = new Map<string, PreparedSnapshot>();
  const elapsedMs: number[] = [];
  const unreached: string[] = [];
  for (const row of response.results) {
    if (!isRecord(row) || typeof row.trackId !== "string") {
      throw new Error("capture batch prepare returned an invalid response");
    }
    const { elapsedMs: itemMs, trackId, ...rest } = row;
    if (typeof itemMs === "number" && Number.isFinite(itemMs) && itemMs >= 0) {
      elapsedMs.push(itemMs);
    }

    if (rest.prepared === false && rest.reason === "deferred") {
      continue;
    }

    if (rest.prepared === true) {
      const unknown = unknownPreparedTrackKeys(rest.track);
      if (unknown.length > 0) {
        log(
          `prepared row ${trackId} carries field(s) this bake does not know (${unknown.join(", ")}) — leaving it unreached until the box is rebaked`,
        );
        unreached.push(trackId);
        continue;
      }
    }
    if (!validPreparedSnapshotValue(rest, trackId)) {
      throw new Error(`capture batch prepare returned an invalid answer for ${trackId}`);
    }
    prepared.set(trackId, rest);
  }

  const reserved =
    typeof response.reserved === "number" &&
    Number.isInteger(response.reserved) &&
    response.reserved >= 0
      ? response.reserved
      : [...prepared.values()].filter((entry) => entry.prepared && entry.track.certified === false)
          .length;
  return { elapsedMs, prepared, reserved, unreached };
}

export function prepareTickSnapshots(
  trackIds: readonly string[],
  kind: CaptureReconciliationKind,
  width: number,

  phase: typeof admittedPhase = admittedPhase,
): CapturePrepareBatchPage | undefined {
  const prepared = new Map<string, PreparedSnapshot>();
  const elapsedMs: number[] = [];
  const unreached: string[] = [];
  let reserved = 0;
  let outstanding = [...trackIds];

  const maxCalls = Math.ceil(trackIds.length / Math.max(1, width)) + 2;

  for (let call = 0; call < maxCalls && outstanding.length > 0; call += 1) {
    const page = prepareBatchSnapshots(outstanding.slice(0, width), kind, reserved, phase);
    if (page === undefined) {
      return undefined;
    }
    reserved += page.reserved;
    elapsedMs.push(...page.elapsedMs);
    for (const [trackId, snapshot] of page.prepared) {
      prepared.set(trackId, snapshot);
    }

    unreached.push(...page.unreached);
    const settled = new Set([...prepared.keys(), ...unreached]);
    const next = outstanding.filter((trackId) => !settled.has(trackId));
    if (next.length === outstanding.length) {
      break;
    }
    outstanding = next;
  }

  return { elapsedMs, prepared, reserved, unreached };
}

function admittedWorkList(options: {
  capabilities?: { value?: CaptureCapabilities };
  kind: "capture" | "youtube-provenance" | "youtube-reverdict";
  limit: number;
  scope: "all" | "catalogue" | "findings";
}): CaptureFinding[] | "due-work-repair-pending" | "yielded" {
  const path = join(
    CAPTURE_PROGRESS_DIR,
    `queue-${options.kind}-${options.scope}-${process.pid}.json`,
  );
  writeJsonAtomic(path, options);
  rmSync(`${path}.result`, { force: true });
  if (admittedPhase("queue", path) === "yielded") {
    return "yielded";
  }
  const response = JSON.parse(readFileSync(`${path}.result`, "utf8")) as {
    capabilities?: unknown;
    dueWorkRepairPending?: boolean;
    tracks?: CaptureFinding[];
  };
  rmSync(path, { force: true });
  rmSync(`${path}.result`, { force: true });
  if (options.capabilities) {
    options.capabilities.value = parseCaptureCapabilities(response.capabilities);
  }

  if (response.dueWorkRepairPending === true) {
    return "due-work-repair-pending";
  }
  return response.tracks ?? [];
}

async function authorizeProgress(progress: CaptureResultProgress): Promise<CaptureResultProgress> {
  if (progress.receipt) {
    return progress;
  }
  const response = await adminApiPost<unknown>(
    `/api/v1/admin/tracks/${encodeURIComponent(progress.trackId)}/capture/authorize`,
    {
      result: externalResultForWire(progress.result),
      snapshotToken: progress.snapshotToken,
      trackId: progress.trackId,
    },
  );

  const receipt = receiptCoordinatesFrom(response);
  if (!receipt) {
    throw new Error(`capture authorize returned an invalid receipt for ${progress.trackId}`);
  }
  return { ...progress, receipt };
}

export type CollectedCaptureCommit = {
  path: string;
  request: CaptureCommitRequest;
  result: CaptureExternalResult;
};

export type CaptureProgressPorts = {
  admittedPhase: typeof admittedPhase;

  collectCommit?: (collected: CollectedCaptureCommit) => boolean;
  authorizeProgress: typeof authorizeProgress;
  prepareCurrentSnapshot: typeof prepareCurrentSnapshot;
  progressPath: typeof progressPath;
  r2Exists: typeof r2Exists;
  r2Put: typeof r2Put;
};

let activeCommitCollector: ((collected: CollectedCaptureCommit) => void) | undefined;

const CAPTURE_PROGRESS_PORTS: CaptureProgressPorts = {
  admittedPhase,
  authorizeProgress,
  collectCommit: (collected) => {
    if (activeCommitCollector === undefined) {
      return false;
    }
    activeCommitCollector(collected);
    return true;
  },
  prepareCurrentSnapshot,
  progressPath,
  r2Exists,
  r2Put,
};

type ReceiptDisposition = ProgressDisposition | "not-found";

const RECEIPT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/;
const RECEIPT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_SUMMARY_KEYS = [
  "createdAt",
  "operationId",
  "outcome",
  "resultIdentity",
  "state",
  "terminalAt",
  "updatedAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validReceiptCoordinates(receipt: ReceiptCoordinates): boolean {
  return (
    receipt.operationId === "track.capture" &&
    receipt.operationKey.length >= 1 &&
    receipt.operationKey.length <= 256 &&
    RECEIPT_KEY_PATTERN.test(receipt.operationKey) &&
    RECEIPT_DIGEST_PATTERN.test(receipt.requestDigest) &&
    receipt.commitToken.length >= 1 &&
    receipt.commitToken.length <= 65_536
  );
}

export function receiptCoordinatesFrom(value: unknown): ReceiptCoordinates | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { commitToken, operationId, operationKey, requestDigest } = value;
  if (
    typeof commitToken !== "string" ||
    operationId !== "track.capture" ||
    typeof operationKey !== "string" ||
    typeof requestDigest !== "string"
  ) {
    return undefined;
  }
  const receipt: ReceiptCoordinates = { commitToken, operationId, operationKey, requestDigest };
  return validReceiptCoordinates(receipt) ? receipt : undefined;
}

export function captureCommitRequest(
  receipt: ReceiptCoordinates,
  trackId: string,
): CaptureCommitRequest {
  return {
    commitToken: receipt.commitToken,
    operationId: receipt.operationId,
    operationKey: receipt.operationKey,
    requestDigest: receipt.requestDigest,
    trackId,
  };
}

export function captureCommitRequestFromState(state: unknown): CaptureCommitRequest | undefined {
  const receipt = receiptCoordinatesFrom(state);
  if (
    !receipt ||
    !isRecord(state) ||
    typeof state.trackId !== "string" ||
    state.trackId.length < 1 ||
    state.trackId.length > 256
  ) {
    return undefined;
  }
  return captureCommitRequest(receipt, state.trackId);
}

function completeReceiptSummary(response: unknown): Record<string, unknown> | undefined {
  return isRecord(response) &&
    hasExactKeys(response, ["ok", "receipt"]) &&
    response.ok === true &&
    isRecord(response.receipt) &&
    hasExactKeys(response.receipt, RECEIPT_SUMMARY_KEYS)
    ? response.receipt
    : undefined;
}

function isExactNotFoundReceipt(receipt: Record<string, unknown>): boolean {
  return (
    receipt.outcome === "not-found" &&
    receipt.createdAt === null &&
    receipt.operationId === null &&
    receipt.resultIdentity === null &&
    receipt.state === null &&
    receipt.terminalAt === null &&
    receipt.updatedAt === null
  );
}

function isCoherentStoredReceipt(
  receipt: Record<string, unknown>,
  expectedCoordinates: ReceiptCoordinates,
): boolean {
  const validFields =
    receipt.operationId === expectedCoordinates.operationId &&
    typeof receipt.createdAt === "string" &&
    typeof receipt.updatedAt === "string" &&
    (receipt.resultIdentity === null || typeof receipt.resultIdentity === "string") &&
    (receipt.terminalAt === null || typeof receipt.terminalAt === "string") &&
    (receipt.state === "accepted" || receipt.state === "committed" || receipt.state === "rejected");
  if (!validFields) {
    return false;
  }
  return (
    (receipt.state === "accepted" &&
      receipt.resultIdentity === null &&
      receipt.terminalAt === null) ||
    (receipt.state !== "accepted" &&
      typeof receipt.resultIdentity === "string" &&
      receipt.resultIdentity.length >= 1 &&
      typeof receipt.terminalAt === "string")
  );
}

function parsedReceiptDisposition(
  response: unknown,
  expectedCoordinates: ReceiptCoordinates,
): ReceiptDisposition | undefined {
  const receipt = completeReceiptSummary(response);
  if (!validReceiptCoordinates(expectedCoordinates) || !receipt) {
    return undefined;
  }
  const outcome = receipt.outcome;
  if (outcome === "not-found") {
    return isExactNotFoundReceipt(receipt) ? "not-found" : undefined;
  }
  if (!isCoherentStoredReceipt(receipt, expectedCoordinates)) {
    return undefined;
  }
  if (outcome === "committed" && receipt.state === "committed") {
    return "committed";
  }
  if (outcome === "rejected" && receipt.state === "rejected") {
    return "rejected";
  }
  if (outcome === "conflict" && receipt.state === "accepted") {
    return "rejected";
  }
  if (outcome === "in-progress" && receipt.state === "accepted") {
    return "pending";
  }
  return undefined;
}

function validCommittedCaptureResult(value: unknown, expected: CaptureExternalResult): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["applied", "kind", "outcome"]) &&
    value.applied === true &&
    value.kind === expected.kind &&
    value.outcome === expected.outcome
  );
}

function parsedCommitDisposition(
  response: unknown,
  expected: CaptureExternalResult,
): ProgressDisposition | undefined {
  if (!isRecord(response) || response.ok !== true || typeof response.replayed !== "boolean") {
    return undefined;
  }
  if (response.outcome === "committed") {
    return hasExactKeys(response, ["ok", "outcome", "replayed", "result"]) &&
      validCommittedCaptureResult(response.result, expected)
      ? "committed"
      : undefined;
  }
  if (response.outcome === "rejected") {
    return hasExactKeys(response, ["ok", "outcome", "replayed", "result"]) &&
      isRecord(response.result) &&
      hasExactKeys(response.result, ["applied", "reason"]) &&
      response.result.applied === false &&
      response.result.reason === "stale"
      ? "rejected"
      : undefined;
  }
  if (!hasExactKeys(response, ["ok", "outcome", "replayed"])) {
    return undefined;
  }
  if (response.outcome === "conflict") {
    return "rejected";
  }
  return response.outcome === "in-progress" || response.outcome === "safely-retryable"
    ? "pending"
    : undefined;
}

function reconcileReceipt(
  progress: CaptureProgress,
  path: string,
  ports: CaptureProgressPorts,
): ReceiptDisposition {
  const receipt = progress.receipt;
  if (!receipt) {
    return "pending";
  }
  writeJsonAtomic(path, {
    operationId: receipt.operationId,
    operationKey: receipt.operationKey,
    requestDigest: receipt.requestDigest,
  });
  rmSync(`${path}.result`, { force: true });
  if (ports.admittedPhase("reconcile", path) === "yielded") {
    return "pending";
  }
  let response: unknown;
  try {
    response = JSON.parse(readFileSync(`${path}.result`, "utf8"));
  } catch {
    return "pending";
  }
  return parsedReceiptDisposition(response, receipt) ?? "pending";
}

function completedLocalDownload(
  path: string,
  progress: CaptureAttemptProgress,
): { bytes: number; fileName: string } | undefined {
  if (
    progress.attempt.workDirectory !== `${path}.work` ||
    !existsSync(progress.attempt.workDirectory)
  ) {
    return undefined;
  }
  const files = readdirSync(progress.attempt.workDirectory).filter(
    (fileName) =>
      /^audio\.[A-Za-z0-9]+$/.test(fileName) &&
      fileName !== "audio.part" &&
      fileName !== "audio.ytdl",
  );
  if (files.length !== 1) {
    return undefined;
  }
  const fileName = files[0];
  if (fileName === undefined) {
    return undefined;
  }
  const file = statSync(join(progress.attempt.workDirectory, fileName));
  return file.isFile() && file.size > 0 ? { bytes: file.size, fileName } : undefined;
}

function removeCaptureAttempt(path: string, progress: CaptureAttemptProgress): void {
  rmSync(path, { force: true });
  if (progress.attempt.workDirectory === `${path}.work`) {
    rmSync(progress.attempt.workDirectory, { force: true, recursive: true });
  }
}

function cleanupProviderWorkDirectory(path: string, workDirectory?: string): void {
  if (!workDirectory) {
    return;
  }
  let retainAttemptFiles = false;
  if (existsSync(path)) {
    try {
      retainAttemptFiles = isCaptureAttemptProgress(readProgress(path));
    } catch {
      retainAttemptFiles = true;
    }
  }
  if (!retainAttemptFiles) {
    rmSync(workDirectory, { force: true, recursive: true });
  }
}

function resultFromProviderCompletion(
  path: string,
  progress: CaptureAttemptProgress,
): CaptureExternalResult | undefined {
  const completion = progress.attempt.completion;
  if (!completion) {
    return undefined;
  }
  if (completion.outcome === "none") {
    if (progress.attempt.kind === "youtube-provenance") {
      return { kind: "youtube-provenance", outcome: "none", verification: "no-match" };
    }
    return {
      attemptedAt: completion.completedAt,
      kind: "capture",
      outcome: "unmatched",
      ...(completion.rejectedSources ? { sourceAudioRejected: completion.rejectedSources } : {}),
    };
  }
  const localDownload = completedLocalDownload(path, progress);
  if (
    !localDownload ||
    localDownload.fileName !== completion.fileName ||
    completion.fileName !== `audio.${completion.ext}` ||
    !/^[A-Za-z0-9]+$/.test(completion.ext) ||
    !RECEIPT_DIGEST_PATTERN.test(completion.digest) ||
    completion.digest !==
      createHash("sha256")
        .update(readFileSync(join(progress.attempt.workDirectory, completion.fileName)))
        .digest("hex")
  ) {
    return undefined;
  }
  if (progress.attempt.kind === "youtube-provenance") {
    if (completion.verdict !== "match") {
      return { kind: "youtube-provenance", outcome: "none", verification: "no-match" };
    }
    return completion.source === "soundcloud"
      ? {
          kind: "youtube-provenance",
          outcome: "source-found",
          sourceVerification: "soundcloud-preview-match",
        }
      : {
          kind: "youtube-provenance",
          outcome: "youtube-found",
          verification: "preview-match",
          youtubeVideoId: completion.videoId,
        };
  }
  const bytes = readFileSync(join(progress.attempt.workDirectory, completion.fileName));
  const keyRoot = progress.attempt.finding.logId ?? `catalogue/${progress.trackId}`;
  const verification = captureVerificationFor(completion.verdict);
  return {
    attemptedAt: completion.completedAt,
    bodyBase64: bytes.toString("base64"),
    bytes: bytes.byteLength,
    captureVerification: verification,
    capturedAt: completion.completedAt,
    contentType: contentTypeForExt(completion.ext),
    kind: "capture",
    outcome: "done",
    sourceAudioKey: buildSourceAudioKey(keyRoot, completion.digest, completion.ext),
    ...(completion.rejectedSources ? { sourceAudioRejected: completion.rejectedSources } : {}),
    verifiedAt: completion.completedAt,
    ...(completion.verdict === "match" && completion.source !== "soundcloud"
      ? { youtubeVideoId: completion.videoId }
      : {}),
  };
}

async function finishCaptureAttempt(
  path: string,
  progress: CaptureAttemptProgress,
  ports: CaptureProgressPorts,
): Promise<ProgressDisposition> {
  const prepared = ports.prepareCurrentSnapshot(
    progress.trackId,
    progress.attempt.kind,
    progress.snapshotToken,
  );
  if (prepared === "yielded") {
    return "pending";
  }
  if (!validPreparedSnapshotValue(prepared, progress.trackId)) {
    return "pending";
  }
  if (!prepared.prepared) {
    removeCaptureAttempt(path, progress);
    return "rejected";
  }
  const result = resultFromProviderCompletion(path, progress);
  if (result) {
    writeJsonAtomic(path, {
      result,
      snapshotToken: progress.snapshotToken,
      trackId: progress.trackId,
    } satisfies CaptureResultProgress);
    rmSync(progress.attempt.workDirectory, { force: true, recursive: true });
    return finishProgress(path, ports);
  }
  const localDownload = completedLocalDownload(path, progress);
  writeJsonAtomic(path, {
    ...progress,
    attempt: {
      ...progress.attempt,
      ...(localDownload ? { localDownload } : {}),
      state: localDownload ? "local-download-present" : "provider-ambiguous",
    },
  } satisfies CaptureAttemptProgress);
  return "pending";
}

export async function finishProgress(
  path: string,
  ports: CaptureProgressPorts = CAPTURE_PROGRESS_PORTS,
): Promise<ProgressDisposition> {
  let progress = readProgress(path);
  if (isCaptureAttemptProgress(progress)) {
    return await finishCaptureAttempt(path, progress, ports);
  }
  if (progress.receipt) {
    let reconciled: ReceiptDisposition;
    try {
      reconciled = reconcileReceipt(progress, `${path}.reconcile`, ports);
    } finally {
      rmSync(`${path}.reconcile`, { force: true });
      rmSync(`${path}.reconcile.result`, { force: true });
    }
    if (reconciled === "committed" || reconciled === "rejected" || reconciled === "pending") {
      if (reconciled !== "pending") {
        rmSync(path, { force: true });
      }
      return reconciled;
    }

    progress = { ...progress, receipt: undefined };
  }
  if (progress.result.kind === "capture" && progress.result.outcome === "done") {
    if (!(await ports.r2Exists(progress.result.sourceAudioKey, progress.result.bytes))) {
      await ports.r2Put(
        progress.result.sourceAudioKey,
        Buffer.from(progress.result.bodyBase64, "base64"),
        progress.result.contentType,
      );
    }
  }
  try {
    progress = await ports.authorizeProgress(progress);
  } catch (error) {
    if (!String(error).includes("expired_capture_token")) {
      throw error;
    }
    const refreshed = ports.prepareCurrentSnapshot(
      progress.trackId,
      progress.result.kind,
      progress.snapshotToken,
    );
    if (refreshed === "yielded") {
      return "pending";
    }
    if (!refreshed.prepared) {
      rmSync(path, { force: true });
      return "rejected";
    }
    progress = await ports.authorizeProgress({
      ...progress,
      receipt: undefined,
      snapshotToken: refreshed.snapshotToken,
    });
  }

  const receipt = receiptCoordinatesFrom(progress.receipt);
  progress = { ...progress, receipt };
  writeJsonAtomic(path, progress);
  if (!receipt) {
    return "pending";
  }
  const commitRequest = captureCommitRequest(receipt, progress.trackId);

  if (ports.collectCommit?.({ path, request: commitRequest, result: progress.result }) === true) {
    return "deferred";
  }
  writeJsonAtomic(`${path}.commit`, commitRequest);
  rmSync(`${path}.commit.result`, { force: true });
  if (ports.admittedPhase("commit", `${path}.commit`) === "yielded") {
    return "pending";
  }
  const response = JSON.parse(readFileSync(`${path}.commit.result`, "utf8")) as unknown;
  rmSync(`${path}.commit`, { force: true });
  rmSync(`${path}.commit.result`, { force: true });
  const commitDisposition = parsedCommitDisposition(response, progress.result);
  if (commitDisposition === "committed") {
    rmSync(path, { force: true });
    return "committed";
  }
  if (commitDisposition === "rejected") {
    rmSync(path, { force: true });
    return "rejected";
  }
  return "pending";
}

export function settleCollectedCommits(
  collected: readonly CollectedCaptureCommit[],
  width: number,

  phase: typeof admittedPhase = admittedPhase,

  timing?: number[],
): Map<string, ProgressDisposition> {
  const dispositions = new Map<string, ProgressDisposition>();

  for (let start = 0; start < collected.length; start += width) {
    const chunk = collected.slice(start, start + width);
    const first = chunk[0];
    if (first === undefined) {
      continue;
    }
    const path = `${first.path}.commit-batch`;
    writeJsonAtomic(path, { items: chunk.map((entry) => entry.request) });
    rmSync(`${path}.result`, { force: true });

    let response: unknown;
    if (phase("commit-batch", path) === "yielded") {
      response = undefined;
    } else {
      try {
        response = JSON.parse(readFileSync(`${path}.result`, "utf8"));
      } catch {
        response = undefined;
      }
    }
    rmSync(path, { force: true });
    rmSync(`${path}.result`, { force: true });

    const receipts =
      isRecord(response) && Array.isArray(response.receipts) ? response.receipts : undefined;

    for (const [index, entry] of chunk.entries()) {
      const receipt = receipts?.[index];
      const itemMs = isRecord(receipt) ? receipt.elapsedMs : undefined;
      if (timing && typeof itemMs === "number" && Number.isFinite(itemMs) && itemMs >= 0) {
        timing.push(itemMs);
      }
      const disposition =
        isRecord(receipt) && receipt.trackId === entry.request.trackId
          ? (parsedCommitDisposition(
              {
                ok: true,
                outcome: receipt.outcome,
                replayed: receipt.replayed,
                ...("result" in receipt ? { result: receipt.result } : {}),
              },
              entry.result,
            ) ?? "pending")
          : "pending";
      if (disposition === "committed" || disposition === "rejected") {
        rmSync(entry.path, { force: true });
      }
      dispositions.set(entry.request.trackId, disposition);
    }
  }

  return dispositions;
}

export async function persistAndCommit(
  trackId: string,
  snapshotToken: string,
  result: CaptureExternalResult,
  ports: CaptureProgressPorts = CAPTURE_PROGRESS_PORTS,
): Promise<ProgressDisposition> {
  const path = ports.progressPath(trackId, result.kind);
  writeJsonAtomic(path, { result, snapshotToken, trackId } satisfies CaptureProgress);
  try {
    return await finishProgress(path, ports);
  } catch (error) {
    log(
      `capture reconciliation deferred for ${trackId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "pending";
  }
}

export type RecoveredCaptureProgress = {
  disposition: ProgressDisposition;
  progress: CaptureProgress;
};

export async function recoverCaptureProgress(
  directory: string,
  ports: CaptureProgressPorts = CAPTURE_PROGRESS_PORTS,
): Promise<RecoveredCaptureProgress[]> {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const recovered: RecoveredCaptureProgress[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) {
      continue;
    }
    const path = join(directory, name);
    const progress = readProgress(path);
    const disposition = await finishProgress(path, ports).catch((error: unknown) => {
      log(
        `capture reconciliation remains pending for ${progress.trackId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "pending" as const;
    });
    recovered.push({ disposition, progress });
  }
  return recovered;
}

export function protectedTrackIdsFromRecovery(
  recovered: readonly RecoveredCaptureProgress[],
): Set<string> {
  return new Set(
    recovered
      .filter(({ disposition }) => disposition === "pending" || disposition === "failed")
      .map(({ progress }) => progress.trackId),
  );
}

export function withoutProtectedTracks(
  rows: readonly CaptureFinding[],
  protectedTrackIds: ReadonlySet<string>,
): CaptureFinding[] {
  return rows.filter((row) => !protectedTrackIds.has(row.trackId));
}

async function commitProvenanceUpdate(
  trackId: string,
  snapshotToken: string,
  update: Record<string, unknown>,
): Promise<ProgressDisposition> {
  let result: CaptureExternalResult;
  if (typeof update.sourceVerification === "string") {
    result = {
      kind: "youtube-provenance",
      outcome: "source-found",
      sourceVerification: update.sourceVerification as
        | "soundcloud-archive-match"
        | "soundcloud-preview-match",
    };
  } else if (typeof update.youtubeVideoId === "string") {
    result = {
      kind: "youtube-provenance",
      outcome: "youtube-found",
      verification: update.youtubeVerification as
        | "archive-match"
        | "metadata-match"
        | "preview-match",
      youtubeVideoId: update.youtubeVideoId,
    };
  } else {
    result = {
      kind: "youtube-provenance",
      outcome: "none",
      verification: update.youtubeVerification === "inconclusive" ? "inconclusive" : "no-match",
    };
  }
  const disposition = await persistAndCommit(trackId, snapshotToken, result);
  if (disposition === "pending") {
    throw new PendingCaptureCommitError();
  }
  if (disposition !== "committed") {
    throw new FailedCaptureCommitError(disposition);
  }
  return disposition;
}

class PendingCaptureCommitError extends Error {
  constructor() {
    super("capture reconciliation is pending");
  }
}

class FailedCaptureCommitError extends Error {
  constructor(disposition: "failed" | "rejected") {
    super(`capture reconciliation ${disposition}`);
  }
}

function runYtSearch(
  proxyUrl: string,
  query: string,
  source: CaptureSearchSource = "youtube",
): YtCandidate[] {
  const target = buildCaptureSearchTarget(source, query);
  const result = spawnSync(
    YT_DLP_BIN,
    [
      "--proxy",
      proxyUrl,
      "--socket-timeout",
      "30",
      "--no-warnings",

      ...(FLAT_SEARCH ? ["--flat-playlist"] : []),

      "--print",
      "%(duration)s\t%(id)s\t%(channel)s\t%(channel_id)s\t%(channel_is_verified)s\t%(title)s",
      ...target,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: YT_SEARCH_TIMEOUT_MS },
  );

  if (result.status !== 0) {
    const stderr = result.stderr || "";
    const err = new Error(`yt-dlp search failed: ${stderr.slice(0, 200)}`);
    (err as { isBotChallenge?: boolean }).isBotChallenge = isBotChallengeStderr(stderr);
    throw err;
  }

  const naToUndefined = (value?: string) => (value && value !== "NA" ? value : undefined);
  const candidates: YtCandidate[] = [];
  const seen = new Set<string>();
  for (const line of (result.stdout || "").split("\n")) {
    const [durationRaw, id, channelRaw, channelIdRaw, verifiedRaw, ...titleParts] =
      line.split("\t");
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    candidates.push({
      channel: naToUndefined(channelRaw),
      channelId: naToUndefined(channelIdRaw),
      durationSec: Number(durationRaw),
      id,
      source,
      title: titleParts.join("\t"),
      verified: verifiedRaw === "True",
    });
  }
  return candidates;
}

function runYtDownload(
  proxyUrl: string,
  candidate: YtCandidate,
  dir: string,
  playerClientFallback: boolean,
): { ext: string; path: string } {
  const source = candidate.source ?? "youtube";
  const base = join(dir, "audio");
  const args = [
    "--proxy",
    proxyUrl,
    "--socket-timeout",
    "30",
    "--no-warnings",
    "--no-playlist",
    "-f",
    "bestaudio",
    "-o",
    `${base}.%(ext)s`,
  ];
  if (playerClientFallback && source !== "soundcloud") {
    args.push("--extractor-args", "youtube:player_client=tv,web_safari");
  }
  args.push(buildCaptureDownloadUrl(source, candidate.id));

  const result = spawnSync(YT_DLP_BIN, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: YT_DOWNLOAD_TIMEOUT_MS,
  });

  const stderr = result.stderr || "";
  if (result.status !== 0) {
    const err = new Error(`yt-dlp download failed: ${stderr.slice(0, 200)}`);
    Object.assign(err, classifyDownloadFailure(stderr));
    throw err;
  }

  const produced = readdirSync(dir).find((entry) => entry.startsWith("audio."));
  if (!produced) {
    throw new Error("yt-dlp produced no output file");
  }
  const ext = produced.slice(produced.indexOf(".") + 1);
  return { ext, path: join(dir, produced) };
}

function runYtSection(
  proxyUrl: string,
  candidate: YtCandidate,
  dir: string,
  playerClientFallback: boolean,
): { ext: string; path: string } {
  const source = candidate.source ?? "youtube";
  const base = join(dir, "section");
  const args = [
    "--proxy",
    proxyUrl,
    "--socket-timeout",
    "30",
    "--no-warnings",
    "--no-playlist",
    "-f",
    "bestaudio",
    "--download-sections",
    PROVENANCE_SEGMENT_RANGE,
    "-o",
    `${base}.%(ext)s`,
  ];

  if (playerClientFallback && source !== "soundcloud") {
    args.push("--extractor-args", "youtube:player_client=tv,web_safari");
  }

  args.push(buildCaptureDownloadUrl(source, candidate.id));

  const result = spawnSync(YT_DLP_BIN, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: YT_DOWNLOAD_TIMEOUT_MS,
  });

  if (result.status !== 0) {
    const err = new Error(`yt-dlp section failed: ${(result.stderr || "").slice(0, 200)}`);
    Object.assign(err, classifyDownloadFailure(result.stderr || ""));
    throw err;
  }

  const produced = readdirSync(dir).find((entry) => entry.startsWith("section."));

  if (!produced) {
    throw new Error("yt-dlp produced no section file");
  }

  return { ext: produced.slice(produced.indexOf(".") + 1), path: join(dir, produced) };
}

function probeDurationSec(filePath: string): number {
  const result = spawnSync(
    FFPROBE_BIN,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${(result.stderr || "").slice(0, 200)}`);
  }
  return Number((result.stdout || "").trim());
}

export type BotChallengeStage = "search" | "download";

export type BotChallengeMeter = { total: number; uncleared: number };

export function createBotChallengeMeter(): BotChallengeMeter {
  return { total: 0, uncleared: 0 };
}

export function noteBotChallenge(
  meter: BotChallengeMeter,
  stage: BotChallengeStage,
  rerolled: boolean,
): void {
  meter.total += 1;

  if (rerolled) {
    log(`bot challenge at ${stage} (rerolled=true) — moving to a fresh residential exit`);
    return;
  }

  meter.uncleared += 1;
  log(`bot-challenged at ${stage} (rerolled=false) — the run's one re-roll is already spent`);
}

export function logBotChallengeRecap(meter: BotChallengeMeter): void {
  if (meter.total === 0) {
    return;
  }

  const cleared = meter.total - meter.uncleared;

  log(
    `bot challenges this tick: ${meter.total} (${cleared} cleared by a re-roll, ${meter.uncleared} with the re-roll spent)`,
  );
}

export type ProxySession = {
  rerollable: () => boolean;

  reroll: (stage: BotChallengeStage) => boolean;
  url: string;
};

function openProxySession(sessionSeed: string, meter: BotChallengeMeter): ProxySession {
  const rerolledProxyUrl = buildStickyProxyUrl({
    host: PROXY_HOST,
    password: PROXY_PASSWORD,
    port: PROXY_PORT,
    sessionId: rerollSessionId(sessionSeed),
    username: PROXY_USERNAME,
  });
  const session: ProxySession = {
    reroll: (stage: BotChallengeStage) => {
      const canReroll = session.url !== rerolledProxyUrl;

      noteBotChallenge(meter, stage, canReroll);

      if (!canReroll) {
        return false;
      }

      session.url = rerolledProxyUrl;
      return true;
    },
    rerollable: () => session.url !== rerolledProxyUrl,
    url: buildStickyProxyUrl({
      host: PROXY_HOST,
      password: PROXY_PASSWORD,
      port: PROXY_PORT,
      sessionId: sessionSeed,
      username: PROXY_USERNAME,
    }),
  };

  return session;
}

export type RejectedMemory = { dirty: boolean; sources: RejectedSource[] };

export type VerifiedUpload = {
  bytes: Uint8Array;
  digest: string;
  ext: string;
  path: string;
  source: CaptureSearchSource;

  verdict: "consensus" | "match" | "no-reference" | "operator";
  videoId: string;
};

export function captureVerificationFor(
  verdict: VerifiedUpload["verdict"],
): "consensus-verified" | "operator-verified" | "preview-match" | "unverified" {
  if (verdict === "match") {
    return "preview-match";
  }
  if (verdict === "consensus") {
    return "consensus-verified";
  }
  return verdict === "operator" ? "operator-verified" : "unverified";
}

export function captureProviderCompletion(
  accepted: VerifiedUpload | null,
  memory: RejectedMemory,
): CaptureProviderCompletion {
  const completedAt = new Date().toISOString();
  const rejectedSources = memory.dirty ? JSON.stringify(memory.sources) : undefined;
  if (!accepted) {
    return { completedAt, outcome: "none", ...(rejectedSources ? { rejectedSources } : {}) };
  }
  return {
    completedAt,
    digest: accepted.digest,
    ext: accepted.ext,
    fileName: basename(accepted.path),
    outcome: "accepted",
    ...(rejectedSources ? { rejectedSources } : {}),
    source: accepted.source,
    verdict: accepted.verdict,
    videoId: accepted.videoId,
  };
}

export type LadderPorts = {
  download: (
    proxyUrl: string,
    candidate: YtCandidate,
    dir: string,
    playerClientFallback: boolean,
  ) => { ext: string; path: string };
  fingerprint: (path: string) => null | number[];
  probeDurationSec: (path: string) => number;
  referenceFingerprint: (idOrLogId: string) => Promise<null | number[]>;
  search: (proxyUrl: string, query: string, source: CaptureSearchSource) => YtCandidate[];
};

type HeldCandidate = {
  candidate: YtCandidate;
  digest: string;
  ext: string;
  fingerprint: readonly number[];
  path: string;
};

function consensusChannelKey(candidate: YtCandidate): string | undefined {
  const key = (candidate.channelId ?? candidate.channel)?.trim();
  return key ? key : undefined;
}

export type ConsensusVerdict<T extends { candidate: YtCandidate; fingerprint: readonly number[] }> =
  {
    accepted: T;

    agreeing: T[];

    bers: number[];
  };

export function findConsensus<T extends { candidate: YtCandidate; fingerprint: readonly number[] }>(
  held: readonly T[],
  threshold: number = maxBer(),
): ConsensusVerdict<T> | null {
  for (const candidate of held) {
    const ownKey = consensusChannelKey(candidate.candidate);

    if (ownKey === undefined) {
      continue;
    }

    const agreeing: T[] = [];
    const bers: number[] = [];
    let independent = false;

    for (const other of held) {
      if (other === candidate) {
        continue;
      }
      const result = mutualWindowMatch(candidate.fingerprint, other.fingerprint, threshold);
      if (result === null || !result.match) {
        continue;
      }
      agreeing.push(other);
      bers.push(result.ber);
      const otherKey = consensusChannelKey(other.candidate);
      if (otherKey !== undefined && otherKey !== ownKey) {
        independent = true;
      }
    }

    if (independent) {
      return { accepted: candidate, agreeing, bers };
    }
  }

  return null;
}

function downloadWithRecovery(
  download: LadderPorts["download"],
  session: ProxySession,
  candidate: YtCandidate,
  dir: string,
): { ext: string; path: string } {
  try {
    return download(session.url, candidate, dir, false);
  } catch (error) {
    const flags = error as DownloadErrorFlags;
    const recovery = chooseDownloadRecovery(flags, session.rerollable(), candidate.source);

    if (flags.isBotChallenge) {
      session.reroll("download");
    }

    if (recovery === "reroll") {
      return download(session.url, candidate, dir, false);
    }
    if (recovery === "player-client-fallback") {
      return download(session.url, candidate, dir, true);
    }
    throw error;
  }
}

export async function findVerifiedUpload(options: {
  dir: string;
  finding: CaptureFinding;

  legacyRejectKey?: string;
  memory: RejectedMemory;
  ports?: Partial<LadderPorts>;
  session: ProxySession;
}): Promise<VerifiedUpload | null> {
  const { dir, finding, memory, session } = options;
  const { trackId } = finding;
  const ports: LadderPorts = {
    download: options.ports?.download ?? runYtDownload,
    fingerprint: options.ports?.fingerprint ?? fpcalcFingerprint,
    probeDurationSec: options.ports?.probeDurationSec ?? probeDurationSec,
    referenceFingerprint:
      options.ports?.referenceFingerprint ??
      ((idOrLogId) =>
        fetchPreviewFingerprint({ apiBaseUrl: API_BASE_URL, apiToken: API_TOKEN, idOrLogId })),
    search: options.ports?.search ?? runYtSearch,
  };

  const rankContext = {
    artistYoutubeChannelIds: finding.artistYoutubeChannelIds,
    durationMs: finding.durationMs,
    label: finding.label,
    title: finding.title,
  };
  const ladder = buildCaptureSearchLadder(finding);

  const found = findFirstRankedCaptureRung(ladder, rankContext, (rung, step) => {
    if (step > 0) {
      log(
        `no accepted candidate yet — ladder step ${step + 1}/${ladder.length}: ${rung.source} search "${rung.query}"`,
      );
    }
    try {
      return ports.search(session.url, rung.query, rung.source);
    } catch (error) {
      if (!(error as { isBotChallenge?: boolean }).isBotChallenge || !session.reroll("search")) {
        throw error;
      }
      return ports.search(session.url, rung.query, rung.source);
    }
  });
  const ranked = found?.ranked ?? [];

  if (ranked.length === 0) {
    return null;
  }

  const rejectedIds = rejectedVideoIds(memory.sources);
  const knownBadShas = rejectedShas(memory.sources);

  const legacyRejectHash = extractSourceAudioSha256(options.legacyRejectKey);
  if (legacyRejectHash) {
    knownBadShas.add(legacyRejectHash);
  }

  const attempts = filterRejectedCandidates(ranked, rejectedIds, DOWNLOAD_ATTEMPTS);

  const preFiltered =
    ranked.length - ranked.filter((entry) => !rejectedIds.has(entry.candidate.id)).length;
  if (preFiltered > 0) {
    log(
      `${preFiltered} of ${ranked.length} ranked candidate(s) already remembered as wrong audio — skipping: ${ranked
        .filter((entry) => rejectedIds.has(entry.candidate.id))
        .map((entry) => entry.candidate.id)
        .join(", ")}`,
    );
  }

  const previewFp = await ports.referenceFingerprint(trackId);

  const held: HeldCandidate[] = [];
  const settle = (keep: ReadonlySet<HeldCandidate>, retainPath?: string): void => {
    for (const entry of held) {
      if (!keep.has(entry)) {
        memory.sources = appendRejectedSource(memory.sources, {
          at: new Date().toISOString(),
          reason: "fingerprint-mismatch",
          sha256: entry.digest,
          videoId: entry.candidate.id,
        });
        memory.dirty = true;
      }
      if (entry.path !== retainPath) {
        rmSync(entry.path, { force: true });
      }
    }
    held.length = 0;
  };

  let lastError: unknown;
  try {
    for (const candidate of attempts) {
      try {
        const file = downloadWithRecovery(ports.download, session, candidate.candidate, dir);

        const fileBytes = new Uint8Array(readFileSync(file.path));
        const fileDigest = createHash("sha256").update(fileBytes).digest("hex");

        if (knownBadShas.has(fileDigest)) {
          log(`candidate ${candidate.candidate.id} is the known wrong audio — trying next`);
          rmSync(file.path, { force: true });
          continue;
        }

        const realDurationSec = ports.probeDurationSec(file.path);
        if (!durationWithinTolerance(realDurationSec, finding.durationMs)) {
          rmSync(file.path, { force: true });
          continue;
        }

        const captureFingerprint = ports.fingerprint(file.path);
        const verified = verifyCaptureFileDetailed(previewFp, captureFingerprint);

        if (verified.verdict === "mismatch" && captureFingerprint !== null) {
          log(
            `candidate ${candidate.candidate.id} failed fingerprint verification (ber=${(verified.ber ?? 0).toFixed(3)}) — holding for consensus, trying next`,
          );
          knownBadShas.add(fileDigest);
          const heldPath = join(dir, `held-${candidate.candidate.id}.${file.ext}`);
          renameSync(file.path, heldPath);
          held.push({
            candidate: candidate.candidate,
            digest: fileDigest,
            ext: file.ext,
            fingerprint: captureFingerprint,
            path: heldPath,
          });
          continue;
        }

        settle(new Set());
        return {
          bytes: fileBytes,
          digest: fileDigest,
          ext: file.ext,
          path: file.path,
          source: candidate.candidate.source ?? "youtube",
          verdict: verified.verdict === "match" ? "match" : "no-reference",
          videoId: candidate.candidate.id,
        };
      } catch (error) {
        lastError = error;
        if ((error as { isRecoverable?: boolean }).isRecoverable) {
          log(`candidate ${candidate.candidate.id} unusable (DRM/bot-wall) — trying next`);
          continue;
        }
        throw error;
      }
    }

    const consensus = findConsensus(held);
    if (consensus) {
      const { accepted, agreeing, bers } = consensus;
      log(
        `preview gate rejected ${held.length} duration-verified candidate(s); ${agreeing.length + 1} of them agree with each other (ber=${bers.map((ber) => ber.toFixed(3)).join(",")}) — accepting ${accepted.candidate.id} on consensus`,
      );

      settle(new Set([accepted, ...agreeing]), accepted.path);

      for (const stray of readdirSync(dir).filter((entry) => entry.startsWith("audio."))) {
        rmSync(join(dir, stray), { force: true });
      }
      const acceptedPath = join(dir, `audio.${accepted.ext}`);
      renameSync(accepted.path, acceptedPath);
      const acceptedBytes = new Uint8Array(readFileSync(acceptedPath));
      return {
        bytes: acceptedBytes,
        digest: createHash("sha256").update(acceptedBytes).digest("hex"),
        ext: accepted.ext,
        path: acceptedPath,
        source: accepted.candidate.source ?? "youtube",
        verdict: "consensus",
        videoId: accepted.candidate.id,
      };
    }
  } finally {
    settle(new Set());
  }

  if (!lastError) {
    return null;
  }

  throw lastError;
}

export type PinnedUploadPorts = {
  download: (
    proxyUrl: string,
    candidate: YtCandidate,
    dir: string,
    playerClientFallback: boolean,
  ) => { ext: string; path: string };
  fingerprint: (path: string) => null | number[];
  probeDurationSec: (path: string) => number;
  referenceFingerprint: (idOrLogId: string) => Promise<null | number[]>;
};

export type PinnedDurationRefusal = Error & { isPinnedDurationRefusal: true };

export function isPinnedDurationRefusal(error: unknown): error is PinnedDurationRefusal {
  return (error as { isPinnedDurationRefusal?: boolean })?.isPinnedDurationRefusal === true;
}

export async function findPinnedUpload(options: {
  allowDurationMismatch?: boolean;
  dir: string;
  finding: CaptureFinding;
  ports?: Partial<PinnedUploadPorts>;
  session: ProxySession;
  videoId: string;
}): Promise<VerifiedUpload> {
  const { dir, finding, session, videoId } = options;
  const ports: PinnedUploadPorts = {
    download: options.ports?.download ?? runYtDownload,
    fingerprint: options.ports?.fingerprint ?? fpcalcFingerprint,
    probeDurationSec: options.ports?.probeDurationSec ?? probeDurationSec,
    referenceFingerprint:
      options.ports?.referenceFingerprint ??
      ((idOrLogId) =>
        fetchPreviewFingerprint({ apiBaseUrl: API_BASE_URL, apiToken: API_TOKEN, idOrLogId })),
  };
  const who = finding.logId ?? `catalogue (${finding.trackId})`;

  const candidate: YtCandidate = { durationSec: 0, id: videoId, source: "youtube", title: "" };

  log(`honouring the operator's capture-source pin for ${who}: youtube ${videoId}`);

  const file = downloadWithRecovery(ports.download, session, candidate, dir);

  const realDurationSec = ports.probeDurationSec(file.path);
  const durationOk = durationWithinTolerance(realDurationSec, finding.durationMs);
  if (!durationOk && options.allowDurationMismatch === true) {
    log(
      `pinned upload duration ${Math.round(realDurationSec)}s vs ${Math.round((finding.durationMs ?? 0) / 1000)}s — accepted on operator authority`,
    );
  } else if (!durationOk) {
    rmSync(file.path, { force: true });
    const refusal = new Error(
      `pinned upload ${videoId} fails the duration guard (${Math.round(realDurationSec)}s against the row's ${Math.round((finding.durationMs ?? 0) / 1000)}s) — not captured`,
    ) as PinnedDurationRefusal;
    refusal.isPinnedDurationRefusal = true;
    log(`pinned upload fails the duration guard (${refusal.message})`);
    throw refusal;
  }

  const fileBytes = new Uint8Array(readFileSync(file.path));
  const fileDigest = createHash("sha256").update(fileBytes).digest("hex");

  const previewFp = await ports.referenceFingerprint(finding.trackId);
  const verified = verifyCaptureFileDetailed(previewFp, ports.fingerprint(file.path));

  if (verified.verdict === "mismatch") {
    log(
      `pinned upload ${videoId} mismatches the store reference (ber=${(verified.ber ?? 0).toFixed(3)}) — capturing on operator authority`,
    );
  } else {
    log(`pinned upload ${videoId} fingerprint verdict: ${verified.verdict} — capturing`);
  }

  return {
    bytes: fileBytes,
    digest: fileDigest,
    ext: file.ext,
    path: file.path,
    source: "youtube",
    verdict: "operator",
    videoId,
  };
}

type FindingOutcome =
  | "deferred:done"
  | "deferred:failed"
  | "deferred:unmatched"
  | "done"
  | "unmatched"
  | "failed"
  | "pending"
  | "rejected"
  | "skipped"
  | "unrecorded-failure";

const DEFERRED_OUTCOMES = {
  "deferred:done": "done",
  "deferred:failed": "failed",
  "deferred:unmatched": "unmatched",
} as const satisfies Record<string, FindingOutcome>;

export function isDeferredOutcome(
  outcome: FindingOutcome,
): outcome is keyof typeof DEFERRED_OUTCOMES {
  return outcome in DEFERRED_OUTCOMES;
}

function captureOutcomeFor(
  disposition: ProgressDisposition,
  landed: "done" | "failed" | "unmatched",
): FindingOutcome {
  if (disposition === "deferred") {
    return `deferred:${landed}`;
  }
  if (disposition === "committed") {
    return landed;
  }
  if (disposition === "rejected") {
    return "rejected";
  }

  return disposition === "failed" ? "unrecorded-failure" : "pending";
}

export function resolveDeferredOutcome(
  outcome: keyof typeof DEFERRED_OUTCOMES,
  disposition: ProgressDisposition | undefined,
): FindingOutcome {
  if (disposition === "committed") {
    return DEFERRED_OUTCOMES[outcome];
  }

  return disposition === "rejected" ? "rejected" : "pending";
}

async function captureFinding(
  finding: CaptureFinding,
  snapshotToken: string,
  botChallenges: BotChallengeMeter,
  failures: CaptureFailureMeter,
): Promise<FindingOutcome> {
  const { logId, trackId } = finding;

  if (!logId && finding.certified !== false) {
    return "skipped";
  }

  const keyRoot = logId ?? `catalogue/${trackId}`;

  const priorFailures =
    typeof finding.sourceAudioFailures === "number" ? finding.sourceAudioFailures : 0;
  const session = openProxySession(
    captureSessionSeed(logId ?? trackId, priorFailures),
    botChallenges,
  );

  const attemptPath = progressPath(trackId, "capture");
  let workDirectory: string | undefined;

  const memory: RejectedMemory = {
    dirty: false,
    sources: parseRejectedSources(finding.sourceAudioRejected),
  };

  try {
    const providerRun = await runJournaledCaptureProvider({
      completion: (accepted) => captureProviderCompletion(accepted, memory),
      finding,
      kind: "capture",
      provider: async (directory) => {
        workDirectory = directory;

        const pin = finding.captureSourcePin?.trim();
        if (pin) {
          return findPinnedUpload({
            allowDurationMismatch: finding.captureSourcePinAllowDuration === true,
            dir: directory,
            finding,
            session,
            videoId: pin,
          });
        }
        return findVerifiedUpload({
          dir: directory,
          finding,
          legacyRejectKey: finding.sourceAudioKey,
          memory,
          session,
        });
      },
      snapshotToken,
    });
    if (providerRun.disposition === "pending") {
      return "pending";
    }
    const accepted = providerRun.value;

    if (!accepted) {
      log(
        `capture unmatched for ${logId ?? `catalogue (${trackId})`} — no candidate survived; ${memory.sources.length} rejected upload(s) remembered`,
      );

      const update: Record<string, unknown> = {
        captureStatus: "unmatched",
        sourceAudioAttemptedAt: new Date().toISOString(),
      };
      if (memory.dirty) {
        update.sourceAudioRejected = JSON.stringify(memory.sources);
      }
      const disposition = await persistAndCommit(trackId, snapshotToken, {
        attemptedAt: String(update.sourceAudioAttemptedAt),
        kind: "capture",
        outcome: "unmatched",
        ...(typeof update.sourceAudioRejected === "string"
          ? { sourceAudioRejected: update.sourceAudioRejected }
          : {}),
      });
      return captureOutcomeFor(disposition, "unmatched");
    }

    const verification = captureVerificationFor(accepted.verdict);
    const key = buildSourceAudioKey(keyRoot, accepted.digest, accepted.ext);

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      captureStatus: "done",
      captureVerification: verification,
      captureVerifiedAt: now,
      sourceAudioAttemptedAt: now,
      sourceAudioBytes: accepted.bytes.byteLength,
      sourceAudioCapturedAt: now,
      sourceAudioKey: key,
    };

    if (accepted.verdict === "match" && accepted.source !== "soundcloud") {
      update.youtubeVideoId = accepted.videoId;
    }
    if (memory.dirty) {
      update.sourceAudioRejected = JSON.stringify(memory.sources);
    }
    if (shouldReenrichAfterCapture(finding.certified, finding.bpm, finding.analyzedFrom)) {
      update.enrichmentStatus = "pending";
    }
    const disposition = await persistAndCommit(trackId, snapshotToken, {
      attemptedAt: now,
      bodyBase64: Buffer.from(accepted.bytes).toString("base64"),
      bytes: accepted.bytes.byteLength,
      captureVerification: verification,
      capturedAt: now,
      contentType: contentTypeForExt(accepted.ext),
      kind: "capture",
      outcome: "done",
      sourceAudioKey: key,
      ...(typeof update.sourceAudioRejected === "string"
        ? { sourceAudioRejected: update.sourceAudioRejected }
        : {}),
      verifiedAt: now,
      ...(typeof update.youtubeVideoId === "string"
        ? { youtubeVideoId: update.youtubeVideoId }
        : {}),
    });

    return captureOutcomeFor(disposition, "done");
  } catch (error) {
    const update: Record<string, unknown> = {
      captureStatus: "failed",
      sourceAudioAttemptedAt: new Date().toISOString(),
      sourceAudioFailures: priorFailures + 1,
    };
    if (memory.dirty) {
      update.sourceAudioRejected = JSON.stringify(memory.sources);
    }
    noteCaptureFailure(failures, error);
    let failureDisposition: ProgressDisposition = "failed";
    failureDisposition = await persistAndCommit(trackId, snapshotToken, {
      attemptedAt: String(update.sourceAudioAttemptedAt),
      kind: "capture",
      outcome: "failed",
      ...(typeof update.sourceAudioRejected === "string"
        ? { sourceAudioRejected: update.sourceAudioRejected }
        : {}),
    }).catch((patchError: unknown) => {
      log(`failed to record failure for ${trackId}: ${String(patchError)}`);
      return "failed" as const;
    });
    if (failureDisposition === "failed") {
      failures.failureRecording += 1;
    }
    log(
      `capture failed for ${logId ?? "catalogue"} (${trackId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return captureOutcomeFor(failureDisposition, "failed");
  } finally {
    cleanupProviderWorkDirectory(attemptPath, workDirectory);
  }
}

export type ProvenanceLadderCounts = {
  deferred: number;
  exhausted: number;
  residualRescued: number;
  searched: number;
  segmentMissed: number;
  segmentVerified: number;
  topicServed: number;
};

export function createLadderCounts(): ProvenanceLadderCounts {
  return {
    deferred: 0,
    exhausted: 0,
    residualRescued: 0,
    searched: 0,
    segmentMissed: 0,
    segmentVerified: 0,
    topicServed: 0,
  };
}

async function loadArchiveFingerprint(key: string, dir: string): Promise<null | number[]> {
  const bytes = await r2Get(key);

  if (!bytes) {
    return null;
  }

  const ext = (key.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = join(dir, `archive.${ext || "bin"}`);

  writeFileSync(path, bytes);

  const fingerprint = fpcalcFingerprint(path);

  rmSync(path, { force: true });

  return fingerprint;
}

function downloadSection(
  session: ProxySession,
  candidate: YtCandidate,
  dir: string,
): { ext: string; path: string } {
  const source = candidate.source ?? "youtube";
  try {
    return runYtSection(session.url, candidate, dir, false);
  } catch (error) {
    const flags = error as DownloadErrorFlags;

    const recovery = chooseDownloadRecovery(flags, session.rerollable(), source);

    if (flags.isBotChallenge) {
      session.reroll("download");
    }

    if (recovery === "reroll") {
      return runYtSection(session.url, candidate, dir, false);
    }

    if (recovery === "player-client-fallback") {
      return runYtSection(session.url, candidate, dir, true);
    }

    throw error;
  }
}

async function proveCatalogueProvenance(
  row: CaptureFinding,
  snapshotToken: string,
  meter: BotChallengeMeter,
  budget: { segments: number },
  counts: ProvenanceLadderCounts,
  dir: string,
): Promise<"deferred" | ProvenanceOutcome> {
  const { trackId } = row;
  const session = openProxySession(captureSessionSeed(trackId, 0), meter);

  const rejectedIds = rejectedVideoIds(parseRejectedSources(row.sourceAudioRejected));
  const archiveKey = row.sourceAudioKey ?? "";

  const rungs = buildCaptureSearchLadder(row);

  let archiveFp: null | number[] | undefined;
  let deferred = false;

  let transient: unknown;

  try {
    for (const [step, rung] of rungs.entries()) {
      counts.searched += 1;

      let candidates: YtCandidate[];

      try {
        candidates = runYtSearch(session.url, rung.query, rung.source);
      } catch (error) {
        if (!(error as { isBotChallenge?: boolean }).isBotChallenge || !session.reroll("search")) {
          throw error;
        }
        candidates = runYtSearch(session.url, rung.query, rung.source);
      }

      const topic = rung.source === "soundcloud" ? null : pickTopicCandidate(candidates, row);

      if (topic) {
        await commitProvenanceUpdate(trackId, snapshotToken, {
          youtubeVerification: "metadata-match",
          youtubeVideoId: topic.id,
        });
        counts.topicServed += 1;

        if (step > 0) {
          counts.residualRescued += 1;
        }

        return "found";
      }

      for (const candidate of pickSegmentCandidates(
        candidates,
        row,
        rejectedIds,
        PROVENANCE_SEGMENT_ATTEMPTS,
      )) {
        if (budget.segments <= 0) {
          deferred = true;
          break;
        }

        if (archiveFp === undefined) {
          archiveFp = archiveKey ? await loadArchiveFingerprint(archiveKey, dir) : null;
        }

        if (archiveFp === null) {
          break;
        }

        budget.segments -= 1;
        rejectedIds.add(candidate.id);

        let section: { ext: string; path: string };

        try {
          section = downloadSection(session, candidate, dir);
        } catch (error) {
          transient = error;
          log(`section for ${candidate.id} unusable (DRM/bot-wall/403) — trying next`);
          continue;
        }

        const sectionFp = fpcalcFingerprint(section.path);

        rmSync(section.path, { force: true });

        const result = sectionFp ? slidingWindowMatch(archiveFp, sectionFp) : null;

        if (result?.match) {
          if (rung.source === "soundcloud") {
            await commitProvenanceUpdate(trackId, snapshotToken, {
              sourceVerification: "soundcloud-archive-match",
            });
            counts.segmentVerified += 1;

            if (step > 0) {
              counts.residualRescued += 1;
            }

            return "found";
          }

          await commitProvenanceUpdate(trackId, snapshotToken, {
            youtubeVerification: "archive-match",
            youtubeVideoId: candidate.id,
          });
          counts.segmentVerified += 1;

          if (step > 0) {
            counts.residualRescued += 1;
          }

          return "found";
        }

        counts.segmentMissed += 1;
      }

      if (deferred) {
        break;
      }
    }

    if (deferred) {
      counts.deferred += 1;

      return "deferred";
    }

    if (transient) {
      await commitProvenanceUpdate(trackId, snapshotToken, {
        youtubeVerification: "inconclusive",
      });

      return "failed-recorded";
    }

    await commitProvenanceUpdate(trackId, snapshotToken, { youtubeVerification: "no-match" });
    counts.exhausted += 1;

    return "none";
  } catch (error) {
    if (error instanceof PendingCaptureCommitError) {
      return "pending";
    }
    if (error instanceof FailedCaptureCommitError) {
      return "failed-write";
    }
    log(
      `catalogue provenance failed for ${trackId}: ${error instanceof Error ? error.message : String(error)}`,
    );

    try {
      await commitProvenanceUpdate(trackId, snapshotToken, {
        youtubeVerification: "inconclusive",
      });
      return "failed-recorded";
    } catch (patchError) {
      if (patchError instanceof PendingCaptureCommitError) {
        return "pending";
      }
      log(`failed to record an inconclusive run for ${trackId}: ${String(patchError)}`);
      return "failed-write";
    }
  }
}

type ProvenanceOutcome =
  | "failed"
  | "failed-recorded"
  | "failed-write"
  | "found"
  | "none"
  | "pending";

async function proveTrackProvenance(
  row: CaptureFinding,
  snapshotToken: string,
  meter: BotChallengeMeter,
): Promise<ProvenanceOutcome> {
  const { logId, trackId } = row;

  const session = openProxySession(captureSessionSeed(logId ?? trackId, 0), meter);
  const attemptPath = progressPath(trackId, "youtube-provenance");
  let workDirectory: string | undefined;

  const memory: RejectedMemory = {
    dirty: false,
    sources: parseRejectedSources(row.sourceAudioRejected),
  };

  try {
    const providerRun = await runJournaledCaptureProvider({
      completion: (accepted) => captureProviderCompletion(accepted, memory),
      finding: row,
      kind: "youtube-provenance",
      provider: async (directory) => {
        workDirectory = directory;
        return findVerifiedUpload({ dir: directory, finding: row, memory, session });
      },
      snapshotToken,
    });
    if (providerRun.disposition === "pending") {
      return "pending";
    }
    const accepted = providerRun.value;

    if (!accepted || accepted.verdict !== "match") {
      await commitProvenanceUpdate(trackId, snapshotToken, { youtubeVerification: "no-match" });
      return "none";
    }

    if (accepted.source === "soundcloud") {
      await commitProvenanceUpdate(trackId, snapshotToken, {
        sourceVerification: "soundcloud-preview-match",
      });
      return "found";
    }

    await commitProvenanceUpdate(trackId, snapshotToken, {
      youtubeVerification: "preview-match",
      youtubeVideoId: accepted.videoId,
    });

    return "found";
  } catch (error) {
    if (error instanceof PendingCaptureCommitError) {
      return "pending";
    }
    if (error instanceof FailedCaptureCommitError) {
      return "failed-write";
    }
    log(
      `provenance failed for ${logId ?? "catalogue"} (${trackId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await commitProvenanceUpdate(trackId, snapshotToken, {
        youtubeVerification: "inconclusive",
      });
      return "failed-recorded";
    } catch (patchError) {
      if (patchError instanceof PendingCaptureCommitError) {
        return "pending";
      }
      log(`failed to record an inconclusive provenance run for ${trackId}: ${String(patchError)}`);
      return "failed-write";
    }
  } finally {
    cleanupProviderWorkDirectory(attemptPath, workDirectory);
  }
}

export type ProvenanceCounts = {
  failed: number;
  found: number;
  none: number;
  pending?: number;
  writesConfirmed?: number;
  writesFailed?: number;
  writesPending?: number;
};

function noteProvenanceOutcome(counts: ProvenanceCounts, outcome: ProvenanceOutcome): void {
  if (outcome === "found" || outcome === "none") {
    counts[outcome] += 1;
    counts.writesConfirmed = (counts.writesConfirmed ?? 0) + 1;
  } else if (outcome === "pending") {
    counts.pending = (counts.pending ?? 0) + 1;
    counts.writesPending = (counts.writesPending ?? 0) + 1;
  } else {
    counts.failed += 1;
    if (outcome === "failed-recorded") {
      counts.writesConfirmed = (counts.writesConfirmed ?? 0) + 1;
    } else if (outcome === "failed-write") {
      counts.writesFailed = (counts.writesFailed ?? 0) + 1;
    }
  }
}

export function splitProvenanceBudget(
  total: number,
  catalogueCap: number,
): { catalogue: number; findings: number } {
  const findings = Math.max(0, Math.trunc(total) || 0);

  return { catalogue: Math.min(Math.max(0, Math.trunc(catalogueCap) || 0), findings), findings };
}

async function runProvenancePhase(
  meter: BotChallengeMeter,
  protectedTrackIds: Set<string> = new Set(),
): Promise<{ counts: ProvenanceCounts; ladder: ProvenanceLadderCounts }> {
  const counts: ProvenanceCounts = {
    failed: 0,
    found: 0,
    none: 0,
    pending: 0,
    writesConfirmed: 0,
    writesFailed: 0,
    writesPending: 0,
  };
  const ladder = createLadderCounts();
  const budget = splitProvenanceBudget(PROVENANCE_LIMIT, PROVENANCE_CATALOGUE_LIMIT);

  if (budget.findings === 0) {
    return { counts, ladder };
  }

  const queuedRows = admittedWorkList({
    kind: "youtube-provenance",
    limit: budget.findings,
    scope: "findings",
  });
  if (queuedRows === "yielded" || queuedRows === "due-work-repair-pending") {
    counts.pending += budget.findings;
    return { counts, ladder };
  }
  const rows = withoutProtectedTracks(queuedRows, protectedTrackIds);

  for (const row of rows) {
    try {
      const prepared = prepareCurrentSnapshot(row.trackId, "youtube-provenance");
      if (prepared === "yielded") {
        counts.pending = (counts.pending ?? 0) + 1;
        continue;
      }
      if (!prepared.prepared) {
        counts.failed += 1;
        continue;
      }
      const currentRow = preparedCaptureFinding(row, prepared.track);
      const outcome = await proveTrackProvenance(currentRow, prepared.snapshotToken, meter);
      noteProvenanceOutcome(counts, outcome);
      if (outcome === "pending") {
        protectedTrackIds.add(row.trackId);
      }
    } catch (error) {
      counts.failed += 1;
      log(
        `provenance row failed for ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const catalogueRoom = Math.min(budget.catalogue, budget.findings - rows.length);

  if (catalogueRoom <= 0) {
    return { counts, ladder };
  }

  const segmentBudget = { segments: catalogueRoom };
  let queuedCatalogueRows: CaptureFinding[] | "due-work-repair-pending" | "yielded";
  try {
    queuedCatalogueRows = admittedWorkList({
      kind: "youtube-provenance",
      limit: catalogueRoom * Math.max(1, Math.trunc(PROVENANCE_SEARCH_FACTOR) || 1),
      scope: "catalogue",
    });
  } catch (error) {
    log(
      `catalogue provenance queue failed after findings completed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { counts, ladder };
  }
  if (queuedCatalogueRows === "yielded" || queuedCatalogueRows === "due-work-repair-pending") {
    counts.pending += catalogueRoom;
    return { counts, ladder };
  }
  const catalogueRows = withoutProtectedTracks(queuedCatalogueRows, protectedTrackIds);

  for (const row of catalogueRows) {
    try {
      const prepared = prepareCurrentSnapshot(row.trackId, "youtube-provenance");
      if (prepared === "yielded") {
        counts.pending = (counts.pending ?? 0) + 1;
        continue;
      }
      if (!prepared.prepared) {
        counts.failed += 1;
        continue;
      }
      const currentRow = preparedCaptureFinding(row, prepared.track);
      const attemptPath = progressPath(row.trackId, "youtube-provenance");
      let workDirectory: string | undefined;
      const providerRun = await runJournaledCaptureProvider({
        finding: currentRow,
        kind: "youtube-provenance",
        provider: async (directory) => {
          workDirectory = directory;
          return proveCatalogueProvenance(
            currentRow,
            prepared.snapshotToken,
            meter,
            segmentBudget,
            ladder,
            directory,
          );
        },
        snapshotToken: prepared.snapshotToken,
      }).finally(() => cleanupProviderWorkDirectory(attemptPath, workDirectory));
      if (providerRun.disposition === "pending") {
        noteProvenanceOutcome(counts, "pending");
        protectedTrackIds.add(row.trackId);
        continue;
      }
      const outcome = providerRun.value;
      if (outcome === "deferred" && existsSync(attemptPath)) {
        const progress = readProgress(attemptPath);
        if (isCaptureAttemptProgress(progress)) {
          removeCaptureAttempt(attemptPath, progress);
        }
      }

      if (outcome !== "deferred") {
        noteProvenanceOutcome(counts, outcome);
      }
      if (outcome === "pending") {
        protectedTrackIds.add(row.trackId);
      }
    } catch (error) {
      counts.failed += 1;
      log(
        `catalogue provenance row failed for ${row.trackId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { counts, ladder };
}

type ReverdictCounts = {
  asked: number;
  failed: number;
  pending?: number;
  writesConfirmed?: number;
  writesFailed?: number;
  writesPending?: number;
};

async function runReverdictPhase(
  protectedTrackIds: Set<string> = new Set(),
): Promise<ReverdictCounts> {
  const limit = Math.max(0, Math.trunc(REVERDICT_LIMIT) || 0);

  if (limit === 0) {
    return {
      asked: 0,
      failed: 0,
      pending: 0,
      writesConfirmed: 0,
      writesFailed: 0,
      writesPending: 0,
    };
  }

  const queuedRows = admittedWorkList({ kind: "youtube-reverdict", limit, scope: "all" });
  if (queuedRows === "yielded" || queuedRows === "due-work-repair-pending") {
    return {
      asked: 0,
      failed: 0,
      pending: limit,
      writesConfirmed: 0,
      writesFailed: 0,
      writesPending: 0,
    };
  }
  const rows = withoutProtectedTracks(queuedRows, protectedTrackIds);
  let asked = 0;
  let failed = 0;
  let pending = 0;
  let writesConfirmed = 0;
  let writesFailed = 0;
  let writesPending = 0;

  for (const row of rows) {
    try {
      const prepared = prepareCurrentSnapshot(row.trackId, "youtube-reverdict");
      if (prepared === "yielded") {
        pending += 1;
        continue;
      }
      if (!prepared.prepared) {
        failed += 1;
        continue;
      }
      const disposition = await persistAndCommit(row.trackId, prepared.snapshotToken, {
        kind: "youtube-reverdict",
        outcome: "reverdict",
      });
      if (disposition === "committed") {
        asked += 1;
        writesConfirmed += 1;
      } else if (disposition === "pending") {
        pending += 1;
        writesPending += 1;
        protectedTrackIds.add(row.trackId);
      } else {
        failed += 1;
        writesFailed += 1;
      }
    } catch (error) {
      failed += 1;
      log(
        `re-verdict failed for ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { asked, failed, pending, writesConfirmed, writesFailed, writesPending };
}

type CaptureCounts = {
  done: number;
  failed: number;
  pending?: number;
  reconciled?: number;
  rejected?: number;
  skipped: number;
  unmatched: number;
};

export const CAPTURE_BLIND_MIN_ATTEMPTS = 4;
export const CAPTURE_BLIND_FAILURE_SHARE = 0.9;

export type CaptureBlindVerdict =
  | "bot_challenged"
  | "capture_failing"
  | "proxy_failing"
  | "ytdlp_failing";

export function captureBlindVerdict(options: {
  attempts: number;
  botChallengesUncleared: number;
  failed: number;
  failures: CaptureFailureMeter;
}): CaptureBlindVerdict | null {
  if (options.attempts < CAPTURE_BLIND_MIN_ATTEMPTS || options.failed <= 0) {
    return null;
  }

  if (options.failed / options.attempts < CAPTURE_BLIND_FAILURE_SHARE) {
    return null;
  }

  if (options.botChallengesUncleared >= options.failed) {
    return "bot_challenged";
  }

  const { proxy, ytDlp } = options.failures;

  if (proxy > ytDlp) {
    return "proxy_failing";
  }

  if (ytDlp > 0) {
    return "ytdlp_failing";
  }

  return "capture_failing";
}

export type CaptureAnchoringCounts = {
  attemptsAnchored: number;
  attemptsUnanchored: number;
  doneAnchored: number;
  doneUnanchored: number;
};

export function summariseItemTiming(
  samples: readonly number[],
): { itemMsMax: number; itemMsP50: number; itemSamples: number } | undefined {
  const sorted = [...samples]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return undefined;
  }

  const median = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;

  return {
    itemMsMax: sorted[sorted.length - 1] ?? 0,
    itemMsP50: median,
    itemSamples: sorted.length,
  };
}

export function buildCaptureSummary(options: {
  anchoring?: CaptureAnchoringCounts;
  batch: number;
  botChallenges: number;
  botChallengesUncleared: number;
  counts: CaptureCounts;

  itemTiming?: readonly number[];
  elapsedMs: number;
  failures?: CaptureFailureMeter;

  ladder?: ProvenanceLadderCounts;

  leases?: number;
  provenance: ProvenanceCounts;
  reverdict: ReverdictCounts;
  writes: { confirmed: number; failed: number; pending: number };
}): Record<string, unknown> {
  const { counts, ladder, provenance, reverdict } = options;
  const failures = options.failures ?? createCaptureFailureMeter();

  const attempts = counts.done + counts.failed + counts.unmatched;
  const blind = captureBlindVerdict({
    attempts,
    botChallengesUncleared: options.botChallengesUncleared,
    failed: counts.failed,
    failures,
  });

  const timing = summariseItemTiming(options.itemTiming ?? []);

  return {
    ...(options.anchoring === undefined ? {} : options.anchoring),
    batch: options.batch,
    botChallenges: options.botChallenges,
    botChallengesUncleared: options.botChallengesUncleared,

    captureAttempts: attempts,
    capturePending: counts.pending ?? 0,
    captureReconciled: counts.reconciled ?? 0,
    captureRejected: counts.rejected ?? 0,
    checked: options.batch,
    done: counts.done,
    elapsedMs: options.elapsedMs,

    errors: blind === null ? 0 : 1,
    failed: counts.failed,
    failureRecordingFailures: failures.failureRecording,
    ...timing,
    ...(options.leases === undefined ? {} : { leases: options.leases }),
    ok: blind === null,
    produced: counts.done,

    provenanceFailed: provenance.failed,
    provenanceFound: provenance.found,

    provenanceLadderDeferred: ladder?.deferred ?? 0,
    provenanceLadderExhausted: ladder?.exhausted ?? 0,
    provenanceLadderResidualRescued: ladder?.residualRescued ?? 0,
    provenanceLadderSearched: ladder?.searched ?? 0,
    provenanceLadderSegmentMissed: ladder?.segmentMissed ?? 0,
    provenanceLadderSegmentVerified: ladder?.segmentVerified ?? 0,
    provenanceLadderTopicServed: ladder?.topicServed ?? 0,
    provenanceNone: provenance.none,
    provenancePending: provenance.pending ?? 0,
    proxyFailures: failures.proxy,
    r2Failures: failures.r2,
    ...(blind === null ? {} : { reason: blind }),
    reverdictAsked: reverdict.asked,
    reverdictFailed: reverdict.failed,
    reverdictPending: reverdict.pending ?? 0,

    skipped: counts.skipped,
    trackUpdateFailures: failures.trackUpdate,
    unknownFailures: failures.unknown,
    unmatched: counts.unmatched,
    writesConfirmed: options.writes.confirmed,
    writesFailed: options.writes.failed,
    writesPending: options.writes.pending,
    ytDlpFailures: failures.ytDlp,
  };
}

export function buildCaptureConfigFailureSummary(reason: string): Record<string, unknown> {
  return {
    checked: 0,
    errors: 1,
    failed: 0,
    ok: false,
    produced: 0,
    reason,
  };
}

export function buildCaptureFatalSummary(error: unknown): Record<string, unknown> {
  return {
    checked: null,
    error: error instanceof Error ? error.message : String(error),
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "capture_failed",
  };
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

// oxlint-disable-next-line complexity
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const admissionPhase = argumentValue(argv, "--admission-phase");
  const phaseStatePath = argumentValue(argv, "--phase-state");
  if (admissionPhase) {
    if (!phaseStatePath || !isCaptureAdmissionAction(admissionPhase)) {
      throw new Error("invalid capture admission phase invocation");
    }
    await runCaptureAdmissionChild(admissionPhase, phaseStatePath);
    return;
  }
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify(buildCaptureConfigFailureSummary("missing_api_token")));
    process.exit(1);
  }
  if (!PROXY_HOST || !PROXY_PORT || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.log(JSON.stringify(buildCaptureConfigFailureSummary("missing_proxy_credentials")));
    process.exit(1);
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify(buildCaptureConfigFailureSummary("missing_r2_credentials")));
    process.exit(1);
  }

  let recoveredConfirmed = 0;
  let recoveredPending = 0;
  let recoveredRejected = 0;
  const recoveredCapture = { pending: 0, reconciled: 0, rejected: 0 };
  const recoveredProvenance: ProvenanceCounts = {
    failed: 0,
    found: 0,
    none: 0,
    pending: 0,
    writesConfirmed: 0,
    writesFailed: 0,
    writesPending: 0,
  };
  const recoveredReverdict: ReverdictCounts = {
    asked: 0,
    failed: 0,
    pending: 0,
    writesConfirmed: 0,
    writesFailed: 0,
    writesPending: 0,
  };
  const recovered = await recoverCaptureProgress(CAPTURE_PROGRESS_DIR);
  const protectedTrackIds = protectedTrackIdsFromRecovery(recovered);
  for (const { disposition, progress: prior } of recovered) {
    if (disposition === "pending" || disposition === "failed") {
      recoveredPending += 1;
    } else if (disposition === "committed") {
      recoveredConfirmed += 1;
    } else {
      recoveredRejected += 1;
    }
    const priorKind = isCaptureAttemptProgress(prior) ? prior.attempt.kind : prior.result.kind;
    if (priorKind === "capture") {
      if (disposition === "committed") {
        recoveredCapture.reconciled += 1;
      } else if (disposition === "rejected") {
        recoveredCapture.rejected += 1;
      } else {
        recoveredCapture.pending += 1;
      }
    } else if (priorKind === "youtube-provenance") {
      if (disposition === "committed") {
        recoveredProvenance.writesConfirmed = (recoveredProvenance.writesConfirmed ?? 0) + 1;
        if (!isCaptureAttemptProgress(prior) && prior.result.outcome === "none") {
          recoveredProvenance.none += 1;
        } else {
          recoveredProvenance.found += 1;
        }
      } else if (disposition === "rejected") {
        recoveredProvenance.failed += 1;
        recoveredProvenance.writesFailed = (recoveredProvenance.writesFailed ?? 0) + 1;
      } else {
        recoveredProvenance.pending = (recoveredProvenance.pending ?? 0) + 1;
        recoveredProvenance.writesPending = (recoveredProvenance.writesPending ?? 0) + 1;
      }
    } else if (disposition === "committed") {
      recoveredReverdict.asked += 1;
      recoveredReverdict.writesConfirmed = (recoveredReverdict.writesConfirmed ?? 0) + 1;
    } else if (disposition === "rejected") {
      recoveredReverdict.failed += 1;
      recoveredReverdict.writesFailed = (recoveredReverdict.writesFailed ?? 0) + 1;
    } else {
      recoveredReverdict.pending = (recoveredReverdict.pending ?? 0) + 1;
      recoveredReverdict.writesPending = (recoveredReverdict.writesPending ?? 0) + 1;
    }
  }

  const capabilities: { value?: CaptureCapabilities } = {};
  const queue = admittedWorkList({
    capabilities,
    kind: "capture",
    limit: QUEUE_LIMIT,
    scope: "all",
  });
  if (queue === "due-work-repair-pending") {
    console.log(
      JSON.stringify(
        dueWorkRepairPendingSummary({
          checked: 0,
          writesConfirmed: recoveredConfirmed,
          writesFailed: recoveredRejected,
          writesPending: recoveredPending,
        }),
      ),
    );
    return;
  }
  if (queue === "yielded") {
    console.log(
      JSON.stringify(
        databaseAdmissionYieldSummary({
          checked: 0,
          writesConfirmed: recoveredConfirmed,
          writesFailed: recoveredRejected,
          writesPending: recoveredPending,
        }),
      ),
    );
    return;
  }
  const batch = withoutProtectedTracks(queue, protectedTrackIds).slice(0, BATCH_CAP);

  const prepareWidth = capabilities.value?.prepareTrackCaptures;
  const prepareTiming: number[] = [];
  let batchPrepared: Map<string, PreparedSnapshot> | undefined;
  let batchPrepareYielded = false;

  if (prepareWidth !== undefined && batch.length > 0) {
    const page = prepareTickSnapshots(
      batch.map((finding) => finding.trackId),
      "capture",
      prepareWidth,
    );
    batchPrepared = page?.prepared;
    batchPrepareYielded = page === undefined;
    prepareTiming.push(...(page?.elapsedMs ?? []));
  }

  const counts = {
    done: 0,
    failed: 0,
    pending: recoveredCapture.pending,
    reconciled: recoveredCapture.reconciled,
    rejected: recoveredCapture.rejected,
    skipped: 0,
    unmatched: 0,
  };
  const captureWrites = {
    confirmed: recoveredCapture.reconciled,
    failed: recoveredCapture.rejected,
    pending: recoveredCapture.pending,
  };

  const anchoring = {
    attemptsAnchored: 0,
    attemptsUnanchored: 0,
    doneAnchored: 0,
    doneUnanchored: 0,
  };
  const anchoredTracks = new Map<string, boolean | undefined>();

  const itemTiming: number[] = [...prepareTiming];

  const botChallenges = createBotChallengeMeter();
  const failures = createCaptureFailureMeter();

  const countOutcome = (outcome: FindingOutcome, trackId: string): void => {
    if (outcome === "done") {
      const anchored = anchoredTracks.get(trackId);
      if (anchored === true) {
        anchoring.doneAnchored += 1;
      } else if (anchored === false) {
        anchoring.doneUnanchored += 1;
      }
    }
    if (outcome === "unrecorded-failure") {
      counts.failed += 1;
    } else if (!isDeferredOutcome(outcome)) {
      counts[outcome] += 1;
    }
    if (outcome === "pending") {
      captureWrites.pending += 1;
      protectedTrackIds.add(trackId);
    } else if (outcome === "rejected") {
      captureWrites.failed += 1;
    } else if (
      outcome !== "skipped" &&
      outcome !== "unrecorded-failure" &&
      !isDeferredOutcome(outcome)
    ) {
      captureWrites.confirmed += 1;
    }
  };

  const deferredRows: { outcome: keyof typeof DEFERRED_OUTCOMES; trackId: string }[] = [];
  const collected: CollectedCaptureCommit[] = [];
  const commitWidth = capabilities.value?.commitTrackCaptures;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < batch.length) {
      const finding = batch[cursor];
      cursor += 1;

      if (!finding) {
        return;
      }

      try {
        const prepared =
          prepareWidth === undefined
            ? prepareCurrentSnapshot(finding.trackId, "capture")
            : (batchPrepared?.get(finding.trackId) ?? "unreached");
        if (prepared === "yielded" || (prepared === "unreached" && batchPrepareYielded)) {
          counts.pending += 1;
          continue;
        }
        if (prepared === "unreached") {
          counts.pending += 1;
          continue;
        }
        if (!prepared.prepared) {
          counts.rejected += 1;
          continue;
        }
        if (prepared.track.anchored === true) {
          anchoring.attemptsAnchored += 1;
        } else if (prepared.track.anchored === false) {
          anchoring.attemptsUnanchored += 1;
        }
        anchoredTracks.set(finding.trackId, prepared.track.anchored);
        const outcome = await captureFinding(
          preparedCaptureFinding(finding, prepared.track),
          prepared.snapshotToken,
          botChallenges,
          failures,
        );
        if (isDeferredOutcome(outcome)) {
          deferredRows.push({ outcome, trackId: finding.trackId });
          continue;
        }
        countOutcome(outcome, finding.trackId);
      } catch (error) {
        counts.failed += 1;
        noteCaptureFailure(failures, error);
        log(
          `unexpected error on ${finding.trackId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  if (commitWidth !== undefined) {
    activeCommitCollector = (entry) => {
      collected.push(entry);
    };
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batch.length) || 1 }, () => worker()),
    );
  } finally {
    activeCommitCollector = undefined;
  }

  if (collected.length > 0 && commitWidth !== undefined) {
    const dispositions = settleCollectedCommits(collected, commitWidth, admittedPhase, itemTiming);
    for (const row of deferredRows) {
      countOutcome(resolveDeferredOutcome(row.outcome, dispositions.get(row.trackId)), row.trackId);
    }
  } else {
    for (const row of deferredRows) {
      countOutcome("pending", row.trackId);
    }
  }

  const currentProvenance = await runProvenancePhase(botChallenges, protectedTrackIds).catch(
    (error: unknown) => {
      log(`provenance phase failed: ${error instanceof Error ? error.message : String(error)}`);

      return { counts: { failed: 0, found: 0, none: 0 }, ladder: createLadderCounts() };
    },
  );
  const provenance: ProvenanceCounts = {
    failed: currentProvenance.counts.failed + recoveredProvenance.failed,
    found: currentProvenance.counts.found + recoveredProvenance.found,
    none: currentProvenance.counts.none + recoveredProvenance.none,
    pending: (currentProvenance.counts.pending ?? 0) + (recoveredProvenance.pending ?? 0),
    writesConfirmed:
      (currentProvenance.counts.writesConfirmed ?? 0) + (recoveredProvenance.writesConfirmed ?? 0),
    writesFailed:
      (currentProvenance.counts.writesFailed ?? 0) + (recoveredProvenance.writesFailed ?? 0),
    writesPending:
      (currentProvenance.counts.writesPending ?? 0) + (recoveredProvenance.writesPending ?? 0),
  };
  const currentReverdict = await runReverdictPhase(protectedTrackIds).catch((error: unknown) => {
    log(`re-verdict phase failed: ${error instanceof Error ? error.message : String(error)}`);

    return { asked: 0, failed: 0 };
  });
  const reverdict = {
    asked: currentReverdict.asked + recoveredReverdict.asked,
    failed: currentReverdict.failed + recoveredReverdict.failed,
    pending: (currentReverdict.pending ?? 0) + (recoveredReverdict.pending ?? 0),
    writesConfirmed:
      (currentReverdict.writesConfirmed ?? 0) + (recoveredReverdict.writesConfirmed ?? 0),
    writesFailed: (currentReverdict.writesFailed ?? 0) + (recoveredReverdict.writesFailed ?? 0),
    writesPending: (currentReverdict.writesPending ?? 0) + (recoveredReverdict.writesPending ?? 0),
  };

  logBotChallengeRecap(botChallenges);

  const summary = buildCaptureSummary({
    anchoring,
    batch: batch.length,

    botChallenges: botChallenges.total,
    botChallengesUncleared: botChallenges.uncleared,
    counts,
    elapsedMs: Date.now() - started,
    failures,

    itemTiming,
    ladder: currentProvenance.ladder,
    leases: admittedPhaseCount,
    provenance,
    reverdict,
    writes: {
      confirmed:
        captureWrites.confirmed +
        (provenance.writesConfirmed ?? 0) +
        (reverdict.writesConfirmed ?? 0),
      failed:
        captureWrites.failed +
        failures.failureRecording +
        (provenance.writesFailed ?? 0) +
        (reverdict.writesFailed ?? 0),
      pending:
        captureWrites.pending + (provenance.writesPending ?? 0) + (reverdict.writesPending ?? 0),
    },
  });

  console.log(JSON.stringify(summary));

  if (summary.ok === false) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const summary = buildCaptureFatalSummary(error);
    log(`capture sweep failed: ${String(summary.error)}`);
    console.log(JSON.stringify(summary));
    process.exit(1);
  });
}
