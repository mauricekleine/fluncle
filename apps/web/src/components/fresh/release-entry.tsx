import { CaretDownIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@fluncle/ui/components/collapsible";
import { DiscoveryRow, RowArt } from "@/components/discovery-row";
import { PlayCover } from "@/components/player/playable-list";
import { type DiscoveryTrack, discoveryQueueTrack } from "@/lib/discovery-tracks";
import { tracksCount } from "@/lib/format";
import { type FreshRelease, releaseTrack } from "@/lib/fresh-releases";
import { FRESH_NEW_MARK_LABEL } from "./copy";

export function FreshNewMark(): ReactNode {
  return <span className="fresh-new-mark">{FRESH_NEW_MARK_LABEL}</span>;
}

export function releaseLead(release: FreshRelease): DiscoveryTrack | undefined {
  const lead = release.tracks.find((track) => track.previewable);

  return lead ? releaseTrack(release, lead) : undefined;
}

function ReleaseArt({ release }: { release: FreshRelease }): ReactNode {
  const first = release.tracks[0];

  return first ? (
    <RowArt track={{ ...releaseTrack(release, first), lit: release.lit }} />
  ) : undefined;
}

function MultiTrackRelease({
  isNew,
  release,
}: {
  isNew: boolean;
  release: FreshRelease;
}): ReactNode {
  const titleId = useId();
  const lead = releaseLead(release);
  const credit = release.artists.join(", ");
  const year = release.releaseDate.slice(0, 4);

  return (
    <li className="fresh-release" data-lit={release.lit ? "" : undefined}>
      <Collapsible>
        <div className="discovery-row fresh-release-head" data-lit={release.lit ? "" : undefined}>
          {lead ? (
            <PlayCover lit={release.lit} track={discoveryQueueTrack(lead)}>
              <ReleaseArt release={release} />
            </PlayCover>
          ) : (
            <span className="discovery-row-still">
              <ReleaseArt release={release} />
            </span>
          )}

          <div className="discovery-row-body">
            <div className="discovery-row-headline">
              {release.albumSlug ? (
                <Link
                  aria-label={credit ? `${release.title} by ${credit}` : undefined}
                  className="discovery-row-link"
                  params={{ slug: release.albumSlug }}
                  to="/album/$slug"
                >
                  <span className="discovery-row-title" id={titleId}>
                    {release.title}
                  </span>
                </Link>
              ) : (
                <span className="discovery-row-title" id={titleId}>
                  {release.title}
                </span>
              )}
              {isNew ? <FreshNewMark /> : null}
            </div>
            <p className="discovery-row-meta">
              <span className="discovery-row-credits">{credit}</span>
              {/^\d{4}$/.test(year) ? (
                <span className="discovery-row-year">
                  {credit ? " · " : null}
                  {year}
                </span>
              ) : null}
            </p>
          </div>

          <div className="discovery-row-tail">
            <CollapsibleTrigger
              aria-label={`${tracksCount(release.tracks.length)}, ${release.title}`}
              className="fresh-release-toggle"
            >
              {tracksCount(release.tracks.length)}
              <CaretDownIcon aria-hidden="true" className="fresh-release-caret" />
            </CollapsibleTrigger>
          </div>
        </div>

        <CollapsibleContent className="fresh-release-panel">
          <ol aria-labelledby={titleId} className="discovery-list fresh-release-tracks">
            {release.tracks.map((track) => (
              <DiscoveryRow key={track.trackId} track={releaseTrack(release, track)} />
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function FreshReleaseEntry({
  isNew,
  release,
}: {
  isNew: boolean;
  release: FreshRelease;
}): ReactNode {
  const only = release.tracks.length === 1 ? release.tracks[0] : undefined;

  if (only) {
    return (
      <DiscoveryRow
        marker={isNew ? <FreshNewMark /> : undefined}
        track={releaseTrack(release, only)}
      />
    );
  }

  return <MultiTrackRelease isNew={isNew} release={release} />;
}

export function FreshReleaseList({
  className,
  label,
  newKeys,
  releases,
}: {
  className?: string;
  label?: string;
  newKeys?: ReadonlySet<string>;
  releases: FreshRelease[];
}): ReactNode {
  return (
    <ol aria-label={label} className={className ? `fresh-releases ${className}` : "fresh-releases"}>
      {releases.map((release) => (
        <FreshReleaseEntry
          isNew={newKeys?.has(release.key) ?? false}
          key={release.key}
          release={release}
        />
      ))}
    </ol>
  );
}
