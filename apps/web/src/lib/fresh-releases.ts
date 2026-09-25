// `/fresh` as a FINITE WEEK: the window's rows folded into RELEASES, and releases into WEEKS.
//
// The server read (`lib/server/fresh.ts`) hands over two newest-first lists of tracks, a lit half
// and an unlit half. A listener does not think in tracks there: one EP is one thing that came out,
// and four of its tracks at the top of a page is the EP flooding the page, not four releases. So
// the page's unit is the RELEASE (every track of one record in the window, folded under one entry),
// and the page's shape is the WEEK (rolling seven-day buckets back from today, each carrying its
// count), ending where the window ends.
//
// THE WEEK RULE: every track sits in the week its own release date falls in. A record whose tracks
// came out in different weeks (a single ahead of its album) appears in each of those weeks, holding
// that week's tracks only — so a week's count, its entries and "Play this week" all mean exactly
// what came out in that week, linked album or not.
//
// The fold runs over exactly the rows the page renders — a set the window and the read's limits
// already bound — so nothing here widens a read. It is pure (no clock, no storage): `today` is
// passed in, and the same rows always fold the same way.
//
// Client-safe: type-only imports from the server module erase at compile time
// (docs/client-bundle.md).

import { type DiscoveryTrack, freshEntryToDiscoveryTrack } from "./discovery-tracks";
import { formatReleaseDate, formatReleaseDayRange } from "./format";
import {
  type FreshCatalogueItem,
  type FreshCoverage,
  type FreshFinding,
  type FreshReleases,
} from "./server/fresh";

/** One row of the window, in the register it arrived in. */
export type FreshEntry =
  | { kind: "catalogue"; releaseDate: string; track: FreshCatalogueItem }
  | { kind: "finding"; finding: FreshFinding; releaseDate: string };

/** How many days a week bucket spans. */
export const FRESH_WEEK_DAYS = 7;

/** At most this many standouts head the page, one per release. */
export const FRESH_STANDOUT_LIMIT = 4;

/** Below this many releases the standouts strip does not print: one tile is not a selection. */
const FRESH_STANDOUT_MIN = 2;

/** Credits past this many read as a compilation, credited as one. */
const RELEASE_CREDIT_LIMIT = 3;

/**
 * One release: every track of one record that came out in the window, under one entry. A record
 * with one track in the window is a release of one, and renders as the plain shared row.
 *
 * `tracks` carry their own cover and portrait only where they differ from the release's (the
 * payload holds a record's cover once); `releaseTrack` puts them back for the row.
 */
export type FreshRelease = {
  /** `/album/<slug>` when the record is an album entity. */
  albumSlug?: string;
  artists: string[];
  avatarUrl?: string;
  coverUrl?: string;
  /** Stable across visits: the album slug, the record's name and lead artist, or the lone track. */
  key: string;
  /** Any track on it is a finding. */
  lit: boolean;
  /**
   * A record rather than a single, for "Albums & EPs": the archive links more than one track to
   * its album entity (stored, whatever share of it is in the window). A record with no album entity
   * has no stored count, so there it means more than one of its tracks is in the window.
   */
  record: boolean;
  /** The newest release date among its tracks (the column's own precision). */
  releaseDate: string;
  /** The record's name for a release of several tracks, the track's title for a release of one. */
  title: string;
  tracks: DiscoveryTrack[];
};

/** One rolling week back from today: week 0 is the last seven days, week 1 the seven before. */
export type FreshWeek = {
  /** The first day the bucket holds (`YYYY-MM-DD`), clamped to the window's trailing edge. */
  from: string;
  index: number;
  releases: FreshRelease[];
  /** The days it spans, formatted once on the server so the render never re-runs a locale. */
  span: string;
  /** The last day the bucket holds (`YYYY-MM-DD`). */
  to: string;
};

/** Where the standouts were drawn from, which the heading says plainly. */
export type FreshStandoutSpan = "last-week" | "this-week" | "two-weeks";

