import {
  type FeedListPage,
  type MixArtist,
  type MixCandidate as MixCandidateDTO,
  type MixReason,
  type MixTrack as MixTrackDTO,
  type TrackCursor,
  type TrackFeatures,
  type TrackListPage,
  type TrackListItem,
} from "@fluncle/contracts";
import { logPageUrl } from "../fluncle-links";
import { bestAlbumCoverUrl, versionedObservationAudioUrl } from "../media";
import { nextBoundaryEpochMs, type RadioScheduleEntry } from "../radio-schedule";
import { type FeedItem, type MixtapeMember, rowToMixtape } from "../mixtapes";
import { composeAppleArtworkUrl } from "./apple-music";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { discogsReleaseUrl } from "./discogs";
import {
  cosineFromDistance,
  embeddingVectorSql,
  parseEmbedding,
  readEmbeddingBlob,
  toVectorProbe,
} from "./embedding";
import { logEvent } from "./log";
import { isLogId } from "../log-id";
import {
  applyTaste,
  type MixCandidate as RankCandidate,
  type MixChainDepth,
  mixChainDepth,
  namedMoveClasses,
  orderMixPath,
  rankMixable,
  RAIL_DEPTH,
  scoreMix,
  shortlistMixable,
  sonicGateOpen,
  TASTE_SHORTLIST,
  tasteSubScore,
  toMixTrack,
} from "./mixability";
import { type Camelot, keyToCamelotCode, parseKey, toCamelot } from "../key-camelot";
import { extractYoutubeChannelId } from "./youtube";

export type { FeedListPage, TrackCursor, TrackFeatures, TrackListPage, TrackListItem };
export type { RadioScheduleEntry };

export type TrackRow = {
  added_at: string;
  album: string | null;
  // The album's stored Apple artwork facts (RFC musickit-second-authority U1), joined by
  // `tracks.album_id`. Non-null only when the album has a row AND the Apple sweep filled it.
  // The DTO composes them into `artworkMaxUrl` (a ≥1920 render source) — RENDER-TIME ONLY.
  album_artwork_height: number | null;
  album_artwork_url_template: string | null;
  album_artwork_width: number | null;
  album_image_url: string | null;
  // The album's OWNED cover master (RFC U3b), joined by `tracks.album_id`. `album_image_state` is
  // `resolved` only once the `backfill_cover_masters` sweep stored a ≤1200 derivative; the DTO
  // then serves it via Cloudflare Images (`bestAlbumCoverUrl`) instead of the Spotify hotlink.
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  // The graph pointers, joined by `tracks.album_id` / `tracks.label_id` (see `label_slug`
  // below). Non-null only when the entity row exists — which is what lets a `GraphLink`
  // render server-side, with the page, and never point at a 404.
  album_slug: string | null;
  // ISO timestamp of the last analysis write (bpm/key/features). Admin-only observability —
  // stripped from every public DTO by `toPublicTrackListItem`; no sweep predicate reads it.
  analyzed_at: string | null;
  // Which audio class BPM/key were analyzed from ("full" the captured song | "preview" a 30s
  // preview | null legacy). Internal analysis provenance — the capture sweep's re-derive
  // predicate reads it; stripped from every public DTO by `toPublicTrackListItem`.
  analyzed_from: string | null;
  // The finding's Apple Music track URL (public listen link, the Spotify twin) —
  // catalogue identity, resolved EXACTLY by ISRC by the `apple-music` backfill. Null
  // until it resolves. See `apple_music_url` on `tracks` in db/schema.ts.
  apple_music_url: string | null;
  artists_json: string;
  bpm: number | null;
  // Who last set bpm/key — the source-hierarchy provenance (operator > rekordbox > DSP;
  // track-update.ts). Admin-only: `toPublicTrackListItem` strips both before any public
  // read. The Rekordbox sync reads them to skip an operator-graded row and to know
  // whether a matching value still needs a protective `rekordbox` stamp.
  bpm_source: string | null;
  duration_ms: number;
  enrichment_status: string;
  features_json: string | null;
  // The finding's sonic galaxy (browse-by-feel RFC), joined by `tracks.galaxy_id`.
  // `galaxy_name`/`galaxy_slug` are non-null ONLY when the galaxy is operator-NAMED —
  // an unnamed or unassigned finding reads null on both, and the DTO omits `galaxy`.
  galaxy_name: string | null;
  galaxy_slug: string | null;
  in_release_id: number | null;
  isrc: string | null;
  key: string | null;
  // Who last set the key — see `bpm_source` above. Admin-only (public-stripped).
  key_source: string | null;
  label: string | null;
  // The `/label/<slug>` this finding's imprint has — the `album_slug` twin. See above.
  label_slug: string | null;
  log_id: string | null;
  note: string | null;
  observation_alignment_json: string | null;
  observation_audio_url: string | null;
  observation_duration_ms: number | null;
  observation_generated_at: string | null;
  popularity: number | null;
  preview_url: string | null;
  release_date: string | null;
  source_audio_failures: number;
  source_audio_key: string | null;
  spotify_url: string;
  tiktok_url: string | null;
  youtube_url: string | null;
  title: string;
  track_id: string;
  updated_at: string | null;
  video_grain: string | null;
  video_model: string | null;
  video_model_reasoning: string | null;
  video_register: string | null;
  video_squared_at: string | null;
  video_url: string | null;
  video_vehicle: string | null;
  added_to_spotify: number;
  posted_to_telegram: number;
};

type MixtapeFeedRow = {
  added_at: string;
  duration_ms: number | null;
  id: string;
  log_id: string;
  member_count: number;
  mixcloud_url: string | null;
  note: string | null;
  sequence_number: number | null;
  soundcloud_url: string | null;
  title: string;
  updated_at: string | null;
  youtube_url: string | null;
};

/**
 * THE FINDING JOIN — the FROM clause every "this row is a finding" read drives through.
 *
 * A finding is the pair `findings ⋈ tracks` (docs/track-lifecycle.md): `tracks` holds the
 * universal music object, `findings` the certification (the Log ID, the note, the video,
 * the observation, the found date). The join is INNER, so a catalogue track with no
 * `findings` row can never leak into a finding surface — that is the whole safety property
 * of the split, and it is why no read here says a bare `from tracks`.
 *
 * `findings` leads because every list/queue predicate and every sort key lives on it
 * (`findings_added_at_track_id_idx` carries the feed order); `tracks` is reached by its
 * PRIMARY KEY, so the join costs one b-tree seek per row.
 *
 * TODAY the join is behaviour-preserving: every `tracks` row has a `findings` row (the
 * archive is all certified), so it selects exactly the rows the old monolithic
 * `from tracks` did. It stops being a no-op the moment the catalogue epic lands
 * uncertified tracks — which is precisely when a missing join would have become a bug.
 *
 * `track_id` is the only column on BOTH tables, so it is the only one that MUST be
 * qualified; everything else resolves unambiguously. Every column below is qualified
 * anyway, so a reader can see which half of the pair it comes from.
 */
export const FINDINGS_FROM = `findings join tracks on tracks.track_id = findings.track_id`;

// Columns exposed to clients. `features_json` is the enrichment spectral summary,
// surfaced (parsed) as creative fuel for the video agent.
const TRACK_SELECT = `tracks.track_id, tracks.spotify_url, tracks.apple_music_url, tracks.title, tracks.album, tracks.album_image_url, tracks.artists_json, tracks.analyzed_at, tracks.analyzed_from,
  tracks.bpm, tracks.bpm_source, tracks.duration_ms, findings.enrichment_status, tracks.features_json, tracks.in_release_id, tracks.isrc, tracks.key, tracks.key_source, tracks.label, findings.log_id, tracks.popularity,
  tracks.preview_url, tracks.release_date, tracks.source_audio_failures, tracks.source_audio_key, findings.video_url, findings.video_squared_at, findings.video_vehicle, findings.video_grain, findings.video_register, findings.video_model, findings.video_model_reasoning, findings.note, findings.added_at,
  findings.updated_at, findings.added_to_spotify, findings.posted_to_telegram,
  findings.observation_audio_url, findings.observation_duration_ms, findings.observation_generated_at, findings.observation_alignment_json,
  (select name from galaxies where galaxies.id = findings.galaxy_id) as galaxy_name,
  (select slug from galaxies where galaxies.id = findings.galaxy_id) as galaxy_slug,
  (select slug from albums where albums.id = tracks.album_id) as album_slug,
  (select artwork_url_template from albums where albums.id = tracks.album_id) as album_artwork_url_template,
  (select artwork_width from albums where albums.id = tracks.album_id) as album_artwork_width,
  (select artwork_height from albums where albums.id = tracks.album_id) as album_artwork_height,
  (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
  (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
  (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
  (select slug from labels where labels.id = tracks.label_id) as label_slug,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'tiktok' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as tiktok_url,
  (select url from social_posts
     where track_id = tracks.track_id and platform = 'youtube' and status = 'published'
       and url is not null
     order by published_at desc limit 1) as youtube_url`;

// ── The lean LIST projection (Finding B4) ──
//
// Every PUBLIC list surface (the homepage feed, /log index, Stories, llms.txt paging,
// the public `list_tracks`/`list_stories` ops) renders a handful of per-row fields but
// used to over-fetch three HEAVY ones that none of them read: `observation_alignment_json`
// (the spoken observation's word-timing arrays — big), `features_json` (the spectral
// summary), and `video_model_reasoning`. Shipping them on every list row bloats the SSR
// HTML and the hydrated react-query cache, and it grows with the archive.
//
// The consumer audit (see tracks-dto.test.ts + the PR body) proved the only readers of
// these three are on NON-list paths that keep the fat shape: `observationAlignment` →
// radio (its own `getRandomRadioTrack`/`getRadioEligibleTracks` path) + the MCP transcript;
// `features` → the single-track `get_track` read (the video pipeline's fuel) + the admin
// board's enrich dialog + the mixability engine's own query; `videoModelReasoning` → the
// admin/CLI update write-paths. So the lean projection is safe for the list surfaces and
// the fat `TRACK_SELECT`/`toTrackListItem` stays the default for admin/MCP/single-track.
//
// `LEAN_TRACK_SELECT` is DERIVED from `TRACK_SELECT` (single source of truth, drift-proof —
// a new column added to `TRACK_SELECT` automatically flows to the lean read too). The split
// is on `,`; none of the correlated subqueries contain a comma, so each fragment trims to a
// bare `<table>.<column>` and the omitted three are filtered out exactly. The table prefix
// is part of the key, so it tracks which half of the tracks/findings pair each column
// lives on (`features_json` is the recording's; the other two are the certification's).
const LEAN_LIST_OMITTED_COLUMNS = new Set([
  "tracks.features_json",
  "findings.observation_alignment_json",
  "findings.video_model_reasoning",
]);
const LEAN_TRACK_SELECT = TRACK_SELECT.split(",")
  .filter((fragment) => !LEAN_LIST_OMITTED_COLUMNS.has(fragment.trim()))
  .join(",");

/** A finite number, or undefined — for tolerant parsing of stored feature JSON. */
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the stored `observation_alignment_json` into the public caption shape
 * (`{ words: [{ text, startMs, endMs }] }`), or undefined. An empty-words sentinel
 * (the forced-alignment backfill stores `{ words: [] }` to mark a finding handled
 * when the aligner found nothing) surfaces as undefined — no captions to render.
 */
function parseObservationAlignment(
  json: string | null,
): { words: { endMs: number; startMs: number; text: string }[] } | undefined {
  if (!json) {
    return undefined;
  }

  try {
    const raw = JSON.parse(json) as { words?: unknown };

    if (!Array.isArray(raw.words)) {
      return undefined;
    }

    const words = raw.words.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const word = entry as {
        end?: unknown;
        endMs?: unknown;
        start?: unknown;
        startMs?: unknown;
        text?: unknown;
      };
      const text = typeof word.text === "string" ? word.text : "";
      const startMs = finiteOrUndefined(word.startMs);
      const endMs = finiteOrUndefined(word.endMs);

      // Legacy SSML markup tokens (e.g. `<break time="1.0s" />`) can linger in an
      // older observation script, and an aligner tokenises them as "words".
      // They must never render as caption text — drop any token carrying tag markup
      // (`<`, `>`, or an `attr="…"` fragment). Spoken words never contain these, and
      // dropping a break leaves a natural gap (the next word's start is past the pause).
      if (!text || /[<>]|="/.test(text) || startMs === undefined || endMs === undefined) {
        return [];
      }

      return [{ endMs, startMs, text }];
    });

    return words.length > 0 ? { words } : undefined;
  } catch (error) {
    logEvent("warn", "tracks.parse-observation-alignment-failed", { error });
    return undefined;
  }
}

/** Parse the enrichment `features_json` into a typed spectral summary, or undefined. */
function parseFeatures(json: string | null): TrackFeatures | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const features: TrackFeatures = {
      centroidHz: finiteOrUndefined(raw.centroidHz),
      highRatio: finiteOrUndefined(raw.highRatio),
      midFlatness: finiteOrUndefined(raw.midFlatness),
      onsetRate: finiteOrUndefined(raw.onsetRate),
      subBassRatio: finiteOrUndefined(raw.subBassRatio),
    };
    return Object.values(features).some((v) => v !== undefined) ? features : undefined;
  } catch (error) {
    logEvent("warn", "tracks.parse-features-failed", { error });
    return undefined;
  }
}

