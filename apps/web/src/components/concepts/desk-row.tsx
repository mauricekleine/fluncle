// One row on the Desk's board.
//
// The row is NOT a link. This concept is a tool, so the row carries several
// independent gestures instead of one destination: each name narrows the board,
// the coordinate names the finding, the seed action re-anchors the whole query on
// this record's sound, and the listening controls leave for the platform.
//
// Tier is carried structurally by `data-lit`, never verbally: a row with a
// coordinate may take Eclipse Gold, a row without one catches the Dust Veil and is
// never named, badged, or headed (DESIGN.md, The Unlit Rule). The only gold an
// unlit row ever shows is the focus ring, which is an accessibility affordance
// rather than a claim about the music.

import { WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import { Coordinate, Cover, ListenRow, Readout } from "@/components/concepts/shared";
import { type ConceptTrack } from "@/concepts/discovery/model";
import { type DeskFilters } from "@/routes/-concepts-data";

/**
 * Every control on the Desk is a `Link` back to the same route, so TanStack's
 * default (fuzzy) active matching would mark each "remove this facet" link as the
 * current page — its search is a SUBSET of the applied state. That paints the
 * removal control as the applied one and stamps `aria-current="page"` on half a
 * dozen controls at once. Exact matching is the honest test here: a control is
 * never the page it navigates away from, which leaves the board free to say which
 * facet is applied with an `aria-current` of its own.
 */
export const EXACT_MATCH = { exact: true } as const;

export function DeskRow({
  filters,
  seedable,
  track,
}: {
  filters: DeskFilters;
  /** True only for a coordinate the capture holds a real sonic ranking for. */
  seedable: boolean;
  track: ConceptTrack;
}) {
  const { album, artists, label, logId, title } = track;
  // A name that is ALREADY the applied facet is not a control: the link would go
  // where the reader is standing, and forty of them would each announce
  // themselves as the current page. It reads as plain text instead.
  const appliedArtist = filters.artist?.toLowerCase();

  return (
    <li className="desk-row" data-lit={logId === undefined ? "false" : "true"}>
      <span className="desk-row-coord">
        <Coordinate className="desk-row-coordinate" track={track} />
      </span>

      <Cover alt="" className="desk-row-cover" lit={track.certified} src={track.coverUrl} />

      <div className="desk-row-main">
        {/* `Artist — Title`, the one sanctioned em dash in the system. Each act is
            a filter on the same board, so a name is a narrowing rather than a
            departure. */}
        <p className="desk-row-billing">
          {artists.map((name, index) => (
            <Fragment key={`${index}-${name}`}>
              {index > 0 ? ", " : undefined}
              {name.toLowerCase() === appliedArtist ? (
                name
              ) : (
                <Link
                  activeOptions={EXACT_MATCH}
                  className="desk-link concept-focus"
                  search={{ ...filters, artist: name }}
                  to="/concepts/desk"
                >
                  {name}
                </Link>
              )}
            </Fragment>
          ))}
          {artists.length > 0 ? " — " : undefined}
          {title}
        </p>

        {label === undefined && album === undefined ? undefined : (
          <p className="desk-row-meta">
            {label === undefined || label === filters.label ? (
              label
            ) : (
              <Link
                activeOptions={EXACT_MATCH}
                className="desk-link concept-focus"
                search={{ ...filters, label }}
                to="/concepts/desk"
              >
                {label}
              </Link>
            )}
            {label !== undefined && album !== undefined ? (
              <span aria-hidden="true">·</span>
            ) : undefined}
            {album === undefined ? undefined : <span>{album}</span>}
          </p>
        )}

        {/* Duration, tempo, key, year — every chip the capture can back, and only
            those (DESIGN.md, The Readout Rule). */}
        <Readout track={track} />
      </div>

      <div className="desk-row-actions">
        {seedable && logId !== undefined && logId !== filters.soundsLike ? (
          <Link
            activeOptions={EXACT_MATCH}
            className="desk-row-seed concept-focus"
            search={{ ...filters, soundsLike: logId }}
            to="/concepts/desk"
          >
            <WaveformIcon aria-hidden="true" className="size-4" />
            Sounds like this
          </Link>
        ) : undefined}
        {/* A row Fluncle holds no destination for shows no control at all: a
            listening link the capture never carried is a link that would lie. The
            `quiet` tone drops the gold fill and the gold hover, which is what lets
            a whole board of these obey the One Sun and Unlit rules at once. */}
        <ListenRow dense tone="quiet" track={track} />
      </div>
    </li>
  );
}
