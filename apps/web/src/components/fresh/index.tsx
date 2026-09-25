import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useMemo } from "react";
import { DiscoveryPlayableList, DiscoveryRow } from "@/components/discovery-row";
import { discoveryQueue } from "@/lib/discovery-tracks";
import {
  type FreshPage,
  type FreshRelease,
  type FreshView,
  type FreshWeek,
  freshViewWeeks,
  releasesQueue,
  releaseTrack,
} from "@/lib/fresh-releases";
import { type FreshVisitState, useFreshVisit } from "@/lib/fresh-visit";
import {
  freshEmptyLine,
  freshEmptyViewLine,
  freshEndLine,
  freshPlayWeekLabels,
  freshSinceVisitJump,
  freshSinceVisitLine,
  freshWeekCount,
  freshWeekHeading,
} from "./copy";
import { PlayListButton } from "./play-list-button";
import { FreshNewMark, FreshReleaseList } from "./release-entry";
import { FreshStandouts } from "./standouts";
import { FreshViewControl } from "./view-control";

function newKeysOf(visit: FreshVisitState | undefined): ReadonlySet<string> | undefined {
  return visit?.kind === "returning" ? visit.newKeys : undefined;
}

function FreshWeekSection({
  newKeys,
  view,
  week,
}: {
  newKeys?: ReadonlySet<string>;
  view: FreshView;
  week: FreshWeek;
}): ReactNode {
  const headingId = useId();
  const queue = useMemo(() => discoveryQueue(releasesQueue(week.releases)), [week.releases]);
  const heading = freshWeekHeading(week);

  return (
    <section aria-labelledby={headingId} className="fresh-week">
      <div className="fresh-week-head">
        <div className="fresh-week-label">
          <h2 className="fresh-band-title" id={headingId}>
            {heading}
          </h2>
          <p className="fresh-week-meta">
            <span className="fresh-week-count">{freshWeekCount(week, view)}</span>
            {heading === week.span ? null : <span className="fresh-week-span">{week.span}</span>}
          </p>
        </div>
        <PlayListButton labels={freshPlayWeekLabels(week)} tracks={queue} />
      </div>

      {view === "tracks" ? (
        <ol aria-labelledby={headingId} className="discovery-list fresh-week-tracks">
          {week.releases.flatMap((release) =>
            release.tracks.map((track) => (
              <DiscoveryRow
                key={track.trackId}
                marker={newKeys?.has(release.key) ? <FreshNewMark /> : undefined}
                track={releaseTrack(release, track)}
              />
            )),
          )}
        </ol>
      ) : (
        <FreshReleaseList newKeys={newKeys} releases={week.releases} />
      )}
    </section>
  );
}

function FreshEnd({ page, view }: { page: FreshPage; view: FreshView }): ReactNode {
  const { lead, tail } = freshEndLine(page, view);

  return (
    <p className="fresh-end">
      {lead}{" "}
      {tail === "caught-up" ? (
        "You're caught up."
      ) : tail === "older" ? (
        <>
          Older tracks are on the <Link to="/tracks">Tracks</Link> page.
        </>
      ) : (
        <>
          The rest of that day's tracks are on the <Link to="/tracks">Tracks</Link> page.
        </>
      )}
    </p>
  );
}

export function freshJumpTarget(entry: Pick<Element, "querySelector">): Element | null {
  return (
    entry.querySelector(".discovery-row-link") ??
    entry.querySelector(".fresh-release-toggle") ??
    entry.querySelector("[data-discovery-play]")
  );
}

function jumpToFirstNew(): void {
  const entry = document.querySelector(".fresh-week .fresh-new-mark")?.closest("li");
  const target = entry ? freshJumpTarget(entry) : null;

  entry?.scrollIntoView({ block: "center" });

  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
  }
}

function FreshBody({
  onViewChange,
  page,
  view,
  visit,
}: {
  onViewChange: (view: FreshView) => void;
  page: FreshPage;
  view: FreshView;
  visit: FreshVisitState | undefined;
}): ReactNode {
  const newKeys = newKeysOf(visit);
  const weeks = useMemo(() => freshViewWeeks(page, view), [page, view]);

  const newInView = useMemo(() => {
    const fresh = weeks
      .flatMap((week) => week.releases)
      .filter((release) => newKeys?.has(release.key));

    return view === "tracks"
      ? fresh.reduce((sum, release) => sum + release.tracks.length, 0)
      : fresh.length;
  }, [newKeys, view, weeks]);
  const tracks = useMemo(() => releasesQueue(weeks.flatMap((week) => week.releases)), [weeks]);
  const standouts = useMemo((): FreshRelease[] => {
    const byKey = new Map<string, FreshRelease>();

    for (const release of page.weeks
      .filter((week) => week.index <= 1)
      .flatMap((week) => week.releases)) {
      if (!byKey.has(release.key)) {
        byKey.set(release.key, release);
      }
    }

    return (page.standouts?.keys ?? []).flatMap((key) => byKey.get(key) ?? []);
  }, [page.standouts, page.weeks]);

  return (
    <>
      <div className="fresh-controls">
        <FreshViewControl onChange={onViewChange} view={view} />

        <div className="fresh-since-visit-row">
          <p aria-live="polite" className="fresh-since-visit">
            {visit?.kind === "returning" ? freshSinceVisitLine(newInView, view) : null}
          </p>
          {visit?.kind === "returning" && newInView > 0 ? (
            <button className="fresh-since-visit-jump" onClick={jumpToFirstNew} type="button">
              {freshSinceVisitJump(view)}
            </button>
          ) : null}
        </div>
      </div>

      {weeks.length === 0 ? (
        <p className="log-index-empty empty-scanlines">{freshEmptyViewLine(page.windowDays)}</p>
      ) : (
        <DiscoveryPlayableList tracks={tracks}>
          {view === "all" && page.standouts ? (
            <FreshStandouts newKeys={newKeys} releases={standouts} span={page.standouts.span} />
          ) : null}
          {weeks.map((week) => (
            <FreshWeekSection key={week.index} newKeys={newKeys} view={view} week={week} />
          ))}
          <FreshEnd page={page} view={view} />
        </DiscoveryPlayableList>
      )}
    </>
  );
}

export function freshPageKeys(page: FreshPage): string[] {
  return [...new Set(page.weeks.flatMap((week) => week.releases.map((release) => release.key)))];
}

export function FreshPageView({
  onViewChange,
  page,
  view,
}: {
  onViewChange: (view: FreshView) => void;
  page: FreshPage;
  view: FreshView;
}): ReactNode {
  const keys = useMemo(() => freshPageKeys(page), [page]);
  const visit = useFreshVisit(keys);

  return page.weeks.length === 0 ? (
    <p className="log-index-empty empty-scanlines">{freshEmptyLine(page.windowDays)}</p>
  ) : (
    <FreshBody onViewChange={onViewChange} page={page} view={view} visit={visit} />
  );
}