// The finding's sonic galaxy for the public DTO (browse-by-feel RFC): the
// operator-named cluster read via the `galaxy_id` join. Present ONLY when the galaxy
// is NAMED (both name + slug frozen) — an unassigned finding, or one in an unnamed
// galaxy, reads null on both and the DTO omits `galaxy`. Replaces the retired
// vibe-quadrant derivation.
function galaxyOf(
  name: string | null,
  slug: string | null,
): { name: string; slug: string } | undefined {
  return name && slug ? { name, slug } : undefined;
}

// The three heavy per-row fields the lean list projection omits — the DTO mirror of
// `LEAN_LIST_OMITTED_COLUMNS`. A `LeanTrackListItem` is assignable to `TrackListItem`
// (all three are OPTIONAL on the contract), so a lean item flows into any
// `TrackListItem[]`/`FeedItem[]` unchanged; it simply carries these three undefined.
export type LeanTrackListItem = Omit<
  TrackListItem,
  "features" | "observationAlignment" | "videoModelReasoning"
>;

// A lean DB row — a `TrackRow` without the three heavy columns `LEAN_TRACK_SELECT` drops.
// `TrackRow` is assignable to it, so `toLeanTrackListItem` also accepts a full (fat) row.
type LeanTrackRow = Omit<
  TrackRow,
  "features_json" | "observation_alignment_json" | "video_model_reasoning"
>;

/**
 * The lean list DTO (Finding B4): every `TrackListItem` field EXCEPT the three heavy ones
 * (`features`, `observationAlignment`, `videoModelReasoning`). Backs the public list
 * surfaces, which never read those three. `toTrackListItem` delegates here and adds the
 * three back — one field-mapping definition, no duplication.
 */
export function toLeanTrackListItem(row: LeanTrackRow): LeanTrackListItem {
  return {
    addedAt: row.added_at,
    addedToSpotify: Boolean(row.added_to_spotify),
    album: row.album ?? undefined,
    // THE BEST DISPLAY COVER, chosen at the DTO boundary so web, mobile, and the video pipeline
    // all upgrade at once (RFC musickit-second-authority U3a → U3b). Prefer the album's OWNED
    // 1200²-capped master through Cloudflare Images once the sweep resolved one; else fall through
    // to the Spotify chain upgraded from the stored 300² to 640². Emitted at `large`; a surface
    // re-sizes with `albumCoverAtSize` (which handles BOTH providers), so mobile + the video
    // pipeline (raw consumers) get a right-sized cover and the feed rows can still ask for `small`.
    albumImageUrl: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    // The graph pointers — the `/album/<slug>` + `/label/<slug>` pages this finding belongs
    // to, resolved in the SAME select that loaded the track. This is what makes the GraphLink
    // system free at the point of use: every surface that renders a finding already holds the
    // slug it needs to link its album and its imprint, so there is no per-link lookup and no
    // N+1 (the hover CARD is the only lazy part; see lib/server/graph-preview.ts).
    albumSlug: row.album_slug ?? undefined,
    // Analysis provenance (RFC bpm-key-accuracy) — the audio class BPM/key were derived
    // from. Internal capture/enrich state on the admin-authed DTO; `toPublicTrackListItem`
    // strips it before any public read. `null` legacy rows surface undefined ("assume
    // preview-grade"). The capture sweep's re-derive predicate reads it.
    analyzedAt: row.analyzed_at ?? undefined,
    analyzedFrom:
      row.analyzed_from === "full" || row.analyzed_from === "preview"
        ? row.analyzed_from
        : undefined,
    // The Apple Music listen link — a PUBLIC field (the Spotify twin), so it is NOT in
    // PRIVATE_TRACK_FIELDS and survives to the public DTO. Absent until the ISRC resolves.
    appleMusicUrl: row.apple_music_url ?? undefined,
    artists: parseArtistsJson(row.artists_json),
    // A ≥1920 render source composed server-side from the album's stored Apple facts (U1),
    // so `packages/video` prefers it over the 640² Spotify cover without importing apps/web or
    // minting an Apple URL itself. Undefined when the album carries no Apple artwork — the
    // render falls through to `albumImageUrl`. RENDER-TIME ONLY, never persisted (decision A).
    artworkMaxUrl: composeAppleArtworkUrl(
      row.album_artwork_url_template,
      row.album_artwork_width,
      row.album_artwork_height,
    ),
    bpm: row.bpm ?? undefined,
    // Source-hierarchy provenance (operator > rekordbox > DSP; track-update.ts). Admin-only
    // on this DTO — `toPublicTrackListItem` strips both. The Rekordbox sync reads them to
    // skip an operator-graded row and to detect a matching-but-unstamped value.
    bpmSource: row.bpm_source ?? undefined,
    discogsReleaseUrl: row.in_release_id ? discogsReleaseUrl(row.in_release_id) : undefined,
    durationMs: row.duration_ms,
    enrichmentStatus: row.enrichment_status,
    galaxy: galaxyOf(row.galaxy_name, row.galaxy_slug),
    isrc: row.isrc ?? undefined,
    key: row.key ?? undefined,
    // Key provenance — see `bpmSource` above. Admin-only (public-stripped).
    keySource: row.key_source ?? undefined,
    label: row.label ?? undefined,
    labelSlug: row.label_slug ?? undefined,
    logId: row.log_id ?? undefined,
    logPageUrl: row.log_id ? logPageUrl(row.log_id) : undefined,
    note: row.note?.trim() ? row.note : undefined,
    // Version the playback URL by the render timestamp so a re-`observe`
    // (which overwrites observation.mp3 in place) re-keys the edge cache — the
    // bare URL alone HITs stale until its max-age TTL. The bare URL stays in the
    // DB column (the admin-overwrite source of truth); only consumers see ?v=.
    observationAudioUrl: versionedObservationAudioUrl(
      row.observation_audio_url ?? undefined,
      row.observation_generated_at ?? undefined,
    ),
    observationDurationMs: row.observation_duration_ms ?? undefined,
    observationGeneratedAt: row.observation_generated_at ?? undefined,
    popularity: row.popularity ?? undefined,
    postedToTelegram: Boolean(row.posted_to_telegram),
    previewUrl: row.preview_url ?? undefined,
    releaseDate: row.release_date ?? undefined,
    // The consecutive full-song capture failures — surfaced so the `fluncle-capture`
    // sweep reads the prior count and increments truthfully (the queue's failure cap
    // depends on it). Only non-zero counts surface; a never-failed finding omits it.
    sourceAudioFailures: row.source_audio_failures > 0 ? row.source_audio_failures : undefined,
    // The R2 key of the captured full song (`<logId>/<sha256>.<ext>`) — presence
    // means the song is captured. Admin/agent-tier only (this whole DTO is admin-authed);
    // the key grants nothing without the private-bucket R2 creds. The enrich + embed
    // sweeps read it (the embed queue only embeds captured findings). Absent until captured.
    sourceAudioKey: row.source_audio_key ?? undefined,
    spotifyUrl: row.spotify_url,
    tiktokUrl: row.tiktok_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
    type: "finding",
    updatedAt: row.updated_at ?? undefined,
    videoGrain: row.video_grain ?? undefined,
    videoModel: row.video_model ?? undefined,
    videoRegister: row.video_register ?? undefined,
    videoSquaredAt: row.video_squared_at ?? undefined,
    videoUrl: row.video_url ?? undefined,
    videoVehicle: row.video_vehicle ?? undefined,
    youtubeUrl: row.youtube_url ?? undefined,
  };
}

/**
 * The full (fat) list DTO: the lean base plus the three heavy fields the admin/MCP/
 * single-track reads need. The default projection for every non-public-list consumer.
 */
export function toTrackListItem(row: TrackRow): TrackListItem {
  return {
    ...toLeanTrackListItem(row),
    features: parseFeatures(row.features_json),
    observationAlignment: parseObservationAlignment(row.observation_alignment_json),
    videoModelReasoning: row.video_model_reasoning ?? undefined,
  };
}

// Internal admin/agent-only fields stripped from every item bound for a PUBLIC surface.
//   - `sourceAudioKey` — the R2 key of the CAPTURED copyrighted full song (a content hash)
//     in the PRIVATE `fluncle-source-audio` bucket; it must NEVER world-serve
//     (audio-source-policy: the full audio is a private analysis artifact; exposing its key
//     advertises the archive).
//   - `analyzedFrom` — BPM/key analysis provenance (RFC bpm-key-accuracy); internal
//     capture/enrich state, never part of a public DTO.
//   - `bpmSource`/`keySource` — the source-hierarchy provenance (operator > rekordbox > DSP);
//     internal curation state the Rekordbox sync reads, never part of a public DTO.
// The on-box sweeps read all of them on the ADMIN path (which deliberately does NOT strip).
const PRIVATE_TRACK_FIELDS = [
  "analyzedAt",
  "analyzedFrom",
  "bpmSource",
  "keySource",
  "sourceAudioKey",
] as const;

/**
 * Strip the internal admin/agent-only fields (`PRIVATE_TRACK_FIELDS`) from a track/feed item
 * bound for a PUBLIC surface. Every PUBLIC read runs its items through this — the oRPC public
 * tracks router (`orpc/tracks.ts`) and the in-process MCP tools (`mcp.ts`); the browser WebMCP
 * surface proxies those same public HTTP reads, so it is covered transitively. The ADMIN read
 * path deliberately does NOT strip — the sweeps need these fields. A mixtape (or a finding
 * carrying none of them) passes through untouched.
 */
export function toPublicTrackListItem<T extends object>(item: T): T {
  // Read each optional field through a cast (not a `{ …?: string }` param type — that WEAK
  // type would reject a FeedItem's mixtape arm, which shares no property with it, at the
  // `list_tracks` map). Only clone when a private field is actually present, so a mixtape or
  // a finding carrying none of them returns the exact same reference as before.
  let result = item;

  for (const field of PRIVATE_TRACK_FIELDS) {
    if ((result as Record<string, unknown>)[field] !== undefined) {
      result = { ...result, [field]: undefined };
    }
  }

  return result;
}

/** Fetch a single track by its Spotify trackId or its Log ID. */
/**
 * The minimal shape the `/api/preview` relay needs to resolve a live preview — resolved from
 * `tracks` (a LEFT join to `findings`, so it answers by track id OR Log ID), NOT through the
 * finding INNER join `getTrackByIdOrLogId` uses. That difference is the point: a CATALOGUE track
 * (a `tracks` row with no `findings` row) has no finding to inner-join, so the finding-scoped
 * resolver returns nothing for it — and The Ear's inline artwork audition (docs/the-ear.md § The
 * operator's actions) previews catalogue rows. The preview itself is the official 30s Deezer /
 * Apple / iTunes preview the relay resolves by ISRC; nothing about the catalogue is exposed but a
 * public song preview. Everything it selects lives on `tracks` (catalogue identity), never on the
 * certification half.
 */
export async function getLivePreviewTrack(
  idOrLogId: string,
): Promise<{ artists: string[]; isrc?: string; previewUrl?: string; title: string } | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select tracks.title, tracks.artists_json, tracks.isrc, tracks.preview_url
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.track_id = ? or findings.log_id = ?
          limit 1`,
  });
  const row = typedRow<{
    artists_json: string;
    isrc: null | string;
    preview_url: null | string;
    title: string;
  }>(result.rows);

  if (!row) {
    return undefined;
  }

  return {
    artists: parseArtistsJson(row.artists_json),
    isrc: row.isrc ?? undefined,
    previewUrl: row.preview_url ?? undefined,
    title: row.title,
  };
}

export async function getTrackByIdOrLogId(idOrLogId: string): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where tracks.track_id = ? or findings.log_id = ? limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

/**
 * Hydrate a batch of findings by their Log IDs in ONE query (no N+1), keyed by
 * `logId` for O(1) lookup. The edition-email render holds only each finding's tiny
 * `{ logId, why }` reference (the schema keeps it small + current), so the render
 * resolves the live `Artist — Title` + Spotify link from here. A logId with no live
 * finding is simply absent from the map; bound args only, never interpolated.
 */
export async function getTracksByLogIds(logIds: string[]): Promise<Record<string, TrackListItem>> {
  const unique = [...new Set(logIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.log_id in (${placeholders})`,
  });

  const byLogId: Record<string, TrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    if (row.log_id) {
      byLogId[row.log_id] = toTrackListItem(row);
    }
  }

  return byLogId;
}

/**
 * Hydrate a batch of findings by their `track_id` in ONE query (no N+1), keyed by
 * `trackId` for O(1) lookup. The plan editor holds each finding only as a cue's
 * `finding_id` (`recording_cues`); this resolves the live `Artist — Title` + cover +
 * BPM/key so the findings builder renders rich rows. A `trackId` with no live finding is
 * simply absent from the map; bound args only, never interpolated.
 */
