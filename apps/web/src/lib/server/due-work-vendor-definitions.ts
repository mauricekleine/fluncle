import { encodeDueWorkOrder } from "./due-work-order";

/** Physical due-work kinds for the remaining track selectors. */
export type DueWorkVendorKind =
  | "apple-catalogue"
  | "apple-finding"
  | "artist-credits"
  | "artist-edges"
  | "beatport-catalogue"
  | "beatport-finding"
  | "capture-verification"
  | "catalogue-rank"
  | "deezer-catalogue"
  | "deezer-finding"
  | "discogs-track"
  | "lastfm-track"
  | "mbid-isrc-lookup"
  | "mbid-isrc-refresh"
  | "mbid-prefix-strip";

/** The source-table columns (and pre-joined findings facts) each evaluator may inspect. */
export const DUE_WORK_VENDOR_SOURCE_COLUMNS = [
  "addedToSpotify",
  "appleMusicAttemptedAt",
  "appleMusicDoneAt",
  "appleMusicFailures",
  "appleMusicUrl",
  "artistCreditsBackfilledAt",
  "artistEdgesBackfilledAt",
  "artists",
  "beatportAttemptedAt",
  "beatportDoneAt",
  "beatportFailures",
  "beatportUrl",
  "capturePriority",
  "captureStatus",
  "captureVerification",
  "catalogueRankCorpus",
  "certified",
  "deezerAttemptedAt",
  "deezerFailures",
  "deezerTrackId",
  "discogsAttemptedAt",
  "discogsDoneAt",
  "discogsFailures",
  "discogsReleaseUrl",
  "dismissedAt",
  "durationMs",
  "findingAddedAt",
  "hasArtistEdge",
  "hasEmbedding",
  "isCatalogue",
  "isrc",
  "isrcAttemptedAt",
  "lastfmAttemptedAt",
  "lastfmDoneAt",
  "lastfmFailures",
  "mbRecordingId",
  "mbRecordingIdAttemptedAt",
  "postedToTelegram",
  "sourceAudioKey",
  "title",
  "trackId",
] as const;

export const DUE_WORK_VENDOR_WORK_KIND_INVENTORY = [
  { family: "catalogue", workKind: "catalogue-rank" },
  { family: "capture", workKind: "capture-verification" },
  { family: "recording-mbid", workKind: "mbid-prefix-strip" },
  { family: "recording-mbid", workKind: "mbid-isrc-lookup" },
  { family: "recording-mbid", workKind: "mbid-isrc-refresh" },
  { family: "discogs", scope: "findings", workKind: "discogs-track" },
  { family: "lastfm", scope: "findings", workKind: "lastfm-track" },
  { family: "apple", scope: "findings", workKind: "apple-finding" },
  { family: "apple", scope: "catalogue", workKind: "apple-catalogue" },
  { family: "beatport", scope: "findings", workKind: "beatport-finding" },
  { family: "beatport", scope: "catalogue", workKind: "beatport-catalogue" },
  { family: "deezer", scope: "findings", workKind: "deezer-finding" },
  { family: "deezer", scope: "catalogue", workKind: "deezer-catalogue" },
  { family: "artist", workKind: "artist-credits" },
  { family: "artist", workKind: "artist-edges" },
] as const satisfies readonly {
  family: string;
  scope?: "catalogue" | "findings";
  workKind: DueWorkVendorKind;
}[];

