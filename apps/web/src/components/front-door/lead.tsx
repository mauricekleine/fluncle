import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { GraphLink } from "@/components/graph-link";
import { PlayButton, PlayCover } from "@/components/player/playable-list";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { formatDateLong } from "@/lib/format";
import { discoveryQueueTrack, findingToDiscoveryTrack } from "@/lib/discovery-tracks";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize } from "@/lib/media";

const LEAD_COVER_SIZE = "large" as const;

export function FrontDoorLead({ lead }: { lead: TrackListItem }): ReactNode {
  const line = artistTitleLine(lead);
  const releaseYear = lead.releaseDate?.slice(0, 4);
  const playable = findingToDiscoveryTrack(lead);

  return (
    <article className="fd-lead">
      {playable.previewable ? (
        <PlayCover className="fd-lead-cover-play" lit track={discoveryQueueTrack(playable)}>
          <TrackArtwork
            alt=""
            className="fd-lead-cover"
            priority
            src={albumCoverAtSize(lead.albumImageUrl, LEAD_COVER_SIZE)}
          />
        </PlayCover>
      ) : (
        <TrackArtwork
          alt=""
          className="fd-lead-cover"
          priority
          src={albumCoverAtSize(lead.albumImageUrl, LEAD_COVER_SIZE)}
        />
      )}
      <div className="fd-lead-body">
        {lead.logId ? <p className="fd-lead-coordinate">{lead.logId}</p> : undefined}
        <p className="fd-lead-line">{line}</p>

        {lead.label || releaseYear ? (
          <p className="fd-lead-imprint">
            {lead.label && lead.labelSlug ? (
              <GraphLink kind="label" slug={lead.labelSlug}>
                {lead.label}
              </GraphLink>
            ) : (
              lead.label
            )}
            {releaseYear ? (lead.label ? ` (${releaseYear})` : releaseYear) : ""}
          </p>
        ) : undefined}
        {lead.note ? <p className="fd-lead-note">{lead.note}</p> : undefined}
        <TrackChips
          bpm={lead.bpm}
          className="fd-lead-chips"
          durationMs={lead.durationMs}
          musicalKey={lead.key}
        />
        <p className="fd-lead-found">
          Found <time dateTime={lead.addedAt}>{formatDateLong(lead.addedAt)}</time>
        </p>
        <div className="fd-lead-actions">
          {playable.previewable ? (
            <PlayButton
              className="fd-lead-play"
              labels={{ pause: "Pause the preview", play: "Play the preview" }}
              track={discoveryQueueTrack(playable)}
            />
          ) : undefined}
          {lead.logId ? (
            <Link
              aria-label={`Read the log entry for ${line}`}
              className="fd-lead-open"
              params={{ logId: lead.logId }}
              to="/log/$logId"
            >
              Read the log entry
            </Link>
          ) : (
            <a
              aria-label={`Listen to ${line} on Spotify`}
              className="fd-lead-open"
              href={lead.spotifyUrl}
              rel="noreferrer"
              target="_blank"
            >
              Listen on Spotify
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
