import { LONG_FORM_MS } from "../catalogue-eligibility";
import { encodeDueWorkOrder, type DueWorkOrderComponent } from "./due-work-order";

export { LONG_FORM_MS };

/** The recurring queue names exposed by `listTrackWork`. */
export type DueWorkKind =
  | "analyze"
  | "anchor"
  | "capture"
  | "embed"
  | "isrc-recovery"
  | "youtube-provenance"
  | "youtube-reverdict";

export type DueWorkScope = "catalogue" | "findings";

/**
 * A physical queue is deliberately narrower than a `listTrackWork` kind. Keeping the two
 * certification halves distinct lets a writer answer both scope and capture-budget questions
 * from the due row itself, without looking up the source table again.
 */
export type DueWorkQueueKind =
  | "analyze-catalogue"
  | "analyze-findings"
  | "anchor"
  | "capture-catalogue"
  | "capture-findings"
  | "embed-catalogue"
  | "embed-findings"
  | "isrc-recovery"
  | "youtube-provenance-catalogue"
  | "youtube-provenance-findings"
  | "youtube-reverdict-catalogue"
  | "youtube-reverdict-findings";

/**
 * The writer/rebuild contract. `usesCatalogueCaptureBudget` is intentionally explicit: a consumer
 * must not infer metering from a source-table join or from a queue-name convention.
 */
export const DUE_WORK_TRACK_WORK_KIND_INVENTORY = [
  {
    kind: "analyze",
    scope: "catalogue",
    usesCatalogueCaptureBudget: false,
    workKind: "analyze-catalogue",
  },
  {
    kind: "analyze",
    scope: "findings",
    usesCatalogueCaptureBudget: false,
    workKind: "analyze-findings",
  },
  { kind: "anchor", scope: "catalogue", usesCatalogueCaptureBudget: false, workKind: "anchor" },
  {
    kind: "capture",
    scope: "catalogue",
    usesCatalogueCaptureBudget: true,
    workKind: "capture-catalogue",
  },
  {
    kind: "capture",
    scope: "findings",
    usesCatalogueCaptureBudget: false,
    workKind: "capture-findings",
  },
  {
    kind: "embed",
    scope: "catalogue",
    usesCatalogueCaptureBudget: false,
    workKind: "embed-catalogue",
  },
  {
    kind: "embed",
    scope: "findings",
    usesCatalogueCaptureBudget: false,
    workKind: "embed-findings",
  },
  {
    kind: "isrc-recovery",
    scope: "catalogue",
    usesCatalogueCaptureBudget: false,
    workKind: "isrc-recovery",
  },
  {
    kind: "youtube-provenance",
    scope: "catalogue",
    usesCatalogueCaptureBudget: true,
    workKind: "youtube-provenance-catalogue",
  },
  {
    kind: "youtube-provenance",
    scope: "findings",
    usesCatalogueCaptureBudget: false,
    workKind: "youtube-provenance-findings",
  },
  {
    kind: "youtube-reverdict",
    scope: "catalogue",
    usesCatalogueCaptureBudget: false,
    workKind: "youtube-reverdict-catalogue",
  },
  {
    kind: "youtube-reverdict",
    scope: "findings",
    usesCatalogueCaptureBudget: false,
    workKind: "youtube-reverdict-findings",
  },
] as const satisfies readonly {
  kind: DueWorkKind;
  scope: DueWorkScope;
  usesCatalogueCaptureBudget: boolean;
  workKind: DueWorkQueueKind;
}[];

export const DUE_WORK_TRACK_SOURCE_COLUMNS = [
  "trackId",
  "artistsJson",
  "certified",
  "logId",
  "findingAddedAt",
  "durationMs",
  "captureStatus",
  "sourceAudioKey",
  "sourceAudioFailures",
  "sourceAudioAttemptedAt",
  "capturePriority",
  "demandScore",
  "dismissedAt",
  "hasEmbedding",
  "analyzedAt",
  "analyzedFrom",
  "hasIsrc",
  "spotifyUri",
  "spotifyAnchorAttemptedAt",
  "spotifyAnchorAttempts",
  "labelSeedState",
  "duplicateOfTrackId",
  "isrcRecoveryAttemptedAt",
  "youtubeVideoId",
  "sourceVerification",
  "youtubeProvenanceFailures",
  "youtubeVerifiedAt",
  "youtubeVideoOfficial",
  "nearestFindingScore",
] as const;

/** Columns carried to a worker but not used to select or order a queue. */
export const DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS = ["isrc", "title"] as const;

export type DueWorkTrackSourceColumn =
  | (typeof DUE_WORK_TRACK_SOURCE_COLUMNS)[number]
  | (typeof DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS)[number];