/** One pre-joined track snapshot. Evaluators never read a database or clock. */
export type DueWorkVendorSource = {
  addedToSpotify: boolean;
  appleMusicAttemptedAt: string | null;
  appleMusicDoneAt: string | null;
  appleMusicFailures: number | null;
  appleMusicUrl: string | null;
  artistCreditsBackfilledAt: string | null;
  artistEdgesBackfilledAt: string | null;
  artists: readonly string[];
  beatportAttemptedAt: string | null;
  beatportDoneAt: string | null;
  beatportFailures: number | null;
  beatportUrl: string | null;
  capturePriority: number | null;
  captureStatus: string | null;
  captureVerification: string | null;
  catalogueRankCorpus: string | null;
  certified: boolean;
  deezerAttemptedAt: string | null;
  deezerFailures: number | null;
  deezerTrackId: string | null;
  discogsAttemptedAt: string | null;
  discogsDoneAt: string | null;
  discogsFailures: number | null;
  discogsReleaseUrl: string | null;
  dismissedAt: string | null;
  durationMs: number | null;
  findingAddedAt: string | null;
  hasArtistEdge: boolean;
  hasEmbedding: boolean;
  isCatalogue: boolean;
  isrc: string | null;
  isrcAttemptedAt: string | null;
  lastfmAttemptedAt: string | null;
  lastfmDoneAt: string | null;
  lastfmFailures: number | null;
  mbRecordingId: string | null;
  mbRecordingIdAttemptedAt: string | null;
  postedToTelegram: boolean;
  sourceAudioKey: string | null;
  title: string;
  trackId: string;
};

type AssertNever<Value extends never> = Value;
type _EverySourcePropertyIsInventoried = AssertNever<
  Exclude<keyof DueWorkVendorSource, (typeof DUE_WORK_VENDOR_SOURCE_COLUMNS)[number]>
>;
type _EveryInventoriedColumnExistsOnSource = AssertNever<
  Exclude<(typeof DUE_WORK_VENDOR_SOURCE_COLUMNS)[number], keyof DueWorkVendorSource>
>;

export const VENDOR_COOLDOWN_BASE_MS = 24 * 60 * 60 * 1000;
export const VENDOR_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const MBID_ISRC_REFRESH_AFTER_MS = 21 * 24 * 60 * 60 * 1000;
export const DEEZER_MAX_FAILURES = 3;
export const WRONG_AUDIO_STATUS = "wrong-audio";

export type DueWorkVendorRow = {
  nextDueAt: string;
  orderKey: string;
  source: DueWorkVendorSource;
  sourceVersion: string;
  trackId: string;
  workKind: DueWorkVendorKind;
};

export type DueWorkVendorEvaluationOptions = {
  /** The currently-derived ranking corpus; required by the catalogue-rank evaluator. */
  rankCorpus?: string;
  /** Freeze time at the caller so a source snapshot always evaluates reproducibly. */
  now: Date | string;
  sources: readonly DueWorkVendorSource[];
};

function nowIso(now: Date | string): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Due-work evaluation requires a valid now timestamp");
  }
  return date.toISOString();
}

function timestampAfter(timestamp: string, milliseconds: number): string | undefined {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? new Date(time + milliseconds).toISOString() : undefined;
}

function cooldownMs(failures: number | null): number {
  const count = failures ?? 0;
  if (count <= 0) {
    return VENDOR_COOLDOWN_BASE_MS;
  }
  return Math.min(VENDOR_COOLDOWN_BASE_MS * 2 ** Math.min(count, 10), VENDOR_COOLDOWN_MAX_MS);
}

function reliabilityDueAt(
  attemptedAt: string | null,
  doneAt: string | null,
  failures: number | null,
  now: string,
): string | undefined {
  if (doneAt !== null) {
    return undefined;
  }
  if (attemptedAt === null) {
    return now;
  }
  // Legacy `shouldSkip` deliberately treats a malformed old stamp as eligible, so a clean write
  // heals it instead of wedging that row forever.
  return timestampAfter(attemptedAt, cooldownMs(failures)) ?? now;
}

function isPublishedFinding(source: DueWorkVendorSource): boolean {
  return source.certified && source.addedToSpotify && source.postedToTelegram;
}

function hasIsrc(source: DueWorkVendorSource): boolean {
  return source.isrc?.trim() !== "" && source.isrc !== null;
}

/** `listIsrcWork` preserves the legacy `isrc != ''` spelling: whitespace remains a candidate. */
function hasLookupIsrc(source: DueWorkVendorSource): boolean {
  return source.isrc !== null && source.isrc !== "";
}

function catalogueOrder(source: DueWorkVendorSource): string {
  return encodeDueWorkOrder([
    { direction: "desc", kind: "boolean", value: source.capturePriority !== null },
    { direction: "desc", kind: "number", value: source.capturePriority ?? 0 },
    { direction: "desc", kind: "text", value: source.trackId },
  ]);
}

