import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type Transaction } from "@libsql/client";
import { parseArtistsJson } from "./artists";
import { getCatalogueCaptureState, isCatalogueCaptureOpen } from "./capture-budget";
import { getDb } from "./db";
import {
  evaluateDueWorkQueue,
  type DueWorkKind,
  type DueWorkTrackSource,
  dueWorkTrackSourceVersion,
} from "./due-work-track-definitions";
import { markDueWorkSourceMaintenanceStatements } from "./due-work";
import { readEnv } from "./env";
import {
  digestOperationRequest,
  executeReceiptBackedOperation,
  type JsonValue,
} from "./operation-receipts";
import { ApiError } from "./spotify";
import { checkYoutubeOfficial, type YoutubeOfficialVerdict } from "./youtube-official";

export const CAPTURE_RECONCILIATION_OPERATION_ID = "track.capture" as const;
const TOKEN_KEY_LABEL = "fluncle/track-capture-reconciliation/v1";
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const TOKEN_MAX_LENGTH = 65_536;

export type CaptureReconciliationKind = Extract<
  DueWorkKind,
  "capture" | "youtube-provenance" | "youtube-reverdict"
>;

export type CaptureExternalResult =
  | {
      attemptedAt: string;
      kind: "capture";
      outcome: "failed" | "unmatched";
      sourceAudioRejected?: string;
    }
  | {
      attemptedAt: string;
      bytes: number;
      capturedAt: string;
      captureVerification: "preview-match" | "unverified";
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

type CaptureSnapshotExtra = {
  bpm: number | null;
  captureVerification: string | null;
  captureVerifiedAt: string | null;
  enrichmentStatus: string | null;
  label: string | null;
  labelName: string | null;
  sourceAudioBytes: number | null;
  sourceAudioCapturedAt: string | null;
  sourceAudioRejected: string | null;
  youtubeVerifiedBy: string | null;
};

export type CaptureSnapshot = {
  extra: CaptureSnapshotExtra;
  source: DueWorkTrackSource;
  sourceVersion: string;
};

export type CapturePreparedTrack = {
  analyzedFrom?: "full" | "preview";
  artists: string[];
  bpm?: number;
  certified: boolean;
  durationMs?: number;
  label?: string;
  logId?: string;
  sourceAudioFailures?: number;
  sourceAudioKey?: string;
  sourceAudioRejected?: string;
  title: string;
  trackId: string;
};

type SnapshotToken = {
  expiresAt: number;
  iat: number;
  kind: CaptureReconciliationKind;
  snapshot: CaptureSnapshot;
  stage: "snapshot";
  trackId: string;
};

type CommitToken = {
  expiresAt: number;
  iat: number;
  kind: CaptureReconciliationKind;
  official: YoutubeOfficialVerdict;
  result: CaptureExternalResult;
  snapshot: CaptureSnapshot;
  stage: "commit";
  trackId: string;
};

type CaptureSourceRow = {
  analyzed_at: string | null;
  analyzed_from: string | null;
  artists_json: string;
  bpm: bigint | null | number;
  capture_priority: bigint | null | number;
  capture_status: string | null;
  capture_verification: string | null;
  capture_verified_at: string | null;
  demand_score: bigint | null | number;
  dismissed_at: string | null;
  duplicate_of_track_id: string | null;
  duration_ms: bigint | null | number;
  enrichment_status: string | null;
  finding_added_at: string | null;
  finding_track_id: string | null;
  has_embedding: bigint | number;
  has_isrc: bigint | number;
  isrc: string | null;
  isrc_recovery_attempted_at: string | null;
  label: string | null;
  label_name: string | null;
  label_seed_state: string | null;
  log_id: string | null;
  nearest_finding_score: bigint | null | number;
  source_audio_attempted_at: string | null;
  source_audio_bytes: bigint | null | number;
  source_audio_captured_at: string | null;
  source_audio_failures: bigint | null | number;
  source_audio_key: string | null;
  source_audio_rejected: string | null;
  source_verification: string | null;
  spotify_anchor_attempted_at: string | null;
  spotify_anchor_attempts: bigint | null | number;
  spotify_uri: string | null;
  title: string;
  track_id: string;
  youtube_provenance_failures: bigint | null | number;
  youtube_verified_at: string | null;
  youtube_verified_by: string | null;
  youtube_video_id: string | null;
  youtube_video_official: bigint | null | number;
};

const CAPTURE_SOURCE_SELECT = `select
  t.analyzed_at, t.analyzed_from, t.artists_json, t.bpm, t.capture_priority, t.capture_status,
  t.capture_verification, t.capture_verified_at, t.demand_score, t.dismissed_at,
  t.duration_ms, t.duplicate_of_track_id, t.has_embedding, t.has_isrc, t.isrc,
  t.isrc_recovery_attempted_at, t.label, t.nearest_finding_score,
  t.source_audio_attempted_at, t.source_audio_bytes, t.source_audio_captured_at,
  t.source_audio_failures, t.source_audio_key, t.source_audio_rejected,
  t.source_verification, t.spotify_anchor_attempted_at, t.spotify_anchor_attempts,
  t.spotify_uri, t.title, t.track_id, t.youtube_provenance_failures,
  t.youtube_verified_at, t.youtube_verified_by, t.youtube_video_id, t.youtube_video_official,
  f.added_at as finding_added_at, f.enrichment_status, f.log_id,
  f.track_id as finding_track_id, l.name as label_name, l.seed_state as label_seed_state
from tracks t
left join findings f on f.track_id = t.track_id
left join labels l on l.id = t.label_id`;

type CaptureDbClient = Pick<Transaction, "execute">;

function numberOrNull(value: bigint | null | number): number | null {
  return value === null ? null : Number(value);
}

function snapshotFromRow(row: CaptureSourceRow): CaptureSnapshot {
  const labelSeedState =
    row.label_seed_state === "disabled" ||
    row.label_seed_state === "enabled" ||
    row.label_seed_state === "undecided"
      ? row.label_seed_state
      : null;
  const source: DueWorkTrackSource = {
    analyzedAt: row.analyzed_at,
    analyzedFrom:
      row.analyzed_from === "full" || row.analyzed_from === "preview" ? row.analyzed_from : null,
    artistsJson: row.artists_json,
    capturePriority: numberOrNull(row.capture_priority),
    captureStatus: row.capture_status,
    certified: row.finding_track_id !== null,
    demandScore: numberOrNull(row.demand_score),
    dismissedAt: row.dismissed_at,
    duplicateOfTrackId: row.duplicate_of_track_id,
    durationMs: numberOrNull(row.duration_ms),
    findingAddedAt: row.finding_added_at,
    hasEmbedding: Number(row.has_embedding) === 1,
    hasIsrc: Number(row.has_isrc) === 1,
    isrc: row.isrc,
    isrcRecoveryAttemptedAt: row.isrc_recovery_attempted_at,
    labelSeedState,
    logId: row.log_id,
    nearestFindingScore: numberOrNull(row.nearest_finding_score),
    sourceAudioAttemptedAt: row.source_audio_attempted_at,
    sourceAudioFailures: numberOrNull(row.source_audio_failures),
    sourceAudioKey: row.source_audio_key,
    sourceVerification: row.source_verification,
    spotifyAnchorAttemptedAt: row.spotify_anchor_attempted_at,
    spotifyAnchorAttempts: numberOrNull(row.spotify_anchor_attempts),
    spotifyUri: row.spotify_uri,
    title: row.title,
    trackId: row.track_id,
    youtubeProvenanceFailures: numberOrNull(row.youtube_provenance_failures),
    youtubeVerifiedAt: row.youtube_verified_at,
    youtubeVideoId: row.youtube_video_id,
    youtubeVideoOfficial:
      row.youtube_video_official === null ? null : Number(row.youtube_video_official) === 1,
  };
  return {
    extra: {
      bpm: numberOrNull(row.bpm),
      captureVerification: row.capture_verification,
      captureVerifiedAt: row.capture_verified_at,
      enrichmentStatus: row.enrichment_status,
      label: row.label,
      labelName: row.label_name,
      sourceAudioBytes: numberOrNull(row.source_audio_bytes),
      sourceAudioCapturedAt: row.source_audio_captured_at,
      sourceAudioRejected: row.source_audio_rejected,
      youtubeVerifiedBy: row.youtube_verified_by,
    },
    source,
    sourceVersion: dueWorkTrackSourceVersion(source),
  };
}

async function readCaptureSnapshot(
  client: CaptureDbClient,
  trackId: string,
): Promise<CaptureSnapshot | undefined> {
  const result = await client.execute({
    args: [trackId],
    sql: `${CAPTURE_SOURCE_SELECT} where t.track_id = ? limit 1`,
  });
  const row = result.rows[0] as CaptureSourceRow | undefined;
  return row === undefined ? undefined : snapshotFromRow(row);
}

export function isCaptureReconciliationEligible(
  snapshot: CaptureSnapshot,
  kind: CaptureReconciliationKind,
  now: Date,
): boolean {
  const row = evaluateDueWorkQueue({ kind, now, sources: [snapshot.source] })[0];
  return row !== undefined && row.nextDueAt <= now.toISOString();
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

async function tokenKey(): Promise<Buffer> {
  return createHmac("sha256", await readEnv("ADMIN_SESSION_SECRET"))
    .update(TOKEN_KEY_LABEL)
    .digest();
}

async function signToken(payload: SnapshotToken | CommitToken): Promise<string> {
  const body = Buffer.from(canonical(payload)).toString("base64url");
  const signature = createHmac("sha256", await tokenKey())
    .update(body)
    .digest("base64url");
  const token = `${body}.${signature}`;
  if (token.length > TOKEN_MAX_LENGTH) {
    throw new ApiError("capture_token_too_large", "The capture token is too large.", 422);
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCaptureReconciliationKind(value: unknown): value is CaptureReconciliationKind {
  return value === "capture" || value === "youtube-provenance" || value === "youtube-reverdict";
}

export function isCaptureReconciliationTokenEnvelope(
  value: unknown,
  stage: "commit" | "snapshot",
): value is CommitToken | SnapshotToken {
  if (!isRecord(value) || value.stage !== stage) {
    return false;
  }
  const { expiresAt, iat, kind, snapshot, trackId } = value;
  if (
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(expiresAt) ||
    typeof trackId !== "string" ||
    trackId.length === 0 ||
    trackId.length > 256 ||
    !isCaptureReconciliationKind(kind) ||
    !isRecord(snapshot) ||
    !isRecord(snapshot.source) ||
    snapshot.source.trackId !== trackId
  ) {
    return false;
  }
  if (
    (expiresAt as number) <= (iat as number) ||
    (expiresAt as number) - (iat as number) > TOKEN_MAX_AGE_MS ||
    (iat as number) > Date.now() + TOKEN_CLOCK_SKEW_MS
  ) {
    return false;
  }
  if (stage === "snapshot") {
    return true;
  }
  return (
    isRecord(value.result) &&
    value.result.kind === kind &&
    (value.official === null || value.official === 0 || value.official === 1)
  );
}

async function verifyToken<T extends SnapshotToken | CommitToken>(
  token: string,
  stage: T["stage"],
  options: { allowExpired?: boolean } = {},
): Promise<T> {
  const parts = token.split(".");
  if (token.length === 0 || token.length > TOKEN_MAX_LENGTH || parts.length !== 2) {
    throw new ApiError("invalid_capture_token", "The capture token is invalid.", 400);
  }
  const [body, signature] = parts;
  if (!body || !signature) {
    throw new ApiError("invalid_capture_token", "The capture token is invalid.", 400);
  }
  const expected = createHmac("sha256", await tokenKey())
    .update(body)
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ApiError("invalid_capture_token", "The capture token is invalid.", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("invalid_capture_token", "The capture token is invalid.", 400);
  }
  if (!isCaptureReconciliationTokenEnvelope(parsed, stage)) {
    throw new ApiError("invalid_capture_token", "The capture token is invalid.", 400);
  }
  if (parsed.expiresAt < Date.now() && !options.allowExpired) {
    throw new ApiError("expired_capture_token", "The capture token has expired.", 409);
  }
  return parsed as T;
}

export async function prepareCaptureReconciliation(
  trackId: string,
  kind: CaptureReconciliationKind,
  priorSnapshotToken?: string,
  /**
   * The catalogue capture budget's verdict, when a CALLER owns it. A batched prepare consumes the
   * rolling count cap cumulatively across its items (see {@link prepareCaptureReconciliations}), so
   * it decides per row and hands the answer down; the per-row path passes nothing and this reads the
   * ledger itself, exactly as it always did.
   */
  options?: { catalogueCaptureOpen?: boolean },
): Promise<
  | { prepared: false; reason: "ineligible" | "not-found" | "stale" }
  | { prepared: true; snapshotToken: string; track: CapturePreparedTrack }
> {
  const prior = priorSnapshotToken
    ? await verifyToken<SnapshotToken>(priorSnapshotToken, "snapshot", { allowExpired: true })
    : undefined;
  if (prior && (prior.trackId !== trackId || prior.kind !== kind)) {
    throw new ApiError(
      "capture_token_mismatch",
      "The capture token does not match this track.",
      409,
    );
  }
  const snapshot = await readCaptureSnapshot(await getDb(), trackId);
  if (snapshot === undefined) {
    return { prepared: false, reason: "not-found" };
  }
  if (prior && !sameCaptureReconciliationState(snapshot, prior.snapshot, kind)) {
    return { prepared: false, reason: "stale" };
  }
  const now = new Date();
  const budgeted =
    (kind === "capture" || kind === "youtube-provenance") &&
    !snapshot.source.certified &&
    prior === undefined;
  if (
    !isCaptureReconciliationEligible(snapshot, kind, now) ||
    (budgeted && !(options?.catalogueCaptureOpen ?? (await isCatalogueCaptureOpen(now.getTime()))))
  ) {
    return { prepared: false, reason: "ineligible" };
  }
  return {
    prepared: true,
    snapshotToken: await signToken({
      expiresAt: now.getTime() + TOKEN_MAX_AGE_MS,
      iat: now.getTime(),
      kind,
      snapshot,
      stage: "snapshot",
      trackId,
    }),
    track: preparedTrack(snapshot),
  };
}

/**
 * THE BATCHED PHASES' WALL BUDGET.
 *
 * An admitted phase holds the single `write` lane under a 90s lease, renewed by a 30s heartbeat and
 * reaped by a watchdog that allows roughly a 75s window. A per-row phase could never approach that;
 * a batched one multiplies the same work by K, so the request must be able to stop itself. The
 * budget is checked BEFORE each item and the first item always runs, so a batch overshoots by at
 * most one item. Everything past it comes back as its own retryable per-item verdict.
 */
export const CAPTURE_BATCH_WALL_BUDGET_MS = 45_000;

export type CapturePrepareBatchItem = {
  kind: CaptureReconciliationKind;
  priorSnapshotToken?: string;
  trackId: string;
};

export type CapturePreparedBatchResult =
  | { prepared: false; reason: "deferred" | "ineligible" | "not-found" | "stale"; trackId: string }
  | { prepared: true; snapshotToken: string; track: CapturePreparedTrack; trackId: string };

/**
 * Freeze a batch of capture rows inside ONE admitted phase.
 *
 * THE BUDGET IS A RESERVATION HERE, NOT A QUESTION. The per-row prepare could only ask
 * `isCatalogueCaptureOpen()` — "is there room right now" — because only one row was ever authorized
 * before the next read of the ledger. A batch authorizes K downloads before ANY of them lands, so
 * asking the same question K times would let a batch of 12 through on a budget with 1 track left.
 * The rolling-24h COUNT cap is therefore consumed in request order: the batch reads the ledger once,
 * and may freeze at most `remainingTracks` uncertified rows. Every uncertified row past that is
 * refused `ineligible` — the same refusal a closed budget already gives — so the count cap cannot be
 * overshot by a batch at all.
 *
 * A CERTIFIED FINDING IS NEVER GATED. It does not consume the reservation, it cannot be displaced by
 * an uncertified row ahead of it in the batch, and it is prepared whatever the budget says. That is
 * the same guarantee the per-row path carried (capture-budget.ts § "the findings are never gated").
 *
 * A row carrying a PRIOR SNAPSHOT TOKEN is a continuation of work already authorized, so it does not
 * consume the reservation either — exactly as the per-row path skips the budget when `prior` is set.
 *
 * THE BYTE CAP STAYS A BACKSTOP. A file's size is knowable only after it is downloaded, so no
 * prepare — batched or not — can enforce it ahead of the spend. Batching widens its overshoot from
 * "the rows in flight when the tick read the gate" to "the uncertified rows this batch froze": at
 * most `min(K, remainingTracks)` × the largest file. The count cap is what keeps that finite.
 */
export async function prepareCaptureReconciliations(
  items: readonly CapturePrepareBatchItem[],
  options: {
    captureState?: () => Promise<{ open: boolean; remainingTracks: number }>;
    now?: () => number;
    /** The per-row prepare. Injectable so the batch's budget accounting is provable in isolation. */
    prepare?: typeof prepareCaptureReconciliation;
    wallBudgetMs?: number;
  } = {},
): Promise<{ deferred: number; results: CapturePreparedBatchResult[] }> {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.wallBudgetMs ?? CAPTURE_BATCH_WALL_BUDGET_MS;
  const startedAt = now();

  // Read the ledger ONCE for the whole batch. A per-row read would be the very thing that lets a
  // batch overshoot: each row would see the same untouched spend and each would say yes.
  const gated = items.some(
    (item) =>
      (item.kind === "capture" || item.kind === "youtube-provenance") &&
      item.priorSnapshotToken === undefined,
  );
  const state = gated
    ? await (options.captureState ?? readBatchCaptureBudgetState)()
    : { open: true, remainingTracks: 0 };
  let reserved = 0;

  const results: CapturePreparedBatchResult[] = [];
  let deferred = 0;

  for (const [index, item] of items.entries()) {
    if (index > 0 && now() - startedAt >= budgetMs) {
      deferred += 1;
      results.push({ prepared: false, reason: "deferred", trackId: item.trackId });
      continue;
    }

    const budgeted =
      (item.kind === "capture" || item.kind === "youtube-provenance") &&
      item.priorSnapshotToken === undefined;
    const prepared = await (options.prepare ?? prepareCaptureReconciliation)(
      item.trackId,
      item.kind,
      item.priorSnapshotToken,
      // The batch owns the budget decision so it can consume it cumulatively; the per-row gate is
      // handed the verdict instead of re-reading a ledger it would find untouched.
      budgeted
        ? { catalogueCaptureOpen: state.open && reserved < state.remainingTracks }
        : undefined,
    );
    // Only an UNCERTIFIED row spends the catalogue budget, so only one consumes the reservation.
    if (budgeted && prepared.prepared && !prepared.track.certified) {
      reserved += 1;
    }
    results.push({ ...prepared, trackId: item.trackId });
  }

  return { deferred, results };
}

async function readBatchCaptureBudgetState(): Promise<{ open: boolean; remainingTracks: number }> {
  const state = await getCatalogueCaptureState();
  return { open: state.open, remainingTracks: state.remainingTracks };
}

export type CaptureCommitBatchItem = {
  commitToken: string;
  operationId: string;
  operationKey: string;
  requestDigest: string;
  trackId: string;
};

export type CaptureCommitBatchReceipt = {
  error?: string;
  outcome:
    | "committed"
    | "conflict"
    | "failed"
    | "in-progress"
    | "lookup-failed"
    | "rejected"
    | "safely-retryable";
  replayed: boolean;
  result?: unknown;
  trackId: string;
};

/**
 * Settle a batch of prepared capture results inside ONE admitted phase.
 *
 * PER-ITEM RECEIPTS, NEVER A COLLAPSED ONE. Every item goes through the same
 * {@link commitCaptureReconciliation} the per-row commit calls, with its own commit token and its
 * own receipt coordinates, so `track.capture` keeps its non-replayable `phased(…, 0)` shape and
 * `resolve_operation_receipt` can still answer about exactly one row. A throw is caught, bounded and
 * recorded as THAT item's `failed`: its neighbours commit regardless.
 */
export async function commitCaptureReconciliations(
  items: readonly CaptureCommitBatchItem[],
  options: {
    /** The per-row commit. Injectable so the batch's own contract is provable without a database. */
    commit?: typeof commitCaptureReconciliation;
    now?: () => number;
    wallBudgetMs?: number;
  } = {},
): Promise<{ deferred: number; receipts: CaptureCommitBatchReceipt[] }> {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.wallBudgetMs ?? CAPTURE_BATCH_WALL_BUDGET_MS;
  const startedAt = now();
  const receipts: CaptureCommitBatchReceipt[] = [];
  let deferred = 0;

  for (const [index, item] of items.entries()) {
    if (index > 0 && now() - startedAt >= budgetMs) {
      deferred += 1;
      receipts.push({ outcome: "safely-retryable", replayed: false, trackId: item.trackId });
      continue;
    }
    try {
      const outcome = await (options.commit ?? commitCaptureReconciliation)(item);
      receipts.push({
        outcome: outcome.outcome,
        replayed: outcome.replayed,
        ...("result" in outcome && outcome.result !== undefined ? { result: outcome.result } : {}),
        trackId: item.trackId,
      });
    } catch (error) {
      receipts.push({
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        outcome: "failed",
        replayed: false,
        trackId: item.trackId,
      });
    }
  }

  return { deferred, receipts };
}

function youtubeIdFor(result: CaptureExternalResult, snapshot: CaptureSnapshot): string | null {
  if (result.kind === "youtube-reverdict") {
    return snapshot.source.youtubeVideoId;
  }
  if (result.kind === "youtube-provenance" && result.outcome === "youtube-found") {
    return result.youtubeVideoId;
  }
  if (
    result.kind === "capture" &&
    result.outcome === "done" &&
    result.captureVerification === "preview-match"
  ) {
    return result.youtubeVideoId ?? null;
  }
  return null;
}

export async function authorizeCaptureReconciliation(options: {
  fetchImpl?: typeof fetch;
  result: CaptureExternalResult;
  snapshotToken: string;
  trackId: string;
}): Promise<{
  commitToken: string;
  operationId: typeof CAPTURE_RECONCILIATION_OPERATION_ID;
  operationKey: string;
  requestDigest: string;
}> {
  const prepared = await verifyToken<SnapshotToken>(options.snapshotToken, "snapshot");
  if (
    prepared.trackId !== options.trackId ||
    prepared.kind !== options.result.kind ||
    prepared.snapshot.source.trackId !== options.trackId
  ) {
    throw new ApiError(
      "capture_token_mismatch",
      "The capture token does not match this result.",
      409,
    );
  }
  if (options.result.kind === "capture" && options.result.outcome === "done") {
    const root = prepared.snapshot.source.certified
      ? prepared.snapshot.source.logId
      : `catalogue/${prepared.trackId}`;
    const suffix = root ? options.result.sourceAudioKey.slice(root.length + 1) : "";
    if (
      !root ||
      !options.result.sourceAudioKey.startsWith(`${root}/`) ||
      !/^[0-9a-f]{64}\.[a-z0-9]+$/.test(suffix) ||
      options.result.bytes <= 0
    ) {
      throw new ApiError(
        "invalid_capture_result",
        "The capture result does not match its deterministic object key.",
        422,
      );
    }
    if (
      options.result.youtubeVideoId !== undefined &&
      options.result.captureVerification !== "preview-match"
    ) {
      throw new ApiError(
        "invalid_capture_result",
        "A YouTube id requires a preview fingerprint match.",
        422,
      );
    }
  }
  const videoId = youtubeIdFor(options.result, prepared.snapshot);
  const names = {
    artists: parseArtistsJson(prepared.snapshot.source.artistsJson),
    labels: [prepared.snapshot.extra.labelName, prepared.snapshot.extra.label].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ),
  };
  const official = videoId ? await checkYoutubeOfficial(videoId, names, options.fetchImpl) : null;
  const now = Date.now();
  const commitToken = await signToken({
    expiresAt: now + TOKEN_MAX_AGE_MS,
    iat: now,
    kind: prepared.kind,
    official,
    result: options.result,
    snapshot: prepared.snapshot,
    stage: "commit",
    trackId: prepared.trackId,
  });
  const tokenDigest = createHash("sha256").update(commitToken).digest("hex");
  return {
    commitToken,
    operationId: CAPTURE_RECONCILIATION_OPERATION_ID,
    operationKey: `track.capture:${tokenDigest}`,
    requestDigest: await digestOperationRequest({ commitToken }),
  };
}

function relevantSnapshot(snapshot: CaptureSnapshot, kind: CaptureReconciliationKind): unknown {
  const source = snapshot.source;
  const identity = {
    artistsJson: source.artistsJson,
    certified: source.certified,
    durationMs: source.durationMs,
    isrc: source.isrc,
    label: snapshot.extra.label,
    labelName: snapshot.extra.labelName,
    labelSeedState: source.labelSeedState,
    logId: source.logId,
    title: source.title,
    trackId: source.trackId,
  };
  const youtube = {
    sourceVerification: source.sourceVerification,
    youtubeProvenanceFailures: source.youtubeProvenanceFailures,
    youtubeVerifiedAt: source.youtubeVerifiedAt,
    youtubeVerifiedBy: snapshot.extra.youtubeVerifiedBy,
    youtubeVideoId: source.youtubeVideoId,
    youtubeVideoOfficial: source.youtubeVideoOfficial,
  };
  if (kind === "youtube-reverdict") {
    return { identity, youtube };
  }
  const capture = {
    captureStatus: source.captureStatus,
    captureVerification: snapshot.extra.captureVerification,
    captureVerifiedAt: snapshot.extra.captureVerifiedAt,
    dismissedAt: source.dismissedAt,
    duplicateOfTrackId: source.duplicateOfTrackId,
    sourceAudioAttemptedAt: source.sourceAudioAttemptedAt,
    sourceAudioBytes: snapshot.extra.sourceAudioBytes,
    sourceAudioCapturedAt: snapshot.extra.sourceAudioCapturedAt,
    sourceAudioFailures: source.sourceAudioFailures,
    sourceAudioKey: source.sourceAudioKey,
    sourceAudioRejected: snapshot.extra.sourceAudioRejected,
  };
  return { capture, identity, youtube };
}

export function sameCaptureReconciliationState(
  left: CaptureSnapshot,
  right: CaptureSnapshot,
  kind: CaptureReconciliationKind,
): boolean {
  return canonical(relevantSnapshot(left, kind)) === canonical(relevantSnapshot(right, kind));
}

function preparedTrack(snapshot: CaptureSnapshot): CapturePreparedTrack {
  return {
    ...(snapshot.source.analyzedFrom ? { analyzedFrom: snapshot.source.analyzedFrom } : {}),
    artists: parseArtistsJson(snapshot.source.artistsJson),
    ...(snapshot.extra.bpm === null ? {} : { bpm: snapshot.extra.bpm }),
    certified: snapshot.source.certified,
    ...(snapshot.source.durationMs === null ? {} : { durationMs: snapshot.source.durationMs }),
    ...(snapshot.extra.labelName || snapshot.extra.label
      ? { label: snapshot.extra.labelName ?? snapshot.extra.label ?? undefined }
      : {}),
    ...(snapshot.source.logId ? { logId: snapshot.source.logId } : {}),
    ...(snapshot.source.sourceAudioFailures === null
      ? {}
      : { sourceAudioFailures: snapshot.source.sourceAudioFailures }),
    ...(snapshot.source.sourceAudioKey ? { sourceAudioKey: snapshot.source.sourceAudioKey } : {}),
    ...(snapshot.extra.sourceAudioRejected
      ? { sourceAudioRejected: snapshot.extra.sourceAudioRejected }
      : {}),
    title: snapshot.source.title,
    trackId: snapshot.source.trackId,
  };
}

async function applyCaptureResult(
  transaction: Transaction,
  token: CommitToken,
  current: CaptureSnapshot,
): Promise<void> {
  const result = token.result;
  const sets: string[] = [];
  const args: Array<number | string | null> = [];
  const findingSets: string[] = [];
  const findingArgs: Array<number | string | null> = [];
  if (result.kind === "capture") {
    sets.push(
      "capture_status = case when capture_status = 'duplicate-cleared' then capture_status else ? end",
      "source_audio_attempted_at = ?",
    );
    args.push(result.outcome, result.attemptedAt);
    if (result.sourceAudioRejected !== undefined) {
      sets.push("source_audio_rejected = ?");
      args.push(result.sourceAudioRejected || null);
    }
    if (result.outcome === "failed") {
      sets.push("source_audio_failures = coalesce(source_audio_failures, 0) + 1");
    }
    if (result.outcome === "done") {
      sets.push(
        "source_audio_key = ?",
        "source_audio_bytes = ?",
        "source_audio_captured_at = ?",
        "capture_verification = ?",
        "capture_verified_at = ?",
      );
      args.push(
        result.sourceAudioKey,
        result.bytes,
        result.capturedAt,
        result.captureVerification,
        result.verifiedAt,
      );
      if (
        result.youtubeVideoId &&
        result.captureVerification === "preview-match" &&
        !token.snapshot.source.youtubeVideoId
      ) {
        sets.push(
          "youtube_video_id = ?",
          "youtube_video_official = ?",
          "youtube_verified_at = ?",
          "youtube_verified_by = 'fingerprint'",
        );
        args.push(result.youtubeVideoId, token.official, result.verifiedAt);
      }
      const bpmMissing = current.extra.bpm === null || current.extra.bpm <= 0;
      if (
        current.source.certified &&
        current.extra.enrichmentStatus !== "processing" &&
        (bpmMissing || current.source.analyzedFrom !== "full")
      ) {
        findingSets.push("enrichment_status = 'pending'", "updated_at = ?");
        findingArgs.push(result.capturedAt);
      }
    }
  } else if (result.kind === "youtube-provenance") {
    if (result.outcome === "source-found") {
      sets.push("source_verification = ?");
      args.push(result.sourceVerification);
    } else if (result.outcome === "youtube-found") {
      const method = result.verification === "metadata-match" ? "search" : "fingerprint";
      sets.push(
        "youtube_video_id = ?",
        "youtube_video_official = ?",
        "youtube_verified_at = ?",
        "youtube_verified_by = ?",
      );
      args.push(result.youtubeVideoId, token.official, new Date(token.iat).toISOString(), method);
    } else {
      sets.push("youtube_provenance_failures = coalesce(youtube_provenance_failures, 0) + 1");
      if (result.verification === "no-match") {
        sets.push("youtube_verified_at = ?");
        args.push(new Date(token.iat).toISOString());
      }
    }
  } else {
    if (token.official !== null) {
      sets.push("youtube_video_official = ?");
      args.push(token.official);
    }
    sets.push("youtube_verified_at = ?");
    args.push(new Date(token.iat).toISOString());
  }

  const statements = [
    {
      args: [...args, token.trackId],
      sql: `update tracks set ${sets.join(", ")} where track_id = ?`,
    },
    ...(findingSets.length > 0
      ? [
          {
            args: [...findingArgs, token.trackId],
            sql: `update findings set ${findingSets.join(", ")} where track_id = ?`,
          },
        ]
      : []),
    ...markDueWorkSourceMaintenanceStatements(
      [{ subjectId: token.trackId, subjectType: "track" }],
      {
        producer: "track-capture-reconciliation",
      },
    ),
  ];
  await transaction.batch(statements);
}

export async function commitCaptureReconciliation(options: {
  commitToken: string;
  operationId: string;
  operationKey: string;
  requestDigest: string;
  trackId: string;
}) {
  const token = await verifyToken<CommitToken>(options.commitToken, "commit");
  const expectedDigest = await digestOperationRequest({ commitToken: options.commitToken });
  const expectedKey = `track.capture:${createHash("sha256").update(options.commitToken).digest("hex")}`;
  if (
    token.trackId !== options.trackId ||
    token.result.kind !== token.kind ||
    options.operationId !== CAPTURE_RECONCILIATION_OPERATION_ID ||
    options.operationKey !== expectedKey ||
    options.requestDigest !== expectedDigest
  ) {
    throw new ApiError(
      "capture_receipt_mismatch",
      "The capture receipt does not match this commit.",
      409,
    );
  }
  const db = await getDb();
  return executeReceiptBackedOperation({
    client: db,
    effect: async (transaction) => {
      const current = await readCaptureSnapshot(transaction, options.trackId);
      if (
        current === undefined ||
        !sameCaptureReconciliationState(current, token.snapshot, token.kind) ||
        !isCaptureReconciliationEligible(current, token.kind, new Date())
      ) {
        return {
          result: { applied: false, reason: "stale" } as JsonValue,
          resultIdentity: `${options.trackId}:stale`,
          state: "rejected",
        };
      }
      await applyCaptureResult(transaction, token, current);
      return {
        result: {
          applied: true,
          kind: token.kind,
          outcome: token.result.outcome,
        } as JsonValue,
        resultIdentity: `${options.trackId}:${token.kind}:${token.result.outcome}`,
        state: "committed",
      };
    },
    operationId: options.operationId,
    operationKey: options.operationKey,
    requestDigest: options.requestDigest,
  });
}
