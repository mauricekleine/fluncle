// The DEFINITION version of every `due_work` family: track queues, vendor queues, and the finding
// and entity queues. The crawl frontier family owns the same mechanism inside `crawl-due-work.ts`,
// because its projector lives there; `due-work-definition-fingerprint.ts` holds the shared probe
// harness and states why a definition version exists at all.
//
// `due-work-definition-version.test.ts` pins each family's value, so a definition edit fails the
// build until the fixture is updated too — which is the point at which a reviewer sees that the
// deploy will re-project that queue.

import {
  definitionFingerprint,
  memoizedDefinitionVersion,
  memoizedProbeMatrix,
  probeAnswer,
  probeLadderCrossing,
  probeMatrix,
  PROBE_BEFORE,
  PROBE_NOW,
} from "./due-work-definition-fingerprint";
import {
  BIO_INDEX_FLOOR,
  DUE_WORK_KINDS,
  DUE_WORK_SOURCE_COLUMNS,
  evaluateAlbumBio,
  evaluateAlbumCoverMaster,
  evaluateArtistBio,
  evaluateArtistCoverMaster,
  evaluateArtistImage,
  evaluateFindingContextNormal,
  evaluateFindingContextRetryEmpty,
  evaluateFindingEnrich,
  evaluateFindingNote,
  evaluateFindingObserve,
  evaluateFindingRenderNormal,
  evaluateFindingRenderRequiresObservation,
  evaluateLabelBio,
  evaluateLabelImage,
  type DueWorkKind as DueWorkEntityKind,
  type DueWorkRow as DueWorkEntityRow,
} from "./due-work-entity-definitions";
import {
  ANCHOR_MAX_ATTEMPTS,
  CAPTURE_MAX_FAILURES,
  describeDueWorkTrackDecision,
  DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS,
  DUE_WORK_TRACK_SOURCE_COLUMNS,
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  LONG_FORM_MS,
  MIN_TRACK_MS,
  YOUTUBE_PROVENANCE_MAX_FAILURES,
  type DueWorkQueueKind,
  type DueWorkTrackSource,
} from "./due-work-track-definitions";
import {
  DEEZER_MAX_FAILURES,
  describeDueWorkVendorDecision,
  DUE_WORK_VENDOR_SOURCE_COLUMNS,
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY,
  type DueWorkVendorKind,
  type DueWorkVendorSource,
} from "./due-work-vendor-definitions";

const PROBE_RANK_CORPUS = "rank-corpus-probe";

/**
 * Every constant these evaluators COMPARE a source value against. The ladder straddles each one, so
 * retuning any of them moves a probe answer and therefore that family's version. A constant that is
 * ADDED to a timestamp is deliberately absent: it reaches the transcript through the `nextDueAt` it
 * computes, and what it needs instead is a base that carries the companion stamp.
 * `due-work-definition-version.test.ts` holds both halves of that contract and fails when a new
 * exported constant joins either module without being classified.
 */
export const DUE_WORK_PROBE_THRESHOLDS: readonly number[] = [
  ANCHOR_MAX_ATTEMPTS,
  BIO_INDEX_FLOOR,
  CAPTURE_MAX_FAILURES,
  DEEZER_MAX_FAILURES,
  LONG_FORM_MS,
  MIN_TRACK_MS,
  YOUTUBE_PROVENANCE_MAX_FAILURES,
];

/** The shared ladder for the three `due_work` source shapes. */
export const DUE_WORK_PROBE_LADDER = probeLadderCrossing(DUE_WORK_PROBE_THRESHOLDS);

const TRACK_PROBE_COLUMNS = [
  ...DUE_WORK_TRACK_SOURCE_COLUMNS,
  ...DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS,
] as const;

/**
 * A catalogue row before any audio is bought: eligible for the metered capture queue and for both
 * identity queues, which is where the ordering that meters spend is decided.
 */
const TRACK_PROBE_CATALOGUE_PRE_CAPTURE: DueWorkTrackSource = {
  analyzedAt: null,
  analyzedFrom: null,
  artistsJson: '["Probe Artist"]',
  capturePriority: 3,
  captureStatus: "pending",
  certified: false,
  demandScore: 2,
  dismissedAt: null,
  duplicateOfTrackId: null,
  durationMs: 300_000,
  findingAddedAt: null,
  hasEmbedding: false,
  hasIsrc: false,
  isrc: null,
  isrcRecoveryAttemptedAt: null,
  labelSeedState: "enabled",
  logId: null,
  nearestFindingScore: 0.5,
  sourceAudioAttemptedAt: null,
  sourceAudioFailures: 0,
  sourceAudioKey: null,
  sourceVerification: null,
  spotifyAnchorAttemptedAt: null,
  spotifyAnchorAttempts: 0,
  spotifyUri: null,
  title: "Probe Title",
  trackId: "probe-track",
  youtubeProvenanceFailures: 0,
  youtubeVerifiedAt: null,
  youtubeVideoId: null,
  youtubeVideoOfficial: null,
};

