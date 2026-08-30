// Concept A — the front page. Its pieces.
//
// The model is EDITORIAL: Fluncle places, the visitor reads. So every component
// here is a piece of a printed page — a lead, an entry in a column, a tile in a
// band — and none of them is a control. The only interaction is following a link,
// which is exactly the argument this concept makes.
//
// The register split is structural, not decorative. A certified record leads with
// its cover and its coordinate; a record Fluncle has not been to is a coverless,
// dust-inked line that sends you out. The two never share a silhouette
// (DESIGN.md, The Unlit Rule; the same split `components/fresh/shared.tsx` makes).

import { Link } from "@tanstack/react-router";

import { Coordinate, Cover, ListenRow, Readout } from "@/components/concepts/shared";
import { freshDate } from "@/components/fresh/shared";
import { type ConceptTrack, billing, releaseYear } from "@/concepts/discovery/model";
import { type FreshRecord } from "@/routes/-concepts-data";

/** The lead: one record given the room, with Fluncle's own line about it. */
export function FrontLead({ track }: { track: ConceptTrack }) {
  return (
    <article className="front-lead">
      <div className="front-lead-frame">
        <Cover className="front-lead-cover" lit={track.certified} priority src={track.coverUrl} />
      </div>
      <div className="flex flex-col items-start gap-4">
        <Coordinate track={track} />
        <h2 className="front-lead-title">
          {track.logId === undefined ? (
            billing(track)
          ) : (
            <Link
              className="concept-focus text-inherit no-underline transition-colors duration-150 hover:text-accent-foreground"
              params={{ logId: track.logId }}
              to="/concepts/front/track/$logId"
            >
              {billing(track)}
            </Link>
          )}
        </h2>
        {track.note === undefined ? null : <p className="front-note">{track.note}</p>}
        <Readout track={track} />
        <TrackImprint track={track} />
        <ListenRow size="lg" track={track} />
      </div>
    </article>
  );
}

/** The label and record line, with the graph nodes the exhibit actually holds. */
export function TrackImprint({ track }: { track: ConceptTrack }) {
  const parts: string[] = [];

  if (track.album !== undefined) {
    parts.push(track.album);
  }

  const year = releaseYear(track.releaseDate);

  if (year !== undefined) {
    parts.push(year);
  }

  if (track.label === undefined && parts.length === 0) {
    return null;
  }

  return (
    <p className="text-[0.85rem] text-muted-foreground">
      {track.label === undefined ? null : (
        <>
          {track.labelSlug === undefined ? (
            track.label
          ) : (
            <Link
              className="concept-focus text-inherit underline decoration-dotted underline-offset-4 transition-colors duration-150 hover:text-accent-foreground hover:decoration-solid"
              params={{ kind: "label", slug: track.labelSlug }}
              to="/concepts/front/on/$kind/$slug"
            >
              {track.label}
            </Link>
          )}
          {parts.length > 0 ? " · " : null}
        </>
      )}
      {parts.join(" · ")}
    </p>
  );
}

/** One entry in the column under the lead. The whole entry is the link. */
export function FrontEntry({ track }: { track: ConceptTrack }) {
  const to = track.logId;

  return (
    <article className="front-entry">
      <Cover className="front-entry-cover" lit={track.certified} src={track.coverUrl} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <Coordinate className="front-entry-coord" track={track} />
        <h3 className="text-[1.02rem] leading-tight font-extrabold text-foreground">
          {to === undefined ? (
            billing(track)
          ) : (
            <Link
              className="front-entry-link text-inherit no-underline"
              params={{ logId: to }}
              to="/concepts/front/track/$logId"
            >
              {billing(track)}
            </Link>
          )}
        </h3>
        {track.note === undefined ? null : (
          <p className="line-clamp-2 text-[0.85rem] text-muted-foreground">{track.note}</p>
        )}
        <Readout track={track} />
      </div>
    </article>
  );
}

/** A cover tile in the earlier grid. */
export function FrontTile({ track }: { track: ConceptTrack }) {
  const to = track.logId;

  return (
    <article className="front-tile">
      <Cover className="front-tile-cover" lit={track.certified} src={track.coverUrl} />
      <h3 className="mt-2 text-[0.82rem] leading-snug font-bold text-foreground">
        {to === undefined ? (
          billing(track)
        ) : (
          <Link
            className="front-entry-link concept-focus text-inherit no-underline transition-colors duration-150 hover:text-accent-foreground"
            params={{ logId: to }}
            to="/concepts/front/track/$logId"
          >
            {billing(track)}
          </Link>
        )}
      </h3>
    </article>
  );
}

/**
 * A record in the release band. No cover and no coordinate, so it can never be
 * mistaken for a finding: an unlit record is a name and a date, and the eye reads
 * the change of kind before it reads a word.
 */
export function FrontRecord({ record }: { record: FreshRecord }) {
  return (
    <div className="front-release">
      <p className="min-w-0 text-[0.86rem] text-[var(--stardust)]">
        {record.artists.join(", ")} — {record.name}
      </p>
      <div className="flex shrink-0 items-center gap-3">
        {record.releaseDate === undefined ? null : (
          <p className="text-[0.8rem] text-[var(--stardust)] tabular-nums">
            Out {freshDate(record.releaseDate)}
          </p>
        )}
      </div>
    </div>
  );
}

/** A line in the release band: what came out, and where to hear it. */
export function FrontRelease({ track }: { track: ConceptTrack }) {
  return (
    <div className="front-release">
      <p className="min-w-0 text-[0.86rem] text-[var(--stardust)]">{billing(track)}</p>
      <div className="flex shrink-0 items-center gap-3">
        <ListenRow dense tone="quiet" track={track} />
        {track.releaseDate === undefined ? null : (
          <p className="text-[0.8rem] text-[var(--stardust)] tabular-nums">
            Out {freshDate(track.releaseDate)}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The sonic step out of a record: Fluncle's own ranking of what sits closest to
 * it. Most of what lands here is not something he has certified, so the rows stay
 * unlit and carry only a link out to where the record can be heard.
 */
export function CloseInSound({ anchor, tracks }: { anchor: ConceptTrack; tracks: ConceptTrack[] }) {
  if (tracks.length === 0) {
    return null;
  }

  return (
    <section className="front-band">
      <h2 className="text-[1.05rem] font-extrabold text-foreground">
        Closest in sound to {billing(anchor)}
      </h2>
      <div className="mt-3">
        {tracks.map((track, index) => (
          <FrontRelease key={`${track.trackId}-${index}`} track={track} />
        ))}
      </div>
    </section>
  );
}