export async function getTracksByIds(trackIds: string[]): Promise<Record<string, TrackListItem>> {
  const unique = [...new Set(trackIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where tracks.track_id in (${placeholders})`,
  });

  const byTrackId: Record<string, TrackListItem> = {};

  for (const row of typedRows<TrackRow>(result.rows)) {
    byTrackId[row.track_id] = toTrackListItem(row);
  }

  return byTrackId;
}

/**
 * Every coordinate-bearing finding that features an artist, newest-first — the
 * artist page's cover grid (Unit 3, artist-relationship RFC §3). The canonical
 * source is the `track_artists` join; when it returns nothing (an artist not yet
 * backfilled into the join) it falls back to the kept `artists_json` cache,
 * matching the name EXACTLY within the parsed array so a substring like "Sub"
 * can't drag in "Subtronics". A finding with no Log ID never appears (the page is
 * a grid of log links).
 */
export async function getFindingsByArtist(
  artistId: string,
  artistName: string,
): Promise<TrackListItem[]> {
  const db = await getDb();
  const viaJoin = await db.execute({
    args: [artistId],
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          join track_artists on track_artists.track_id = tracks.track_id
          where track_artists.artist_id = ? and findings.log_id is not null
          order by findings.added_at desc, tracks.track_id desc`,
  });

  const joined = typedRows<TrackRow>(viaJoin.rows);

  if (joined.length > 0) {
    return joined.map(toTrackListItem);
  }

  // Fallback: the artist has no track_artists rows yet (pre-backfill). Match the
  // kept display cache, then keep only exact-name members (case-insensitive).
  const needle = artistName.toLowerCase();
  const viaJson = await db.execute({
    args: [needle],
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.log_id is not null
            and lower(tracks.artists_json) like '%' || ? || '%'
          order by findings.added_at desc, tracks.track_id desc`,
  });

  return typedRows<TrackRow>(viaJson.rows)
    .map(toTrackListItem)
    .filter((finding) => finding.artists.some((name) => name.toLowerCase() === needle));
}

/**
 * Every coordinate-bearing finding on one label / one album, newest-first — the cover grid
 * that LEADS each graph page. Reads through the `tracks.label_id` / `tracks.album_id`
 * pointer (an indexed seek, never a fold over the catalogue; see schema.ts) and drives
 * from `FINDINGS_FROM`, so it can only ever return findings.
 */
export async function getFindingsByLabel(labelId: string): Promise<TrackListItem[]> {
  return findingsByEntity("tracks.label_id", labelId);
}

export async function getFindingsByAlbum(albumId: string): Promise<TrackListItem[]> {
  return findingsByEntity("tracks.album_id", albumId);
}

// The shared body of the two above. `column` is a CONSTANT from this module (never user
// input) — the value is always bound.
async function findingsByEntity(
  column: "tracks.album_id" | "tracks.label_id",
  entityId: string,
): Promise<TrackListItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [entityId],
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where ${column} = ? and findings.log_id is not null
          order by findings.added_at desc, tracks.track_id desc`,
  });

  return typedRows<TrackRow>(result.rows).map(toTrackListItem);
}

/**
 * A track Fluncle KNOWS OF but has never certified — a `tracks` row with no `findings` row.
 * The other half of a graph page: the rest of the record, the rest of the label.
 *
 * ── THE ANTI-JOIN, AND WHY IT IS THE ONE READ THAT DOES NOT USE `FINDINGS_FROM` ────────
 * Every other read in this module drives through the inner finding join, which is what
 * makes it structurally impossible to mistake a catalogue track for a finding. This read
 * wants exactly the complement — `left join findings … where findings.track_id is null` —
 * so it states that inversion explicitly, and its return type is a DIFFERENT type
 * (`CatalogueTrackItem`) that carries NO `logId`, NO note, NO video, NO coordinate. There
 * is nothing on it a finding surface could render, so a row from here cannot leak into one
 * by accident; the type system is doing the same job the inner join does elsewhere.
 *
 * The pages render these rows UNLIT (DESIGN.md): quieter, uncoordinated, and linking OUT
 * (a track with no Log ID has no page of its own to link to). They are never introduced,
 * never named, never counted aloud — a finding is the only named object in Fluncle's world.
 *
 * ── AND WHY IT IS CAPPED ───────────────────────────────────────────────────────────────
 * The seek is indexed (`tracks_album_id_idx`), so the SCAN is bounded however big the
 * catalogue gets. The RESULT SET is not — and that is the distinction that bites. Measured on
 * a 10,800-row synthetic catalogue, an uncapped `/label/hospital-records` served **4.34 MB of
 * HTML** — 3,000 rows through the SSR markup, again through the hydration payload, and a third
 * time as `MusicRecording` nodes in the JSON-LD. An indexed seek that returns 3,000 rows is
 * still 3,000 rows.
 *
 * So the page takes a SLICE, and the TOTAL is counted in SQL (`count(*) over ()`) and returned
 * as a scalar — never by handing the rows to the isolate to length-check (AGENTS.md: rank and
 * aggregate in SQL). The thin-content gate keys off the total; the page renders the slice.
 *
 * The ARTIST and LABEL pages have since outgrown this shape entirely: a flat slice of a
 * discography is a dump, so their rows are GROUPED, and the bound moved with them into
 * `catalogue-groups.ts` (a page of groups, plus a per-group row cap, both in SQL). What is
 * left here is the ALBUM page, which needs no grouping because an album IS one group.
 */
export type CatalogueTrackItem = {
  artists: string[];
  /** Null when the track has no Spotify presence at all (a catalogue-only resolve). */
  spotifyUrl: string | undefined;
  title: string;
  trackId: string;
};

/**
 * The most quieter rows an ALBUM page will ever render. A cap the page can survive, not a cap
 * the DATA respects — the entity's true count still drives the thin-content gate.
 *
 * The artist and label pages no longer read through here at all: at catalogue scale their rows
 * are GROUPED (by record, and by artist-then-record), and grouping moves the bound rather than
 * removing it — see `catalogue-groups.ts`, which owns their limits. An album is already one
 * record, so its tracklist stays the flat list it always was, and this is its ceiling.
 */
export const GRAPH_PAGE_CATALOGUE_LIMIT = 100;

/** A page's worth of quieter rows, plus how many the entity carries in total. */
export type CatalogueSlice = {
  /** At most {@link GRAPH_PAGE_CATALOGUE_LIMIT} rows — what the page renders. */
  tracks: CatalogueTrackItem[];
  /** Every uncertified track on the entity, counted in SQL. Drives the thin-content gate. */
  total: number;
};

type CatalogueTrackRow = {
  artists_json: string;
  spotify_url: string | null;
  title: string;
  total: number;
  track_id: string;
};

/**
 * The uncertified tracklist of ONE record. `count(*) over ()` is evaluated over the WHOLE
 * filtered set — SQLite applies `limit` last — so one round trip brings back the capped slice
 * AND the honest total, and the rows past the cap never cross the wire.
 *
 * `release_date is null` leads the sort because SQLite orders NULL as the SMALLEST value, so a
 * bare `release_date desc` would float every undated row to the top of the page.
 *
 * No `album_image_url` here, and that is not an oversight: an unlit row renders NO COVER (it is
 * half of what holds it apart from a finding — DESIGN.md's Unlit Rule), so selecting one shipped
 * a URL through the markup, the hydration payload and the wire on every row, to be thrown away.
 */
export async function listCatalogueTracksByAlbum(albumId: string): Promise<CatalogueSlice> {
  const db = await getDb();
  const result = await db.execute({
    args: [albumId, GRAPH_PAGE_CATALOGUE_LIMIT],
    sql: `select tracks.track_id, tracks.title, tracks.artists_json,
                 tracks.spotify_url, count(*) over () as total
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.album_id = ? and findings.track_id is null
          order by tracks.release_date is null asc, tracks.release_date desc,
                   tracks.title collate nocase asc
          limit ?`,
  });

  const rows = typedRows<CatalogueTrackRow>(result.rows);

  return {
    total: Number(rows[0]?.total ?? 0),
    tracks: rows.map((row) => ({
      artists: parseArtistsJson(row.artists_json),
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    })),
  };
}

/**
 * Read the INTERNAL `context_note` for a track (the Firecrawl-derived facts).
 * `context_note` is deliberately OUTSIDE `TRACK_SELECT` (internal-only fuel,
 * never surfaced through `toTrackListItem`), so the observe steps read it
 * directly: the `context_track` step skips when it is already present
 * (idempotent no-op), and `observe_track` reads it as the stored fuel it no
 * longer fetches itself. Returns `null` when the track is missing or unset.
 */
export async function getTrackContextNote(idOrLogId: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select context_note from findings where track_id = ? or log_id = ? limit 1`,
  });
  const row = typedRow<{ context_note: string | null }>(result.rows);

  return row ? (row.context_note ?? null) : null;
}

/**
 * The R2 key of a finding's captured FULL SONG (`source_audio_key`), or null when
 * the finding is unknown OR not yet captured. A dedicated column-only read (like
 * `getTrackContextNote`) rather than a widening of `TRACK_SELECT`/`toTrackListItem`:
 * the full song is a private analysis artifact, never part of a public/admin DTO,
 * and only the `get_source_audio` streaming endpoint (the M5 bridge) needs the key.
 */
export async function getSourceAudioKey(idOrLogId: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    // LEFT join, not the finding inner join: a CATALOGUE row's captured bytes stream too — the
    // quarantine lens auditions them so the operator can hear which side of a wrong-audio
    // collision is actually wrong (docs/the-ear.md § Wrong audio). Same privacy tier either way.
    sql: `select tracks.source_audio_key from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.track_id = ? or findings.log_id = ? limit 1`,
  });
  const row = typedRow<{ source_audio_key: string | null }>(result.rows);

  return row ? (row.source_audio_key ?? null) : null;
}

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;

/**
 * Admin free-text search over the findings archive — matches `q` (case-insensitive,
 * substring) against track_id, log_id, title, or any stored artist. Newest-first to
 * mirror listTracks. The artists are stored as a JSON array string (`artists_json`),
 * so we match the raw JSON text — good enough to find an artist by name without
 * unpacking the array. Bound args only; `q` is never interpolated into SQL.
 */
export async function searchTracks(options: {
  q: string;
  limit?: number;
}): Promise<TrackListItem[]> {
  const q = options.q.trim();

  if (!q) {
    return [];
  }

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT) || SEARCH_DEFAULT_LIMIT, 1),
    SEARCH_MAX_LIMIT,
  );
  const needle = q.toLowerCase();

  const db = await getDb();
  const result = await db.execute({
    args: [needle, needle, needle, needle, limit],
    sql: `select ${TRACK_SELECT}
          from ${FINDINGS_FROM}
          where lower(tracks.track_id) like '%' || ? || '%'
             or lower(findings.log_id) like '%' || ? || '%'
             or lower(tracks.title) like '%' || ? || '%'
             or lower(tracks.artists_json) like '%' || ? || '%'
          order by findings.added_at desc, tracks.track_id desc
          limit ?`,
  });

  return typedRows<TrackRow>(result.rows).map(toTrackListItem);
}

/**
 * The most-recently-SHIPPED findings — the admin Renders view's "recently shipped"
 * list (the operator's morning render review). Every finding that carries a video,
 * ordered by its video VINTAGE (`video_squared_at`, the two-master ship stamp)
 * newest-first, so a fresh overnight render surfaces at the top even though the
 * finding it filmed is an OLD find (the render queue is worked oldest-first).
 *
 * DISTINCT from `listTracks({ hasVideo: true })`, which orders by FOUND order and so
 * would bury an overnight render of an old find below the newest-added catalogue. A
 * legacy single-master finding (no `video_squared_at`) sorts last — SQLite orders
 * NULLs last under DESC — then by found-order, so the freshest two-master renders
 * always lead.
 */
export async function listRecentlyRenderedFindings(limit: number): Promise<TrackListItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit],
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.video_url is not null
          order by findings.video_squared_at desc, findings.added_at desc, tracks.track_id desc
          limit ?`,
  });

  return typedRows<TrackRow>(result.rows).map(toTrackListItem);
}

export async function getTracksForMixtape(mixtapeId: string): Promise<MixtapeMember[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [mixtapeId],
    sql: `select ${TRACK_SELECT}, mt.start_ms as start_ms
          from ${FINDINGS_FROM}
          join mixtape_tracks mt on mt.track_id = tracks.track_id and mt.mixtape_id = ?
          order by mt.position asc`,
  });

  return typedRows<TrackRow & { start_ms: number | null }>(result.rows).map((row) => ({
    ...toTrackListItem(row),
    startMs: row.start_ms ?? undefined,
  }));
}

/** One random certified track, mapped like every other list item. */
export async function getRandomTrack(): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM} order by random() limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

/**
 * One random RADIO-ELIGIBLE finding for the cycling station (radio.fluncle.com).
 *
 * Eligible = the finding carries BOTH a clean square master (`video_squared_at`
 * set) AND an observation (`observation_audio_url` set):
 *   - The square master is what radio centre-crops per orientation (media.ts
 *     `videoCrop`) and draws its OWN chrome over, so a legacy baked-text cut must
 *     never reach the station — `video_squared_at` is the two-master signal.
 *   - The observation is the only audio radio plays (the video is silent), so a
 *     finding with no observation has nothing to say.
 * Both predicates are `is not null` filters on this OWN bare query (not the
 * `listTracks` builder), so the endpoint only ever returns a playable finding.
 */
