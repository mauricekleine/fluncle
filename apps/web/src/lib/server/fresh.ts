// `/fresh` — WHAT JUST CAME OUT, across the whole archive.
//
// The reads behind the public `/fresh` page: every track whose RELEASE DATE falls inside a
// trailing 30-day window, freshest first, split three ways —
//
//   1. the certified FINDINGS (a `findings ⋈ tracks` pair), rendered in full voice;
//   2. the UNCERTIFIED rows (a `tracks` row with no `findings` row), rendered in the unlit
//      register — never named, never given a coordinate (DESIGN.md's Unlit Rule);
//   3. the RECORDS (album entities) a recent release sits on, for the browse graph.
//
// ── RELEASE DATE IS NOT FOUND DATE ─────────────────────────────────────────────────────
// Everywhere else in the archive the ordering key is `findings.added_at` — WHEN Fluncle
// found a tune. This page orders by `tracks.release_date` — when the tune came OUT — and the
// two are unrelated. A record pressed last week that Fluncle logged months from now still
// belongs here today; a banger he found last night off a 2019 record does not. So the copy on
// the page never says he FOUND these — only that they just landed (VOICE.md's Found Rule).
//
// ── WHY IT SCALES ──────────────────────────────────────────────────────────────────────
// `tracks.release_date` is a btree index (`tracks_release_date_idx`), so the window predicate
// (`release_date BETWEEN <30d ago> AND <today>`) is a bounded RANGE SCAN and the `ORDER BY
// release_date DESC` rides the same index — not the full scan of a growing table AGENTS.md
// forbids. The window bounds the row set to ~a month of releases however big the catalogue
// gets, and a hard `LIMIT` caps it regardless, so nothing unbounded ever crosses into the
// isolate (the anti-join for the uncertified half is `listCatalogueTracksByAlbum`'s exact
// shape). The two-query split — the finding inner join for the lit half, its anti-join
// complement for the unlit half — is the same structural guard the rest of `tracks.ts` uses:
// a catalogue row has no `findings` columns to map, so it cannot leak into a finding surface.

import { bestAlbumCoverUrl, bestArtistAvatarUrl } from "../media";
import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import {
  type CatalogueTrackItem,
  FINDINGS_FROM,
  LEAN_TRACK_SELECT,
  type TrackListItem,
  toPublicTrackListItem,
  toTrackListItem,
  type TrackRow,
} from "./tracks";

// The LEAD ARTIST's owned/Spotify avatar, joined per track so a row can show WHO made it (the
// artist image, monogram-fallback in the UI) rather than only its album art. `track_artists.position`
// is 1-based with the lead first, so the scalar subquery picks the lead; the join is a PK lookup on
// `artists`. Both are indexed (`track_artists_track_id_idx`, the `artists` PK) and the outer scan is
// already window-bounded + LIMIT-capped, so this stays a bounded seek, never a growing-table scan.
// EXPORTED so the `/tracks` hub (`tracks-hub.ts`) can hang the SAME lead-artist avatar on its rows
// without re-deriving the join — it renders through the identical `FreshStreamRow`, so it wants the
// identical avatar (dimmed into the unlit register on a catalogue row).
export const LEAD_ARTIST_JOIN = `left join artists fresh_lead_artist on fresh_lead_artist.id = (
        select ta.artist_id from track_artists ta
        where ta.track_id = tracks.track_id
        order by ta.position asc limit 1)`;
export const LEAD_ARTIST_SELECT = `fresh_lead_artist.image_url as artist_image_url,
       fresh_lead_artist.image_key as artist_image_key,
       fresh_lead_artist.image_state as artist_image_state,
       fresh_lead_artist.image_updated_at as artist_image_updated_at`;

/** The four `artists` image columns the lead-artist join selects, on any fresh row. */
export type LeadArtistRow = {
  artist_image_key: string | null;
  artist_image_state: string | null;
  artist_image_updated_at: string | null;
  artist_image_url: string | null;
};

/** The lead artist's best avatar (owned master when resolved, else Spotify) for a joined row. */
export function leadArtistAvatarUrl(row: LeadArtistRow): string | undefined {
  return bestArtistAvatarUrl({
    imageKey: row.artist_image_key,
    imageState: row.artist_image_state,
    imageUpdatedAt: row.artist_image_updated_at,
    imageUrl: row.artist_image_url,
  });
}

/** The trailing release window the TRACK STREAM reads: how far back "just came out" reaches. This is
    the contract the syndication feeds pin (`fresh.xml`/`fresh.json` say "the last 30 days"), so it is
    fixed — the album view widens on its OWN window ({@link FRESH_RECORDS_WINDOW_DAYS}), never this. */
export const FRESH_WINDOW_DAYS = 30;

