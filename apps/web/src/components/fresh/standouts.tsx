import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { ArtistAvatar } from "@/components/artist-avatar";
import { PlayCover } from "@/components/player/playable-list";
import { TrackArtwork } from "@/components/track-artwork";
import { discoveryQueueTrack } from "@/lib/discovery-tracks";
import { tracksCount } from "@/lib/format";
import { type FreshRelease, type FreshStandoutSpan, releaseTrack } from "@/lib/fresh-releases";
import { albumCoverAtSize, HUB_COVER_TILE_SIZE } from "@/lib/media";
import { freshStandoutsHeading } from "./copy";
import { FreshNewMark, releaseLead } from "./release-entry";

function StandoutArt({
  priority,
  release,
}: {
  priority: boolean;
  release: FreshRelease;
}): ReactNode {
  const cover = albumCoverAtSize(release.coverUrl, HUB_COVER_TILE_SIZE);

  if (!cover && !release.lit && release.avatarUrl) {
    return (
      <ArtistAvatar
        className="fresh-standout-art fresh-standout-avatar"
        name={release.artists[0] ?? release.title}
        priority={priority}
        src={albumCoverAtSize(release.avatarUrl, HUB_COVER_TILE_SIZE)}
      />
    );
  }

  return <TrackArtwork alt="" className="fresh-standout-art" priority={priority} src={cover} />;
}

function StandoutTitle({ release }: { release: FreshRelease }): ReactNode {
  const title = <span className="fresh-standout-title">{release.title}</span>;
  const credit = release.artists.join(", ");

  const name = credit ? `${release.title} by ${credit}` : undefined;
  const first = release.tracks[0];
  const track = first ? releaseTrack(release, first) : undefined;

  if (release.tracks.length > 1 && release.albumSlug) {
    return (
      <Link
        aria-label={name}
        className="fresh-standout-link"
        params={{ slug: release.albumSlug }}
        to="/album/$slug"
      >
        {title}
      </Link>
    );
  }

  if (release.tracks.length === 1 && track?.href) {
    return (
      <Link aria-label={name} className="fresh-standout-link" to={track.href as never}>
        {title}
      </Link>
    );
  }

  if (release.tracks.length === 1 && track?.spotifyUrl) {
    return (
      <a
        aria-label={name}
        className="fresh-standout-link"
        href={track.spotifyUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        {title}
      </a>
    );
  }

  return title;
}

function Standout({
  isNew,
  priority,
  release,
}: {
  isNew: boolean;

  priority: boolean;
  release: FreshRelease;
}): ReactNode {
  const lead = releaseLead(release);

  return (
    <li className="fresh-standout" data-lit={release.lit ? "" : undefined}>
      {lead ? (
        <PlayCover
          className="fresh-standout-play"
          lit={release.lit}
          track={discoveryQueueTrack(lead)}
        >
          <StandoutArt priority={priority} release={release} />
        </PlayCover>
      ) : (
        <span className="fresh-standout-still">
          <StandoutArt priority={priority} release={release} />
        </span>
      )}
      <div className="fresh-standout-body">
        <StandoutTitle release={release} />
        <p className="fresh-standout-meta">{release.artists.join(", ")}</p>
        <p className="fresh-standout-count">
          {release.tracks.length > 1 ? tracksCount(release.tracks.length) : null}
          {isNew ? <FreshNewMark /> : null}
        </p>
      </div>
    </li>
  );
}

export function FreshStandouts({
  newKeys,
  releases,
  span,
}: {
  newKeys?: ReadonlySet<string>;
  releases: FreshRelease[];
  span: FreshStandoutSpan;
}): ReactNode {
  const headingId = useId();

  if (releases.length === 0) {
    return undefined;
  }

  return (
    <section aria-labelledby={headingId} className="fresh-standouts">
      <h2 className="fresh-band-title" id={headingId}>
        {freshStandoutsHeading(span)}
      </h2>
      <ul className="fresh-standout-grid">
        {releases.map((release, index) => (
          <Standout
            isNew={newKeys?.has(release.key) ?? false}
            key={release.key}
            priority={index === 0}
            release={release}
          />
        ))}
      </ul>
    </section>
  );
}