export async function getRandomRadioTrack(): Promise<TrackListItem | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
          where findings.video_squared_at is not null
            and findings.observation_audio_url is not null
          order by random() limit 1`,
  });
  const row = typedRow<TrackRow>(result.rows);

  return row ? toTrackListItem(row) : undefined;
}

// ── radio.fluncle.com — the shared schedule (the radio-broadcast RFC, Unit A) ──

/**
 * The radio loop's eligible findings, deterministically ordered. The eligibility
 * predicate matches `getRandomRadioTrack` (a clean square master + an observation)
 * PLUS `observation_duration_ms`/`log_id` non-null — the schedule arithmetic needs
 * the segment length (the audio IS the clock) and the URL builder needs the logId,
 * where the random op tolerated their absence by skipping client-side.
 *
 * The order is found-order — `added_at ASC, track_id ASC`, the codebase's
 * canonical stable total order (the feed cursor, neighbors, and search tiebreak
 * all use this tuple). It MUST NOT be `random()` — that is exactly what breaks
 * synchronization. A non-found shuffle (Decision #2) would be a stable
 * epoch-seeded permutation in the handler; the SQL stays deterministic either way.
 */
export async function getRadioEligibleTracks(): Promise<RadioScheduleEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select track_id, log_id, observation_duration_ms
          from findings
          where video_squared_at is not null
            and observation_audio_url is not null
            and observation_duration_ms is not null
            and log_id is not null
          order by added_at asc, track_id asc`,
  });

  return typedRows<{
    log_id: string;
    observation_duration_ms: number;
    track_id: string;
  }>(result.rows).map((row) => ({
    logId: row.log_id,
    observationDurationMs: row.observation_duration_ms,
    trackId: row.track_id,
  }));
}

/**
 * A cheap fingerprint of the eligible set — `${count}:${maxObservationGeneratedAt}`
 * over the SAME predicate as `getRadioEligibleTracks`. `count` rises on a new
 * eligible finding; `latest` (the max `observation_generated_at`) moves on a
 * re-observe (a changed duration). A different fingerprint is the "the schedule
 * changed" trigger that rolls the epoch to the next loop boundary — computed on
 * the READ path, so the eligibility-changing agent writes never touch the anchor.
 */
export async function getRadioScheduleFingerprint(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select count(*) as count,
                 coalesce(max(observation_generated_at), '') as latest
          from findings
          where video_squared_at is not null
            and observation_audio_url is not null
            and observation_duration_ms is not null
            and log_id is not null`,
  });
  const row = typedRow<{ count: number; latest: string }>(result.rows);

  return `${Number(row?.count ?? 0)}:${row?.latest ?? ""}`;
}

type RadioScheduleRow = {
  epoch_ms: number;
  version: string;
};

/**
 * Read the stored schedule anchor, ROLLING it to the next loop boundary when the
 * eligible set changed (a self-heal on the read path). Returns the live epoch the
 * modulo math is measured from plus the fingerprint clients re-fetch on.
 *
 * On a fingerprint mismatch (or a first-ever read), the new schedule is made to
 * take effect at the NEXT loop boundary of the OLD loop (`nextBoundaryEpochMs`),
 * so a grown/re-observed catalogue applies at a seam and no current listener's
 * playhead jumps mid-loop — then the row is upserted. `oldEntries` lets the caller
 * pass the freshly-read eligible set so the boundary roll uses the OLD loop length
 * the listeners are still riding (the caller reads the live set anyway).
 */
export async function getRadioScheduleAnchor(
  version: string,
  oldLoopDurationMs: number,
  nowMs: number = Date.now(),
): Promise<{ epochMs: number; version: string }> {
  const db = await getDb();
  const stored = typedRow<RadioScheduleRow>(
    (
      await db.execute({
        args: ["radio"],
        sql: `select epoch_ms, version from radio_schedule where service = ?`,
      })
    ).rows,
  );

  // The anchor still matches the live set — nothing to roll.
  if (stored && stored.version === version) {
    return { epochMs: stored.epoch_ms, version };
  }

  // First-ever read: anchor at now. A changed set: roll the OLD epoch to the next
  // boundary of the OLD loop so the new schedule applies at a seam.
  const epochMs = stored ? nextBoundaryEpochMs(stored.epoch_ms, oldLoopDurationMs, nowMs) : nowMs;
  const generatedAt = new Date(nowMs).toISOString();

  await db.execute({
    args: [epochMs, generatedAt, version],
    sql: `insert into radio_schedule (service, epoch_ms, generated_at, version)
          values ('radio', ?, ?, ?)
          on conflict(service) do update set
            epoch_ms = excluded.epoch_ms,
            generated_at = excluded.generated_at,
            version = excluded.version`,
  });

  return { epochMs, version };
}

export type TrackNeighbor = {
  artists: string[];
  logId: string;
  title: string;
};

type NeighborRow = {
  artists_json: string;
  log_id: string;
  title: string;
};

/**
 * The adjacent coordinate-bearing findings in found order — the log page's
 * newer/older links (crawlable adjacency through the whole archive).
 */
export async function getTrackNeighbors(track: {
  addedAt: string;
  trackId: string;
}): Promise<{ newer?: TrackNeighbor; older?: TrackNeighbor }> {
  const db = await getDb();
  const select = `select findings.log_id, tracks.title, tracks.artists_json
    from ${FINDINGS_FROM} where findings.log_id is not null`;
  const [newerResult, olderResult] = await Promise.all([
    db.execute({
      args: [track.addedAt, track.addedAt, track.trackId],
      sql: `${select} and (findings.added_at > ? or (findings.added_at = ? and tracks.track_id > ?))
            order by findings.added_at asc, tracks.track_id asc limit 1`,
    }),
    db.execute({
      args: [track.addedAt, track.addedAt, track.trackId],
      sql: `${select} and (findings.added_at < ? or (findings.added_at = ? and tracks.track_id < ?))
            order by findings.added_at desc, tracks.track_id desc limit 1`,
    }),
  ]);
  const toNeighbor = (row: NeighborRow | undefined): TrackNeighbor | undefined =>
    row
      ? { artists: parseArtistsJson(row.artists_json), logId: row.log_id, title: row.title }
      : undefined;

  return {
    newer: toNeighbor(typedRow<NeighborRow>(newerResult.rows)),
    older: toNeighbor(typedRow<NeighborRow>(olderResult.rows)),
  };
}

// The old `getRelatedTracks` (vibe-quadrant "more in this galaxy" adjacency) is retired with its /log row (browse-by-feel RFC, Slice 4): the sonic
// galaxy lens (`/galaxies/<slug>`, reached from the linked prose clause) is the real
// topical adjacency now, and "Close in sound" (`getSimilarFindings`) already covers the
// per-finding neighbourhood. The vibe columns themselves are dropped — nothing read or
// wrote them, and the stale coordinates were still leaking into the observe/note prompts.

/**
 * The N sonically-nearest findings to a given one — the automatic "more like this"
 * cluster (docs/track-lifecycle.md). Loads the target's MuQ embedding, has the DATABASE
 * cosine-rank it against every OTHER coordinate-bearing finding's vector, and hydrates
 * the winners in similarity order. Powers the `/log` "more like this" row and the public
 * `get_similar_findings` op; a future "play something like this" radio hook reads the
 * same function.
 *
 * THE RANKING IS AN EXACT SCAN IN SQL — `order by vector_distance_cos(vector, ?) limit N`
 * with the probe bound as a RAW BLOB (`toVectorProbe`; see embedding.ts for why the
 * binding is the whole ballgame). It returns the ~6 winners, never the corpus: 100%
 * recall, one round trip, ~2.5 KB. The old shape — every `embedding_json` into the
 * isolate, cosine there — hard-failed `turso dev`'s 10 MiB response cap at 460 embedded
 * findings and was on course to OOM the 128 MB Worker isolate in prod
 * (docs/local-database.md "Local is not production"). No ANN index: `libsql_vector_idx`
 * wedged hosted Turso's write path in the measurement spike and is not to be used.
 *
 * Returns `[]` (never throws) when the finding is unknown, has no embedding yet (the
 * embed cron hasn't drained it), or nothing else is embedded. A malformed stored vector
 * is skipped, not fatal (`embeddingVectorSql`'s guard). Only coordinate-bearing
 * candidates (`log_id IS NOT NULL`) are considered — every result links to a `/log`
 * page — and the target is excluded.
 *
 * Ordering is deterministic: distance ascending, `track_id` ascending as the tiebreak.
 *
 * SCALE NOTE. The scan is unfiltered by design — "close in sound" is a GLOBAL nearest-
 * neighbour question, and the archive is one corpus. That costs ~1.9 s at 100k on
 * hosted (linear in N: 175 ms at 10k). The lever, when the archive gets there, is a
 * btree pre-filter before the scan — `where galaxy_id = ?` takes it to 274 ms — but it
 * would confine the row to the finding's own galaxy, which CHANGES what comes back. That
 * is a product call, not a performance one, and it is not made here.
 */
export async function getSimilarFindings(idOrLogId: string, limit = 6): Promise<TrackListItem[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  const targetResult = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select tracks.track_id, tracks.embedding_json from ${FINDINGS_FROM}
          where tracks.track_id = ? or findings.log_id = ? limit 1`,
  });
  const targetRow = typedRow<{ embedding_json: string | null; track_id: string }>(
    targetResult.rows,
  );

  if (!targetRow) {
    return [];
  }

  const target = parseEmbedding(targetRow.embedding_json);

  if (!target) {
    return [];
  }

  // The probe rides as raw f32 bytes, NOT as a JSON string — a 14x cliff on hosted that
  // does not reproduce locally (embedding.ts, `toVectorProbe`).
  const probe = toVectorProbe(target);
  // Args bind in SQL-TEXT order, and the probe's `?` is written before the subquery's:
  // probe, then the excluded target, then the limit. `where vec is not null` filters the
  // un-embedded/malformed rows BEFORE `vector_distance_cos` ever sees them (it throws on
  // a NULL rather than returning one).
  const rankedResult = await db.execute({
    args: [probe, targetRow.track_id, limit],
    sql: `select track_id, vector_distance_cos(vec, ?) as dist
          from (
            select tracks.track_id as track_id, ${embeddingVectorSql()} as vec
            from ${FINDINGS_FROM}
            where findings.log_id is not null and tracks.track_id != ?
          )
          where vec is not null
          order by dist asc, track_id asc
          limit ?`,
  });

  const topIds = typedRows<{ track_id: string }>(rankedResult.rows).map((row) => row.track_id);

  if (topIds.length === 0) {
    return [];
  }

  // Hydrate the winners in ONE batched query, then re-order to the ranking (the map
  // is by trackId, unordered). A winner that vanished between the two reads is dropped.
  const byId = await getTracksByIds(topIds);

  return topIds.flatMap((id) => {
    const item = byId[id];
    return item ? [item] : [];
  });
}

// ── `/mix`: the catalogue-aware rail ─────────────────────────────────────────
//
// THE JOIN IS A LEFT JOIN, and that one word is most of this feature. Every other read in
// this file drives through `FINDINGS_FROM` (an INNER join), because every other surface is
// about findings — the things Fluncle has been to. `/mix` is the first surface that is
// about the MUSIC: a track is mixable if it has a key and a vector, and whether Fluncle
// ever certified it has no bearing on whether it beatmatches. So the rail scans
// `MIX_FROM`, and an uncertified track competes on exactly the same terms as a finding.
//
// That is what makes the tool get BETTER as the archive grows rather than merely bigger,
// and it is the whole reason the catalogue is worth crawling.
const MIX_FROM = `tracks left join findings on findings.track_id = tracks.track_id`;

