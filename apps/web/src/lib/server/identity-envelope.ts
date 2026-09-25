import { type AnchorRefusalReason, anchorRefusalReason, ANCHOR_MAX_ATTEMPTS } from "./track-work";
import { getDb, typedRows } from "./db";
import { parseArtistsJson } from "./artists";
import { siteUrl } from "../fluncle-links";
import { ALL_TRACK_OR_LOG_ID_MATCHES_CTE } from "./track-id-resolver";
import { publicTrackDurationWhere } from "../../db/public-track-visibility";

export const IDENTITY_CONTACT = "hey@fluncle.com";

export const IDENTITY_ATTRIBUTION =
  "Recording identifiers include data from MusicBrainz (musicbrainz.org), released under CC0.";

export const APPLE_LINKS_MACHINE_SERVED = false;

export type IdentityAudience = "first-party" | "machine";

export type IdentityMethod =
  | "fingerprint"
  | "isrc"
  | "operator"
  | "pk-derived"
  | "publish"
  | "search"
  | "search-subset"
  | "unknown-legacy";

export const IDENTITY_METHODS = [
  "fingerprint",
  "isrc",
  "operator",
  "pk-derived",
  "publish",
  "search",
  "search-subset",
  "unknown-legacy",
] as const satisfies readonly IdentityMethod[];

export type IdentityRetry = "capped" | "recheckable" | "single-shot";

export type IdentityRelation = "ambiguous" | "canonical" | `duplicate-of:${string}`;

export type IdentityState =
  | {
      attempts?: number;

      cap: null | number;
      lastAttemptedAt: null | string;
      retry: IdentityRetry;
      state: "absent";

      terminal: boolean | null;
    }
  | { reason: AnchorRefusalReason; state: "refused" }
  | { state: "unattempted" }
  | { state: "unsupported" }
  | {
      state: "verified";
      url?: string;
      value?: string;
      verification: {
        at: null | string;

        atMeaning: "attempted" | "verified" | null;
        method: IdentityMethod;

        source: null | string;
      };
    };

export type IdentityRecording = {
  artists: string[];

  certified: boolean;
  identifiers: { isrc: IdentityState; mbRecordingId: IdentityState };
  links: {
    appleMusic: IdentityState;
    beatport: IdentityState;
    deezer: IdentityState;
    discogs: IdentityState;
    spotify: IdentityState;
    tidal: IdentityState;
    youtube: IdentityState;
  };

  logId: null | string;
  relation: IdentityRelation;
  title: string;
  trackId: string;
};

export type IdentityEnvelope = {
  meta: { asOf: string; attribution: string; contact: string };
  recordings: IdentityRecording[];
};

const IDENTITY_SELECT = `t.track_id, t.title, t.artists_json, t.duration_ms,
    t.isrc, t.isrc_attempted_at,
    t.mb_recording_id, t.mb_recording_id_attempted_at,
    t.spotify_uri, t.spotify_anchor_attempted_at, t.spotify_anchor_attempts,
    t.spotify_anchor_source, t.spotify_anchor_verified_by, t.spotify_anchored_at,
    t.apple_music_url, t.backfill_apple_music_attempted_at, t.backfill_apple_music_attempts,
    t.backfill_apple_music_done_at,
    t.in_release_id, t.backfill_discogs_attempted_at, t.backfill_discogs_attempts,
    t.backfill_discogs_done_at,
    t.beatport_url, t.beatport_verified_at, t.backfill_beatport_attempted_at,
    t.backfill_beatport_attempts,
    t.deezer_track_id, t.deezer_verified_at, t.deezer_verified_by,
    t.backfill_deezer_attempted_at, t.backfill_deezer_attempts,
    t.youtube_video_id, t.youtube_video_official, t.youtube_verified_at,
    t.youtube_verified_by,
    t.dismissed_at, t.duplicate_of_track_id,
    f.log_id as log_id, (f.track_id is not null) as has_finding`;

const IDENTITY_FROM = `from tracks t left join findings f on f.track_id = t.track_id`;

