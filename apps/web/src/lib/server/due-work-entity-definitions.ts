import { encodeDueWorkOrder, type DueWorkOrderComponent } from "./due-work-order";

/** The due-work kinds owned by the finding and entity selectors in this slice. */
export const DUE_WORK_KINDS = [
  "finding.enrich",
  "finding.context",
  "finding.context.retry-empty",
  "finding.note",
  "finding.observe",
  "finding.render",
  "finding.render.requires-observation",
  "artist.bio",
  "album.bio",
  "label.bio",
  "artist.cover-master",
  "album.cover-master",
  "label.image",
  "artist.image",
] as const;

export type DueWorkKind = (typeof DUE_WORK_KINDS)[number];

/** The exact source columns needed to decide eligibility and ordering for each kind. */
export const DUE_WORK_SOURCE_COLUMNS = {
  "album.bio": ["id", "bio", "certified_finding_count", "renderable_track_count", "created_at"],
  "album.cover-master": ["slug", "image_state", "image_attempted_at"],
  "artist.bio": ["id", "bio", "certified_finding_count", "renderable_track_count", "created_at"],
  "artist.cover-master": ["slug", "image_url", "image_state", "image_attempted_at"],
  "artist.image": ["id", "image_url", "spotify_artist_id", "image_state"],
  "finding.context": ["track_id", "context_note", "context_status", "added_at"],
  "finding.context.retry-empty": ["track_id", "context_note", "context_status", "added_at"],
  "finding.enrich": ["track_id", "enrichment_status", "updated_at", "added_at"],
  "finding.note": ["track_id", "context_note", "note", "added_at"],
  "finding.observe": ["track_id", "context_note", "observation_audio_url", "added_at"],
  "finding.render": ["track_id", "context_note", "video_url", "added_at"],
  "finding.render.requires-observation": [
    "track_id",
    "context_note",
    "observation_audio_url",
    "video_url",
    "added_at",
  ],
  "label.bio": ["id", "bio", "certified_finding_count", "renderable_track_count", "created_at"],
  "label.image": ["slug", "image_state", "image_attempted_at"],
} as const satisfies Record<DueWorkKind, readonly string[]>;

export type DueWorkSourceColumn = (typeof DUE_WORK_SOURCE_COLUMNS)[DueWorkKind][number];

/** One materialized due-work row. `nextDueAt` is the frozen evaluation instant for eligible work. */
export type DueWorkRow = {
  entityId: string;
  kind: DueWorkKind;
  nextDueAt: string;
  orderKey: string;
  sourceVersion: string;
};

export type FindingEnrichSource = {
  added_at: string | null;
  enrichment_status: string | null;
  track_id: string;
  updated_at: string | null;
};

export type FindingContextSource = {
  added_at: string | null;
  context_note: string | null;
  context_status: string | null;
  track_id: string;
};

export type FindingNoteSource = FindingContextSource & {
  note: string | null;
};

export type FindingObserveSource = FindingContextSource & {
  observation_audio_url: string | null;
};

export type FindingRenderSource = FindingContextSource & {
  observation_audio_url: string | null;
  video_url: string | null;
};

export type EntityBioSource = {
  bio: string | null;
  certified_finding_count: number | null;
  created_at: string | null;
  id: string;
  renderable_track_count: number | null;
};

export type CoverMasterSource = {
  image_attempted_at: string | null;
  image_failures?: number | null;
  image_state: string | null;
  image_url?: string | null;
  slug: string;
};

export type LabelImageSource = {
  image_attempted_at: string | null;
  image_state: string | null;
  slug: string;
};

export type ArtistImageSource = {
  id: string;
  image_state: string | null;
  image_url: string | null;
  spotify_artist_id: string | null;
};

