import { DATABASE_OPERATION_REGISTRY } from "./database-operation-registry";
import { DUE_WORK_KINDS } from "./due-work-entity-definitions";
import { DUE_WORK_TRACK_WORK_KIND_INVENTORY } from "./due-work-track-definitions";
import { DUE_WORK_VENDOR_WORK_KIND_INVENTORY } from "./due-work-vendor-definitions";

export type PhysicalDueWorkKind =
  | (typeof DUE_WORK_TRACK_WORK_KIND_INVENTORY)[number]["workKind"]
  | (typeof DUE_WORK_KINDS)[number]
  | (typeof DUE_WORK_VENDOR_WORK_KIND_INVENTORY)[number]["workKind"];

type RecurringCutoverConsumer<WorkKind extends PhysicalDueWorkKind> = Readonly<{
  consumerId: string;
  mode: "recurring";
  triggerMatch?: "family";
  triggerRationale?: string;
  triggerOperationId: string;
  workKind: WorkKind;
}>;

type LegacyOnlyCutoverConsumer<WorkKind extends string> = Readonly<{
  consumerId: string;
  mode: "legacy-only";
  rationale: string;
  triggerOperationId?: never;
  workKind: WorkKind;
}>;

type OnDemandCutoverConsumer<WorkKind extends PhysicalDueWorkKind> = Readonly<{
  consumerId: string;
  mode: "on-demand";
  rationale: string;
  triggerOperationId?: never;
  workKind: WorkKind;
}>;

export type DueWorkCutoverConsumer<WorkKind extends PhysicalDueWorkKind> =
  | RecurringCutoverConsumer<WorkKind>
  | OnDemandCutoverConsumer<WorkKind>;

/** Operator-targeted modes that intentionally never enter the physical recurring inventory. */
export const DUE_WORK_LEGACY_ONLY_NONPHYSICAL_MODES = {
  "cover-masters.retryNone": {
    consumerId: "cover-masters.resolveCoverMasters.retryNone",
    mode: "legacy-only",
    rationale:
      "retryNone explicitly re-arms terminal cover rows for an operator repair pass and is not part of the routine cover-master sweep.",
    workKind: "cover-masters.retryNone",
  },
} as const satisfies {
  [WorkKind in "cover-masters.retryNone"]: LegacyOnlyCutoverConsumer<WorkKind>;
};

/**
 * The source-of-truth physical inventory assembled without restating any queue names. Consumers
 * can use this alongside the map below to machine-check Goal C coverage as definitions evolve.
 */
export const PHYSICAL_DUE_WORK_KINDS: readonly PhysicalDueWorkKind[] = [
  ...DUE_WORK_TRACK_WORK_KIND_INVENTORY.map((entry) => entry.workKind),
  ...DUE_WORK_KINDS,
  ...DUE_WORK_VENDOR_WORK_KIND_INVENTORY.map((entry) => entry.workKind),
];

/**
 * One cutover consumer per physical due-work kind. The list-track-work rows deliberately name a
 * consumer family: one endpoint serves multiple physical scope halves, and the fleet registry
 * records the scheduled phase rather than every accepted request parameter.
 */