export type FreshPage = {
  coverage: FreshCoverage;
  /** The coverage's day, formatted ("Sep 2, 2026"): a partial read's oldest whole day, or the one
      day a truncated read holds part of. Absent when the window is whole. */
  coverageDate?: string;
  /** Every release in the page, across every week. */
  releaseCount: number;
  /** The standouts, as release keys (each release is in the payload once). */
  standouts: { keys: string[]; span: FreshStandoutSpan } | undefined;
  /** `YYYY-MM-DD`, the day the weeks count back from. */
  today: string;
  trackCount: number;
  /** Only the weeks that hold a release, newest first. */
  weeks: FreshWeek[];
  windowDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first day a stored release date stands for: a full day is itself, a month or a year prefix
 * is its first day (`lib/server/release-day.ts`: a release is out from the first day its precision
 * represents).
 */
export function freshDay(releaseDate: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(releaseDate)) {
    return releaseDate.slice(0, 10);
  }
  if (/^\d{4}-\d{2}$/.test(releaseDate)) {
    return `${releaseDate}-01`;
  }
  if (/^\d{4}$/.test(releaseDate)) {
    return `${releaseDate}-01-01`;
  }

  return releaseDate;
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

function dayOf(number: number): string {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Which rolling week a release day falls in, counted back from today (0 = the last seven days).
 * The window's last few days never make a stub week of their own: they join the week before, so
 * the oldest bucket runs a little long instead of printing a three-day "week".
 */
export function freshWeekIndex(releaseDate: string, today: string, windowDays: number): number {
  const age = dayNumber(today) - dayNumber(freshDay(releaseDate));
  const lastWeek = Math.max(0, Math.floor(windowDays / FRESH_WEEK_DAYS) - 1);

  return Number.isFinite(age)
    ? Math.min(lastWeek, Math.max(0, Math.floor(age / FRESH_WEEK_DAYS)))
    : 0;
}

/** Every row of the window, newest release first; on a tie a finding leads (the lit register). */
function freshEntries(data: FreshReleases): FreshEntry[] {
  const entries: FreshEntry[] = [
    ...data.findings.map(
      (finding): FreshEntry => ({
        finding,
        kind: "finding",
        releaseDate: finding.releaseDate ?? "",
      }),
    ),
    ...data.catalogue.map(
      (track): FreshEntry => ({ kind: "catalogue", releaseDate: track.releaseDate, track }),
    ),
  ];

  return entries.sort((a, b) => {
    if (a.releaseDate !== b.releaseDate) {
      return a.releaseDate < b.releaseDate ? 1 : -1;
    }
    if (a.kind !== b.kind) {
      return a.kind === "finding" ? -1 : 1;
    }
    return entryTrackId(a) < entryTrackId(b) ? 1 : -1;
  });
}

function entryTrackId(entry: FreshEntry): string {
  return entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId;
}

/** The record a row sits on: its album slug, else its record name, else nothing (a release of one). */
function recordOf(entry: FreshEntry): { name?: string; slug?: string } {
  const source = entry.kind === "finding" ? entry.finding : entry.track;
  const name = source.album?.trim();

  return { name: name || undefined, slug: source.albumSlug };
}

function releaseKey(entry: FreshEntry): string {
  const { name, slug } = recordOf(entry);

  if (slug) {
    return `album:${slug}`;
  }
  if (name) {
    // A record with no album entity has only its name, and generic names repeat ("Remixes"): its
    // lead credited artist keeps two artists' same-named records apart. The date is no part of the
    // key, so one record whose tracks came out in different weeks stays one record (the week rule).
    const source = entry.kind === "finding" ? entry.finding : entry.track;
    const lead = (source.artists[0] ?? "").trim().toLowerCase();

    return `record:${name.toLowerCase()}|${lead}`;
  }

  return `track:${entryTrackId(entry)}`;
}

function distinctCredits(tracks: DiscoveryTrack[]): string[] {
  const names: string[] = [];

  for (const track of tracks) {
    for (const artist of track.artists) {
      if (!names.includes(artist.name)) {
        names.push(artist.name);
      }
    }
  }

  return names.length > RELEASE_CREDIT_LIMIT ? ["Various artists"] : names;
}

const byTitle = new Intl.Collator("en", { sensitivity: "base" });

/**
 * A release's tracks in tracklist order as best the data knows it. There is no track number on a
 * row, but a label assigns a release's ISRCs in sequence, so the ISRC orders the tracks that carry
 * one; the rest follow by title, so the fold reads the same every time.
 */
function orderEntries(entries: FreshEntry[]): FreshEntry[] {
  const isrcOf = (entry: FreshEntry): string | undefined =>
    (entry.kind === "finding" ? entry.finding.isrc : entry.track.isrc) || undefined;
  const titleOf = (entry: FreshEntry): string =>
    entry.kind === "finding" ? entry.finding.title : entry.track.title;

  return [...entries].sort((a, b) => {
    const isrcA = isrcOf(a);
    const isrcB = isrcOf(b);

    if (isrcA && isrcB && isrcA !== isrcB) {
      return isrcA < isrcB ? -1 : 1;
    }
    if (Boolean(isrcA) !== Boolean(isrcB)) {
      return isrcA ? -1 : 1;
    }
    return byTitle.compare(titleOf(a), titleOf(b)) || (entryTrackId(a) < entryTrackId(b) ? -1 : 1);
  });
}

/** The payload holds a record's cover once: a track keeps its own only where it differs. */
function compactTrack(track: DiscoveryTrack, release: FreshRelease): DiscoveryTrack {
  return {
    ...track,
    avatarUrl: track.avatarUrl === release.avatarUrl ? undefined : track.avatarUrl,
    coverUrl: track.coverUrl === release.coverUrl ? undefined : track.coverUrl,
  };
}

/** A release's track as the row renders it: the record's cover and portrait put back. */
export function releaseTrack(release: FreshRelease, track: DiscoveryTrack): DiscoveryTrack {
  return {
    ...track,
    avatarUrl: track.avatarUrl ?? release.avatarUrl,
    coverUrl: track.coverUrl ?? release.coverUrl,
  };
}

/** Every track of a set of releases, in page order, ready for the rows and the player. */
export function releasesQueue(releases: FreshRelease[]): DiscoveryTrack[] {
  return releases.flatMap((release) => release.tracks.map((track) => releaseTrack(release, track)));
}

/** A release is playable when any of its tracks carries a live preview source. */
export function releasePlayable(release: FreshRelease): boolean {
  return release.tracks.some((track) => track.previewable);
}

/** A whole release, plus each of its tracks' own release date (the week rule's input). */
type BuiltRelease = { dates: Map<string, string>; release: FreshRelease };

function storedTrackCount(entry: FreshEntry): number | undefined {
  return entry.kind === "finding" ? entry.finding.albumTrackCount : entry.track.albumTrackCount;
}

function buildRelease(key: string, entries: FreshEntry[]): BuiltRelease {
  const ordered = orderEntries(entries);
  const tracks = ordered.map(freshEntryToDiscoveryTrack);
  const lead = tracks.find((track) => track.coverUrl) ?? tracks[0];
  const newest = entries[0] as FreshEntry;
  const record = recordOf(newest);
  const stored = Math.max(0, ...entries.map((entry) => storedTrackCount(entry) ?? 0));
  const release: FreshRelease = {
    albumSlug: record.slug,
    artists: distinctCredits(tracks),
    avatarUrl: tracks.find((track) => track.avatarUrl)?.avatarUrl,
    coverUrl: lead?.coverUrl,
    key,
    lit: tracks.some((track) => track.lit),
    record: record.slug ? stored > 1 : tracks.length > 1,
    releaseDate: newest.releaseDate,
    title: tracks.length > 1 ? (record.name ?? tracks[0]?.title ?? "") : (tracks[0]?.title ?? ""),
    tracks,
  };

  return {
    dates: new Map(ordered.map((entry) => [entryTrackId(entry), entry.releaseDate])),
    release: { ...release, tracks: tracks.map((track) => compactTrack(track, release)) },
  };
}

/**
 * The release as it appears in one week: that week's tracks only (the week rule), lit only if one of
 * them is a finding, dated by its newest track there, and titled by its one track when only one
 * came out that week (it then renders as the plain shared row).
 */
function weekSlice(built: BuiltRelease, tracks: DiscoveryTrack[]): FreshRelease {
  const { dates, release } = built;
  const newest = tracks
    .map((track) => dates.get(track.trackId) ?? "")
    .reduce((max, date) => (date > max ? date : max), "");
  const only = tracks.length === 1 ? tracks[0] : undefined;

  return {
    ...release,
    lit: tracks.some((track) => track.lit),
    releaseDate: newest,
    title: only ? only.title : release.title,
    tracks,
  };
}

/** Newest first; on a tie a release carrying a finding leads, then by title. */
function compareReleases(a: FreshRelease, b: FreshRelease): number {
  if (a.releaseDate !== b.releaseDate) {
    return a.releaseDate < b.releaseDate ? 1 : -1;
  }
  if (a.lit !== b.lit) {
    return a.lit ? -1 : 1;
  }
  return byTitle.compare(a.title, b.title) || (a.key < b.key ? -1 : 1);
}

/**
 * The standouts: at most one tile per release, findings first, then a release that can play, then
 * the bigger record, then the newest. Drawn from this week; a thin week is topped up from last
 * week, and the span says so. A selection holds at most half the releases it drew from, and two at
 * the least, or there is no strip.
 */
function pickStandouts(weeks: FreshWeek[]): FreshPage["standouts"] {
  const thisWeek = weeks.find((week) => week.index === 0)?.releases ?? [];
  const lastWeek = weeks.find((week) => week.index === 1)?.releases ?? [];
  const rank = (releases: FreshRelease[]) =>
    [...releases].sort((a, b) => {
      if (a.lit !== b.lit) {
        return a.lit ? -1 : 1;
      }
      if (releasePlayable(a) !== releasePlayable(b)) {
        return releasePlayable(a) ? -1 : 1;
      }
      if (a.tracks.length !== b.tracks.length) {
        return b.tracks.length - a.tracks.length;
      }
      return compareReleases(a, b);
    });

  // A selection shows at most half of what it drew from, or it is the list below it again.
  const room = (pool: number) => Math.min(FRESH_STANDOUT_LIMIT, Math.floor(pool / 2));
  const fromThisWeek = rank(thisWeek).slice(0, room(thisWeek.length));
  // A thin week tops up from last week, and its own releases lead the strip either way.
  const thin = fromThisWeek.length < FRESH_STANDOUT_MIN;
  const topRoom = room(thisWeek.length + lastWeek.length);
  // Its newest release leads even when half the week is none; the rest of the room is last week's.
  const picked = thin
    ? rank(thisWeek).slice(0, Math.min(topRoom, Math.max(1, fromThisWeek.length)))
    : fromThisWeek;
  // A record with tracks in both weeks is one release: its this-week slice already stands for it.
  const pickedKeys = new Set(picked.map((release) => release.key));
  const topUp = thin
    ? rank(lastWeek.filter((release) => !pickedKeys.has(release.key))).slice(
        0,
        topRoom - picked.length,
      )
    : [];
  const releases = [...picked, ...topUp];

  if (releases.length < FRESH_STANDOUT_MIN) {
    return undefined;
  }

  const span: FreshStandoutSpan =
    topUp.length === 0 ? "this-week" : picked.length === 0 ? "last-week" : "two-weeks";

  return { keys: releases.map((release) => release.key), span };
}

function coverageDay(coverage: FreshCoverage): string | undefined {
  if (coverage.kind === "partial") {
    return formatReleaseDate(freshDay(coverage.since));
  }
  if (coverage.kind === "truncated") {
    return formatReleaseDate(freshDay(coverage.day));
  }

  return undefined;
}

/** Fold the window's rows into whole releases, keyed as the page keys them. */
function foldReleases(data: FreshReleases): BuiltRelease[] {
  const groups = new Map<string, FreshEntry[]>();

  for (const entry of freshEntries(data)) {
    const key = releaseKey(entry);
    const group = groups.get(key);

    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  return [...groups].map(([key, entries]) => buildRelease(key, entries));
}

/**
 * Fold the window's rows into releases and the releases into rolling weeks. Pure: `today` is the
 * UTC day (`YYYY-MM-DD`) the weeks count back from.
 */
export function groupFreshReleases(data: FreshReleases, today: string): FreshPage {
  const built = foldReleases(data);
  const todayNumber = dayNumber(today);
  const windowStart = todayNumber - data.windowDays;
  const lastWeekIndex = freshWeekIndex(dayOf(windowStart), today, data.windowDays);
  const slices: { index: number; release: FreshRelease }[] = [];

  for (const release of built) {
    const byIndex = new Map<number, DiscoveryTrack[]>();

    for (const track of release.release.tracks) {
      const index = freshWeekIndex(release.dates.get(track.trackId) ?? "", today, data.windowDays);
      byIndex.set(index, [...(byIndex.get(index) ?? []), track]);
    }

    for (const [index, tracks] of byIndex) {
      slices.push({ index, release: weekSlice(release, tracks) });
    }
  }

  const byWeek = new Map<number, FreshRelease[]>();

  for (const { index, release } of slices.sort((a, b) => compareReleases(a.release, b.release))) {
    const week = byWeek.get(index);

    if (week) {
      week.push(release);
    } else {
      byWeek.set(index, [release]);
    }
  }

  const weeks: FreshWeek[] = [...byWeek]
    .sort(([a], [b]) => a - b)
    .map(([index, weekReleases]) => {
      const oldest =
        index === lastWeekIndex
          ? windowStart
          : todayNumber - index * FRESH_WEEK_DAYS - (FRESH_WEEK_DAYS - 1);
      const from = dayOf(Math.max(windowStart, oldest));
      const to = dayOf(todayNumber - index * FRESH_WEEK_DAYS);

      return { from, index, releases: weekReleases, span: formatReleaseDayRange(from, to), to };
    });

  return {
    coverage: data.coverage,
    coverageDate: coverageDay(data.coverage),
    releaseCount: built.length,
    standouts: pickStandouts(weeks),
    today,
    trackCount: data.findings.length + data.catalogue.length,
    weeks,
    windowDays: data.windowDays,
  };
}

/** The `/fresh` view the reader has picked (the `?view=` pill). */
export type FreshView = "albums" | "all" | "tracks";

/**
 * The weeks a view shows. "All" and "Tracks" hold every release (Tracks renders them as flat rows);
 * "Albums & EPs" keeps the records ({@link FreshRelease.record}) and drops a week left empty. No
 * release type is stored, so a single the archive holds two versions of counts as a record.
 */
export function freshViewWeeks(page: FreshPage, view: FreshView): FreshWeek[] {
  if (view !== "albums") {
    return page.weeks;
  }

  return page.weeks
    .map((week) => ({ ...week, releases: week.releases.filter((release) => release.record) }))
    .filter((week) => week.releases.length > 0);
}

/**
 * The newest `count` WHOLE releases in the window (every track of each in the window, whichever
 * week it came out in): the front door's window onto `/fresh`.
 */
export function newestFreshReleases(data: FreshReleases, count: number): FreshRelease[] {
  return foldReleases(data)
    .map((built) => built.release)
    .sort(compareReleases)
    .slice(0, count);
}
