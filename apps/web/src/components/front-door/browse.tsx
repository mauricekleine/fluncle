// THE FOUR WAYS IN — direct, familiar routes into the wider archive.
//
// Tracks, artists, albums, labels: the music's own taxonomy, the four hubs Fluncle's whole index is
// reachable through. Each card carries the REAL size of its shelf, read in SQL by the loader, so the
// door is offered with a number rather than a promise.
//
// ── WHAT THESE COUNTS ARE, AND WHAT THEY ARE NOT ─────────────────────────────────────────────
// Every count here is a SUPERSET — "tracks", "artists", "albums", "labels" — true of every row under
// it, which is exactly what DESIGN.md's Unlit Rule permits a heading to name. None of them counts
// certifications, none of them separates the two registers, and none of them attaches a noun or a
// badge that would imply Fluncle stands behind every indexed row. The findings are a DIFFERENT band,
// further up the page, and the distinction is carried by placement and light alone.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type FrontDoorCounts } from "@/lib/front-door";

type BrowseCard = {
  /** One line, self-contained: it must name its own nouns, since a card is read on its own. */
  blurb: string;
  count: (counts: FrontDoorCounts) => number;
  label: string;
  /** "12 albums" — the shelf's real size, in the superset noun. */
  noun: (count: number) => string;
  to: string;
};

const countFormatter = new Intl.NumberFormat("en-US");

const plural = (count: number, one: string, many: string): string =>
  `${countFormatter.format(count)} ${count === 1 ? one : many}`;

const CARDS: BrowseCard[] = [
  {
    blurb: "Every track I hold, newest release first.",
    count: (counts) => counts.tracks,
    label: "Tracks",
    noun: (count) => plural(count, "track", "tracks"),
    to: "/tracks",
  },
  {
    blurb: "Everyone I've found a banger from.",
    count: (counts) => counts.artists,
    label: "Artists",
    noun: (count) => plural(count, "artist", "artists"),
    to: "/artists",
  },
  {
    blurb: "Every record I've pulled a track off.",
    count: (counts) => counts.albums,
    label: "Albums",
    noun: (count) => plural(count, "album", "albums"),
    to: "/albums",
  },
  {
    blurb: "The labels behind the bangers.",
    count: (counts) => counts.labels,
    label: "Labels",
    noun: (count) => plural(count, "label", "labels"),
    to: "/labels",
  },
];

export function FrontDoorBrowse({ counts }: { counts: FrontDoorCounts }): ReactNode {
  return (
    <ul className="fd-browse">
      {CARDS.map((card) => {
        const count = card.count(counts);

        return (
          <li key={card.label}>
            {/* The nav model's precedent: `to` is plain data, cast at the single `<Link>` boundary
                so TanStack builds the real href at runtime. */}
            <Link className="fd-browse-card" to={card.to as never}>
              <span className="fd-browse-label">{card.label}</span>
              {/* An empty shelf prints no number rather than a bare "0": a count is an invitation,
                  and "0 labels" invites nothing. The card still opens its hub, which speaks its own
                  empty state honestly. */}
              {count > 0 ? <span className="fd-browse-count">{card.noun(count)}</span> : undefined}
              <span className="fd-browse-blurb">{card.blurb}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
