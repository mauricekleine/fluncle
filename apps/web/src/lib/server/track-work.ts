import { type TrackWorkItem, type TrackWorkKind, type TrackWorkScope } from "@fluncle/contracts";
import { anchorSearchQuery } from "./anchor";
import { deezerSearchQuery } from "./deezer";
import { type CatalogueCaptureState, isCatalogueCaptureOpen } from "./capture-budget";
import { LONG_FORM_MS, MIN_TRACK_MS } from "./catalogue";
import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import {
  countTrackWorkDue,
  isTrackWorkDueCutoverEnabled,
  readTrackWorkDueIds,
} from "./due-work-cutover";
import { type DueWorkClient } from "./due-work";
import {
  CAPTURE_FAILED_COOLDOWN_MS,
  CAPTURE_MAX_FAILURES,
  readArtistYoutubeChannelIdsByTrack,
} from "./tracks";

export type { TrackWorkItem, TrackWorkKind, TrackWorkScope };

export const ISRC_RECOVERY_REASK_AFTER_DAYS = 21;

export const YOUTUBE_PROVENANCE_REASK_AFTER_DAYS = 90;

export const YOUTUBE_PROVENANCE_MAX_FAILURES = 5;

export const ANCHOR_REASK_AFTER_DAYS = 14;

export const ANCHOR_MAX_ATTEMPTS = 6;

const UNANCHORABLE_ARTIST_CREDITS = [
  "Unknown Artist",
  "Various Artists",
  "VA",
  "Unknown",
  "[unknown]",
  "traditional",
];

const UNANCHORABLE_ARTISTS_JSON = UNANCHORABLE_ARTIST_CREDITS.map((name) =>
  JSON.stringify([name]).toLowerCase(),
);

type WorkRow = {
  analyzed_from: null | string;
  artists_json: string;
  bpm: null | number;
  capture_priority: null | number;
  capture_source_pin: null | string;
  capture_source_pin_allow_duration: bigint | null | number;
  certified: number;
  duration_ms: number;
  isrc: null | string;
  label: null | string;
  log_id: null | string;
  source_audio_failures: null | number;
  source_audio_key: null | string;
  source_audio_rejected: null | string;
  title: string;
  track_id: string;
};

const WORK_SELECT = `t.track_id, t.title, t.artists_json, t.isrc, t.label, t.duration_ms,
  t.source_audio_key, t.source_audio_rejected, t.capture_priority, t.bpm, t.analyzed_from, t.source_audio_failures,
  t.capture_source_pin, t.capture_source_pin_allow_duration,
  f.log_id as log_id,
  (f.track_id is not null) as certified`;

function workOrder(kind: TrackWorkKind, half: Exclude<TrackWorkScope, "all">): string {
  const catalogueCapture = kind === "capture" && half === "catalogue";
  const capturePriority = catalogueCapture
    ? "t.capture_priority"
    : "coalesce(t.capture_priority, 0)";
  const anchored = catalogueCapture ? "\n  (t.spotify_uri is not null) desc," : "";

  return `order by ${capturePriority} desc,${anchored}
  coalesce(t.demand_score, 0) desc,
  coalesce(f.added_at, '') desc,
  t.track_id desc`;
}

const ANCHOR_ORDER = `order by t.has_isrc desc,
  t.has_embedding desc,
  t.nearest_finding_score desc,
  t.track_id desc`;

const REVERDICT_ORDER = `order by t.youtube_verified_at asc, t.track_id asc`;

export function scopeClause(scope: TrackWorkScope): string {
  if (scope === "findings") {
    return "f.track_id is not null";
  }

  if (scope === "catalogue") {
    return "f.track_id is null";
  }

  return "1 = 1";
}

export function workHalfClause(kind: TrackWorkKind, half: Exclude<TrackWorkScope, "all">): string {
  const captureSeek =
    kind === "capture" && half === "catalogue"
      ? " and t.dismissed_at is null and t.capture_priority >= 0"
      : "";

  return `${scopeClause(half)} and t.is_catalogue = ${half === "catalogue" ? 1 : 0}${captureSeek}`;
}