/**
 * One bounded, pre-joined source snapshot. `certified` is the finding-row existence test and
 * `labelSeedState` is the already-resolved label ruling; neither requires evaluator DB access.
 */
export type DueWorkTrackSource = {
  analyzedAt: string | null;
  analyzedFrom: "full" | "preview" | null;
  artistsJson: string;
  capturePriority: number | null;
  captureStatus: string | null;
  certified: boolean;
  demandScore: number | null;
  dismissedAt: string | null;
  durationMs: number | null;
  findingAddedAt: string | null;
  hasEmbedding: boolean;
  hasIsrc: boolean;
  isrc: string | null;
  isrcRecoveryAttemptedAt: string | null;
  labelSeedState: "disabled" | "enabled" | "undecided" | null;
  logId: string | null;
  nearestFindingScore: number | null;
  sourceAudioAttemptedAt: string | null;
  sourceAudioFailures: number | null;
  sourceAudioKey: string | null;
  sourceVerification: string | null;
  spotifyAnchorAttemptedAt: string | null;
  spotifyAnchorAttempts: number | null;
  spotifyUri: string | null;
  title: string;
  trackId: string;
  youtubeProvenanceFailures: number | null;
  youtubeVerifiedAt: string | null;
  youtubeVideoId: string | null;
  youtubeVideoOfficial: boolean | null;
  duplicateOfTrackId: string | null;
};

type AssertNever<Value extends never> = Value;
type _EverySourcePropertyIsInventoried = AssertNever<
  Exclude<keyof DueWorkTrackSource, DueWorkTrackSourceColumn>
>;
type _EveryInventoriedColumnExistsOnSource = AssertNever<
  Exclude<DueWorkTrackSourceColumn, keyof DueWorkTrackSource>
>;

export const CAPTURE_FAILED_COOLDOWN_MS = 60 * 60 * 1000;
export const CAPTURE_MAX_FAILURES = 8;
export const MIN_TRACK_MS = 60_000;
export const ANCHOR_REASK_AFTER_DAYS = 14;
export const ANCHOR_MAX_ATTEMPTS = 6;
export const ISRC_RECOVERY_REASK_AFTER_DAYS = 21;
export const YOUTUBE_PROVENANCE_REASK_AFTER_DAYS = 90;
export const YOUTUBE_PROVENANCE_MAX_FAILURES = 5;

const UNANCHORABLE_ARTISTS_JSON = new Set(
  ["Unknown Artist", "Various Artists", "VA", "Unknown", "[unknown]", "traditional"].map((artist) =>
    JSON.stringify([artist]).toLowerCase(),
  ),
);

export type DueWorkTrackRow = {
  kind: DueWorkKind;
  nextDueAt: string;
  orderKey: string;
  scope: DueWorkScope;
  source: DueWorkTrackSource;
  sourceVersion: string;
  trackId: string;
  usesCatalogueCaptureBudget: boolean;
  workKind: DueWorkQueueKind;
};

export type DueWorkEvaluationOptions = {
  /** The evaluator never reads the clock; callers freeze this for a reproducible snapshot. */
  now: Date | string;
  sources: readonly DueWorkTrackSource[];
};

function nowIso(now: Date | string): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Due-work evaluation requires a valid now timestamp");
  }
  return date.toISOString();
}

function addMilliseconds(iso: string, milliseconds: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    throw new RangeError("Due-work source timestamps must be valid ISO timestamps");
  }
  return new Date(time + milliseconds).toISOString();
}

function scheduledAt(attemptedAt: string | null, delayMs: number, now: string): string {
  // Every legacy timestamp window uses `attempted_at < cutoff`, not `<=`. ISO timestamps are
  // millisecond-precision, so equality remains ineligible until the following millisecond.
  return attemptedAt === null ? now : addMilliseconds(attemptedAt, delayMs + 1);
}

function scopeFor(source: DueWorkTrackSource): DueWorkScope {
  return source.certified ? "findings" : "catalogue";
}

function queueKind(kind: DueWorkKind, scope: DueWorkScope): DueWorkQueueKind {
  const found = DUE_WORK_TRACK_WORK_KIND_INVENTORY.find(
    (entry) => entry.kind === kind && entry.scope === scope,
  );
  if (found !== undefined) {
    return found.workKind;
  }
  throw new RangeError(`No due-work queue inventory entry for ${kind}/${scope}`);
}

function usesCatalogueCaptureBudget(workKind: DueWorkQueueKind): boolean {
  const found = DUE_WORK_TRACK_WORK_KIND_INVENTORY.find((entry) => entry.workKind === workKind);
  if (found !== undefined) {
    return found.usesCatalogueCaptureBudget;
  }
  throw new RangeError(`No due-work queue inventory entry for ${workKind}`);
}