type IdentityRow = {
  apple_music_url: null | string;
  artists_json: null | string;
  backfill_apple_music_attempted_at: null | string;
  backfill_apple_music_attempts: null | number;
  backfill_apple_music_done_at: null | string;
  backfill_beatport_attempted_at: null | string;
  backfill_beatport_attempts: null | number;
  backfill_deezer_attempted_at: null | string;
  backfill_deezer_attempts: null | number;
  backfill_discogs_attempted_at: null | string;
  backfill_discogs_attempts: null | number;
  backfill_discogs_done_at: null | string;
  beatport_url: null | string;
  beatport_verified_at: null | string;
  deezer_track_id: null | string;
  deezer_verified_at: null | string;
  deezer_verified_by: null | string;
  dismissed_at: null | string;
  duplicate_of_track_id: null | string;
  duration_ms: null | number;
  has_finding: number;
  in_release_id: null | number;
  isrc: null | string;
  isrc_attempted_at: null | string;
  log_id: null | string;
  mb_recording_id: null | string;
  mb_recording_id_attempted_at: null | string;
  spotify_anchor_attempted_at: null | string;
  spotify_anchor_attempts: null | number;
  spotify_anchor_source: null | string;
  spotify_anchor_verified_by: null | string;
  spotify_anchored_at: null | string;
  spotify_uri: null | string;
  title: string;
  track_id: string;
  youtube_verified_at: null | string;
  youtube_verified_by: null | string;
  youtube_video_id: null | string;
  youtube_video_official: null | number;
};

export type IdentityKey =
  | { idOrLogId: string; kind: "idOrLogId" }
  | { isrcs: string[]; kind: "isrc" }
  | { kind: "mbid"; mbid: string }
  | { kind: "spotify"; spotifyId: string }
  | { deezerId: string; kind: "deezer" };

export {
  normalizeDeezerKey,
  normalizeIsrcKey,
  normalizeMbidKey,
  normalizeSpotifyKey,
} from "../identity-key";

function spotifyTrackId(uri: null | string): string | undefined {
  const id = (uri ?? "").replace(/^spotify:track:/, "").trim();

  return id && id !== uri?.trim() ? id : undefined;
}

export function spotifyHopUrl(trackId: string): string {
  return `${siteUrl}/out/spotify/${encodeURIComponent(trackId)}`;
}

function verified(
  method: IdentityMethod,
  at: null | string,
  atMeaning: "attempted" | "verified" | null,
  extra: { source?: null | string; url?: string; value?: string } = {},
): IdentityState {
  return {
    state: "verified",
    ...(extra.url ? { url: extra.url } : {}),
    ...(extra.value ? { value: extra.value } : {}),
    verification: {
      at: at ?? null,

      atMeaning: at ? atMeaning : null,
      method,
      source: extra.source ?? null,
    },
  };
}

function spotifyState(row: IdentityRow): IdentityState {
  const id = spotifyTrackId(row.spotify_uri);

  if (id) {
    return verified(
      (row.spotify_anchor_verified_by as IdentityMethod | null) ?? "unknown-legacy",
      row.spotify_anchored_at,
      "verified",
      { source: row.spotify_anchor_source, url: spotifyHopUrl(row.track_id), value: id },
    );
  }

  const refusal = anchorRefusalReason({
    artistsJson: row.artists_json,
    dismissedAt: row.dismissed_at,
    duplicateOfTrackId: row.duplicate_of_track_id,
    durationMs: row.duration_ms,
    spotifyAnchorAttempts: row.spotify_anchor_attempts,
  });

  if (refusal) {
    return { reason: refusal, state: "refused" };
  }

  if (row.spotify_anchor_attempted_at) {
    return {
      cap: ANCHOR_MAX_ATTEMPTS,
      lastAttemptedAt: row.spotify_anchor_attempted_at,
      retry: "capped",
      state: "absent",

      terminal: false,
    };
  }

  return { state: "unattempted" };
}

