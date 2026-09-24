// `/fresh` — THE MARQUEE. A billboard of NOW, and the only treatment `/fresh` ships: the newest
// handful of drops set at display scale, big Oxanium dates down the edge, the rest running compact
// underneath. Loud on type, quiet on chrome — the energy of a board that just flipped.
//
// The headline is TWO parts — the credited artists and the title — so a narrow screen stacks them on
// their own rows and truncates each on its own (a long title never shoves the artist off, and the
// "Artist — Title" em dash never orphans mid-wrap). Wide screens flow them inline as one line.

import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { ArtistAvatar } from "@/components/artist-avatar";
import { DiscoveryPlayableList } from "@/components/discovery-row";
import { PlayCover } from "@/components/player/playable-list";
import { discoveryQueueTrack, freshEntryToDiscoveryTrack } from "@/lib/discovery-tracks";
import { type FreshReleases } from "@/lib/server/fresh";
import { FreshAlbumsBoard, FreshAlbumsRail } from "./albums-rail";
import {
  freshRecordCovers,
  freshStream,
  freshTrackWindowRecordCovers,
  type FreshStreamEntry,
  type FreshView,
} from "./data";
import { FreshMasthead } from "./masthead";
import { freshAvatarSrc, freshDateParts, FreshReleaseRows } from "./shared";
import { FreshViewControl } from "./view-control";

const MARQUEE_HEADLINE_COUNT = 6;

/** The two-part headline: artists, a hidden-on-mobile em dash, then the title — each truncatable. */
function MarqueeLine({ artists, title }: { artists: string[]; title: string }) {
  return (
    <>
      <span className="fresh-mq-artist">{artists.join(", ")}</span>
      <span aria-hidden="true" className="fresh-mq-sep">
        {" — "}
      </span>
      <span className="fresh-mq-title">{title}</span>
    </>
  );
}

/**
 * A headline's portrait, and its play control when the release has a live preview: the headline
 * plays the stream from its own place, exactly as a row's cover does.
 */
function HeadlinePlay({ avatar, entry }: { avatar: ReactNode; entry: FreshStreamEntry }) {
  const track = freshEntryToDiscoveryTrack(entry);

  if (!track.previewable) {
    return avatar;
  }

  return (
    <PlayCover className="fresh-mq-play" lit={track.lit} track={discoveryQueueTrack(track)}>
      {avatar}
    </PlayCover>
  );
}

function MarqueeHeadline({ entry }: { entry: FreshStreamEntry }) {
  const { day, month } = freshDateParts(entry.releaseDate);
  const stamp = (
    <time className="fresh-mq-date" dateTime={entry.releaseDate}>
      <span className="fresh-mq-day">{day}</span>
      <span className="fresh-mq-mon">{month}</span>
    </time>
  );

  if (entry.kind === "finding") {
    const finding = entry.finding;
    const line = `${finding.artists.join(", ")} — ${finding.title}`;
    const body = <MarqueeLine artists={finding.artists} title={finding.title} />;
    return (
      <li className="fresh-mq-row fresh-mq-lit">
        {stamp}
        <HeadlinePlay
          avatar={
            <ArtistAvatar
              className="fresh-mq-avatar"
              name={finding.artists[0] ?? finding.title}
              src={freshAvatarSrc(finding.artistAvatarUrl)}
            />
          }
          entry={entry}
        />
        {finding.logId ? (
          <Link
            aria-label={`Open the log page for ${line}`}
            className="fresh-mq-line"
            params={{ logId: finding.logId }}
            to="/log/$logId"
          >
            {body}
          </Link>
        ) : (
          <a
            aria-label={`Listen to ${line} on Spotify`}
            className="fresh-mq-line"
            href={finding.spotifyUrl}
            rel="noreferrer"
            target="_blank"
          >
            {body}
          </a>
        )}
      </li>
    );
  }

  const track = entry.track;
  const line = `${track.artists.join(", ")} — ${track.title}`;
  const body = <MarqueeLine artists={track.artists} title={track.title} />;
  return (
    <li className="fresh-mq-row fresh-mq-unlit">
      {stamp}
      <HeadlinePlay
        avatar={
          <ArtistAvatar
            className="fresh-mq-avatar fresh-mq-avatar-unlit"
            name={track.artists[0] ?? track.title}
            src={freshAvatarSrc(track.artistAvatarUrl)}
          />
        }
        entry={entry}
      />
      {track.spotifyUrl ? (
        <a
          aria-label={`${line} on Spotify`}
          className="fresh-mq-line"
          href={track.spotifyUrl}
          rel="noreferrer"
          target="_blank"
        >
          {body}
        </a>
      ) : (
        <span className="fresh-mq-line fresh-mq-plain">{body}</span>
      )}
    </li>
  );
}

/** The flat track stream — the marquee headlines over the compact rest-rows. The "All" view trails it
    with the 30-day albums rail; the "Tracks" view drops the rail and shows the stream alone. An empty
    stream (records but no tracks in the window) reads as a quiet line, never an empty bordered board. */
function FreshTrackStream({ data, view }: { data: FreshReleases; view: "all" | "tracks" }) {
  const stream = useMemo(() => freshStream(data), [data]);
  // The whole stream is one list to the player: a headline or a row plays from its own place.
  const discoveryTracks = useMemo(() => stream.map(freshEntryToDiscoveryTrack), [stream]);
  const headlines = stream.slice(0, MARQUEE_HEADLINE_COUNT);
  const rest = stream.slice(MARQUEE_HEADLINE_COUNT);

  if (stream.length === 0) {
    return (
      <p className="fresh-empty empty-scanlines">
        No new tracks in the last {data.windowDays} days.
      </p>
    );
  }

  return (
    <DiscoveryPlayableList tracks={discoveryTracks}>
      <ol className="fresh-mq-board">
        {headlines.map((entry) => (
          <MarqueeHeadline
            entry={entry}
            key={entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId}
          />
        ))}
      </ol>

      {rest.length > 0 ? (
        <FreshReleaseRows className="fresh-mq-rest" entries={rest} heading="h2" />
      ) : undefined}

      {view === "all" ? <FreshAlbumsRail albums={freshTrackWindowRecordCovers(data)} /> : undefined}
    </DiscoveryPlayableList>
  );
}

export function FreshMarquee({
  data,
  onViewChange,
  view,
}: {
  data: FreshReleases;
  onViewChange: (view: FreshView) => void;
  view: FreshView;
}) {
  return (
    <div className="fresh-stage fresh-marquee">
      <FreshMasthead />
      <FreshViewControl onChange={onViewChange} view={view} />

      {view === "albums" ? (
        <FreshAlbumsBoard albums={freshRecordCovers(data)} />
      ) : (
        <FreshTrackStream data={data} view={view} />
      )}
    </div>
  );
}