function sharedOrder(source: DueWorkTrackSource): string {
  const components: DueWorkOrderComponent[] = [
    { direction: "desc", kind: "number", value: source.capturePriority ?? 0 },
    { direction: "desc", kind: "number", value: source.demandScore ?? 0 },
    { direction: "desc", kind: "text", value: source.findingAddedAt ?? "" },
    { direction: "desc", kind: "text", value: source.trackId },
  ];
  return encodeDueWorkOrder(components);
}

function anchorOrder(source: DueWorkTrackSource): string {
  return encodeDueWorkOrder([
    { direction: "desc", kind: "boolean", value: source.hasIsrc },
    { direction: "desc", kind: "boolean", value: source.hasEmbedding },
    { direction: "desc", kind: "boolean", value: source.nearestFindingScore !== null },
    { direction: "desc", kind: "number", value: source.nearestFindingScore ?? 0 },
    { direction: "desc", kind: "text", value: source.trackId },
  ]);
}

function reverdictOrder(source: DueWorkTrackSource): string {
  return encodeDueWorkOrder([
    { direction: "asc", kind: "timestamp", nulls: "first", value: source.youtubeVerifiedAt },
    { direction: "asc", kind: "text", value: source.trackId },
  ]);
}

/** A stable FNV-1a token over the explicit source-column contract. */
export function dueWorkTrackSourceVersion(source: DueWorkTrackSource): string {
  let hash = 0xcbf29ce484222325n;
  const input = [...DUE_WORK_TRACK_SOURCE_COLUMNS, ...DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS]
    .map((column) => `${column}:${JSON.stringify(source[column])}`)
    .join("\u001f");
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `dw1-${hash.toString(16).padStart(16, "0")}`;
}

function isAnchorableArtist(source: DueWorkTrackSource): boolean {
  return !UNANCHORABLE_ARTISTS_JSON.has(source.artistsJson.toLowerCase());
}

function isEnabledForLabelSpend(source: DueWorkTrackSource): boolean {
  return source.labelSeedState !== "disabled";
}

function isCaptureEligible(source: DueWorkTrackSource, now: string): string | undefined {
  const status = source.captureStatus;
  if (status === null || status === "pending" || status === "wrong-audio") {
    return now;
  }
  const failures = source.sourceAudioFailures;
  if (failures === null || failures >= CAPTURE_MAX_FAILURES) {
    return undefined;
  }
  if (status === "failed") {
    return scheduledAt(source.sourceAudioAttemptedAt, CAPTURE_FAILED_COOLDOWN_MS, now);
  }
  if (status === "duplicate-cleared" && source.sourceAudioKey === null) {
    return scheduledAt(source.sourceAudioAttemptedAt, CAPTURE_FAILED_COOLDOWN_MS, now);
  }
  return undefined;
}

function canCapture(source: DueWorkTrackSource): boolean {
  if (source.certified) {
    return source.logId !== null;
  }
  return (
    source.capturePriority !== null &&
    source.capturePriority >= 0 &&
    source.dismissedAt === null &&
    source.durationMs !== null &&
    source.durationMs >= MIN_TRACK_MS &&
    source.durationMs < LONG_FORM_MS
  );
}

function isIsrcRecoveryEligible(source: DueWorkTrackSource): boolean {
  return (
    source.spotifyUri === null &&
    !source.hasIsrc &&
    source.spotifyAnchorAttemptedAt === null &&
    source.durationMs !== null &&
    source.durationMs > 0 &&
    source.dismissedAt === null &&
    source.duplicateOfTrackId === null &&
    isEnabledForLabelSpend(source)
  );
}

function isAnchorEligible(source: DueWorkTrackSource): boolean {
  return (
    source.spotifyUri === null &&
    source.durationMs !== null &&
    source.durationMs > 0 &&
    source.dismissedAt === null &&
    source.duplicateOfTrackId === null &&
    (source.spotifyAnchorAttempts ?? 0) < ANCHOR_MAX_ATTEMPTS &&
    isAnchorableArtist(source) &&
    isEnabledForLabelSpend(source)
  );
}