function findingOrder(
  source: DueWorkVendorSource,
  trackIdDirection: "asc" | "desc" = "desc",
): string {
  return encodeDueWorkOrder([
    { direction: "desc", kind: "timestamp", nulls: "last", value: source.findingAddedAt },
    { direction: trackIdDirection, kind: "text", value: source.trackId },
  ]);
}

function idOrder(source: DueWorkVendorSource): string {
  return encodeDueWorkOrder([{ direction: "asc", kind: "text", value: source.trackId }]);
}

export function dueWorkVendorSourceVersion(
  source: DueWorkVendorSource,
  kind: DueWorkVendorKind,
  rankCorpus?: string,
): string {
  let hash = 0xcbf29ce484222325n;
  const input = [
    `kind:${kind}`,
    ...DUE_WORK_VENDOR_SOURCE_COLUMNS.map(
      (column) => `${column}:${JSON.stringify(source[column])}`,
    ),
    ...(kind === "catalogue-rank" ? [`rankCorpus:${rankCorpus ?? ""}`] : []),
  ].join("\u001f");
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `dw1-${hash.toString(16).padStart(16, "0")}`;
}

function dueAt(
  kind: DueWorkVendorKind,
  source: DueWorkVendorSource,
  now: string,
  rankCorpus?: string,
): string | undefined {
  switch (kind) {
    case "catalogue-rank":
      if (rankCorpus === undefined) {
        throw new RangeError("catalogue-rank evaluation requires rankCorpus");
      }
      return !source.isCatalogue ||
        source.dismissedAt !== null ||
        (source.catalogueRankCorpus !== null &&
          source.catalogueRankCorpus === rankCorpus &&
          !(source.hasEmbedding && source.capturePriority !== null && source.capturePriority >= 0))
        ? undefined
        : now;
    case "capture-verification":
      return source.sourceAudioKey !== null &&
        source.captureVerification === null &&
        source.captureStatus !== WRONG_AUDIO_STATUS
        ? now
        : undefined;
    case "mbid-prefix-strip":
      return source.mbRecordingId === null &&
        source.mbRecordingIdAttemptedAt === null &&
        source.trackId.startsWith("mb_")
        ? now
        : undefined;
    case "mbid-isrc-lookup":
      return source.mbRecordingId === null &&
        source.mbRecordingIdAttemptedAt === null &&
        !source.trackId.startsWith("mb_") &&
        hasLookupIsrc(source)
        ? now
        : undefined;
    case "mbid-isrc-refresh":
      if (source.mbRecordingId === null || hasIsrc(source)) {
        return undefined;
      }
      return source.isrcAttemptedAt === null
        ? now
        : (timestampAfter(source.isrcAttemptedAt, MBID_ISRC_REFRESH_AFTER_MS + 1) ?? now);
    case "discogs-track":
      return isPublishedFinding(source) &&
        source.discogsReleaseUrl === null &&
        Boolean(source.artists[0]?.trim()) &&
        Boolean(source.title.trim())
        ? reliabilityDueAt(
            source.discogsAttemptedAt,
            source.discogsDoneAt,
            source.discogsFailures,
            now,
          )
        : undefined;
    case "lastfm-track": {
      const artist = source.artists[0] ?? source.artists.join(", ");
      return isPublishedFinding(source) && Boolean(artist) && Boolean(source.title.trim())
        ? reliabilityDueAt(
            source.lastfmAttemptedAt,
            source.lastfmDoneAt,
            source.lastfmFailures,
            now,
          )
        : undefined;
    }
    default:
      return remainingDueAt(kind, source, now);
  }
}