/** The same row once its audio is held: the analyze, embed, and provenance queues open here. */
const TRACK_PROBE_CATALOGUE_CAPTURED: DueWorkTrackSource = {
  ...TRACK_PROBE_CATALOGUE_PRE_CAPTURE,
  captureStatus: "complete",
  sourceAudioKey: "probe/audio.mp3",
  youtubeVideoId: "probe-video",
  youtubeVideoOfficial: false,
};

/** A certified row: the findings half of every scoped queue. */
const TRACK_PROBE_FINDING_PRE_CAPTURE: DueWorkTrackSource = {
  ...TRACK_PROBE_CATALOGUE_PRE_CAPTURE,
  certified: true,
  findingAddedAt: PROBE_BEFORE,
  logId: "001.A.01",
};

const TRACK_PROBE_FINDING_CAPTURED: DueWorkTrackSource = {
  ...TRACK_PROBE_FINDING_PRE_CAPTURE,
  captureStatus: "complete",
  sourceAudioKey: "probe/audio.mp3",
  youtubeVideoId: "probe-video",
  youtubeVideoOfficial: false,
};

/**
 * A catalogue row mid-retry. `isCaptureEligible`'s `failed` branch reads the cooldown off
 * `sourceAudioAttemptedAt`, so the companion column has to be set on a BASE — varying
 * `captureStatus` alone off a base whose attempt stamp is null reaches the branch with nothing for
 * `CAPTURE_FAILED_COOLDOWN_MS` to act on, and the constant never enters a probe answer.
 */
const TRACK_PROBE_CATALOGUE_FAILED: DueWorkTrackSource = {
  ...TRACK_PROBE_CATALOGUE_PRE_CAPTURE,
  captureStatus: "failed",
  sourceAudioAttemptedAt: PROBE_BEFORE,
  sourceAudioFailures: 2,
  spotifyAnchorAttemptedAt: PROBE_BEFORE,
  spotifyAnchorAttempts: 2,
};

/** The other cooldown arm: a cleared duplicate with no audio key, same companion-column rule. */
const TRACK_PROBE_CATALOGUE_DUPLICATE_CLEARED: DueWorkTrackSource = {
  ...TRACK_PROBE_CATALOGUE_PRE_CAPTURE,
  captureStatus: "duplicate-cleared",
  isrcRecoveryAttemptedAt: PROBE_BEFORE,
  sourceAudioAttemptedAt: PROBE_BEFORE,
  sourceAudioFailures: 1,
  sourceAudioKey: null,
};

/** A captured row already carrying a provenance verdict, so its re-ask window is live. */
const TRACK_PROBE_CATALOGUE_VERDICTED: DueWorkTrackSource = {
  ...TRACK_PROBE_CATALOGUE_CAPTURED,
  youtubeProvenanceFailures: 2,
  youtubeVerifiedAt: PROBE_BEFORE,
  youtubeVideoId: null,
};

const TRACK_PROBE_BASES: readonly DueWorkTrackSource[] = [
  TRACK_PROBE_CATALOGUE_PRE_CAPTURE,
  TRACK_PROBE_CATALOGUE_CAPTURED,
  TRACK_PROBE_CATALOGUE_FAILED,
  TRACK_PROBE_CATALOGUE_DUPLICATE_CLEARED,
  TRACK_PROBE_CATALOGUE_VERDICTED,
  TRACK_PROBE_FINDING_PRE_CAPTURE,
  TRACK_PROBE_FINDING_CAPTURED,
];

const VENDOR_PROBE_CATALOGUE: DueWorkVendorSource = {
  addedToSpotify: false,
  appleMusicAttemptedAt: null,
  appleMusicDoneAt: null,
  appleMusicFailures: 0,
  appleMusicUrl: null,
  artistCreditsBackfilledAt: null,
  artistEdgesBackfilledAt: null,
  artists: ["Probe Artist"],
  beatportAttemptedAt: null,
  beatportDoneAt: null,
  beatportFailures: 0,
  beatportUrl: null,
  capturePriority: 3,
  captureStatus: "complete",
  captureVerification: null,
  catalogueRankCorpus: null,
  certified: false,
  deezerAttemptedAt: null,
  deezerFailures: 0,
  deezerTrackId: null,
  discogsAttemptedAt: null,
  discogsDoneAt: null,
  discogsFailures: 0,
  discogsReleaseUrl: null,
  dismissedAt: null,
  durationMs: 300_000,
  findingAddedAt: null,
  hasArtistEdge: false,
  hasEmbedding: false,
  isCatalogue: true,
  isrc: null,
  isrcAttemptedAt: null,
  lastfmAttemptedAt: null,
  lastfmDoneAt: null,
  lastfmFailures: 0,
  mbRecordingId: null,
  mbRecordingIdAttemptedAt: null,
  postedToTelegram: false,
  sourceAudioKey: "probe/audio.mp3",
  title: "Probe Title",
  trackId: "probe-track",
};

