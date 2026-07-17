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

import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import {
  type CatalogueTrackItem,
  FINDINGS_FROM,
  TRACK_SELECT,
  type TrackListItem,
  toPublicTrackListItem,
  toTrackListItem,
  type TrackRow,
} from "./tracks";

/** The trailing release window: how far back "just came out" reaches. A constant, never a param. */
export const FRESH_WINDOW_DAYS = 30;

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

/** An uncertified row on the fresh page — the unlit `CatalogueTrackItem`, plus the date it landed. */
export type FreshCatalogueItem = CatalogueTrackItem & { releaseDate: string };

/** One recency section: the findings (lit) and the quieter rows (unlit) that landed in its window. */
export type FreshSection = {
  catalogue: FreshCatalogueItem[];
  findings: TrackListItem[];
  key: FreshBucket;
};

/** A record (album entity) a recent release sits on — the browse-graph half of the page. */
export type FreshRecord = {
  /** The credited artists, folded distinct across the record's fresh tracks. */
  artists: string[];
  name: string;
  releaseDate: string;
  /** `/album/<slug>` — always present, because this row IS an album entity (an inner join minted it). */
  slug: string;
};

export type FreshReleases = {
  records: FreshRecord[];
  /** Only the NON-EMPTY sections, "This week" before "Earlier" — an empty section renders nothing. */
  sections: FreshSection[];
  /** Echoed for the page's honest copy ("the last 30 days"). */
  windowDays: number;
};

type FreshCatalogueRow = {
  artists_json: string;
  release_date: string;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type FreshRecordRow = {
  artists: string | null;
  name: string;
  release_date: string;
  slug: string;
};

/** A `YYYY-MM-DD` day, `daysAgo` days before `now` (UTC) — the release_date column's own precision. */
function dayString(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The fresh page's data: certified findings + uncertified rows released in the trailing window,
 * bucketed by recency, plus the records they sit on. `now` is injectable so the window is
 * deterministic under test (the `getRadioScheduleAnchor` precedent).
 */
export async function listFreshReleases(now: Date = new Date()): Promise<FreshReleases> {
  const db = await getDb();
  // `<= today` drops future-dated pre-orders: a record that has not come out yet has not "just
  // come out". `>= windowStart` is the trailing edge. Both bind against the release_date index.
  const windowStart = dayString(now, FRESH_WINDOW_DAYS);
  const weekStart = dayString(now, FRESH_WEEK_DAYS);
  const today = dayString(now, 0);

  const [findingsResult, catalogueResult, recordsResult] = await Promise.all([
    // The lit half: findings whose track was RELEASED in the window. Drives through the finding
    // inner join, so it can only ever return findings — the full `TRACK_SELECT` the Track Row reads.
    db.execute({
      args: [windowStart, today, FRESH_FINDINGS_LIMIT],
      sql: `select ${TRACK_SELECT} from ${FINDINGS_FROM}
            where tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
    // The unlit half: the anti-join's exact complement (a `tracks` row with no `findings` row),
    // released in the window. Only the four unlit columns — no cover, no coordinate, nothing a
    // finding surface could render (DESIGN.md's Unlit Rule; `listCatalogueTracksByAlbum`'s shape).
    db.execute({
      args: [windowStart, today, FRESH_CATALOGUE_LIMIT],
      sql: `select tracks.track_id, tracks.title, tracks.artists_json,
                   tracks.spotify_url, tracks.release_date
            from tracks
            left join findings on findings.track_id = tracks.track_id
            where findings.track_id is null
              and tracks.release_date >= ? and tracks.release_date <= ?
            order by tracks.release_date desc, tracks.track_id desc
            limit ?`,
    }),
    // The records half: the album ENTITIES a fresh release sits on, newest release first. The
    // `join albums` requires an `album_id` (a minted entity), so every row links to `/album/<slug>`.
    // `json_each` is safe under the release_date range — the scan is bounded to the window before the
    // JSON is touched, and the aggregation stays in SQL (AGENTS.md: never fold a growing table in the
    // isolate). `group_concat(distinct …)` folds the credited artists across the record's fresh rows.
    db.execute({
      args: [windowStart, today, FRESH_RECORDS_LIMIT],
      sql: `select al.slug as slug, min(al.name) as name,
                   max(tracks.release_date) as release_date,
                   group_concat(distinct credit.value) as artists
            from tracks
            join albums al on al.id = tracks.album_id
            join json_each(tracks.artists_json) credit
            where tracks.release_date >= ? and tracks.release_date <= ?
            group by al.id
            order by max(tracks.release_date) desc, min(al.name) collate nocase asc
            limit ?`,
    }),
  ]);

  const findings = typedRows<TrackRow>(findingsResult.rows).map((row) =>
    toPublicTrackListItem(toTrackListItem(row)),
  );
  const catalogue: FreshCatalogueItem[] = typedRows<FreshCatalogueRow>(catalogueResult.rows).map(
    (row) => ({
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
    name: row.name,
    releaseDate: row.release_date,
    slug: row.slug,
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