// The columns `MixTrackSchema` needs — deliberately tiny. A `/mix` row is a small honest
// shape (title, artists, cover, the two chips, and whether it is certified), not a
// `TrackListItem`: there is no note, no video, no galaxy here to leak into the unlit
// register, because they are not selected. `log_id` is the ONLY certification signal, and
// both `certified` and `logId` are read off it, so they cannot disagree.
const MIX_TRACK_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album_image_url,
  tracks.spotify_url, tracks.apple_music_url, tracks.duration_ms, tracks.bpm, tracks.key, findings.log_id`;

type MixTrackRow = {
  album_image_url: string | null;
  // NULL until the Apple ISRC backfill resolves it (or Apple has no match) — the Apple twin of
  // spotify_url below. An unlit /mix row shows whichever listen-out glyphs it actually has.
  apple_music_url: string | null;
  artists_json: string;
  bpm: number | null;
  duration_ms: number;
  key: string | null;
  log_id: string | null;
  // NULL for a crawler-minted catalogue row (MusicBrainz-born; Spotify is a per-track
  // ISRC anchor, not a guarantee). Typing this `string` once let a NULL sail into a
  // required schema field and 500 the whole /mix rail the day the first crawled track
  // was analyzed into rankability.
  spotify_url: string | null;
  title: string;
  track_id: string;
};

/**
 * A `MIX_FROM` row → the wire DTO. THE UNLIT RULE, in three lines: `certified` is
 * `Boolean(log_id)` and `logId` is `log_id ?? undefined`, so a row without a coordinate is
 * uncertified and an uncertified row has no coordinate — one column, one truth, no way for
 * a caller to construct a catalogue row that shows a Log ID. The tier is never named.
 */
function toMixTrackDTO(row: MixTrackRow): MixTrackDTO {
  return {
    albumImageUrl: row.album_image_url ?? undefined,
    appleMusicUrl: row.apple_music_url ?? undefined,
    artists: parseArtistsJson(row.artists_json),
    bpm: row.bpm ?? undefined,
    certified: Boolean(row.log_id),
    durationMs: row.duration_ms,
    key: row.key ?? undefined,
    logId: row.log_id ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

// A candidate/target row for the mixability engine: the four scoring columns + its ids.
type MixRow = {
  bpm: number | null;
  embedding_json: string | null;
  features_json: string | null;
  key: string | null;
  log_id: string | null;
  track_id: string;
};

// A `/mix` CANDIDATE row. The vector itself never crosses the wire: the database
// reports only whether the track HAS one (`has_embedding`, feeding the coverage gate)
// and its cosine DISTANCE to the target (`sonic_dist` — null when either side has no
// vector), which `cosineFromDistance` turns back into the cosine the engine scores.
type MixCandidateRow = Omit<MixRow, "embedding_json"> & {
  has_embedding: number | null;
  sonic_dist: number | null;
};

// ── The depth gate ───────────────────────────────────────────────────────────

// The gate is a property of the whole archive, so it is the same answer for every reader,
// and it moves only when a track is keyed. Memoized per isolate for a minute: `/mix` asks
// on every load, and the honest cost of a cache miss is one index-only `group by`.
const DEPTH_TTL_MS = 60_000;
let depthCache: { at: number; value: MixChainDepth } | null = null;

/**
 * Measure whether the archive is deep enough for `/mix` to be worth opening to a stranger
 * (`mixChainDepth` — the median track's named-move neighbourhood against a floor of one of
 * Fluncle's own sets plus a full rail).
 *
 * ONE `group by key` over `tracks_key_idx` — 24-ish distinct values, answered from the
 * index without touching the table. Every keyed track counts, certified or not: a catalogue
 * track is rankable the moment it has a key, so it is depth, which is exactly the claim the
 * gate exists to test.
 */
export async function getMixChainDepth(): Promise<MixChainDepth> {
  const now = Date.now();

  if (depthCache && now - depthCache.at < DEPTH_TTL_MS) {
    return depthCache.value;
  }

  const db = await getDb();
  const result = await db.execute(
    `select key, count(*) as count from tracks where key is not null group by key`,
  );
  const rows = typedRows<{ count: number; key: string | null }>(result.rows);
  const value = mixChainDepth(rows);

  depthCache = { at: now, value };

  return value;
}

// ── The candidate pre-filter ─────────────────────────────────────────────────

/**
 * The archive's stored key SPELLINGS that sit a named harmonic move from `from` — the
 * `key in (…)` pre-filter's argument list.
 *
 * It reads the archive's own spellings rather than generating them, and that is the point:
 * `tracks.key` is scale text written by several hands (the DSP writes sharps, Rekordbox may
 * not, an operator may type a flat), and a hand-built reverse map would silently drop every
 * spelling it failed to predict. Folding the DISTINCT keys the archive actually holds
 * through the same tolerant `parseKey` the engine uses cannot drift from it. The distinct
 * list is 24-ish rows off `tracks_key_idx`, and it is the same read the depth gate makes.
 *
 * THIS IS A SCORING DECISION, not a performance fix, and it is made deliberately. The old
 * scan ranked EVERY keyed row and let distant keys surface when the archive was too sparse
 * to offer better. The rail no longer does that: a `distant` pair is not a move a DJ makes
 * on purpose, and the rail's promise — everything on it mixes clean — is worth more than a
 * full-looking list. The gate is what makes it safe: it opens only once the median track has
 * a named move to 29 others, so the neighbourhood the rail serves is exactly the
 * neighbourhood the gate measured. One definition of "what can follow this", used by both.
 */
async function namedMoveKeys(from: Camelot): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute(`select distinct key from tracks where key is not null`);
  const wanted = new Set(namedMoveClasses(from).map(({ letter, number }) => `${number}${letter}`));

  return typedRows<{ key: string | null }>(result.rows).flatMap((row) => {
    const code = keyToCamelotCode(row.key);

    return row.key && code && wanted.has(code) ? [row.key] : [];
  });
}

/** The Camelot position of a scale-text key, or null when it is absent/unparseable. */
function camelotOfKey(key: string | null): Camelot | null {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

// ── Taste (the seed) ─────────────────────────────────────────────────────────

/** At most this many tracks per seeded artist become probes (see `getTasteProbes`). */
const PROBES_PER_ARTIST = 3;
/** The hard cap on the probe set, whatever the seed's size (see `getTasteProbes`). */
const MAX_TASTE_PROBES = 24;

/**
 * The seed, as vectors: up to {@link PROBES_PER_ARTIST} embedded tracks per seeded artist,
 * capped at {@link MAX_TASTE_PROBES} overall.
 *
 * CAPPED, because taste is max-similarity and max-similarity costs a distance per (candidate
 * × probe). Uncapped, a reader who seeds an artist with 200 catalogue tracks turns the rail
 * into a cross join. Capped, the whole taste stage is `probes × TASTE_SHORTLIST` ≈ 7k
 * distance ops inside the database — less than one tick of The Ear's sweep.
 *
 * The cap does NOT collapse the seed's shape, which is the thing that would have broken it.
 * Three tracks per artist keeps every artist the reader named represented by their own
 * vectors, so max-sim still lets each of them win on their own ground (`tasteSubScore`); a
 * per-artist MEAN would have been the centroid this design exists to refuse, at artist
 * granularity. Certified tracks are preferred as probes — they are the ones whose audio
 * Fluncle has actually captured and analysed end to end — then the most popular.
 */
async function getTasteProbes(artistSlugs: string[]): Promise<Uint8Array[]> {
  const slugs = [...new Set(artistSlugs.map((slug) => slug.trim()).filter(Boolean))];

  if (slugs.length === 0) {
    return [];
  }

  const db = await getDb();
  const placeholders = slugs.map(() => "?").join(", ");

  // One query, one row per (artist, track) — ranked inside SQL, so only the survivors cross
  // the wire. The vectors DO come back here (they are the probes; they must), but there are
  // at most `MAX_TASTE_PROBES` of them, which is the whole reason for the cap.
  const result = await db.execute({
    args: slugs,
    sql: `select vec from (
            select ${embeddingVectorSql()} as vec,
                   row_number() over (
                     partition by artists.id
                     order by (findings.track_id is not null) desc, tracks.popularity desc
                   ) as rank
            from artists
            join track_artists on track_artists.artist_id = artists.id
            join tracks on tracks.track_id = track_artists.track_id
            left join findings on findings.track_id = tracks.track_id
            where artists.slug in (${placeholders})
              and tracks.key is not null
              and (tracks.embedding_blob is not null or tracks.embedding_json is not null)
          )
          where rank <= ${PROBES_PER_ARTIST} and vec is not null
          limit ${MAX_TASTE_PROBES}`,
  });

  return result.rows.flatMap((row) => {
    const vector = readEmbeddingBlob((row as unknown as { vec: unknown }).vec);

    return vector ? [toVectorProbe(vector)] : [];
  });
}

/**
 * Each shortlisted track's TASTE cosine — its similarity to the NEAREST probe (`min` over the
 * cosine DISTANCES is the max over the similarities). Ranked in SQL: the shortlist's vectors
 * never enter the isolate, only one number per row comes back.
 *
 * One `union all` branch per probe over a shortlist CTE, so each probe binds ONCE as a raw
 * float32 blob — never as text (the 14× hosted cliff; embedding.ts). Bounded by construction:
 * ≤ `MAX_TASTE_PROBES × TASTE_SHORTLIST` distances.
 */
async function getTasteCosines(
  trackIds: string[],
  probes: Uint8Array[],
): Promise<Map<string, number>> {
  if (trackIds.length === 0 || probes.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const ids = trackIds.map(() => "?").join(", ");
  const branches = probes
    .map(() => `select track_id, vector_distance_cos(vec, ?) as dist from shortlist`)
    .join(" union all ");

  const result = await db.execute({
    // SQL-TEXT order: the shortlist's ids bind inside the CTE, then one probe per branch.
    args: [...trackIds, ...probes],
    sql: `with shortlist as (
            select track_id, ${embeddingVectorSql()} as vec
            from tracks
            where track_id in (${ids}) and (embedding_blob is not null or embedding_json is not null)
          )
          select track_id, min(dist) as dist
          from (${branches})
          where dist is not null
          group by track_id`,
  });

  const byTrackId = new Map<string, number>();

  for (const row of typedRows<{ dist: number | null; track_id: string }>(result.rows)) {
    const cos = cosineFromDistance(row.dist);

    if (cos !== null) {
      byTrackId.set(row.track_id, cos);
    }
  }

  return byTrackId;
}

/**
 * The tracks that mix cleanly OUT of the given one, ranked by the mixability engine
 * (`mixability.ts`) — the rail behind `/mix` and the public `list_mixable_tracks` op.
 *
 * CANDIDATES ARE THE WHOLE ARCHIVE (`MIX_FROM`, a LEFT join), not just the findings: the key
 * is the engine's mandatory floor, so any keyed track is rankable, and a catalogue track
 * competes for the rail on the same terms as a certified one. Each result carries its
 * `certified` bit for the REGISTER it renders in (DESIGN.md's Unlit Rule) and nothing more —
 * the tier is never named on the wire, never labelled on the page.
 *
 * THE VECTORS STAY IN THE DATABASE. The scan computes each candidate's cosine to the target
 * with `vector_distance_cos` (the probe bound as a RAW BLOB — embedding.ts, `toVectorProbe`)
 * and each row carries back a single number, rather than 21 KB of vector per candidate. It is
 * pre-filtered by `key in (…)` to the ~8 Camelot classes a NAMED harmonic move can reach
 * (`namedMoveKeys` — read its comment; that is a scoring decision, argued there), which is the
 * ratified "btree pre-filter ahead of an exact vector scan" shape and the only reason this
 * survives a five-figure catalogue.
 *
 * TASTE, when `artistSlugs` is seeded: the engine shortlists the `TASTE_SHORTLIST` cleanest
 * mixes, SQL scores each one's similarity to the nearest seeded artist's track, and the rail
 * is re-ranked by mixability × taste (`railScore`). Everything on the rail still mixes clean —
 * taste only chooses among the clean ones.
 *
 * `exclude` drops the already-chained tracks SERVER-SIDE (Log IDs and/or Spotify track ids,
 * mixed freely — a chain now holds both kinds) so a deep chain can't silently empty the rail.
 * Each result carries its `reason` chip, never a numeric score (§3.0 invariant). Returns `[]`
 * (never throws) for an unknown coordinate, a target with no key, or an empty archive.
 */
export async function getMixableTracks(
  idOrLogId: string,
  options: { artistSlugs?: string[]; exclude?: string[]; limit?: number } = {},
): Promise<MixCandidateDTO[]> {
  const limit = options.limit ?? RAIL_DEPTH;

  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  const targetResult = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select tracks.track_id, findings.log_id, tracks.key, tracks.bpm,
                 tracks.embedding_json, tracks.features_json
          from ${MIX_FROM}
          where tracks.track_id = ? or findings.log_id = ? limit 1`,
  });
  const targetRow = typedRow<MixRow>(targetResult.rows);

  if (!targetRow) {
    return [];
  }

  // The key is the engine's floor (`scoreMix`: a pair whose key we do not know is a pair we
  // cannot justify), so a target with no key has no rail — and no pre-filter either.
  const targetCamelot = camelotOfKey(targetRow.key);

  if (!targetCamelot) {
    return [];
  }

  const keys = await namedMoveKeys(targetCamelot);

  if (keys.length === 0) {
    return [];
  }

  // The target's vector becomes the probe. When it has none, every pair's sonic term is
  // null anyway, so the scan skips the distance work entirely.
  const targetEmbedding = parseEmbedding(targetRow.embedding_json);
  const probe = targetEmbedding ? toVectorProbe(targetEmbedding) : null;

  // A chain holds findings AND catalogue tracks, so an exclusion may arrive as either kind
  // of token. Split them and exclude on both columns.
  const excluded = [...new Set((options.exclude ?? []).map((id) => id.trim()).filter(Boolean))];
  const excludedLogIds = excluded.filter((id) => isLogId(id));
  const excludedTrackIds = excluded.filter((id) => !isLogId(id));

  const keyClause = keys.map(() => "?").join(", ");
  const logIdClause =
    excludedLogIds.length > 0
      ? `and (findings.log_id is null or findings.log_id not in (${excludedLogIds.map(() => "?").join(", ")}))`
      : "";
  const trackIdClause =
    excludedTrackIds.length > 0
      ? `and tracks.track_id not in (${excludedTrackIds.map(() => "?").join(", ")})`
      : "";

  const distanceSql = probe ? `vector_distance_cos(vec, ?)` : `null`;
  const candidateResult = await db.execute({
    // SQL-TEXT order decides the bind order, and the probe's `?` is in the OUTER select —
    // which is textually BEFORE the inner subquery — so the probe binds FIRST, then the
    // inner WHERE's keys, target, and exclusions in the order they appear. (Getting this
    // backwards binds a key string into `vector_distance_cos`, a SQLITE_ERROR hosted and a
    // silent wrong answer locally.)
    args: [
      ...(probe ? [probe] : []),
      ...keys,
      targetRow.track_id,
      ...excludedLogIds,
      ...excludedTrackIds,
    ],
    sql: `select track_id, log_id, key, bpm, features_json, has_embedding,
                 case when vec is null then null else ${distanceSql} end as sonic_dist
          from (
            select tracks.track_id as track_id, findings.log_id as log_id, tracks.key as key,
                   tracks.bpm as bpm, tracks.features_json as features_json,
                   (tracks.embedding_blob is not null or tracks.embedding_json is not null)
                     as has_embedding,
                   ${embeddingVectorSql()} as vec
            from ${MIX_FROM}
            where tracks.key in (${keyClause})
              and tracks.track_id != ? ${logIdClause} ${trackIdClause}
          )`,
  });

  const candidateRows = typedRows<MixCandidateRow>(candidateResult.rows);
  const candidates: RankCandidate<string>[] = candidateRows.map((row) => ({
    item: row.track_id,
    // The database already answered the sonic question for this pair; `null` here means
    // "no comparable vector", exactly as a null embedding meant before.
    sonicCos: probe ? cosineFromDistance(row.sonic_dist) : null,
    track: toMixTrack({ ...row, embedding_json: null }),
  }));

  // The sonic-term gate is a global archive property: count the embedded tracks in play
  // (candidates + the target when embedded) and open the gate only past the floor.
  const embeddedCount =
    candidateRows.filter((row) => Boolean(row.has_embedding)).length +
    (targetRow.embedding_json !== null ? 1 : 0);
  const gateOpen = sonicGateOpen(embeddedCount);
  const target = toMixTrack(targetRow);

  const probes = await getTasteProbes(options.artistSlugs ?? []);

  // Un-seeded: rank straight to the rail. Seeded: shortlist the cleanest mixes, score each
  // one's taste in SQL, and re-rank by mixability × taste.
  const ranked =
    probes.length === 0
      ? rankMixable(target, candidates, limit, { gateOpen })
      : await (async () => {
          const shortlist = shortlistMixable(target, candidates, TASTE_SHORTLIST, { gateOpen });
          const cosines = await getTasteCosines(
            shortlist.map((entry) => entry.item),
            probes,
          );

          return applyTaste(
            shortlist,
            (trackId) => tasteSubScore(cosines.get(trackId) ?? null),
            limit,
          );
        })();

  if (ranked.length === 0) {
    return [];
  }

  const byId = await getMixTracksByIds(ranked.map((entry) => entry.item));

  return ranked.flatMap((entry) => {
    const item = byId[entry.item];

    return item ? [{ ...item, reason: entry.reason }] : [];
  });
}