const VENDOR_PROBE_FINDING: DueWorkVendorSource = {
  ...VENDOR_PROBE_CATALOGUE,
  addedToSpotify: true,
  certified: true,
  findingAddedAt: PROBE_BEFORE,
  isCatalogue: false,
  isrc: "GB0000000001",
  mbRecordingId: "probe-recording",
  postedToTelegram: true,
};

/**
 * Every vendor leg mid-retry. `reliabilityDueAt` returns `now` while `*AttemptedAt` is null, so a
 * base with every attempt stamp unset makes `VENDOR_COOLDOWN_BASE_MS`, the `2 ** failures` ladder
 * and `VENDOR_COOLDOWN_MAX_MS` unreachable for discogs, lastfm, apple, beatport and deezer alike.
 * The failure counts straddle `DEEZER_MAX_FAILURES` and the cooldown's own `min(count, 10)` clamp.
 */
const VENDOR_PROBE_RETRYING: DueWorkVendorSource = {
  ...VENDOR_PROBE_FINDING,
  appleMusicAttemptedAt: PROBE_BEFORE,
  appleMusicFailures: 2,
  artistCreditsBackfilledAt: PROBE_BEFORE,
  beatportAttemptedAt: PROBE_BEFORE,
  beatportFailures: 4,
  deezerAttemptedAt: PROBE_BEFORE,
  deezerFailures: 2,
  discogsAttemptedAt: PROBE_BEFORE,
  discogsFailures: 11,
  isrcAttemptedAt: PROBE_BEFORE,
  lastfmAttemptedAt: PROBE_BEFORE,
  lastfmFailures: 0,
  mbRecordingIdAttemptedAt: PROBE_BEFORE,
};

/** The catalogue half of the same retry shape, for the `*-catalogue` legs' own scope test. */
const VENDOR_PROBE_CATALOGUE_RETRYING: DueWorkVendorSource = {
  ...VENDOR_PROBE_RETRYING,
  addedToSpotify: false,
  certified: false,
  findingAddedAt: null,
  isCatalogue: true,
  // No ISRC, so `mbid-isrc-refresh` is live and `MBID_ISRC_REFRESH_AFTER_MS` reaches a decision.
  isrc: null,
  postedToTelegram: false,
};

const VENDOR_PROBE_BASES: readonly DueWorkVendorSource[] = [
  VENDOR_PROBE_CATALOGUE,
  VENDOR_PROBE_FINDING,
  VENDOR_PROBE_RETRYING,
  VENDOR_PROBE_CATALOGUE_RETRYING,
];

const ENTITY_EVALUATORS: Record<
  DueWorkEntityKind,
  (source: never, now: string) => DueWorkEntityRow | null
> = {
  "album.bio": evaluateAlbumBio,
  "album.cover-master": evaluateAlbumCoverMaster,
  "artist.bio": evaluateArtistBio,
  "artist.cover-master": evaluateArtistCoverMaster,
  "artist.image": evaluateArtistImage,
  "finding.context": evaluateFindingContextNormal,
  "finding.context.retry-empty": evaluateFindingContextRetryEmpty,
  "finding.enrich": evaluateFindingEnrich,
  "finding.note": evaluateFindingNote,
  "finding.observe": evaluateFindingObserve,
  "finding.render": evaluateFindingRenderNormal,
  "finding.render.requires-observation": evaluateFindingRenderRequiresObservation,
  "label.bio": evaluateLabelBio,
  "label.image": evaluateLabelImage,
};

const matrices = new Map<string, unknown>();

/** The probe matrix every track family shares; built once, because it is pure and large. */
export function trackProbeMatrix(): readonly DueWorkTrackSource[] {
  return memoizedProbeMatrix(matrices, "track", () =>
    probeMatrix(
      TRACK_PROBE_BASES as unknown as Record<string, unknown>[],
      TRACK_PROBE_COLUMNS,
      DUE_WORK_PROBE_LADDER,
    ),
  ) as unknown as DueWorkTrackSource[];
}

/** The probe matrix every vendor family shares. */
export function vendorProbeMatrix(): readonly DueWorkVendorSource[] {
  return memoizedProbeMatrix(matrices, "vendor", () =>
    probeMatrix(
      VENDOR_PROBE_BASES as unknown as Record<string, unknown>[],
      DUE_WORK_VENDOR_SOURCE_COLUMNS,
      DUE_WORK_PROBE_LADDER,
    ),
  ) as unknown as DueWorkVendorSource[];
}

