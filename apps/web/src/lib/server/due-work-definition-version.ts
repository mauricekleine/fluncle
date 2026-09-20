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
  probeAnswer,
  probeMatrix,
  PROBE_BEFORE,
  PROBE_NOW,
} from "./due-work-definition-fingerprint";
import {
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
  describeDueWorkTrackDecision,
  DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS,
  DUE_WORK_TRACK_SOURCE_COLUMNS,
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  type DueWorkQueueKind,
  type DueWorkTrackSource,
} from "./due-work-track-definitions";
import {
  describeDueWorkVendorDecision,
  DUE_WORK_VENDOR_SOURCE_COLUMNS,
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY,
  type DueWorkVendorKind,
  type DueWorkVendorSource,
} from "./due-work-vendor-definitions";

const PROBE_RANK_CORPUS = "rank-corpus-probe";

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

const TRACK_PROBE_BASES: readonly DueWorkTrackSource[] = [
  TRACK_PROBE_CATALOGUE_PRE_CAPTURE,
  TRACK_PROBE_CATALOGUE_CAPTURED,
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

const VENDOR_PROBE_BASES: readonly DueWorkVendorSource[] = [
  VENDOR_PROBE_CATALOGUE,
  VENDOR_PROBE_FINDING,
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

function trackDefinitionVersion(workKind: DueWorkQueueKind): string {
  const entry = DUE_WORK_TRACK_WORK_KIND_INVENTORY.find((row) => row.workKind === workKind);
  if (entry === undefined) {
    throw new Error(`no due-work track inventory entry for ${workKind}`);
  }
  const probes = probeMatrix(
    TRACK_PROBE_BASES as unknown as Record<string, unknown>[],
    TRACK_PROBE_COLUMNS,
  ) as unknown as DueWorkTrackSource[];
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
  const probes = probeMatrix(
    VENDOR_PROBE_BASES as unknown as Record<string, unknown>[],
    DUE_WORK_VENDOR_SOURCE_COLUMNS,
  ) as unknown as DueWorkVendorSource[];
  const transcript = probes.map((source, index) =>
    probeAnswer(
      () =>
        `${index}:${describeDueWorkVendorDecision(workKind, source, PROBE_NOW, PROBE_RANK_CORPUS)}`,
    ),
  );
  return definitionFingerprint(workKind, transcript);
}

function entityProbeBase(kind: DueWorkEntityKind): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const column of DUE_WORK_SOURCE_COLUMNS[kind]) {
    base[column] = column.endsWith("_at")
      ? PROBE_BEFORE
      : column.endsWith("_count")
        ? 5
        : `probe-${column}`;
  }
  return base;
}

function entityDefinitionVersion(kind: DueWorkEntityKind): string {
  const probes = probeMatrix([entityProbeBase(kind)], DUE_WORK_SOURCE_COLUMNS[kind]);
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