const BIO_INDEX_FLOOR = 3;
const ENRICH_STALE_PROCESSING_MS = 30 * 60 * 1000;
const IMAGE_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function timestampMilliseconds(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${field} must be a valid timestamp`);
  }
  return milliseconds;
}

function sqliteTrim(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === " ") {
    start += 1;
  }
  while (end > start && value[end - 1] === " ") {
    end -= 1;
  }

  return value.slice(start, end);
}

function isSqliteEmpty(value: string | null): boolean {
  return value === null || sqliteTrim(value) === "";
}

function timestampComponent(value: string | null): DueWorkOrderComponent {
  return { direction: "asc", kind: "timestamp", nulls: "first", value };
}

function textComponent(value: string): DueWorkOrderComponent {
  return { direction: "asc", kind: "text", value };
}

function sourceVersion(kind: DueWorkKind, values: readonly unknown[]): string {
  return `${kind}:${JSON.stringify(values)}`;
}

export type DueWorkSourceByKind = {
  "album.bio": EntityBioSource;
  "album.cover-master": CoverMasterSource;
  "artist.bio": EntityBioSource;
  "artist.cover-master": CoverMasterSource;
  "artist.image": ArtistImageSource;
  "finding.context": FindingContextSource;
  "finding.context.retry-empty": FindingContextSource;
  "finding.enrich": FindingEnrichSource;
  "finding.note": FindingNoteSource;
  "finding.observe": FindingObserveSource;
  "finding.render": FindingRenderSource;
  "finding.render.requires-observation": FindingRenderSource;
  "label.bio": EntityBioSource;
  "label.image": LabelImageSource;
};

/** Stable version of exactly the columns each entity evaluator inspects. */
export function dueWorkEntitySourceVersion<Kind extends DueWorkKind>(
  kind: Kind,
  source: DueWorkSourceByKind[Kind],
): string {
  switch (kind) {
    case "finding.enrich": {
      const value = source as FindingEnrichSource;
      return sourceVersion(kind, [
        value.track_id,
        value.enrichment_status,
        value.updated_at,
        value.added_at,
      ]);
    }
    case "finding.context":
    case "finding.context.retry-empty": {
      const value = source as FindingContextSource;
      return sourceVersion(kind, [
        value.track_id,
        value.context_note,
        value.context_status,
        value.added_at,
      ]);
    }
    case "finding.note": {
      const value = source as FindingNoteSource;
      return sourceVersion(kind, [value.track_id, value.context_note, value.note, value.added_at]);
    }
    case "finding.observe": {
      const value = source as FindingObserveSource;
      return sourceVersion(kind, [
        value.track_id,
        value.context_note,
        value.observation_audio_url,
        value.added_at,
      ]);
    }
    case "finding.render": {
      const value = source as FindingRenderSource;
      return sourceVersion(kind, [
        value.track_id,
        value.context_note,
        value.video_url,
        value.added_at,
      ]);
    }
    case "finding.render.requires-observation": {
      const value = source as FindingRenderSource;
      return sourceVersion(kind, [
        value.track_id,
        value.context_note,
        value.observation_audio_url,
        value.video_url,
        value.added_at,
      ]);
    }
    case "artist.bio":
    case "album.bio":
    case "label.bio": {
      const value = source as EntityBioSource;
      return sourceVersion(kind, [
        value.bio,
        value.certified_finding_count,
        value.renderable_track_count,
        value.created_at,
      ]);
    }
    case "artist.cover-master": {
      const value = source as CoverMasterSource;
      return sourceVersion(kind, [
        value.slug,
        value.image_url,
        value.image_state,
        value.image_attempted_at,
      ]);
    }
    case "album.cover-master": {
      const value = source as CoverMasterSource;
      return sourceVersion(kind, [value.slug, value.image_state, value.image_attempted_at]);
    }
    case "label.image": {
      const value = source as LabelImageSource;
      return sourceVersion(kind, [value.slug, value.image_state, value.image_attempted_at]);
    }
    case "artist.image": {
      const value = source as ArtistImageSource;
      return sourceVersion(kind, [
        value.id,
        value.image_url,
        value.spotify_artist_id,
        value.image_state,
      ]);
    }
  }
}

function row(
  kind: DueWorkKind,
  entityId: string,
  now: string,
  version: string,
  orderComponents: readonly DueWorkOrderComponent[],
  nextDueAt = now,
): DueWorkRow {
  return {
    entityId,
    kind,
    nextDueAt,
    orderKey: encodeDueWorkOrder(orderComponents),
    sourceVersion: version,
  };
}

function findingOrder(source: {
  added_at: string | null;
  track_id: string;
}): DueWorkOrderComponent[] {
  return [timestampComponent(source.added_at), textComponent(source.track_id)];
}

function entityOrder(source: { created_at: string | null; id: string }): DueWorkOrderComponent[] {
  return [timestampComponent(source.created_at), textComponent(source.id)];
}

function slugOrder(source: { slug: string }): DueWorkOrderComponent[] {
  return [textComponent(source.slug)];
}

/** Evaluate the self-healing finding enrichment queue. */
export function evaluateFindingEnrich(source: FindingEnrichSource, now: string): DueWorkRow | null {
  if (!["pending", "failed", "processing"].includes(source.enrichment_status ?? "")) {
    return null;
  }
  const nextDueAt =
    source.enrichment_status === "processing" && source.updated_at !== null
      ? new Date(
          timestampMilliseconds(source.updated_at, "updated_at") + ENRICH_STALE_PROCESSING_MS + 1,
        ).toISOString()
      : now;

  return row(
    "finding.enrich",
    source.track_id,
    now,
    dueWorkEntitySourceVersion("finding.enrich", source),
    findingOrder(source),
    nextDueAt,
  );
}

/** Evaluate either context queue policy; normal excludes confirmed-empty rows. */
export function evaluateFindingContext(
  source: FindingContextSource,
  now: string,
  retryEmpty = false,
): DueWorkRow | null {
  const statuses = retryEmpty ? [null, "pending", "failed", "empty"] : [null, "pending", "failed"];
  const eligible = source.context_note === null && statuses.includes(source.context_status);

  if (!eligible) {
    return null;
  }

  const kind = retryEmpty ? "finding.context.retry-empty" : "finding.context";
  return row(
    kind,
    source.track_id,
    now,
    dueWorkEntitySourceVersion(kind, source),
    findingOrder(source),
  );
}

export function evaluateFindingContextNormal(
  source: FindingContextSource,
  now: string,
): DueWorkRow | null {
  return evaluateFindingContext(source, now);
}

export function evaluateFindingContextRetryEmpty(
  source: FindingContextSource,
  now: string,
): DueWorkRow | null {
  return evaluateFindingContext(source, now, true);
}

/** Evaluate the fill-empty-only note queue, including its context-fuel gate. */
export function evaluateFindingNote(source: FindingNoteSource, now: string): DueWorkRow | null {
  if (source.context_note === null || !isSqliteEmpty(source.note)) {
    return null;
  }

  return row(
    "finding.note",
    source.track_id,
    now,
    dueWorkEntitySourceVersion("finding.note", source),
    findingOrder(source),
  );
}

/** Evaluate the observation queue, which also requires a resolved context note. */
export function evaluateFindingObserve(
  source: FindingObserveSource,
  now: string,
): DueWorkRow | null {
  if (source.context_note === null || source.observation_audio_url !== null) {
    return null;
  }

  return row(
    "finding.observe",
    source.track_id,
    now,
    dueWorkEntitySourceVersion("finding.observe", source),
    findingOrder(source),
  );
}

/** Evaluate the normal render queue: context present and video absent. */
export function evaluateFindingRender(
  source: FindingRenderSource,
  now: string,
  requiresObservation = false,
): DueWorkRow | null {
  if (
    source.context_note === null ||
    source.video_url !== null ||
    (requiresObservation && source.observation_audio_url === null)
  ) {
    return null;
  }

  const kind = requiresObservation ? "finding.render.requires-observation" : "finding.render";
  return row(
    kind,
    source.track_id,
    now,
    requiresObservation
      ? dueWorkEntitySourceVersion("finding.render.requires-observation", source)
      : dueWorkEntitySourceVersion("finding.render", source),
    findingOrder(source),
  );
}

export function evaluateFindingRenderNormal(
  source: FindingRenderSource,
  now: string,
): DueWorkRow | null {
  return evaluateFindingRender(source, now);
}

export function evaluateFindingRenderRequiresObservation(
  source: FindingRenderSource,
  now: string,
): DueWorkRow | null {
  return evaluateFindingRender(source, now, true);
}

function evaluateEntityBio(
  kind: "artist.bio" | "album.bio" | "label.bio",
  source: EntityBioSource,
  now: string,
): DueWorkRow | null {
  const eligible =
    isSqliteEmpty(source.bio) &&
    ((source.certified_finding_count !== null && source.certified_finding_count > 0) ||
      (source.renderable_track_count !== null && source.renderable_track_count >= BIO_INDEX_FLOOR));

  if (!eligible) {
    return null;
  }

  return row(kind, source.id, now, dueWorkEntitySourceVersion(kind, source), entityOrder(source));
}

export function evaluateArtistBio(source: EntityBioSource, now: string): DueWorkRow | null {
  return evaluateEntityBio("artist.bio", source, now);
}

export function evaluateAlbumBio(source: EntityBioSource, now: string): DueWorkRow | null {
  return evaluateEntityBio("album.bio", source, now);
}

export function evaluateLabelBio(source: EntityBioSource, now: string): DueWorkRow | null {
  return evaluateEntityBio("label.bio", source, now);
}

function evaluateCoverMaster(
  kind: "artist.cover-master" | "album.cover-master",
  source: CoverMasterSource,
  now: string,
): DueWorkRow | null {
  const hasArtistSource =
    kind === "album.cover-master" || (source.image_url !== null && source.image_url !== undefined);
  if (source.image_state !== "pending" || !hasArtistSource) {
    return null;
  }
  const nextDueAt =
    source.image_attempted_at === null
      ? now
      : new Date(
          timestampMilliseconds(source.image_attempted_at, "image_attempted_at") +
            IMAGE_RETRY_COOLDOWN_MS +
            1,
        ).toISOString();

  return row(
    kind,
    source.slug,
    now,
    dueWorkEntitySourceVersion(kind, source),
    slugOrder(source),
    nextDueAt,
  );
}

export function evaluateArtistCoverMaster(
  source: CoverMasterSource,
  now: string,
): DueWorkRow | null {
  return evaluateCoverMaster("artist.cover-master", source, now);
}

export function evaluateAlbumCoverMaster(
  source: CoverMasterSource,
  now: string,
): DueWorkRow | null {
  return evaluateCoverMaster("album.cover-master", source, now);
}

/** Evaluate the pending, cooldown-gated label logo queue. */
export function evaluateLabelImage(source: LabelImageSource, now: string): DueWorkRow | null {
  if (source.image_state !== "pending") {
    return null;
  }
  const nextDueAt =
    source.image_attempted_at === null
      ? now
      : new Date(
          timestampMilliseconds(source.image_attempted_at, "image_attempted_at") +
            IMAGE_RETRY_COOLDOWN_MS +
            1,
        ).toISOString();

  return row(
    "label.image",
    source.slug,
    now,
    dueWorkEntitySourceVersion("label.image", source),
    slugOrder(source),
    nextDueAt,
  );
}

/** Evaluate the Spotify-id artist-image backfill queue. */
export function evaluateArtistImage(source: ArtistImageSource, now: string): DueWorkRow | null {
  if (
    source.image_url !== null ||
    source.spotify_artist_id === null ||
    source.image_state !== "pending"
  ) {
    return null;
  }

  return row("artist.image", source.id, now, dueWorkEntitySourceVersion("artist.image", source), [
    textComponent(source.id),
  ]);
}