function trackDefinitionVersion(workKind: DueWorkQueueKind): string {
  const entry = DUE_WORK_TRACK_WORK_KIND_INVENTORY.find((row) => row.workKind === workKind);
  if (entry === undefined) {
    throw new Error(`no due-work track inventory entry for ${workKind}`);
  }
  const probes = trackProbeMatrix();
  const transcript = probes.map((source, index) =>
    probeAnswer(() => {
      // A physical queue owns one certification half; the other half's probes are inert for it.
      const scope = source.certified === true ? "findings" : "catalogue";
      return scope === entry.scope
        ? `${index}:${describeDueWorkTrackDecision(entry.kind, source, PROBE_NOW)}`
        : `${index}:~`;
    }),
  );
  return definitionFingerprint(workKind, transcript);
}

function vendorDefinitionVersion(workKind: DueWorkVendorKind): string {
  const probes = vendorProbeMatrix();
  const transcript = probes.map((source, index) =>
    probeAnswer(
      () =>
        `${index}:${describeDueWorkVendorDecision(workKind, source, PROBE_NOW, PROBE_RANK_CORPUS)}`,
    ),
  );
  return definitionFingerprint(workKind, transcript);
}

/**
 * Per-kind base overrides. A generic "every column gets a string" base is ELIGIBLE FOR NOTHING —
 * `finding.render` needs `context_note` set and `video_url` null together, and the matrix moves one
 * column at a time, so neither probe alone reaches the branch. Each kind's base therefore starts
 * INSIDE its own queue, and the ladder probes it back out.
 */
const ENTITY_PROBE_BASE_OVERRIDES: Record<DueWorkEntityKind, Record<string, unknown>> = {
  "album.bio": { bio: null, certified_finding_count: 0, renderable_track_count: 5 },
  "album.cover-master": { image_state: "pending" },
  "artist.bio": { bio: null, certified_finding_count: 0, renderable_track_count: 5 },
  "artist.cover-master": { image_state: "pending" },
  "artist.image": { image_state: "pending", image_url: null },
  "finding.context": { context_note: null, context_status: "pending" },
  "finding.context.retry-empty": { context_note: null, context_status: "empty" },
  "finding.enrich": { enrichment_status: "processing" },
  "finding.note": { note: null },
  "finding.observe": { observation_audio_url: null },
  "finding.render": { video_url: null },
  "finding.render.requires-observation": { video_url: null },
  "label.bio": { bio: null, certified_finding_count: 0, renderable_track_count: 5 },
  "label.image": { image_state: "pending" },
};

function entityProbeBase(kind: DueWorkEntityKind): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const column of DUE_WORK_SOURCE_COLUMNS[kind]) {
    base[column] = column.endsWith("_at")
      ? PROBE_BEFORE
      : column.endsWith("_count")
        ? 5
        : `probe-${column}`;
  }
  return { ...base, ...ENTITY_PROBE_BASE_OVERRIDES[kind] };
}

function entityDefinitionVersion(kind: DueWorkEntityKind): string {
  const probes = probeMatrix(
    [entityProbeBase(kind)],
    DUE_WORK_SOURCE_COLUMNS[kind],
    DUE_WORK_PROBE_LADDER,
  );
  const evaluate = ENTITY_EVALUATORS[kind];
  const transcript = probes.map((source, index) =>
    probeAnswer(() => {
      const row = evaluate(source as never, PROBE_NOW);
      return row === null ? `${index}:-` : `${index}:${row.nextDueAt}|${row.orderKey}`;
    }),
  );
  return definitionFingerprint(kind, transcript);
}

const cache = new Map<string, string>();

/**
 * The running code's definition version for one `due_work` family. Computed on first use (a rebuild
 * step), then memoized for the isolate.
 */
export function dueWorkDefinitionVersion(workKind: string): string {
  return memoizedDefinitionVersion(cache, workKind, () => {
    if (DUE_WORK_TRACK_WORK_KIND_INVENTORY.some((entry) => entry.workKind === workKind)) {
      return trackDefinitionVersion(workKind as DueWorkQueueKind);
    }
    if (DUE_WORK_VENDOR_WORK_KIND_INVENTORY.some((entry) => entry.workKind === workKind)) {
      return vendorDefinitionVersion(workKind as DueWorkVendorKind);
    }
    if ((DUE_WORK_KINDS as readonly string[]).includes(workKind)) {
      return entityDefinitionVersion(workKind as DueWorkEntityKind);
    }
    throw new Error(`no due-work definition version for ${workKind}`);
  });
}