// ── The `/mix` hydrates ──────────────────────────────────────────────────────

/** Hydrate `/mix` rows by `track_id`, keyed for O(1) lookup. Certified or not. */
async function getMixTracksByIds(trackIds: string[]): Promise<Record<string, MixTrackDTO>> {
  const unique = [...new Set(trackIds.filter((id) => id.trim()))];

  if (unique.length === 0) {
    return {};
  }

  const db = await getDb();
  const result = await db.execute({
    args: unique,
    sql: `select ${MIX_TRACK_SELECT} from ${MIX_FROM}
          where tracks.track_id in (${unique.map(() => "?").join(", ")})`,
  });

  const byTrackId: Record<string, MixTrackDTO> = {};

  for (const row of typedRows<MixTrackRow>(result.rows)) {
    byTrackId[row.track_id] = toMixTrackDTO(row);
  }

  return byTrackId;
}

/**
 * Hydrate a `?set=` chain from its tokens, IN ORDER. A token is a finding's Log ID or — for a
 * track Fluncle never certified, which has no coordinate to name it by — its Spotify track id.
 * One query for both kinds; a token that resolves to nothing drops silently (a set link
 * outlives the archive it was built from, and a vanished row should thin the chain, not 500
 * the page).
 */
export async function getMixTracksByTokens(tokens: string[]): Promise<MixTrackDTO[]> {
  const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];

  if (unique.length === 0) {
    return [];
  }

  const logIds = unique.filter((token) => isLogId(token));
  const trackIds = unique.filter((token) => !isLogId(token));
  const clauses: string[] = [];

  if (logIds.length > 0) {
    clauses.push(`findings.log_id in (${logIds.map(() => "?").join(", ")})`);
  }
  if (trackIds.length > 0) {
    clauses.push(`tracks.track_id in (${trackIds.map(() => "?").join(", ")})`);
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...logIds, ...trackIds],
    sql: `select ${MIX_TRACK_SELECT} from ${MIX_FROM} where ${clauses.join(" or ")}`,
  });

  const byToken = new Map<string, MixTrackDTO>();

  for (const row of typedRows<MixTrackRow>(result.rows)) {
    const item = toMixTrackDTO(row);

    byToken.set(row.track_id, item);

    if (row.log_id) {
      byToken.set(row.log_id, item);
    }
  }

  // The URL is the order (a set is a sequence), so walk the tokens, not the result rows.
  return unique.flatMap((token) => {
    const item = byToken.get(token);

    return item ? [item] : [];
  });
}

// ── Taste-seeding: the artists, and what to open with ────────────────────────

/**
 * The artists a mix can be seeded from — every artist with at least one RANKABLE track (a key
 * and a vector), most-represented first, optionally filtered by name. The taste picker's grid.
 *
 * `trackCount` counts rankable tracks and NOT findings, because that is the honest measure of
 * what seeding this artist can actually do: an artist with 40 catalogue tracks Fluncle can
 * place is a better seed than one with a single certified finding, and the picker must not
 * pretend otherwise. See `list_mixable_artists` for why this is not `listArtists`.
 */
export async function listMixableArtists(
  options: { limit?: number; q?: string } = {},
): Promise<MixArtist[]> {
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const q = options.q?.trim() ?? "";
  const db = await getDb();

  const result = await db.execute({
    args: q ? [`%${q}%`, limit] : [limit],
    sql: `select artists.name as name, artists.slug as slug, artists.image_url as image_url,
                 count(*) as track_count
          from artists
          join track_artists on track_artists.artist_id = artists.id
          join tracks on tracks.track_id = track_artists.track_id
          where tracks.key is not null
            and (tracks.embedding_blob is not null or tracks.embedding_json is not null)
            ${q ? "and artists.name like ? collate nocase" : ""}
          group by artists.id
          order by track_count desc, artists.name asc
          limit ?`,
  });

  return typedRows<{
    image_url: string | null;
    name: string;
    slug: string;
    track_count: number;
  }>(result.rows).map((row) => ({
    imageUrl: row.image_url ?? undefined,
    name: row.name,
    slug: row.slug,
    trackCount: row.track_count,
  }));
}

/**
 * What to open a set with, given the seeded artists: their OWN rankable tracks, certified
 * first. See `list_mix_openers` for why this is the artists' tracks rather than a taste-ranked
 * sweep of the archive (exact beats inferred, and a stranger can VERIFY this list at a glance).
 *
 * Certified first is not a ranking of quality — it is a ranking of AFFORDANCE: a finding has
 * somewhere to send you (`/log`), and putting the rows that can show you around at the top of a
 * stranger's very first list is how they discover there is a Fluncle here at all. Within each
 * register, the most popular. Uncertified rows below them carry no label and no heading; the
 * list is a mixed one, and its heading names the SUPERSET (the Unlit Rule).
 */
export async function getMixOpeners(
  artistSlugs: string[],
  options: { limit?: number } = {},
): Promise<MixTrackDTO[]> {
  const slugs = [...new Set(artistSlugs.map((slug) => slug.trim()).filter(Boolean))];
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 60);

  if (slugs.length === 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...slugs, limit],
    sql: `select distinct ${MIX_TRACK_SELECT}
          from ${MIX_FROM}
          join track_artists on track_artists.track_id = tracks.track_id
          join artists on artists.id = track_artists.artist_id
          where artists.slug in (${slugs.map(() => "?").join(", ")})
            and tracks.key is not null
            and (tracks.embedding_blob is not null or tracks.embedding_json is not null)
          order by (findings.log_id is not null) desc, tracks.popularity desc
          limit ?`,
  });

  return typedRows<MixTrackRow>(result.rows).map(toMixTrackDTO);
}

/** One ordered stop in a proposed mix (the admin dream-weaver's output row). */
export type MixOrderStop = {
  artists: string[];
  bpm?: number;
  flagged: boolean;
  key?: string;
  logId: string;
  title: string;
  transitionReason?: MixReason;
  transitionScore?: number;
};

/** The dream-weaver's full result: the ordered stops + total cost + which algorithm ran. */
export type MixableOrderResult = {
  algorithm: "held-karp" | "greedy-2opt";
  order: MixOrderStop[];
  totalCost: number;
};

/**
 * Order a pool of findings (by Log ID) into a smoothness-optimized proposed mix —
 * Product B's dream-weaver, a PURE admin READ (never writes). Held-Karp exact for
 * ≤16, greedy + 2-opt to 64. `seedLogId` pins the first stop. Every `transitionScore`
 * describes the edge INTO its stop (the first stop's is undefined). An unknown Log ID
 * is a clean fault (the caller lists what didn't resolve), never a silent mis-order.
 */
export async function getMixableOrder(
  logIds: string[],
  options: { seedLogId?: string } = {},
): Promise<MixableOrderResult> {
  const unique = [...new Set(logIds.filter((id) => id.trim()))];

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const result = await db.execute({
    args: unique,
    sql: `select tracks.track_id, findings.log_id, tracks.key, tracks.bpm,
                 tracks.embedding_json, tracks.features_json, tracks.title, tracks.artists_json
          from ${FINDINGS_FROM} where findings.log_id in (${placeholders})`,
  });

  const rowByLogId = new Map<string, MixRow & { artists_json: string; title: string }>();

  for (const row of typedRows<MixRow & { artists_json: string; title: string }>(result.rows)) {
    if (row.log_id) {
      rowByLogId.set(row.log_id, row);
    }
  }

  const missing = unique.filter((id) => !rowByLogId.has(id));

  if (missing.length > 0) {
    throw new MixableOrderError(`No finding for ${missing.join(", ")}`);
  }

  const ordered = unique.map((id) => {
    const row = rowByLogId.get(id);

    if (!row) {
      throw new MixableOrderError(`No finding for ${id}`);
    }

    return row;
  });

  const tracks = ordered.map((row) => toMixTrack(row));
  const embeddedCount = ordered.filter((row) => row.embedding_json !== null).length;
  const gateOpen = sonicGateOpen(embeddedCount);

  const seedIndex = options.seedLogId !== undefined ? unique.indexOf(options.seedLogId) : -1;

  const path = orderMixPath(tracks, {
    gateOpen,
    seedIndex: seedIndex >= 0 ? seedIndex : undefined,
  });

  const order: MixOrderStop[] = path.order.map((trackIndex, position) => {
    const row = ordered[trackIndex];
    const from = position > 0 ? tracks[path.order[position - 1] ?? -1] : undefined;
    const to = tracks[trackIndex];
    const edge = from && to ? scoreMix(from, to, { gateOpen }) : undefined;

    return {
      artists: row ? parseArtistsJson(row.artists_json) : [],
      bpm: row?.bpm ?? undefined,
      flagged: position > 0 ? (edge?.score ?? null) === null : false,
      key: row?.key ?? undefined,
      logId: row?.log_id ?? "",
      title: row?.title ?? "",
      transitionReason: edge?.reason ?? undefined,
      transitionScore: edge?.score ?? undefined,
    };
  });

  return { algorithm: path.algorithm, order, totalCost: path.totalCost };
}

/** A resolvable-input fault the `get_mixable_order` handler maps to a 400. */
export class MixableOrderError extends Error {}

/**
 * The findings in one sonic galaxy, ordered by centroid-distance ASCENDING — the core
 * of the galaxy first (browse-by-feel RFC). The DATABASE cosine-ranks every member's
 * MuQ vector against the galaxy's stored centroid and returns just the requested page,
 * in that deterministic order (the order a future radio consumer needs). Backs the
 * public `get_galaxy` op + the `/galaxies/<slug>` lens. Returns `[]` when the galaxy has
 * no members. The caller (`galaxies-map.ts`) public-strips the items.
 *
 * This is the spike's PRE-FILTERED shape, and the cheapest of the three: the `galaxy_id`
 * btree narrows the scan to one cluster's members before a single vector is touched
 * (274 ms at 100k on hosted, against ~1.9 s unfiltered). Paging happens in SQL, so the
 * isolate never holds more than a page. A member with no readable vector (shouldn't
 * happen — assignment requires one) sorts LAST, as it did when it scored −Infinity.
 */
export async function getFindingsByGalaxyRanked(
  galaxyId: string,
  centroid: number[],
  limit: number,
  offset: number,
): Promise<TrackListItem[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  // Args in SQL-TEXT order: the subquery's galaxy id is written before the ORDER BY's
  // probe, so it binds first. The `case` around the distance is what keeps
  // `vector_distance_cos` from ever seeing a NULL (it throws on one).
  const probe = toVectorProbe(centroid);
  const pageResult = await db.execute({
    args: [galaxyId, probe, limit, offset],
    sql: `select track_id from (
            select tracks.track_id as track_id, ${embeddingVectorSql()} as vec
            from ${FINDINGS_FROM}
            where findings.galaxy_id = ? and findings.log_id is not null
          )
          order by (vec is null) asc,
                   case when vec is not null then vector_distance_cos(vec, ?) end asc,
                   track_id asc
          limit ? offset ?`,
  });

  const pageIds = typedRows<{ track_id: string }>(pageResult.rows).map((row) => row.track_id);

  if (pageIds.length === 0) {
    return [];
  }

  const byId = await getTracksByIds(pageIds);

  return pageIds.flatMap((id) => {
    const item = byId[id];
    return item ? [item] : [];
  });
}

