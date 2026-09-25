import { type DiscoveryTrack, freshEntryToDiscoveryTrack } from "./discovery-tracks";
import { formatReleaseDate, formatReleaseDayRange } from "./format";
import {
  type FreshCatalogueItem,
  type FreshCoverage,
  type FreshFinding,
  type FreshReleases,
} from "./server/fresh";

export type FreshEntry =
  | { kind: "catalogue"; releaseDate: string; track: FreshCatalogueItem }
  | { kind: "finding"; finding: FreshFinding; releaseDate: string };

export const FRESH_WEEK_DAYS = 7;

export const FRESH_STANDOUT_LIMIT = 4;

const FRESH_STANDOUT_MIN = 2;

const RELEASE_CREDIT_LIMIT = 3;

export type FreshRelease = {
  albumSlug?: string;
  artists: string[];
  avatarUrl?: string;
  coverUrl?: string;

  key: string;

  lit: boolean;

  record: boolean;

  releaseDate: string;

  title: string;
  tracks: DiscoveryTrack[];
};

export type FreshWeek = {
  from: string;
  index: number;
  releases: FreshRelease[];

  span: string;

  to: string;
};

export type FreshStandoutSpan = "last-week" | "this-week" | "two-weeks";

export type FreshPage = {
  coverage: FreshCoverage;

  coverageDate?: string;

  releaseCount: number;

  standouts: { keys: string[]; span: FreshStandoutSpan } | undefined;

  today: string;
  trackCount: number;

  weeks: FreshWeek[];
  windowDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

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

export function freshWeekIndex(releaseDate: string, today: string, windowDays: number): number {
  const age = dayNumber(today) - dayNumber(freshDay(releaseDate));
  const lastWeek = Math.max(0, Math.floor(windowDays / FRESH_WEEK_DAYS) - 1);

  return Number.isFinite(age)
    ? Math.min(lastWeek, Math.max(0, Math.floor(age / FRESH_WEEK_DAYS)))
    : 0;
}

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

function compactTrack(track: DiscoveryTrack, release: FreshRelease): DiscoveryTrack {
  return {
    ...track,
    avatarUrl: track.avatarUrl === release.avatarUrl ? undefined : track.avatarUrl,
    coverUrl: track.coverUrl === release.coverUrl ? undefined : track.coverUrl,
  };
}

export function releaseTrack(release: FreshRelease, track: DiscoveryTrack): DiscoveryTrack {
  return {
    ...track,
    avatarUrl: track.avatarUrl ?? release.avatarUrl,
    coverUrl: track.coverUrl ?? release.coverUrl,
  };
}

export function releasesQueue(releases: FreshRelease[]): DiscoveryTrack[] {
  return releases.flatMap((release) => release.tracks.map((track) => releaseTrack(release, track)));
}

export function releasePlayable(release: FreshRelease): boolean {
  return release.tracks.some((track) => track.previewable);
}

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

function compareReleases(a: FreshRelease, b: FreshRelease): number {
  if (a.releaseDate !== b.releaseDate) {
    return a.releaseDate < b.releaseDate ? 1 : -1;
  }
  if (a.lit !== b.lit) {
    return a.lit ? -1 : 1;
  }
  return byTitle.compare(a.title, b.title) || (a.key < b.key ? -1 : 1);
}

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

  const room = (pool: number) => Math.min(FRESH_STANDOUT_LIMIT, Math.floor(pool / 2));
  const fromThisWeek = rank(thisWeek).slice(0, room(thisWeek.length));

  const thin = fromThisWeek.length < FRESH_STANDOUT_MIN;
  const topRoom = room(thisWeek.length + lastWeek.length);

  const picked = thin
    ? rank(thisWeek).slice(0, Math.min(topRoom, Math.max(1, fromThisWeek.length)))
    : fromThisWeek;

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

export type FreshView = "albums" | "all" | "tracks";

export function freshViewWeeks(page: FreshPage, view: FreshView): FreshWeek[] {
  if (view !== "albums") {
    return page.weeks;
  }

  return page.weeks
    .map((week) => ({ ...week, releases: week.releases.filter((release) => release.record) }))
    .filter((week) => week.releases.length > 0);
}

export function newestFreshReleases(data: FreshReleases, count: number): FreshRelease[] {
  return foldReleases(data)
    .map((built) => built.release)
    .sort(compareReleases)
    .slice(0, count);
}
