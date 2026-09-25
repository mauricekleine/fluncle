import {
  type FreshPage,
  type FreshStandoutSpan,
  type FreshView,
  type FreshWeek,
} from "@/lib/fresh-releases";
import { tracksCount } from "@/lib/format";

function releasesCount(count: number): string {
  return `${count} ${count === 1 ? "release" : "releases"}`;
}

function stretchOf(page: FreshPage): string {
  if (page.coverage.kind === "truncated") {
    return `out on ${page.coverageDate ?? ""}`;
  }
  if (page.coverage.kind === "partial") {
    return `since ${page.coverageDate ?? ""}`;
  }

  return `from the last ${page.windowDays} days`;
}

export function freshIntro(page: FreshPage): string {
  const noun = page.releaseCount === 1 ? "release" : "releases";

  if (page.coverage.kind === "truncated") {
    return `${page.releaseCount} of the drum & bass ${noun} ${stretchOf(page)}.`;
  }

  return `${page.releaseCount} drum & bass ${noun} ${stretchOf(page)}.`;
}

export function freshEmptyLine(windowDays: number): string {
  return `No new releases in the last ${windowDays} days.`;
}

export function freshEmptyViewLine(windowDays: number): string {
  return `No albums or EPs out in the last ${windowDays} days.`;
}

export function freshWeekHeading(week: FreshWeek): string {
  if (week.index === 0) {
    return "This week";
  }
  if (week.index === 1) {
    return "Last week";
  }

  return week.span;
}

export function freshWeekCount(week: FreshWeek, view: FreshView): string {
  if (view === "tracks") {
    return tracksCount(week.releases.reduce((sum, release) => sum + release.tracks.length, 0));
  }

  return releasesCount(week.releases.length);
}

export function freshPlayWeekLabels(week: FreshWeek): {
  name?: { pause: string; play: string };
  pause: string;
  play: string;
} {
  if (week.index === 0) {
    return { pause: "Pause this week", play: "Play this week" };
  }
  if (week.index === 1) {
    return { pause: "Pause last week", play: "Play last week" };
  }

  return {
    name: { pause: `Pause the week of ${week.span}`, play: `Play the week of ${week.span}` },
    pause: "Pause the week",
    play: "Play the week",
  };
}

export function freshStandoutsHeading(span: FreshStandoutSpan): string {
  if (span === "this-week") {
    return "This week's standouts";
  }
  if (span === "last-week") {
    return "Last week's standouts";
  }

  return "Standouts from the last two weeks";
}

export function freshSinceVisitLine(count: number, view: FreshView = "all"): string {
  const noun = view === "tracks" ? "track" : "release";

  return count === 0
    ? `No new ${noun}s since your last visit.`
    : `${count} new ${count === 1 ? noun : `${noun}s`} since your last visit.`;
}

export function freshSinceVisitJump(view: FreshView = "all"): string {
  return `Jump to the first new ${view === "tracks" ? "track" : "release"}`;
}

export const FRESH_NEW_MARK_LABEL = "New";

export function freshEndLine(
  page: FreshPage,
  view: FreshView,
): { lead: string; tail: "caught-up" | "older" | "rest" } {
  const noun = view === "tracks" ? "track" : view === "albums" ? "album and EP" : "release";

  if (page.coverage.kind === "truncated") {
    return {
      lead: `That's part of what came out on ${page.coverageDate ?? ""}.`,
      tail: "rest",
    };
  }

  return {
    lead: `That's every ${noun} ${stretchOf(page)}.`,
    tail: page.coverage.kind === "partial" ? "older" : "caught-up",
  };
}