function isrcState(row: IdentityRow): IdentityState {
  const isrc = row.isrc?.trim();

  if (isrc) {
    return verified("unknown-legacy", row.isrc_attempted_at, "attempted", { value: isrc });
  }

  if (row.isrc_attempted_at) {
    return {
      cap: null,
      lastAttemptedAt: row.isrc_attempted_at,
      retry: "recheckable",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

function musicbrainzState(row: IdentityRow): IdentityState {
  const mbid = row.mb_recording_id?.replace(/^mb_/, "").trim();

  if (mbid) {
    return verified(
      row.track_id.startsWith("mb_") ? "pk-derived" : "unknown-legacy",
      row.mb_recording_id_attempted_at,
      "attempted",
      { url: `https://musicbrainz.org/recording/${mbid}`, value: mbid },
    );
  }

  if (row.mb_recording_id_attempted_at) {
    return {
      cap: null,
      lastAttemptedAt: row.mb_recording_id_attempted_at,
      retry: "single-shot",
      state: "absent",
      terminal: true,
    };
  }

  return { state: "unattempted" };
}

function discogsState(row: IdentityRow): IdentityState {
  const releaseId = row.in_release_id;
  const certified = Number(row.has_finding) === 1;

  if (releaseId !== null && releaseId !== undefined) {
    return verified("unknown-legacy", row.backfill_discogs_done_at, "verified", {
      url: `https://www.discogs.com/release/${releaseId}`,
      value: String(releaseId),
    });
  }

  if (row.backfill_discogs_attempted_at) {
    return {
      attempts: row.backfill_discogs_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_discogs_attempted_at,
      retry: certified ? "recheckable" : "single-shot",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

function deezerState(row: IdentityRow): IdentityState {
  const id = row.deezer_track_id?.trim();

  if (id) {
    return verified(
      (row.deezer_verified_by as IdentityMethod | null) ?? "unknown-legacy",
      row.deezer_verified_at,
      "verified",
      { url: `https://www.deezer.com/track/${encodeURIComponent(id)}`, value: id },
    );
  }

  if (row.backfill_deezer_attempted_at) {
    return {
      attempts: row.backfill_deezer_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_deezer_attempted_at,
      retry: "single-shot",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

function youtubeMethod(storedBy: null | string): IdentityMethod {
  if (storedBy === "operator") {
    return "operator";
  }
  return storedBy === "search" ? "search" : "fingerprint";
}

function youtubeState(row: IdentityRow): IdentityState {
  const id = row.youtube_video_id?.trim();

  if (id && Number(row.youtube_video_official) === 1) {
    return verified(youtubeMethod(row.youtube_verified_by), row.youtube_verified_at, "verified", {
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      value: id,
    });
  }

  return { state: "unattempted" };
}

function beatportState(row: IdentityRow): IdentityState {
  const url = row.beatport_url?.trim();

  if (url) {
    return verified("isrc", row.beatport_verified_at, "verified", { url, value: url });
  }

  if (row.backfill_beatport_attempted_at) {
    return {
      attempts: row.backfill_beatport_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_beatport_attempted_at,
      retry: "single-shot",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

function appleMusicState(row: IdentityRow, audience: IdentityAudience): IdentityState {
  if (audience === "machine" && !APPLE_LINKS_MACHINE_SERVED) {
    return { state: "unsupported" };
  }

  const url = row.apple_music_url?.trim();

  if (url) {
    return verified("isrc", row.backfill_apple_music_done_at, "verified", { url, value: url });
  }

  if (row.backfill_apple_music_attempted_at) {
    return {
      attempts: row.backfill_apple_music_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_apple_music_attempted_at,
      retry: "recheckable",
      state: "absent",
      terminal: false,
    };
  }

  return { state: "unattempted" };
}

function relationsFor(rows: IdentityRow[]): Map<string, IdentityRelation> {
  const undecided = rows.filter((row) => !row.duplicate_of_track_id);
  const out = new Map<string, IdentityRelation>();

  for (const row of rows) {
    const duplicateOf = row.duplicate_of_track_id;

    out.set(
      row.track_id,
      duplicateOf
        ? `duplicate-of:${duplicateOf}`
        : undecided.length > 1
          ? "ambiguous"
          : "canonical",
    );
  }

  return out;
}

function toRecording(
  row: IdentityRow,
  relation: IdentityRelation,
  audience: IdentityAudience,
): IdentityRecording {
  return {
    artists: parseArtistsJson(row.artists_json ?? "[]"),

    certified: Number(row.has_finding) === 1 && Boolean(row.log_id),
    identifiers: { isrc: isrcState(row), mbRecordingId: musicbrainzState(row) },
    links: {
      appleMusic: appleMusicState(row, audience),
      beatport: beatportState(row),
      deezer: deezerState(row),
      discogs: discogsState(row),
      spotify: spotifyState(row),

      tidal: { state: "unsupported" },
      youtube: youtubeState(row),
    },
    logId: row.log_id,
    relation,
    title: row.title,
    trackId: row.track_id,
  };
}

function toEnvelope(groups: IdentityRow[][], audience: IdentityAudience): IdentityEnvelope {
  return {
    meta: {
      asOf: new Date().toISOString(),
      attribution: IDENTITY_ATTRIBUTION,
      contact: IDENTITY_CONTACT,
    },
    recordings: groups.flatMap((rows) => {
      const relations = relationsFor(rows);

      return rows.map((row) =>
        toRecording(row, relations.get(row.track_id) ?? "canonical", audience),
      );
    }),
  };
}

const IDENTITY_MAX_ROWS = 25;

function spotifyKeyArms(spotifyId: string): { args: string[]; where: string } {
  return {
    args: [spotifyId, `sp_${spotifyId}`, `spotify:track:${spotifyId}`],
    where: `(t.track_id = ? or t.track_id = ? or t.spotify_uri = ?)`,
  };
}

export async function readIdentity(
  key: IdentityKey,
  audience: IdentityAudience = "machine",
): Promise<IdentityEnvelope | undefined> {
  const db = await getDb();

  const isrcs = key.kind === "isrc" ? key.isrcs : [];

  if (key.kind === "isrc" && isrcs.length === 0) {
    return undefined;
  }

  const query =
    key.kind === "isrc"
      ? {
          args: [...isrcs, IDENTITY_MAX_ROWS * Math.max(isrcs.length, 1)],
          where: `t.isrc in (${isrcs.map(() => "?").join(", ")})`,
        }
      : key.kind === "mbid"
        ? { args: [key.mbid, IDENTITY_MAX_ROWS], where: `t.mb_recording_id = ?` }
        : key.kind === "spotify"
          ? (() => {
              const arms = spotifyKeyArms(key.spotifyId);

              return { args: [...arms.args, IDENTITY_MAX_ROWS], where: arms.where };
            })()
          : key.kind === "deezer"
            ? { args: [key.deezerId, IDENTITY_MAX_ROWS], where: `t.deezer_track_id = ?` }
            : {
                args: [key.idOrLogId, key.idOrLogId, key.idOrLogId, IDENTITY_MAX_ROWS],
                where: "1 = 1",
              };
  const referenceLookup = key.kind === "idOrLogId";

  const result = await db.execute({
    args: query.args,

    sql: `${referenceLookup ? `with ${ALL_TRACK_OR_LOG_ID_MATCHES_CTE}` : ""}
          select ${IDENTITY_SELECT}
          ${
            referenceLookup
              ? `from resolved_tracks
                 join tracks t on t.track_id = resolved_tracks.track_id
                 left join findings f on f.track_id = t.track_id`
              : IDENTITY_FROM
          }
          where ${query.where} and ${publicTrackDurationWhere("t", "f")}
          ${referenceLookup ? "" : "order by t.track_id asc"}
          limit ?`,
  });

  const rows = typedRows<IdentityRow>(result.rows);

  if (referenceLookup) {
    rows.sort((left, right) =>
      left.track_id < right.track_id ? -1 : left.track_id > right.track_id ? 1 : 0,
    );
  }

  if (rows.length === 0) {
    return undefined;
  }

  return toEnvelope(key.kind === "isrc" ? groupByIsrc(rows, isrcs) : [rows], audience);
}

function groupByIsrc(rows: IdentityRow[], isrcs: string[]): IdentityRow[][] {
  return isrcs
    .map((isrc) => rows.filter((row) => row.isrc === isrc).slice(0, IDENTITY_MAX_ROWS))
    .filter((group) => group.length > 0);
}

export async function readSpotifyHopTarget(trackId: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select spotify_url from tracks
          where track_id = ? and ${publicTrackDurationWhere("tracks")} limit 1`,
  });

  const url = typedRows<{ spotify_url: null | string }>(result.rows)[0]?.spotify_url?.trim();

  return url ? url : undefined;
}