export type AnchorRefusalReason =
  | "attempt-cap-reached"
  | "credit-not-an-identity"
  | "dismissed"
  | "duplicate"
  | "no-duration";

export function anchorEligibilityClause(): { args: string[]; sql: string } {
  const unanchorable = UNANCHORABLE_ARTISTS_JSON.map(() => "?").join(", ");

  return {
    args: [...UNANCHORABLE_ARTISTS_JSON],

    sql: `t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and coalesce(t.spotify_anchor_attempts, 0) < ${ANCHOR_MAX_ATTEMPTS}
            and lower(t.artists_json) not in (${unanchorable})`,
  };
}

export type AnchorEligibilityRow = {
  artistsJson: null | string;
  dismissedAt: null | string;
  durationMs: null | number;
  duplicateOfTrackId: null | string;
  spotifyAnchorAttempts: null | number;
};

export function anchorRefusalReason(row: AnchorEligibilityRow): AnchorRefusalReason | undefined {
  if (row.dismissedAt !== null) {
    return "dismissed";
  }

  if (row.duplicateOfTrackId !== null) {
    return "duplicate";
  }

  if (!(Number(row.durationMs ?? 0) > 0)) {
    return "no-duration";
  }

  if ((row.spotifyAnchorAttempts ?? 0) >= ANCHOR_MAX_ATTEMPTS) {
    return "attempt-cap-reached";
  }

  if (UNANCHORABLE_ARTISTS_JSON.includes((row.artistsJson ?? "").toLowerCase())) {
    return "credit-not-an-identity";
  }

  return undefined;
}

const ANCHOR_RULED_OUT_LABEL_CLAUSE = `(t.label_id is null
              or t.label_id not in (select id from labels where seed_state = 'disabled'))`;

export function kindClause(kind: TrackWorkKind): { args: string[]; sql: string } {
  if (kind === "youtube-provenance") {
    const cutoff = new Date(
      Date.now() - YOUTUBE_PROVENANCE_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    return {
      args: [cutoff],
      sql: `t.source_audio_key is not null
            and t.youtube_video_id is null
            and t.source_verification is null
            and coalesce(t.capture_status, '') <> 'wrong-audio'
            and coalesce(t.youtube_provenance_failures, 0) < ${YOUTUBE_PROVENANCE_MAX_FAILURES}
            and (t.youtube_verified_at is null or t.youtube_verified_at < ?)`,
    };
  }

  if (kind === "youtube-reverdict") {
    return {
      args: [],
      sql: `t.youtube_video_id is not null
            and coalesce(t.youtube_video_official, 0) <> 1`,
    };
  }

  if (kind === "isrc-recovery") {
    const cutoff = new Date(
      Date.now() - ISRC_RECOVERY_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    return {
      args: [cutoff],

      sql: `f.track_id is null
            and t.spotify_uri is null
            and t.has_isrc = 0
            and t.spotify_anchor_attempted_at is null
            and t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and ${ANCHOR_RULED_OUT_LABEL_CLAUSE}
            and (t.isrc_recovery_attempted_at is null or t.isrc_recovery_attempted_at < ?)`,
    };
  }

  if (kind === "anchor") {
    const cutoff = new Date(
      Date.now() - ANCHOR_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const permanent = anchorEligibilityClause();

    return {
      args: [cutoff, ...permanent.args],
      sql: `f.track_id is null
            and t.spotify_uri is null
            and (t.spotify_anchor_attempted_at is null or t.spotify_anchor_attempted_at < ?)
            and ${ANCHOR_RULED_OUT_LABEL_CLAUSE}
            and ${permanent.sql}`,
    };
  }

  if (kind === "capture") {
    const cooldown = new Date(Date.now() - CAPTURE_FAILED_COOLDOWN_MS).toISOString();

    return {
      args: [cooldown, cooldown],

      sql: `(t.capture_status is null
             or t.capture_status = 'pending'
             or t.capture_status = 'wrong-audio'
             or (t.capture_status = 'duplicate-cleared'
                 and t.source_audio_key is null
                 and t.source_audio_failures < ${CAPTURE_MAX_FAILURES}
                 and (t.source_audio_attempted_at is null or t.source_audio_attempted_at < ?))
             or (t.capture_status = 'failed'
                 and t.source_audio_failures < ${CAPTURE_MAX_FAILURES}
                 and (t.source_audio_attempted_at is null or t.source_audio_attempted_at < ?)))
            and (
              (f.track_id is not null and f.log_id is not null)
              or (f.track_id is null and t.capture_priority is not null and t.capture_priority >= 0
                  and t.dismissed_at is null
                  and t.duration_ms >= ${MIN_TRACK_MS}
                  and t.duration_ms < ${LONG_FORM_MS})
            )`,
    };
  }

  if (kind === "analyze") {
    return {
      args: [],

      sql: `t.source_audio_key is not null
            and t.capture_status <> 'wrong-audio'
            and (t.analyzed_at is null or t.analyzed_from is null or t.analyzed_from <> 'full')`,
    };
  }

  return {
    args: [],

    sql: `t.source_audio_key is not null
          and t.has_embedding = 0
          and t.capture_status <> 'wrong-audio'`,
  };
}

const METERED_KINDS = new Set<TrackWorkKind>(["capture", "youtube-provenance"]);

const LADDER_KINDS = new Set<TrackWorkKind>(["capture", "youtube-provenance"]);

const MAX_WORK_LIMIT = 200;

async function hydrateWorkRows(db: DueWorkClient, trackIds: readonly string[]): Promise<WorkRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: [...trackIds],
    sql: `select ${WORK_SELECT}
          from tracks t
          left join findings f on f.track_id = t.track_id
          where t.track_id in (${placeholders})`,
  });
  const rowsById = new Map(
    typedRows<WorkRow>(result.rows).map((row) => [row.track_id, row] as const),
  );

  return trackIds.flatMap((trackId) => {
    const row = rowsById.get(trackId);
    return row === undefined ? [] : [row];
  });
}

