import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { ArtistAvatar } from "@/components/artist-avatar";
import { GraphLink } from "@/components/graph-link";
import { PlayableList, PlayCover } from "@/components/player/playable-list";
import { TrackActionsMenu } from "@/components/player/track-actions-menu";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { albumCoverAtSize } from "@/lib/media";
import {
  type DiscoveryCredit,
  type DiscoveryTrack,
  discoveryQueue,
  discoveryQueueTrack,
} from "@/lib/discovery-tracks";
import { type QueueTrack } from "@/lib/preview-player";
import { cn } from "@/lib/utils";

function Credits({ credits }: { credits: DiscoveryCredit[] }): ReactNode {
  return credits.map((credit, index) => (
    <span key={`${credit.name}-${index}`}>
      {index > 0 ? ", " : null}
      {credit.slug ? (
        <GraphLink kind="artist" slug={credit.slug}>
          {credit.name}
        </GraphLink>
      ) : (
        credit.name
      )}
    </span>
  ));
}

export function RowArt({ track }: { track: DiscoveryTrack }): ReactNode {
  const cover = albumCoverAtSize(track.coverUrl, "small");

  if (!cover && !track.lit && track.avatarUrl) {
    return (
      <ArtistAvatar
        className="discovery-row-art discovery-row-avatar"
        name={track.artists[0]?.name ?? track.title}
        src={albumCoverAtSize(track.avatarUrl, "small")}
      />
    );
  }

  return <TrackArtwork alt="" className="discovery-row-art" src={cover} />;
}

export function DiscoveryRow({
  marker,
  menuItems,
  track,
}: {
  marker?: ReactNode;

  menuItems?: ReactNode;
  track: DiscoveryTrack;
}): ReactNode {
  const queued = discoveryQueueTrack(track);
  const credit = track.artists.map((artist) => artist.name).join(", ");
  const linkName = credit.length > 0 ? `${track.title} by ${credit}` : undefined;
  const hasMeta = track.artists.length > 0 || track.label || track.year;
  const headline = track.href ? (
    <Link aria-label={linkName} className="discovery-row-link" to={track.href as never}>
      <span className="discovery-row-title">{track.title}</span>
    </Link>
  ) : track.spotifyUrl ? (
    <a
      aria-label={linkName}
      className="discovery-row-link"
      href={track.spotifyUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="discovery-row-title">{track.title}</span>
    </a>
  ) : (
    <span className="discovery-row-title">{track.title}</span>
  );

  return (
    <li className="discovery-row" data-lit={track.lit ? "" : undefined}>
      {track.previewable ? (
        <PlayCover lit={track.lit} track={queued}>
          <RowArt track={track} />
        </PlayCover>
      ) : (
        <span className="discovery-row-still">
          <RowArt track={track} />
        </span>
      )}

      <div className="discovery-row-body">
        {marker ? (
          <div className="discovery-row-headline">
            {headline}
            {marker}
          </div>
        ) : (
          headline
        )}
        {hasMeta ? (
          <p className="discovery-row-meta">
            <span className="discovery-row-credits">
              <Credits credits={track.artists} />
              {track.label ? (
                <>
                  {track.artists.length > 0 ? " · " : null}
                  {track.label.slug ? (
                    <GraphLink kind="label" slug={track.label.slug}>
                      {track.label.name}
                    </GraphLink>
                  ) : (
                    track.label.name
                  )}
                </>
              ) : null}
            </span>
            {track.year ? (
              <span className="discovery-row-year">
                {track.artists.length > 0 || track.label ? " · " : null}
                {track.year}
              </span>
            ) : null}
          </p>
        ) : null}
        <TrackChips
          bpm={track.bpm}
          className="discovery-row-chips"
          durationMs={track.durationMs}
          musicalKey={track.key}
        />
      </div>

      <div className="discovery-row-tail">
        {track.lit && track.logId ? (
          <span className="discovery-row-coordinate">{track.logId}</span>
        ) : null}
        <TrackActionsMenu track={queued}>{menuItems}</TrackActionsMenu>
      </div>
    </li>
  );
}

export function DiscoveryPlayableList({
  children,
  nextPageHref,
  seed,
  tracks,
}: {
  children: ReactNode;
  nextPageHref?: string;
  /** The track a sonic view's list sounds like; it joins the player's trail when the list plays. */
  seed?: QueueTrack;
  tracks: DiscoveryTrack[];
}): ReactNode {
  const queue = useMemo(() => discoveryQueue(tracks), [tracks]);

  return (
    <PlayableList nextPageHref={nextPageHref} seed={seed} tracks={queue}>
      {children}
    </PlayableList>
  );
}

export function DiscoveryList({
  className,
  label,
  nextPageHref,
  tracks,
}: {
  className?: string;

  label?: string;
  nextPageHref?: string;
  tracks: DiscoveryTrack[];
}): ReactNode {
  return (
    <DiscoveryPlayableList nextPageHref={nextPageHref} tracks={tracks}>
      <ul aria-label={label} className={cn("discovery-list", className)}>
        {tracks.map((track) => (
          <DiscoveryRow key={track.trackId} track={track} />
        ))}
      </ul>
    </DiscoveryPlayableList>
  );
}
