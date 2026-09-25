// THE DISCOVERY ROW — the one track row every public list renders (DESIGN.md §5, Track Row).
//
// Derived from the canonical finding row (`components/track-row.tsx`) and shared by `/tracks`,
// `/search`, `/fresh`, the front door's releases band, and the track lists on the artist, label
// and album pages, so what is clickable, where play lives, the readout and the cover rule read
// the same everywhere:
//
//   - THE COVER IS THE PLAY BUTTON (`PlayCover`): it plays the whole list from this row. Only a
//     row with a live preview source shows it (a stored preview URL or an ISRC — the `/api/preview`
//     relay re-resolves from those); a row without one keeps its cover as a plain image.
//   - THE REST OF THE ROW OPENS THE TRACK: the title is a stretched link over the row, to the
//     finding's coordinate page or the archive track's own destination. The credits, the cover
//     button and the ⋮ menu sit ABOVE it as siblings, never inside it — a link inside a link is
//     not a thing (GraphLink's excluded contexts).
//   - THE TITLE IS THE LOUDEST TEXT. The artists and the imprint are GraphLinks on the metadata
//     line in Stardust, with the release year beside them; the readout chips (duration, BPM, key)
//     sit beneath (The Readout Rule). There is no date column.
//   - THE LIGHT IS THE REGISTER, and nothing else says it (The Unlit Rule). A finding shows its
//     cover in full colour, its coordinate, and heats to gold. A catalogue row shows its REAL cover
//     desaturated and dimmed (the lead artist's portrait, dimmed, when it has no cover), catches the
//     Dust Veil, and carries no coordinate and no gold. No word on the row names the register.
//   - Everything rarer lives behind the quiet ⋮ menu: the same actions the player carries.

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

function RowArt({ track }: { track: DiscoveryTrack }): ReactNode {
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
  menuItems,
  track,
}: {
  /** A row's own extra ⋮ entries, rendered above the shared ones (a finding's story). */
  menuItems?: ReactNode;
  track: DiscoveryTrack;
}): ReactNode {
  const queued = discoveryQueueTrack(track);
  const credit = track.artists.map((artist) => artist.name).join(", ");
  const linkName = credit.length > 0 ? `${track.title} by ${credit}` : undefined;
  const hasMeta = track.artists.length > 0 || track.label || track.year;

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
        {track.href ? (
          // Named with its credit, so two rows that share a title never read as one link.
          <Link aria-label={linkName} className="discovery-row-link" to={track.href as never}>
            <span className="discovery-row-title">{track.title}</span>
          </Link>
        ) : track.spotifyUrl ? (
          // A row the destination would refuse (no title or credit) still has one honest way
          // out: the whole row opens Spotify.
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
        )}
        {hasMeta ? (
          // The credits truncate; the year never does (The Readout Rule).
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

/**
 * The queue boundary for any markup that holds discovery rows: every `PlayCover` inside plays the
 * playable subset of `tracks`, in order, from its own row. Use it directly where one answer spans
 * several blocks (search's findings and tracks groups are one list to the player).
 */
export function DiscoveryPlayableList({
  children,
  nextPageHref,
  tracks,
}: {
  children: ReactNode;
  nextPageHref?: string;
  tracks: DiscoveryTrack[];
}): ReactNode {
  const queue = useMemo(() => discoveryQueue(tracks), [tracks]);

  return (
    <PlayableList nextPageHref={nextPageHref} tracks={queue}>
      {children}
    </PlayableList>
  );
}

/** A list of discovery rows that plays as one: the player's queue is this list, in order. */
export function DiscoveryList({
  className,
  label,
  nextPageHref,
  tracks,
}: {
  className?: string;
  /** The list's accessible name, when it has no visible heading naming it. */
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