/**
 * Which of the given tracks already carry a MuQ audio embedding (`embedding_json IS
 * NOT NULL`). Returns the trackIds that have one as a Set — the admin board turns it
 * into the Embeddings cell status. The embedding vector is INTERNAL analysis fuel: it
 * never rides the public `TrackListItem` contract (only its presence, admin-only, and
 * the derived `get_similar_findings` neighbours do), so the board reads it through
 * this gated path like `context_note`. One batch query for the whole page, no N+1.
 * See docs/track-lifecycle.md.
 */
export async function listEmbeddingPresenceForTracks(trackIds: string[]): Promise<Set<string>> {
  if (trackIds.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id from tracks
          where track_id in (${placeholders})
            and embedding_json is not null`,
  });

  return new Set(typedRows<{ track_id: string }>(result.rows).map((row) => row.track_id));
}

type TrackCountRow = {
  total_count: number;
};

/**
 * How long a track may sit in `processing` before the enrich-queue treats it as
 * stuck (the box rebooted mid-run, etc.) and re-picks it. Enrichment is a
 * multi-minute job, so 30 min is comfortably longer than a healthy run; a row
 * that's been "processing" past it is presumed dead, not in-flight. The
 * idempotency key (`enrich:${logId}`) makes a wrongly-early re-pick harmless —
 * an in-flight run is de-duped rather than duplicated.
 */
export const ENRICH_STALE_PROCESSING_MS = 30 * 60 * 1000;

// The full-song capture queue's BACKOFF (RFC full-audio § Unit 1). A `failed` finding is
// held out of the queue until `source_audio_attempted_at` is older than the cooldown, and
// is dropped entirely once `source_audio_failures` reaches the cap — so a persistently
// failing finding stops re-attempting every tick (and, under newest-first order, stops
// pinning the batch slots + burning proxy bandwidth). `pending`/NULL are always eligible.
export const CAPTURE_FAILED_COOLDOWN_MS = 60 * 60 * 1000;
export const CAPTURE_MAX_FAILURES = 8;

/**
 * Enrichment state filters. The four are the real `enrichment_status` values;
 * `"queue"` is the SELF-HEALING meta-filter the sweep uses: tracks NEEDING
 * (re-)enrichment = pending ∪ failed ∪ STALE processing (a `processing` row
 * older than ENRICH_STALE_PROCESSING_MS, including rows with no updated_at).
 * Filtering on only pending/failed would never re-pick a box-rebooted
 * `processing` track — the most common failure — so "queue" must include it.
 */
export type EnrichmentStatusFilter = "pending" | "processing" | "done" | "failed" | "queue";

export const ENRICHMENT_STATUS_FILTERS: readonly EnrichmentStatusFilter[] = [
  "pending",
  "processing",
  "done",
  "failed",
  "queue",
];

type ListTracksOptions = {
  /**
   * The full-song CAPTURE queue's filter (admin only) — the `fluncle-capture`
   * cron's worklist. `true` = findings still NEEDING a capture: `pending`/NULL always
   * eligible (the NULL arm is defensive — the column is notNull-default, but a pre-column
   * row reads NULL), a terminal `unmatched`/`done` never re-burned, and a `failed` row
   * BACKED OFF (re-picked only past the cooldown + below the failure cap —
   * CAPTURE_FAILED_COOLDOWN_MS / CAPTURE_MAX_FAILURES). Coordinate-less rows are excluded
   * (`log_id is not null`). This is a SEPARATE queue: capture never gates the enrich/embed
   * queues (RFC full-audio § "Capture does NOT gate the analysis queues"). The capture
   * cron pairs it with `order: "desc"` so a fresh add jumps ahead of the backfill. Omitted
   * for public reads.
   */
  captureQueue?: boolean;
  cursor?: TrackCursor;
  /**
   * Context-fetch state (admin only) — the `context_track` queue's filter.
   * `false` = the queue: findings still NEEDING a context fetch. Status-aware so a
   * CONFIRMED-EMPTY fetch is not re-burned every tick: it matches `context_status`
   * pending ∪ failed ∪ NULL (never-attempted rows that predate the column read NULL
   * and count as pending), but NOT `empty`/`resolved`. `true` = already resolved
   * (`context_note IS NOT NULL`). Internal field, never surfaced; omitted for
   * public reads. Pair `false` with `retryEmptyContext` to also re-pick `empty`.
   */
  hasContext?: boolean;
  /**
   * Audio-embedding presence (admin only) — the MuQ embed queue's filter.
   * `false` = the embed worklist: `embedding_json IS NULL` AND a captured source key
   * on file (`source_audio_key IS NOT NULL`), since MuQ embeds the CAPTURED full song,
   * not a preview or the unmatched tail (RFC full-audio § Unit 3) — a keyless finding is
   * excluded. `true` = a vector is on file (a pure presence check, no key gate). Omitted
   * for public reads. Mirrors `hasVideo`/`hasKey`'s tri-state. See docs/track-lifecycle.md.
   */
  hasEmbedding?: boolean;
  /**
   * Observation presence (admin only) — the observation queue's filter.
   * `false` = `observation_audio_url IS NULL` (no spoken observation yet);
   * `true` = already minted. The observation queue is `hasContext=true AND
   * hasObservation=false`. Omitted for public reads.
   */
  hasObservation?: boolean;
  /**
   * Editorial-note presence (admin only) — the auto-note queue's filter.
   * `false` = `note IS NULL OR note = ''` (no editorial note yet — the queue);
   * `true` = a note is on file. The note queue is `hasContext=true AND hasNote=false`
   * (a finding with the context_note fuel but no written note yet). Omitted for
   * public reads.
   */
  hasNote?: boolean;
  /**
   * Musical-key presence (admin only) — the Rekordbox sync's queue.
   * `false` = `key IS NULL` (no stored key yet: the DSP left it null below its
   * confidence floor — the missing-key backlog the sync targets); `true` = a
   * key is on file. Omitted for public reads. Mirrors `hasVideo`'s tri-state.
   */
  hasKey?: boolean;
  /** Only findings with a rendered video — the Stories feed's filter. */
  hasVideo?: boolean;
  includeMixtapes?: boolean;
  /**
   * Read the LEAN list projection (Finding B4) — drop the three heavy per-row fields
   * (`features`, `observationAlignment`, `videoModelReasoning`) that no PUBLIC list
   * surface renders. Set on the public list ops + the SSR feed loaders; omitted (fat)
   * for the admin board, the queue sweeps, and MCP, which read those fields. Additive:
   * a lean item is still a `TrackListItem` (the three are optional), just carrying them
   * undefined.
   */
  lean?: boolean;
  limit: number;
  /**
   * Found-order direction. "desc" (newest-first) is the public default; the
   * admin tagging queue passes "asc" to work the oldest unlabelled finds first.
   */
  order?: "asc" | "desc";
  /**
   * Widen the `hasContext=false` context queue to also re-pick CONFIRMED-EMPTY
   * finds (`context_status = 'empty'`) — the `--retry-empty` escape hatch for when
   * a query/source fix means a previously-hopeless find might now resolve. No
   * effect unless `hasContext === false`. Omitted for public reads.
   */
  retryEmptyContext?: boolean;
  since?: string;
  /**
   * Enrichment-state filter (admin only). A bare status matches that exact
   * `enrichment_status`; "queue" matches everything needing (re-)enrichment —
   * pending ∪ failed ∪ stale processing — and is what the enrich-queue + sweep
   * read. Omitted for public reads.
   */
  status?: EnrichmentStatusFilter;
  until?: string;
};

/**
 * Group `artist_socials` YouTube URLs (each joined to a finding via `track_artists`)
 * by `track_id` into that finding's DEDUPED list of `UC…` channel ids — the capture
 * queue's artist-own-channel trust signal. Each URL runs through
 * `extractYoutubeChannelId`, so a `/user/<name>` or `/@handle` link (no directly usable
 * channel id) contributes nothing; a finding left with no channel id is simply absent
 * from the returned map. PURE (no DB) so the grouping/dedupe is unit-testable.
 */
export function groupArtistYoutubeChannelIds(
  rows: { track_id: string; url: string }[],
): Map<string, string[]> {
  const byTrack = new Map<string, string[]>();

  for (const row of rows) {
    const channelId = extractYoutubeChannelId(row.url);

    if (!channelId) {
      continue;
    }

    const existing = byTrack.get(row.track_id);

    if (!existing) {
      byTrack.set(row.track_id, [channelId]);
    } else if (!existing.includes(channelId)) {
      existing.push(channelId);
    }
  }

  return byTrack;
}

/**
 * Read every listed track's artists' YouTube `UC…` channel ids in ONE batched query,
 * grouped by `track_id` — the capture queue's artist-own-channel trust signal. Kept off
 * the shared `TRACK_SELECT`/`toTrackListItem` path (every other consumer) so a correlated
 * subquery does not bloat every DTO. Bound params only — the track ids are never
 * interpolated. `status` does not gate (any known artist YouTube link is a valid
 * own-channel signal for capture). A track whose artists have no `/channel/UC…` link is
 * simply absent from the returned map — an empty set is omitted, never surfaced as `[]`.
 *
 * Shared by the finding-only capture queue (`attachArtistYoutubeChannelIds` below) and the
 * catalogue-aware `list_track_work` capture worklist (track-work.ts), so the two cannot drift.
 */
export async function readArtistYoutubeChannelIdsByTrack(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (trackIds.length === 0) {
    return new Map();
  }

  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_artists.track_id as track_id, artist_socials.url as url
          from artist_socials
          join track_artists on track_artists.artist_id = artist_socials.artist_id
          where artist_socials.platform = 'youtube'
            and track_artists.track_id in (${placeholders})`,
  });

  return groupArtistYoutubeChannelIds(typedRows<{ track_id: string; url: string }>(result.rows));
}

/**
 * Attach `artistYoutubeChannelIds` to the capture-queue items IN PLACE, off the shared
 * batched read above. The full-song capture sweep reads this field as its strongest trust
 * tier: a candidate on the artist's OWN channel is the artist's own upload.
 */