function eligibleAt(
  kind: DueWorkKind,
  source: DueWorkTrackSource,
  now: string,
): string | undefined {
  if (kind === "capture") {
    return canCapture(source) ? isCaptureEligible(source, now) : undefined;
  }
  if (kind === "analyze") {
    return source.sourceAudioKey !== null &&
      source.captureStatus !== null &&
      source.captureStatus !== "wrong-audio" &&
      (source.analyzedAt === null || source.analyzedFrom !== "full")
      ? now
      : undefined;
  }
  if (kind === "embed") {
    return source.sourceAudioKey !== null &&
      !source.hasEmbedding &&
      source.captureStatus !== null &&
      source.captureStatus !== "wrong-audio"
      ? now
      : undefined;
  }
  if (kind === "youtube-provenance") {
    if (
      source.sourceAudioKey === null ||
      source.youtubeVideoId !== null ||
      source.sourceVerification !== null ||
      source.captureStatus === "wrong-audio" ||
      (source.youtubeProvenanceFailures ?? 0) >= YOUTUBE_PROVENANCE_MAX_FAILURES
    ) {
      return undefined;
    }
    return scheduledAt(
      source.youtubeVerifiedAt,
      YOUTUBE_PROVENANCE_REASK_AFTER_DAYS * 86_400_000,
      now,
    );
  }
  if (kind === "youtube-reverdict") {
    return source.youtubeVideoId !== null && source.youtubeVideoOfficial !== true ? now : undefined;
  }
  if (!source.certified && kind === "isrc-recovery") {
    if (!isIsrcRecoveryEligible(source)) {
      return undefined;
    }
    return scheduledAt(
      source.isrcRecoveryAttemptedAt,
      ISRC_RECOVERY_REASK_AFTER_DAYS * 86_400_000,
      now,
    );
  }
  if (!source.certified && kind === "anchor") {
    if (!isAnchorEligible(source)) {
      return undefined;
    }
    return scheduledAt(source.spotifyAnchorAttemptedAt, ANCHOR_REASK_AFTER_DAYS * 86_400_000, now);
  }
  return undefined;
}

function orderFor(kind: DueWorkKind, source: DueWorkTrackSource): string {
  if (kind === "anchor" || kind === "isrc-recovery") {
    return anchorOrder(source);
  }
  return kind === "youtube-reverdict" ? reverdictOrder(source) : sharedOrder(source);
}

function compareRows(left: DueWorkTrackRow, right: DueWorkTrackRow): number {
  if (left.orderKey < right.orderKey) {
    return -1;
  }
  if (left.orderKey > right.orderKey) {
    return 1;
  }
  return left.trackId.localeCompare(right.trackId);
}

/**
 * Evaluate exactly one legacy queue over a bounded source snapshot. Scheduled rows remain present
 * until their `nextDueAt`, while terminal vetoes and retry caps yield no row at all.
 */
export function evaluateDueWorkQueue(
  options: DueWorkEvaluationOptions & { kind: DueWorkKind; scope?: DueWorkScope },
): DueWorkTrackRow[] {
  const now = nowIso(options.now);
  const rows: DueWorkTrackRow[] = [];
  const scopes: readonly DueWorkScope[] = options.scope
    ? [options.scope]
    : ["findings", "catalogue"];
  for (const scope of scopes) {
    for (const source of options.sources) {
      if (scopeFor(source) !== scope) {
        continue;
      }
      const nextDueAt = eligibleAt(options.kind, source, now);
      if (nextDueAt === undefined) {
        continue;
      }
      rows.push({
        kind: options.kind,
        nextDueAt,
        orderKey: orderFor(options.kind, source),
        scope,
        source,
        sourceVersion: dueWorkTrackSourceVersion(source),
        trackId: source.trackId,
        usesCatalogueCaptureBudget: usesCatalogueCaptureBudget(queueKind(options.kind, scope)),
        workKind: queueKind(options.kind, scope),
      });
    }
    // Legacy `listTrackWork({scope:"all"})` concatenates findings before catalogue rather than
    // sorting a joined result on certification. Preserve that outer ordering exactly.
    if (options.scope === undefined && scope === "findings") {
      rows.sort(compareRows);
    }
  }
  // The legacy re-verdict selector is one specialist read over both certification halves, ordered
  // only by the verdict timestamp and track id. Unlike the shared ladder, it does not put findings
  // ahead of catalogue rows, so the two physical projections must merge into one global order.
  if (options.scope === undefined && options.kind === "youtube-reverdict") {
    return rows.sort(compareRows);
  }
  if (options.scope !== undefined) {
    rows.sort(compareRows);
  } else {
    const findingCount = rows.findIndex((row) => row.scope === "catalogue");
    if (findingCount >= 0) {
      const findings = rows.slice(0, findingCount).sort(compareRows);
      const catalogue = rows.slice(findingCount).sort(compareRows);
      return [...findings, ...catalogue];
    }
    rows.sort(compareRows);
  }
  return rows;
}

/** Evaluate every recurring queue; use `evaluateDueWorkQueue` where legacy per-kind order matters. */
export function evaluateDueWork(options: DueWorkEvaluationOptions): DueWorkTrackRow[] {
  const kinds: readonly DueWorkKind[] = [
    "analyze",
    "anchor",
    "capture",
    "embed",
    "isrc-recovery",
    "youtube-provenance",
    "youtube-reverdict",
  ];
  return kinds.flatMap((kind) => evaluateDueWorkQueue({ ...options, kind }));
}