function remainingDueAt(
  kind: DueWorkVendorKind,
  source: DueWorkVendorSource,
  now: string,
): string | undefined {
  switch (kind) {
    case "apple-finding":
      return isPublishedFinding(source) && source.appleMusicUrl === null && hasIsrc(source)
        ? reliabilityDueAt(
            source.appleMusicAttemptedAt,
            source.appleMusicDoneAt,
            source.appleMusicFailures,
            now,
          )
        : undefined;
    case "apple-catalogue":
      return source.isCatalogue &&
        !source.certified &&
        source.appleMusicUrl === null &&
        hasIsrc(source)
        ? reliabilityDueAt(
            source.appleMusicAttemptedAt,
            source.appleMusicDoneAt,
            source.appleMusicFailures,
            now,
          )
        : undefined;
    case "beatport-finding":
      return isPublishedFinding(source) && hasIsrc(source)
        ? reliabilityDueAt(
            source.beatportAttemptedAt,
            source.beatportDoneAt,
            source.beatportFailures,
            now,
          )
        : undefined;
    case "beatport-catalogue":
      if (
        source.isCatalogue &&
        !source.certified &&
        source.beatportUrl === null &&
        hasIsrc(source) &&
        source.beatportDoneAt === null
      ) {
        if (source.beatportAttemptedAt === null) {
          return now;
        }
        return (source.beatportFailures ?? 0) > 0
          ? reliabilityDueAt(source.beatportAttemptedAt, null, source.beatportFailures, now)
          : undefined;
      }
      return undefined;
    case "deezer-finding":
    case "deezer-catalogue": {
      const scopeMatches =
        kind === "deezer-finding" ? source.certified : source.isCatalogue && !source.certified;
      return scopeMatches &&
        source.deezerTrackId === null &&
        source.deezerAttemptedAt === null &&
        (source.deezerFailures ?? 0) < DEEZER_MAX_FAILURES &&
        hasIsrc(source) &&
        source.durationMs !== null &&
        source.durationMs > 0
        ? now
        : undefined;
    }
    case "artist-credits":
      return !source.hasArtistEdge &&
        source.artistEdgesBackfilledAt !== null &&
        source.artistCreditsBackfilledAt === null
        ? now
        : undefined;
    case "artist-edges":
      return !source.hasArtistEdge && source.artistEdgesBackfilledAt === null ? now : undefined;
    default:
      return undefined;
  }
}

function orderFor(kind: DueWorkVendorKind, source: DueWorkVendorSource): string {
  switch (kind) {
    case "apple-finding":
    case "beatport-finding":
    case "discogs-track":
    case "lastfm-track":
      return findingOrder(source);
    case "deezer-finding":
      return findingOrder(source, "asc");
    case "apple-catalogue":
    case "beatport-catalogue":
    case "deezer-catalogue":
      return catalogueOrder(source);
    case "mbid-isrc-refresh":
      return encodeDueWorkOrder([
        { direction: "asc", kind: "timestamp", nulls: "first", value: source.isrcAttemptedAt },
        { direction: "asc", kind: "text", value: source.trackId },
      ]);
    default:
      return idOrder(source);
  }
}

/** Evaluate one legacy selector over a stable, caller-supplied source snapshot. */
export function evaluateDueWorkVendorQueue(
  options: DueWorkVendorEvaluationOptions & { kind: DueWorkVendorKind },
): DueWorkVendorRow[] {
  const now = nowIso(options.now);
  return options.sources
    .flatMap((source) => {
      const nextDueAt = dueAt(options.kind, source, now, options.rankCorpus);
      return nextDueAt === undefined
        ? []
        : [
            {
              nextDueAt,
              orderKey: orderFor(options.kind, source),
              source,
              sourceVersion: dueWorkVendorSourceVersion(source, options.kind, options.rankCorpus),
              trackId: source.trackId,
              workKind: options.kind,
            },
          ];
    })
    .sort(
      (left, right) =>
        left.orderKey.localeCompare(right.orderKey) || left.trackId.localeCompare(right.trackId),
    );
}

/** Evaluate every remaining selector; physical finding/catalogue legs intentionally stay separate. */
export function evaluateDueWorkVendor(options: DueWorkVendorEvaluationOptions): DueWorkVendorRow[] {
  return DUE_WORK_VENDOR_WORK_KIND_INVENTORY.flatMap((entry) =>
    evaluateDueWorkVendorQueue({ ...options, kind: entry.workKind }),
  );
}