async function attachArtistYoutubeChannelIds(
  db: Awaited<ReturnType<typeof getDb>>,
  items: TrackListItem[],
): Promise<void> {
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

export function listTracks(
  options: ListTracksOptions & { includeMixtapes: true },
): Promise<FeedListPage>;
export function listTracks(options: ListTracksOptions): Promise<TrackListPage>;
export async function listTracks({
  captureQueue,
  cursor,
  hasContext,
  hasEmbedding,
  hasKey,
  hasNote,
  hasObservation,
  hasVideo,
  includeMixtapes = false,
  lean = false,
  limit,
  order = "desc",
  retryEmptyContext = false,
  since,
  status,
  until,
}: ListTracksOptions): Promise<FeedListPage | TrackListPage> {
  const db = await getDb();

  // The lean list projection (Finding B4): the public list surfaces read a narrower
  // SELECT (no heavy caption/feature/reasoning columns) and map with the lean mapper.
  // A lean item is assignable to `TrackListItem`, so the merge/return types are unchanged.
  const trackSelect = lean ? LEAN_TRACK_SELECT : TRACK_SELECT;
  const mapRow: (row: TrackRow) => TrackListItem = lean ? toLeanTrackListItem : toTrackListItem;

  // Discovery-window and video filters; totalCount is scoped to the same
  // filters so a windowed caller (the newsletter agent) or the Stories feed
  // gets the matching count, while the homepage's unfiltered calls keep the
  // global archive count for numbering.
  const filterClauses: string[] = [];
  const filterArgs: string[] = [];

  if (since) {
    filterClauses.push("findings.added_at >= ?");
    filterArgs.push(since);
  }

  if (until) {
    filterClauses.push("findings.added_at < ?");
    filterArgs.push(until);
  }

  if (hasVideo === true) {
    filterClauses.push("findings.video_url is not null");
  } else if (hasVideo === false) {
    filterClauses.push("findings.video_url is null");
  }

  // The Rekordbox-sync queue: `key IS NULL` (no stored musical key — the DSP left it
  // null below its confidence floor). `true` = a key is on file. Mirrors hasVideo.
  if (hasKey === true) {
    filterClauses.push("tracks.key is not null");
  } else if (hasKey === false) {
    filterClauses.push("tracks.key is null");
  }

  // The MuQ embed queue (RFC full-audio § Unit 3): `embedding_json IS NULL` AND a
  // captured source key on file (`source_audio_key IS NOT NULL`) — the `fluncle-embed`
  // cron's worklist. The key gate is the point: MuQ embeds the CAPTURED full song, never
  // a preview or the unmatched tail, so a keyless finding is not embeddable yet and stays
  // out of the queue. `true` = a vector is already on file (a pure presence check — no key
  // gate; an embedded finding is done regardless of how it was captured). Mirrors hasKey.
  if (hasEmbedding === true) {
    filterClauses.push("tracks.embedding_json is not null");
  } else if (hasEmbedding === false) {
    filterClauses.push("tracks.embedding_json is null and tracks.source_audio_key is not null");
  }

  // The context queue. `true` = resolved (a note is stored). `false` = the work
  // queue: findings still needing a fetch — no note yet AND `context_status`
  // pending/failed/NULL (NULL = never-attempted rows that predate the column), but
  // NOT `empty` so a confirmed-empty find is not re-burned every tick. The
  // `context_note IS NULL` guard also keeps a legacy resolved-but-unmarked row (note
  // present, status NULL) out of the queue. `retryEmptyContext` widens it to also
  // re-pick `empty` (the `--retry-empty` escape hatch).
  if (hasContext === true) {
    filterClauses.push("findings.context_note is not null");
  } else if (hasContext === false) {
    filterClauses.push(
      retryEmptyContext
        ? "(findings.context_note is null and (findings.context_status is null or findings.context_status in ('pending', 'failed', 'empty')))"
        : "(findings.context_note is null and (findings.context_status is null or findings.context_status in ('pending', 'failed')))",
    );
  }

  // The observation queue: `observation_audio_url IS NULL` (no spoken
  // observation). Paired with hasContext=true it is the "ready to observe" queue.
  if (hasObservation === true) {
    filterClauses.push("findings.observation_audio_url is not null");
  } else if (hasObservation === false) {
    filterClauses.push("findings.observation_audio_url is null");
  }

  // The auto-note queue: `note IS NULL OR note = ''` (no editorial note yet). Paired
  // with hasContext=true it is the "ready to author a note" queue — a finding with
  // the context_note fuel but an empty `note`. The empty-string guard matches the
  // fill-empty-only semantics of note_track (a whitespace note is still empty).
  if (hasNote === true) {
    filterClauses.push("(findings.note is not null and trim(findings.note) != '')");
  } else if (hasNote === false) {
    filterClauses.push("(findings.note is null or trim(findings.note) = '')");
  }

  // The full-song CAPTURE queue: findings still needing a capture. `pending`/NULL are
  // ALWAYS eligible (the NULL arm is defensive — the column is notNull-default, but a
  // pre-column row reads NULL — mirroring the context_status style above); a terminal
  // `unmatched`/`done` is never re-burned. A `failed` row backs off: re-included only
  // once `source_audio_attempted_at` is past the cooldown AND below the failure cap, so a
  // persistently failing finding stops re-attempting every tick (CAPTURE_FAILED_COOLDOWN_MS
  // / CAPTURE_MAX_FAILURES — the cutoff is BOUND like the enrich queue's staleCutoff; the
  // cap is a trusted module int, interpolated). `log_id is not null` drops coordinate-less
  // stragglers (the R2 key needs a Log ID) so they never re-pick. A SEPARATE queue — no
  // capture predicate ever reaches the enrich/embed queues (capture must not gate them).
  // The capture cron pairs this with order=desc so a fresh add jumps ahead of the backfill.
  if (captureQueue) {
    const captureCooldown = new Date(Date.now() - CAPTURE_FAILED_COOLDOWN_MS).toISOString();
    filterClauses.push(
      `(findings.log_id is not null and (tracks.capture_status is null or tracks.capture_status = 'pending' or (tracks.capture_status = 'failed' and tracks.source_audio_failures < ${CAPTURE_MAX_FAILURES} and (tracks.source_audio_attempted_at is null or tracks.source_audio_attempted_at < ?))))`,
    );
    filterArgs.push(captureCooldown);
  }

  if (status === "queue") {
    // The self-healing enrich-queue: pending ∪ failed ∪ STALE processing. A
    // `processing` row counts as stuck once it's older than the staleness
    // threshold (updated_at is bumped to the processing transition — enrichment
    // status is a visible field in track-update.ts) OR has a null updated_at
    // (predates the column). Bound arg only; never string-concatenated.
    const staleCutoff = new Date(Date.now() - ENRICH_STALE_PROCESSING_MS).toISOString();
    filterClauses.push(
      "(findings.enrichment_status in ('pending', 'failed') or (findings.enrichment_status = 'processing' and (findings.updated_at is null or findings.updated_at < ?)))",
    );
    filterArgs.push(staleCutoff);
  } else if (status) {
    filterClauses.push("findings.enrichment_status = ?");
    filterArgs.push(status);
  }

  // asc/desc are internal literals (never user strings), so they interpolate
  // safely; the cursor comparison flips with the direction.
  const dir = order === "asc" ? "asc" : "desc";
  const cursorComparator =
    dir === "asc"
      ? "(findings.added_at > ? or (findings.added_at = ? and tracks.track_id > ?))"
      : "(findings.added_at < ? or (findings.added_at = ? and tracks.track_id < ?))";
  // The mixtape arm of the feed pages by the SAME cursor tuple, but over `mixtapes`
  // (its id column is `log_id`), so it carries its own comparator rather than a
  // string-rewrite of the findings one.
  const mixtapeCursorComparator =
    dir === "asc"
      ? "(added_at > ? or (added_at = ? and log_id > ?))"
      : "(added_at < ? or (added_at = ? and log_id < ?))";

  const countWhere = filterClauses.length > 0 ? `where ${filterClauses.join(" and ")}` : "";
  const listClauses = cursor ? [...filterClauses, cursorComparator] : filterClauses;
  const where = listClauses.length > 0 ? `where ${listClauses.join(" and ")}` : "";
  const cursorArgs = cursor ? [cursor.addedAt, cursor.addedAt, cursor.trackId] : [];
  const args: Array<string | number> = [...filterArgs, ...cursorArgs, limit + 1];

  const [result, countResult] = await Promise.all([
    db.execute({
      args,
      sql: `select ${trackSelect}
            from ${FINDINGS_FROM}
            ${where}
            order by findings.added_at ${dir}, tracks.track_id ${dir}
            limit ?`,
    }),
    db.execute({
      args: filterArgs,
      sql: `select count(*) as total_count from ${FINDINGS_FROM} ${countWhere}`,
    }),
  ]);
  const rows = typedRows<TrackRow>(result.rows);
  const feedRows =
    includeMixtapes && !since && !until && hasVideo === undefined && status === undefined
      ? await listPublishedMixtapeFeedRows(
          db,
          cursor,
          mixtapeCursorComparator,
          cursorArgs,
          dir,
          limit,
        )
      : undefined;
  const countRows = typedRows<TrackCountRow>(countResult.rows);
  const totalCount = feedFindingsCount(countRows[0]?.total_count, rows.length);

  if (feedRows) {
    const {
      items,
      hasMore,
      nextCursor: nextRawCursor,
    } = mergeFeedPage(
      rows.map(mapRow),
      feedRows.map((row) => rowToMixtape(row)),
      dir,
      limit,
    );
    return {
      nextCursor: hasMore && nextRawCursor ? encodeTrackCursor(nextRawCursor) : undefined,
      totalCount,
      tracks: items,
    };
  }

  const visibleRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastVisibleRow = visibleRows.at(-1);
  const tracks = visibleRows.map(mapRow);

  // The capture queue's artist-own-channel trust signal: attach each finding's
  // artists' YouTube channel ids in ONE batched read (never through TRACK_SELECT — that
  // shared select feeds every consumer, so a correlated subquery there would bloat
  // every DTO). The full-song capture sweep reads `artistYoutubeChannelIds` as its
  // strongest trust tier. Capture-queue reads only.
  if (captureQueue) {
    await attachArtistYoutubeChannelIds(db, tracks);
  }

  return {
    nextCursor:
      hasMore && lastVisibleRow
        ? encodeTrackCursor({
            addedAt: lastVisibleRow.added_at,
            trackId: lastVisibleRow.track_id,
          })
        : undefined,
    totalCount,
    tracks,
  };
}

async function listPublishedMixtapeFeedRows(
  db: Awaited<ReturnType<typeof getDb>>,
  cursor: TrackCursor | undefined,
  cursorComparator: string,
  cursorArgs: string[],
  dir: "asc" | "desc",
  limit: number,
): Promise<MixtapeFeedRow[]> {
  const result = await db.execute({
    args: [...cursorArgs, limit + 1],
    sql: `select
            m.id,
            m.log_id,
            m.sequence_number,
            m.title,
            m.duration_ms,
            m.note,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'mixcloud' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as mixcloud_url,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'youtube' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as youtube_url,
            (select url from mixtape_social_posts s
               where s.mixtape_id = m.id and s.platform = 'soundcloud' and s.status = 'published' and s.url is not null
               order by published_at desc limit 1) as soundcloud_url,
            m.added_at,
            m.updated_at,
            (select count(*) from mixtape_tracks mt where mt.mixtape_id = m.id) as member_count
          from mixtapes m
          where m.status = 'published'
            and m.log_id is not null
            and m.added_at is not null
            ${cursor ? `and ${cursorComparator}` : ""}
          order by m.added_at ${dir}, m.log_id ${dir}
          limit ?`,
  });

  return typedRows<MixtapeFeedRow>(result.rows);
}

function itemCursorId(item: FeedItem): string {
  return item.type === "mixtape" ? (item.logId as string) : item.trackId;
}

function compareFeedItems(left: FeedItem, right: FeedItem, dir: "asc" | "desc"): number {
  const direction = dir === "asc" ? 1 : -1;
  const byDate = binaryCompare(left.addedAt ?? "", right.addedAt ?? "");

  if (byDate !== 0) {
    return byDate * direction;
  }

  return binaryCompare(itemCursorId(left), itemCursorId(right)) * direction;
}

function binaryCompare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

// The JS mirror of the SQL cursor comparator. The feed fetches findings and
// mixtapes in two separate queries (each filtered by the same cursor and
// limited to limit+1), then merges in JS. This helper reproduces the cursor
// filter so mergeFeedPage can be tested end-to-end without a database.
function isAfterCursor(item: FeedItem, cursor: TrackCursor, dir: "asc" | "desc"): boolean {
  const itemAddedAt = item.addedAt ?? "";
  const itemId = itemCursorId(item);
  const byDate = binaryCompare(itemAddedAt, cursor.addedAt);

  if (dir === "desc") {
    if (byDate < 0) {
      return true;
    }
    if (byDate === 0) {
      return binaryCompare(itemId, cursor.trackId) < 0;
    }
    return false;
  }

  if (byDate > 0) {
    return true;
  }
  if (byDate === 0) {
    return binaryCompare(itemId, cursor.trackId) > 0;
  }
  return false;
}

/**
 * Merge findings and mixtapes into a single feed page. Both tables are fetched
 * separately (each over-fetching by one), then concatenated, sorted by
 * `addedAt` (tiebreak: the cursor id — `trackId` for findings, `logId` for
 * mixtapes), and sliced to `limit+1`. The first `limit` items are the visible
 * page; the extra item signals `hasMore` and seeds the next cursor.
 *
 * When `cursor` is provided, each array is filtered by the same comparator the
 * SQL cursor uses (so the function can simulate full paging in tests without a
 * database). `listTracks` calls this WITHOUT a cursor — the SQL already
 * filtered — so the filter is a no-op in production and only exercised by tests.
 *
 * Each table is sorted before slicing to `limit+1` — the JS mirror of the SQL
 * `order by ... limit ?`. In production the SQL already sorted the rows, so the
 * sort is a cheap no-op; it makes the function self-contained for tests that
 * pass unsorted fixtures.
 */
export function mergeFeedPage(
  findings: FeedItem[],
  mixtapes: FeedItem[],
  dir: "asc" | "desc",
  limit: number,
  cursor?: TrackCursor,
): { items: FeedItem[]; hasMore: boolean; nextCursor?: TrackCursor } {
  const filteredFindings = cursor
    ? findings.filter((item) => isAfterCursor(item, cursor, dir))
    : findings.slice();
  const filteredMixtapes = cursor
    ? mixtapes.filter((item) => isAfterCursor(item, cursor, dir))
    : mixtapes.slice();

  // Over-fetch limit+1 from each table (matches the SQL `limit ?` with limit+1).
  const findingsPage = filteredFindings
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);
  const mixtapesPage = filteredMixtapes
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);

  const merged = [...findingsPage, ...mixtapesPage]
    .sort((left, right) => compareFeedItems(left, right, dir))
    .slice(0, limit + 1);

  const items = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const lastVisible = items.at(-1);
  const nextCursor =
    hasMore && lastVisible
      ? { addedAt: lastVisible.addedAt ?? "", trackId: itemCursorId(lastVisible) }
      : undefined;

  return { hasMore, items, nextCursor };
}

/**
 * The feed's "Found · N" counter is findings-only by design: mixtapes join the
 * feed stream without inflating the finding count. `listTracks` passes the
 * dedicated `count(*)` over the finding join (and the findings row count as
 * fallback); mixtapes never enter the count. Extracting this as a named helper
 * makes the invariant explicit and testable — a future change that unions
 * mixtapes into the count would have to touch this function and its tests.
 */
export function feedFindingsCount(sqlCount: number | undefined, fallback: number): number {
  return Number(sqlCount ?? fallback);
}

export function decodeTrackCursor(value: string | null): TrackCursor | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TrackCursor;

    if (typeof parsed.addedAt === "string" && typeof parsed.trackId === "string") {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function encodeTrackCursor(cursor: TrackCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
