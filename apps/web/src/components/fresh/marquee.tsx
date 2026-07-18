// `/fresh` — THE MARQUEE. A billboard of NOW, and the only treatment `/fresh` ships: the newest
// handful of drops set at display scale, big Oxanium dates down the edge, the rest running compact
// underneath. Loud on type, quiet on chrome — the energy of a board that just flipped.
//
// The headline is TWO parts — the credited artists and the title — so a narrow screen stacks them on
// their own rows and truncates each on its own (a long title never shoves the artist off, and the
// "Artist — Title" em dash never orphans mid-wrap). Wide screens flow them inline as one line.

import { Link } from "@tanstack/react-router";
import { ArtistAvatar } from "@/components/artist-avatar";
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
import { freshDateParts, FreshStreamRow } from "./shared";
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
        <ArtistAvatar
          className="fresh-mq-avatar"
          name={finding.artists[0] ?? finding.title}
          src={finding.artistAvatarUrl}
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
      <ArtistAvatar
        className="fresh-mq-avatar fresh-mq-avatar-unlit"
        name={track.artists[0] ?? track.title}
        src={track.artistAvatarUrl}
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
  const stream = freshStream(data);
  const headlines = stream.slice(0, MARQUEE_HEADLINE_COUNT);
  const rest = stream.slice(MARQUEE_HEADLINE_COUNT);

  if (stream.length === 0) {
    return (
      <p className="fresh-empty empty-scanlines">No new tracks landed this month. Quiet sector.</p>
    );
  }

  return (
    <>
      <ol className="fresh-mq-board">
        {headlines.map((entry) => (
          <MarqueeHeadline
            entry={entry}
            key={entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId}
          />
        ))}
      </ol>

      {rest.length > 0 ? (
        <ol className="fresh-rows fresh-mq-rest">
          {rest.map((entry) => (
            <FreshStreamRow
              entry={entry}
              key={entry.kind === "finding" ? entry.finding.trackId : entry.track.trackId}
            />
          ))}
        </ol>
      ) : undefined}

      {view === "all" ? <FreshAlbumsRail albums={freshTrackWindowRecordCovers(data)} /> : undefined}
    </>
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
