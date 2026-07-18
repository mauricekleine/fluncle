// `/artist/<slug>/fresh.xml` + `/label/<slug>/fresh.xml` — WHAT JUST CAME OUT, from ONE entity.
//
// The whole-archive `/fresh` read (./fresh) narrowed to a single artist or label: every track
// whose RELEASE DATE falls inside the same trailing 30-day window, freshest first, split the same
// two ways —
//
//   1. the certified FINDINGS (a `findings ⋈ tracks` pair), carrying their Log ID coordinate + cover;
//   2. the UNCERTIFIED rows (a `tracks` row with no `findings` row), carrying NEITHER — the unlit
//      register (DESIGN.md's Unlit Rule), structural here because the mapping only ever hands a
//      catalogue row a bare title + Spotify link.
//
// ── LITERAL, NEVER SIMILAR ─────────────────────────────────────────────────────────────
// The feed answers "new releases from THIS entity" and nothing more — only the entity's own tracks,
// never a widening to similar artists (ratified 2026-07-18; that expansion lives in a future email
// digest, not a feed). The predicate is the entity's own pointer: an artist via the `track_artists`
// join (`getFindingsByArtist`'s shape), a label via the indexed `tracks.label_id` seek.
//
// ── RELEASE DATE IS NOT FOUND DATE ─────────────────────────────────────────────────────
// Like `/fresh`, this orders by `tracks.release_date` — when the tune came OUT — not
// `findings.added_at`. So the feed copy never says Fluncle FOUND these, only that they just landed
// (VOICE.md's Found Rule). The window rides the `tracks_release_date_idx` btree, and every query is
// LIMIT-capped, so nothing unbounded crosses into the isolate however big the catalogue grows.

import { getArtistBySlug, parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { clampFreshLimit, FRESH_WINDOW_DAYS, type FreshTrack } from "./fresh";
import { getLabelBySlug } from "./labels";
import {
  FINDINGS_FROM,
  TRACK_SELECT,
  toPublicTrackListItem,
  toTrackListItem,
  type TrackRow,
} from "./tracks";

/** The two entity kinds a per-entity fresh feed narrows to. */
type FreshEntityKind = "artist" | "label";

/**
 * The per-kind narrowing, both halves. `join`/`where` are CONSTANTS chosen by `kind` (never user
 * input) — the entity id is always the bound param — so the SQL is injection-safe by construction.
 * An artist joins `track_artists` and filters on `artist_id`; a label seeks the indexed
 * `tracks.label_id` pointer directly, no extra join.
 */
const ENTITY_NARROWING: Record<FreshEntityKind, { join: string; where: string }> = {
  artist: {
    join: "join track_artists on track_artists.track_id = tracks.track_id",
    where: "track_artists.artist_id = ?",
  },
  label: { join: "", where: "tracks.label_id = ?" },
};

/** A `YYYY-MM-DD` day, `daysAgo` days before `now` (UTC) — the release_date column's own precision. */
function dayString(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The lean catalogue row the unlit half selects — no cover, no coordinate (the Unlit Rule). */
type FreshEntityCatalogueRow = {
  artists_json: string;
  release_date: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

/**
 * The flat, capped fresh list for ONE entity: the entity's certified findings + its uncertified
 * catalogue rows released in the trailing window, folded into one newest-release-first list (a
 * finding leads a catalogue row on a date tie — the lit register first), capped. Mirrors
 * `listFreshTracks`' fold exactly, so the two feeds render the same two-tier contract.
 *
 * `now` is injectable so the window is deterministic under test (the `listFreshReleases` precedent).
 */
async function listEntityFreshTracks(
  kind: FreshEntityKind,
  entityId: string,
  options?: { limit?: number; now?: Date },
): Promise<FreshTrack[]> {
  const db = await getDb();
  const limit = clampFreshLimit(options?.limit);
  const now = options?.now ?? new Date();
  // `<= today` drops future-dated pre-orders; `>= windowStart` is the trailing edge. Both bind
  // against the release_date index.
  const windowStart = dayString(now, FRESH_WINDOW_DAYS);
  const today = dayString(now, 0);
  const { join, where } = ENTITY_NARROWING[kind];

  const [findingsResult, catalogueResult] = await Promise.all([
    // The lit half: this entity's findings released in the window. Drives through the finding inner
    // join, so it can only ever return findings — the full `TRACK_SELECT` the Track Row reads.
    db.execute({
      args: [entityId, windowStart, today, limit],
      sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
            ${join}
            where ${where}
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
    // The unlit half: this entity's catalogue rows (a `tracks` row with no `findings` row) released
    // in the window. No cover, no coordinate — nothing that would let a row read as a finding.
    db.execute({
      args: [entityId, windowStart, today, limit],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json,
                   tracks.spotify_url, tracks.release_date
            from tracks
            left join findings on findings.track_id = tracks.track_id
            ${join}
            where findings.track_id is null
              and ${where}
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
  ]);

  const findings: FreshTrack[] = typedRows<TrackRow>(findingsResult.rows).map((row) => {
    const finding = toPublicTrackListItem(toTrackListItem(row));
    return {
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
    };
  });
  const catalogue: FreshTrack[] = typedRows<FreshEntityCatalogueRow>(catalogueResult.rows).map(
    (row) => ({
      artists: parseArtistsJson(row.artists_json),
      certified: false,
      releaseDate: row.release_date,
      spotifyUrl: row.spotify_url ?? undefined,
      title: row.title,
    }),
  );

  // Newest release first; on a date tie a certified finding leads (the lit register first), then the
  // order is stable by title so the list is deterministic (no clock, no random — the AGENTS.md rule).
  return [...findings, ...catalogue]
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
}

/** A resolved entity's fresh feed: its display NAME (drives the channel copy) + its fresh tracks. */
export type EntityFreshFeed = {
  name: string;
  tracks: FreshTrack[];
};

/**
 * One artist's fresh releases + the artist's name, or `undefined` when the slug resolves to no
 * artist (the route 404s). An artist with a page but nothing released in the window returns an
 * empty `tracks` list — a valid, empty feed, not a miss.
 */
export async function listArtistFreshTracks(
  slug: string,
  options?: { limit?: number; now?: Date },
): Promise<EntityFreshFeed | undefined> {
  const artist = await getArtistBySlug(slug);
  if (!artist) {
    return undefined;
  }
  return { name: artist.name, tracks: await listEntityFreshTracks("artist", artist.id, options) };
}

/**
 * One label's fresh releases + the label's name, or `undefined` when the slug resolves to no label
 * (the route 404s). A label with a page but nothing released in the window returns an empty `tracks`
 * list — a valid, empty feed.
 */
export async function listLabelFreshTracks(
  slug: string,
  options?: { limit?: number; now?: Date },
): Promise<EntityFreshFeed | undefined> {
  const label = await getLabelBySlug(slug);
  if (!label) {
    return undefined;
  }
  return { name: label.name, tracks: await listEntityFreshTracks("label", label.id, options) };
}