export async function listTrackWork(options: {
  kind: TrackWorkKind;
  limit?: number;
  scope?: TrackWorkScope;
}): Promise<TrackWorkItem[]> {
  const { kind, limit = 50, scope = "all" } = options;
  const page = Math.min(Math.max(1, Math.trunc(limit)), MAX_WORK_LIMIT);

  const catalogueShut = METERED_KINDS.has(kind) ? !(await isCatalogueCaptureOpen()) : false;

  if (catalogueShut && scope === "catalogue") {
    return [];
  }

  const effectiveScope: TrackWorkScope = catalogueShut ? "findings" : scope;

  const db = await getDb();
  const dueCutoverEnabled = await isTrackWorkDueCutoverEnabled();

  let rows: WorkRow[];

  if (dueCutoverEnabled) {
    const selectedIds = await readTrackWorkDueIds(db, {
      kind,
      limit: page,
      scope: effectiveScope,
    });
    rows = await hydrateWorkRows(db, selectedIds);
  } else {
    const kindWhere = kindClause(kind);

    const specialistOrder =
      kind === "anchor" || kind === "isrc-recovery"
        ? ANCHOR_ORDER
        : kind === "youtube-reverdict"
          ? REVERDICT_ORDER
          : null;

    const readRows = async (where: string, order: string, limit: number): Promise<WorkRow[]> => {
      const result = await db.execute({
        args: [...kindWhere.args, limit],

        sql: `select ${WORK_SELECT}
              from tracks t${order === ANCHOR_ORDER ? " indexed by tracks_anchor_order_idx" : ""}
              left join findings f on f.track_id = t.track_id
              where ${where} and ${kindWhere.sql}
              ${order}
              limit ?`,
      });

      return typedRows<WorkRow>(result.rows);
    };

    if (specialistOrder !== null) {
      rows = await readRows(scopeClause(effectiveScope), specialistOrder, page);
    } else {
      const halves: Exclude<TrackWorkScope, "all">[] =
        effectiveScope === "all" ? ["findings", "catalogue"] : [effectiveScope];
      rows = [];

      for (const half of halves) {
        const remaining = page - rows.length;

        if (remaining === 0) {
          break;
        }

        rows.push(
          ...(await readRows(workHalfClause(kind, half), workOrder(kind, half), remaining)),
        );
      }
    }
  }

  const items: TrackWorkItem[] = rows.map((row) => {
    const artists = parseArtistsJson(row.artists_json);

    const deezerQuery =
      kind === "isrc-recovery" || (kind === "anchor" && !row.isrc?.trim())
        ? deezerSearchQuery(artists, row.title)
        : undefined;

    return {
      artists,
      capturePriority: row.capture_priority === null ? null : Number(row.capture_priority),
      certified: Number(row.certified) === 1,
      durationMs: Number(row.duration_ms),
      isrc: row.isrc,
      label: row.label,
      logId: row.log_id,
      sourceAudioKey: row.source_audio_key,
      title: row.title,
      trackId: row.track_id,

      ...(kind === "anchor" ? { anchorQuery: anchorSearchQuery(artists, row.title) } : {}),
      ...(deezerQuery ? { deezerQuery } : {}),

      ...(kind === "capture"
        ? {
            analyzedFrom:
              row.analyzed_from === "full" || row.analyzed_from === "preview"
                ? row.analyzed_from
                : undefined,
            bpm:
              row.bpm !== null && Number.isFinite(Number(row.bpm)) && Number(row.bpm) > 0
                ? Number(row.bpm)
                : undefined,

            captureSourcePin:
              typeof row.capture_source_pin === "string" && row.capture_source_pin.trim()
                ? row.capture_source_pin.trim()
                : undefined,

            captureSourcePinAllowDuration:
              typeof row.capture_source_pin === "string" &&
              row.capture_source_pin.trim() &&
              Number(row.capture_source_pin_allow_duration ?? 0) === 1
                ? true
                : undefined,
            sourceAudioFailures:
              row.source_audio_failures !== null && Number(row.source_audio_failures) > 0
                ? Number(row.source_audio_failures)
                : undefined,
          }
        : {}),

      ...(LADDER_KINDS.has(kind)
        ? {
            sourceAudioRejected:
              typeof row.source_audio_rejected === "string" && row.source_audio_rejected.trim()
                ? row.source_audio_rejected
                : undefined,
          }
        : {}),
    };
  });

  if (LADDER_KINDS.has(kind) && items.length > 0) {
    const byTrack = await readArtistYoutubeChannelIdsByTrack(
      db,
      items.map((item) => item.trackId),
    );

    for (const item of items) {
      const channelIds = byTrack.get(item.trackId);

      if (channelIds && channelIds.length > 0) {
        item.artistYoutubeChannelIds = channelIds;
      }
    }
  }

  return items;
}

export async function countTrackWork(options: {
  captureState?: CatalogueCaptureState;
  kind: TrackWorkKind;
  scope?: TrackWorkScope;
}): Promise<number> {
  const { captureState, kind, scope = "all" } = options;

  const catalogueShut = METERED_KINDS.has(kind)
    ? !(captureState ? captureState.open : await isCatalogueCaptureOpen())
    : false;

  if (catalogueShut && scope === "catalogue") {
    return 0;
  }

  const effectiveScope: TrackWorkScope = catalogueShut ? "findings" : scope;
  const db = await getDb();

  if (await isTrackWorkDueCutoverEnabled()) {
    return countTrackWorkDue(db, { kind, scope: effectiveScope });
  }

  const kindWhere = kindClause(kind);
  const where = `${scopeClause(effectiveScope)} and ${kindWhere.sql}`;

  const needsFindings = where.includes("f.");
  const result = await db.execute({
    args: kindWhere.args,
    sql: `select count(*) as queued
          from tracks t
          ${needsFindings ? "left join findings f on f.track_id = t.track_id" : ""}
          where ${where}`,
  });

  return Number(typedRows<{ queued: number }>(result.rows)[0]?.queued ?? 0);
}