/** The trailing window the ALBUM cut reads — wider than the track stream, because a record is a rarer
    event than a single track and a month-old LP is still fresh. The page's records query reaches this
    far back; the track stream (and every feed) stays on {@link FRESH_WINDOW_DAYS}. */
export const FRESH_RECORDS_WINDOW_DAYS = 90;

/** The split inside the window: releases newer than this land in "This week". */
export const FRESH_WEEK_DAYS = 7;

// The hard row ceilings — the window already bounds the scan, these bound the RESULT the isolate
// folds (AGENTS.md: never hand the isolate an unbounded set, even off an indexed seek). A page of
// "what just came out" is a reading surface, not an infinite feed; there is no pager here.
export const FRESH_FINDINGS_LIMIT = 60;
export const FRESH_CATALOGUE_LIMIT = 60;
export const FRESH_RECORDS_LIMIT = 24;

/** Which recency bucket a release falls in — the page's two sections. */
export type FreshBucket = "earlier" | "week";

/** An uncertified row on the fresh page — the unlit `CatalogueTrackItem`, plus the date it landed and
    the lead artist's avatar (dimmed in the unlit register; a monogram of `artists[0]` when absent). */
export type FreshCatalogueItem = CatalogueTrackItem & {
  artistAvatarUrl?: string;
  releaseDate: string;
};

/** A certified finding on the fresh page — the full `TrackListItem` plus its lead artist's avatar. */
export type FreshFinding = TrackListItem & { artistAvatarUrl?: string };

/** One recency section: the findings (lit) and the quieter rows (unlit) that landed in its window. */
export type FreshSection = {
  catalogue: FreshCatalogueItem[];
  findings: FreshFinding[];
  key: FreshBucket;
};

/** A record (album entity) a recent release sits on — the browse-graph half of the page. */
export type FreshRecord = {
  /** The credited artists, folded distinct across the record's fresh tracks. */
  artists: string[];
  /** The record's cover: its OWNED ≤1200² master through the Cloudflare Images ladder when the
      cover-masters sweep has resolved one, else the raw provider art off one of its tracks. Either
      way `albumCoverAtSize` takes it down to the render rung. Undefined when the record has neither. */
  coverImageUrl: string | undefined;
  name: string;
  releaseDate: string;
  /** `/album/<slug>` — always present, because this row IS an album entity (an inner join minted it). */
  slug: string;
  /** How many of the record's tracks landed in the query window — the "4 tracks" label the album view
      prints (a real count of a real entity; the tier the rows belong to is never counted). */
  trackCount: number;
  /** True when the record's newest release also falls inside the (narrower) TRACK window — so the "All"
      view's rail can show today's 30-day cut while the album view reaches the full {@link
      FRESH_RECORDS_WINDOW_DAYS}. */
  withinTrackWindow: boolean;
};

export type FreshReleases = {
  records: FreshRecord[];
  /** Only the NON-EMPTY sections, "This week" before "Earlier" — an empty section renders nothing. */
  sections: FreshSection[];
  /** Echoed for the page's honest copy ("the last 30 days"). */
  windowDays: number;
};