export const DUE_WORK_CUTOVER_CONSUMERS = {
  "album.bio": {
    consumerId: "albums.listAlbumsMissingBio",
    mode: "recurring",
    triggerOperationId: "bio.album.queue",
    workKind: "album.bio",
  },
  "album.cover-master": {
    consumerId: "cover-masters.resolveCoverMasters",
    mode: "recurring",
    triggerOperationId: "backfill.cover-masters.album",
    workKind: "album.cover-master",
  },
  "analyze-catalogue": {
    consumerId: "track-work.listTrackWork.analyze",
    mode: "recurring",
    triggerOperationId: "track.enrich.catalogue-queue",
    workKind: "analyze-catalogue",
  },
  "analyze-findings": {
    consumerId: "track-work.listTrackWork.analyze",
    mode: "recurring",
    triggerMatch: "family",
    triggerOperationId: "track.enrich.catalogue-queue",
    triggerRationale:
      "The finding analysis leg is served by listTrackWork, while the fleet registry names the catalogue queue call from the shared enrich sweep.",
    workKind: "analyze-findings",
  },
  anchor: {
    consumerId: "track-work.listTrackWork.anchor",
    mode: "recurring",
    triggerOperationId: "catalogue.anchor.queue",
    workKind: "anchor",
  },
  "apple-catalogue": {
    consumerId: "backfill.backfillAppleMusicCatalogue",
    mode: "recurring",
    triggerOperationId: "backfill.apple-catalogue",
    workKind: "apple-catalogue",
  },
  "apple-finding": {
    consumerId: "backfill.backfillAppleMusicUrls",
    mode: "recurring",
    triggerOperationId: "backfill.apple-music",
    workKind: "apple-finding",
  },
  "artist-credits": {
    consumerId: "backfill-artist-credits.resolveArtistCredits",
    mode: "recurring",
    triggerOperationId: "backfill.artist-credits",
    workKind: "artist-credits",
  },
  "artist-edges": {
    consumerId: "backfill-artist-edges.resolveArtistEdges",
    mode: "recurring",
    triggerOperationId: "backfill.artist-edges",
    workKind: "artist-edges",
  },
  "artist.bio": {
    consumerId: "artists.listArtistsMissingBio",
    mode: "recurring",
    triggerOperationId: "bio.artist.queue",
    workKind: "artist.bio",
  },
  "artist.cover-master": {
    consumerId: "cover-masters.resolveCoverMasters",
    mode: "recurring",
    triggerOperationId: "backfill.cover-masters.artist",
    workKind: "artist.cover-master",
  },
  "artist.image": {
    consumerId: "backfill-artist-images.backfillArtistImages",
    mode: "recurring",
    triggerOperationId: "backfill.artist-images",
    workKind: "artist.image",
  },
  "beatport-catalogue": {
    consumerId: "backfill.backfillBeatportUrls.catalogue",
    mode: "recurring",
    triggerOperationId: "backfill.beatport",
    workKind: "beatport-catalogue",
  },
  "beatport-finding": {
    consumerId: "backfill.backfillBeatportUrls.findings",
    mode: "recurring",
    triggerOperationId: "backfill.beatport",
    workKind: "beatport-finding",
  },
  "capture-catalogue": {
    consumerId: "track-work.listTrackWork.capture",
    mode: "recurring",
    triggerOperationId: "track.capture.queue",
    workKind: "capture-catalogue",
  },
  "capture-findings": {
    consumerId: "track-work.listTrackWork.capture",
    mode: "recurring",
    triggerOperationId: "track.capture.queue",
    workKind: "capture-findings",
  },
  "capture-verification": {
    consumerId: "catalogue.listUnverifiedCaptures",
    mode: "recurring",
    triggerOperationId: "catalogue.verify-captures.queue",
    workKind: "capture-verification",
  },
  "catalogue-rank": {
    consumerId: "catalogue.rankCatalogue",
    mode: "recurring",
    triggerOperationId: "catalogue.rank",
    workKind: "catalogue-rank",
  },
  "deezer-catalogue": {
    consumerId: "backfill.backfillDeezer.catalogue",
    mode: "recurring",
    triggerOperationId: "backfill.deezer",
    workKind: "deezer-catalogue",
  },
  "deezer-finding": {
    consumerId: "backfill.backfillDeezer.findings",
    mode: "recurring",
    triggerOperationId: "backfill.deezer",
    workKind: "deezer-finding",
  },
  "discogs-track": {
    consumerId: "backfill.backfillDiscogsIds",
    mode: "recurring",
    triggerOperationId: "backfill.discogs",
    workKind: "discogs-track",
  },
  "embed-catalogue": {
    consumerId: "track-work.listTrackWork.embed",
    mode: "recurring",
    triggerOperationId: "track.embed.queue",
    workKind: "embed-catalogue",
  },
  "embed-findings": {
    consumerId: "track-work.listTrackWork.embed",
    mode: "recurring",
    triggerOperationId: "track.embed.queue",
    workKind: "embed-findings",
  },
  "finding.context": {
    consumerId: "tracks.listTracks.finding-context",
    mode: "recurring",
    triggerOperationId: "track.context.queue",
    workKind: "finding.context",
  },
  "finding.context.retry-empty": {
    consumerId: "tracks.listTracks.finding-context-retry-empty",
    mode: "on-demand",
    rationale:
      "The operator-only --retry-empty repair mode deliberately widens the routine context queue and is not a recurring fleet trigger.",
    workKind: "finding.context.retry-empty",
  },
  "finding.enrich": {
    consumerId: "tracks.listTracks.finding-enrich",
    mode: "recurring",
    triggerOperationId: "track.enrich.queue",
    workKind: "finding.enrich",
  },
  "finding.note": {
    consumerId: "tracks.listTracks.finding-note",
    mode: "recurring",
    triggerOperationId: "track.note.queue",
    workKind: "finding.note",
  },
  "finding.observe": {
    consumerId: "tracks.listTracks.finding-observe",
    mode: "recurring",
    triggerOperationId: "track.observe.queue",
    workKind: "finding.observe",
  },
  "finding.render": {
    consumerId: "tracks.listTracks.finding-render",
    mode: "recurring",
    triggerOperationId: "render.tracks.queue-read",
    workKind: "finding.render",
  },
  "finding.render.requires-observation": {
    consumerId: "tracks.listTracks.finding-render-requires-observation",
    mode: "on-demand",
    rationale:
      "The --has-observation render filter is an operator-targeted narrowing mode; the recurring conductor reads the ordinary render queue.",
    workKind: "finding.render.requires-observation",
  },
  "isrc-recovery": {
    consumerId: "track-work.listTrackWork.isrc-recovery",
    mode: "recurring",
    triggerOperationId: "catalogue.isrc-recovery.queue",
    workKind: "isrc-recovery",
  },
  "label.bio": {
    consumerId: "labels.listLabelsMissingBio",
    mode: "recurring",
    triggerOperationId: "bio.label.queue",
    workKind: "label.bio",
  },
  "label.image": {
    consumerId: "label-images.resolveLabelImages",
    mode: "recurring",
    triggerOperationId: "backfill.label-images",
    workKind: "label.image",
  },
  "lastfm-track": {
    consumerId: "backfill.backfillLastfmLoves",
    mode: "recurring",
    triggerOperationId: "backfill.lastfm",
    workKind: "lastfm-track",
  },
  "mbid-isrc-lookup": {
    consumerId: "recording-mbids.resolveRecordingMbids.isrc-lookup",
    mode: "recurring",
    triggerOperationId: "backfill.recording-mbids",
    workKind: "mbid-isrc-lookup",
  },
  "mbid-isrc-refresh": {
    consumerId: "recording-mbids.resolveRecordingMbids.isrc-refresh",
    mode: "recurring",
    triggerOperationId: "backfill.recording-mbids",
    workKind: "mbid-isrc-refresh",
  },
  "mbid-prefix-strip": {
    consumerId: "recording-mbids.resolveRecordingMbids.prefix-strip",
    mode: "recurring",
    triggerOperationId: "backfill.recording-mbids",
    workKind: "mbid-prefix-strip",
  },
  "youtube-provenance-catalogue": {
    consumerId: "track-work.listTrackWork.youtube-provenance",
    mode: "recurring",
    triggerOperationId: "track.capture.queue",
    workKind: "youtube-provenance-catalogue",
  },
  "youtube-provenance-findings": {
    consumerId: "track-work.listTrackWork.youtube-provenance",
    mode: "recurring",
    triggerOperationId: "track.capture.queue",
    workKind: "youtube-provenance-findings",
  },
  "youtube-reverdict-catalogue": {
    consumerId: "track-work.listTrackWork.youtube-reverdict",
    mode: "recurring",
    triggerOperationId: "track.capture.queue",
    workKind: "youtube-reverdict-catalogue",
  },
  "youtube-reverdict-findings": {
    consumerId: "track-work.listTrackWork.youtube-reverdict",
    mode: "recurring",
    triggerOperationId: "track.capture.queue",
    workKind: "youtube-reverdict-findings",
  },
} as const satisfies {
  [WorkKind in PhysicalDueWorkKind]: DueWorkCutoverConsumer<WorkKind>;
};

/** The registry import is intentionally live: this module is the machine-readable join. */
export const RECURRING_DUE_WORK_TRIGGER_OPERATION_IDS = new Set(
  DATABASE_OPERATION_REGISTRY.flatMap((operation) =>
    operation.triggers.map((trigger) => trigger.operationId),
  ),
);