type FreshCatalogueRow = LeadArtistRow & {
  artists_json: string;
  release_date: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type FreshRecordRow = {
  artists: string | null;
  cover_url: string | null;
  image_key: string | null;
  image_state: string | null;
  image_updated_at: string | null;
  name: string;
  release_date: string;
  slug: string;
  track_count: number;
};

/** A `YYYY-MM-DD` day, `daysAgo` days before `now` (UTC) — the release_date column's own precision. */
function dayString(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The fresh page's data: certified findings + uncertified rows released in the trailing window,
 * bucketed by recency, plus the records they sit on. `now` is injectable so the window is
 * deterministic under test (the `getRadioScheduleAnchor` precedent).
 *
 * `recordsWindowDays` widens ONLY the album (records) read — the findings + catalogue track stream
 * always stays on {@link FRESH_WINDOW_DAYS}, which is the window the syndication feeds pin. It
 * defaults to that same 30-day window, so `listFreshTracks` (and therefore `fresh.xml`/`fresh.json`)
 * is byte-identical; the `/fresh` page passes {@link FRESH_RECORDS_WINDOW_DAYS} to reach further back
 * for its album view.
 */
export async function listFreshReleases(
  now: Date = new Date(),
  recordsWindowDays: number = FRESH_WINDOW_DAYS,
): Promise<FreshReleases> {
  const db = await getDb();
  // `<= today` drops future-dated pre-orders: a record that has not come out yet has not "just
  // come out". `>= windowStart` is the trailing edge. Both bind against the release_date index.
  const windowStart = dayString(now, FRESH_WINDOW_DAYS);
  // The album cut's own trailing edge — never narrower than the track window (a longer window can
  // only reach further back), so a record inside the track window is always inside this one too.
  const recordsWindowStart = dayString(now, Math.max(recordsWindowDays, FRESH_WINDOW_DAYS));
  const weekStart = dayString(now, FRESH_WEEK_DAYS);
  const today = dayString(now, 0);

  const [findingsResult, catalogueResult, recordsResult] = await Promise.all([
    // The lit half: findings whose track was RELEASED in the window. Drives through the finding
    // inner join, so it can only ever return findings. Uses the LEAN projection (Finding B4):
    // the fresh cards render a cover + artist/title + coordinate and NONE of the three heavy JSON
    // columns (`observation_alignment_json`, `features_json`, `video_model_reasoning`) or the
    // render-only artworkMax subqueries, so the lean read drops exactly the over-fetch. The mapper
    // stays `toTrackListItem` — it simply carries those undefined for a lean row. Plus the lead
    // artist's avatar columns.
    db.execute({
      args: [windowStart, today, FRESH_FINDINGS_LIMIT],
      sql: `select ${LEAN_TRACK_SELECT}, ${LEAD_ARTIST_SELECT} from ${FINDINGS_FROM}
            ${LEAD_ARTIST_JOIN}
            where tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
    // The unlit half: the anti-join's exact complement (a `tracks` row with no `findings` row),
    // released in the window. No album COVER and no coordinate — nothing that would let it read as a
    // finding (DESIGN.md's Unlit Rule). The lead artist's avatar rides along, but the UI dims it into
    // the unlit register (the `hub-grid` precedent), so it identifies WHO without lighting up.
    db.execute({
      args: [windowStart, today, FRESH_CATALOGUE_LIMIT],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json,
                   tracks.spotify_url, tracks.release_date, ${LEAD_ARTIST_SELECT}
            from tracks
            left join findings on findings.track_id = tracks.track_id
            ${LEAD_ARTIST_JOIN}
            where findings.track_id is null
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
    // The records half: the album ENTITIES a fresh release sits on, newest release first, over the
    // WIDER records window (`recordsWindowStart`, up to 90 days — albums are rarer than singles). The
    // `join albums` requires an `album_id` (a minted entity), so every row links to `/album/<slug>`.
    // `json_each` is safe under the release_date range — the scan is bounded to the window before the
    // JSON is touched, and the aggregation stays in SQL (AGENTS.md: never fold a growing table in the
    // isolate). `group_concat(distinct …)` folds the credited artists across the record's fresh rows,
    // and `count(distinct tracks.track_id)` counts the tracks (never the artist-multiplied join rows).
    //
    // THE COVER comes off the ALBUM ENTITY first: `al.image_key`/`image_state`/`image_updated_at`
    // are the album's OWN columns (grouped by `al.id`, so they are constant across the group — the
    // `listAlbumSitemapRows` shape), and `bestAlbumCoverUrl` serves the owned ≤1200² master
    // through the Cloudflare Images ladder when the sweep has resolved one. The correlated
    // `album_image_url` subquery stays as the FALLBACK for a record with no master yet — and
    // because the master rides the album row rather than a second subquery, the two can never pair
    // one record's master with another's fallback. See docs/album-artwork.md.
    db.execute({
      args: [recordsWindowStart, today, FRESH_RECORDS_LIMIT],
      sql: `select al.slug as slug, min(al.name) as name,
                   max(tracks.release_date) as release_date,
                   count(distinct tracks.track_id) as track_count,
                   group_concat(distinct credit.value) as artists,
                   al.image_key as image_key, al.image_state as image_state,
                   al.image_updated_at as image_updated_at,
                   (select t2.album_image_url
                      from tracks t2
                      where t2.album_id = al.id and t2.album_image_url is not null
                      order by t2.release_date is null asc, t2.release_date desc, t2.track_id asc
                      limit 1) as cover_url
            from tracks
            join albums al on al.id = tracks.album_id
            join json_each(tracks.artists_json) credit
            where tracks.release_date >= ? and tracks.release_date <= ?
            group by al.id
            order by max(tracks.release_date) desc, min(al.name) collate nocase asc
            limit ?`,
    }),
  ]);

  const findings: FreshFinding[] = typedRows<TrackRow & LeadArtistRow>(findingsResult.rows).map(
    (row) => ({
      ...toPublicTrackListItem(toTrackListItem(row)),
      artistAvatarUrl: leadArtistAvatarUrl(row),
    }),
  );
  const catalogue: FreshCatalogueItem[] = typedRows<FreshCatalogueRow>(catalogueResult.rows).map(
    (row) => ({
      artistAvatarUrl: leadArtistAvatarUrl(row),
      artists: parseArtistsJson(row.artists_json),
      releaseDate: row.release_date,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
      trackId: row.track_id,
    }),
  );
  const records: FreshRecord[] = typedRows<FreshRecordRow>(recordsResult.rows).map((row) => ({
    // `group_concat` joins on a bare comma; artist names practically never carry one, and a stray
    // split is a cosmetic miss on a secondary browse row, never a correctness one.
    artists: (row.artists ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    coverImageUrl: bestAlbumCoverUrl({
      imageKey: row.image_key,
      imageState: row.image_state,
      imageUpdatedAt: row.image_updated_at,
      spotifyUrl: row.cover_url,
    }),
    name: row.name,
    releaseDate: row.release_date,
    slug: row.slug,
    trackCount: row.track_count,
    // The record's newest release decides the flag — inside the 30-day track window (today's rail)
    // or only inside the wider album window. `>=` is the same boundary the track queries bind.
    withinTrackWindow: row.release_date >= windowStart,
  }));

  const sections: FreshSection[] = (["week", "earlier"] as const).flatMap((key) => {
    const inWeek = (date: string | undefined): boolean => (date ?? "") >= weekStart;
    const sectionFindings = findings.filter((finding) =>
      key === "week" ? inWeek(finding.releaseDate) : !inWeek(finding.releaseDate),
    );
    const sectionCatalogue = catalogue.filter((track) =>
      key === "week" ? inWeek(track.releaseDate) : !inWeek(track.releaseDate),
    );

    // An empty section renders nothing — no heading over an empty band (graph-sections.tsx).
    return sectionFindings.length === 0 && sectionCatalogue.length === 0
      ? []
      : [{ catalogue: sectionCatalogue, findings: sectionFindings, key }];
  });

  return { records, sections, windowDays: FRESH_WINDOW_DAYS };
}

/** The flat "fresh tracks" default + ceiling — a discovery list, not an infinite feed. */
export const FRESH_TRACKS_DEFAULT = 50;
export const FRESH_TRACKS_MAX = 100;

/**
 * One track on the FLAT fresh list — the shape the syndication surfaces (API, feed, MCP, CLI, SSH)
 * read. A `certified` finding carries its Log ID coordinate and cover; an uncertified catalogue row
 * carries NEITHER (the Unlit Rule is structural here — `logId`/`coverImageUrl` are present iff
 * `certified`, so a consumer physically cannot render an uncertified row as a named finding). Every
 * date is a RELEASE date (VOICE.md's Found Rule) — a surface labels it "Released", never "Found".
 */
export type FreshTrack = {
  artists: string[];
  bpm?: number;
  certified: boolean;
  coverImageUrl?: string;
  durationMs?: number;
  key?: string;
  logId?: string;
  releaseDate: string;
  spotifyUrl?: string;
  title: string;
};

/** The flat fresh payload: newest RELEASES first, plus the album entities they sit on. */
export type FreshTracks = {
  albums: FreshRecord[];
  tracks: FreshTrack[];
  windowDays: number;
};

/** Clamp the requested list size into `[1, FRESH_TRACKS_MAX]`, defaulting to {@link FRESH_TRACKS_DEFAULT}. */
export function clampFreshLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return FRESH_TRACKS_DEFAULT;
  }
  return Math.max(1, Math.min(FRESH_TRACKS_MAX, Math.floor(limit)));
}

/**
 * The flat, capped fresh list every non-web surface reads: `listFreshReleases`' findings and
 * catalogue rows folded into ONE newest-release-first list (a finding leads a catalogue row on a
 * date tie — the lit register first), capped, plus the album records. Reuses `listFreshReleases`,
 * so it inherits the same window bounds + index + the public-strip already applied to findings.
 */
export async function listFreshTracks(options?: {
  limit?: number;
  now?: Date;
}): Promise<FreshTracks> {
  const limit = clampFreshLimit(options?.limit);
  const data = await listFreshReleases(options?.now);

  const findings: FreshTrack[] = data.sections.flatMap((section) =>
    section.findings.map((finding) => ({
      artists: finding.artists,
      bpm: finding.bpm,
      certified: true,
      coverImageUrl: finding.albumImageUrl,
      durationMs: finding.durationMs,
      key: finding.key,
      logId: finding.logId,
      releaseDate: finding.releaseDate ?? "",
      spotifyUrl: finding.spotifyUrl,
      title: finding.title,
    })),
  );
  const catalogue: FreshTrack[] = data.sections.flatMap((section) =>
    section.catalogue.map((track) => ({
      artists: track.artists,
      certified: false,
      releaseDate: track.releaseDate,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
    })),
  );

  // Newest release first; on a date tie a certified finding leads (the lit register first), then the
  // order is stable by title so the list is deterministic (no clock, no random — the AGENTS.md rule).
  const tracks = [...findings, ...catalogue]
    .sort((a, b) => {
      if (a.releaseDate !== b.releaseDate) {
        return a.releaseDate < b.releaseDate ? 1 : -1;
      }
      if (a.certified !== b.certified) {
        return a.certified ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, limit);

  return { albums: data.records, tracks, windowDays: data.windowDays };
}
