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
//
// The BLURB is held to the same rule and it is the easier one to get wrong. Each hub lists every
// entity Fluncle holds, certified and catalogue alike (`countIndexableHubEntities` gates on
// `renderable_track_count` and knows nothing about certification), so a line like "everyone I've
// found a banger from" printed beside that number would claim he stands behind rows he has ruled on
// nothing about. The blurbs are therefore read from the nav model, which owns them for the same four
// hubs — one sentence per shelf, in one place, held to the superset rule there.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type FrontDoorCounts, frontDoorCount } from "@/lib/front-door";
import { navSections } from "@/lib/nav-model";

type BrowseCard = {
  /** One line, self-contained: it must name its own nouns, since a card is read on its own. */
  blurb: string;
  count: (counts: FrontDoorCounts) => number;
  label: string;
  /** "1,234 albums" — the shelf's real size, in the superset noun, grouped for this page. */
  noun: (count: number) => string;
  to: string;
};

/**
 * The blurb the nav model already publishes for a hub, read rather than re-typed. The colophon and
 * this card print the same sentence about the same shelf, so one of them owning it is the only way
 * they cannot drift — and the blurb is load-bearing here (see the Unlit note above), so a silent
 * divergence would be a claim, not a wording nit.
 */
function navBlurb(id: string): string {
  const item = navSections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === id);

  return item?.blurb ?? "";
}

const CARDS: BrowseCard[] = [
  {
    blurb: navBlurb("tracks"),
    count: (counts) => counts.tracks,
    label: "Tracks",
    noun: (count) => frontDoorCount(count, "track", "tracks"),
    to: "/tracks",
  },
  {
    blurb: navBlurb("artists"),
    count: (counts) => counts.artists,
    label: "Artists",
    noun: (count) => frontDoorCount(count, "artist", "artists"),
    to: "/artists",
  },
  {
    blurb: navBlurb("albums"),
    count: (counts) => counts.albums,
    label: "Albums",
    noun: (count) => frontDoorCount(count, "album", "albums"),
    to: "/albums",
  },
  {
    blurb: navBlurb("labels"),
    count: (counts) => counts.labels,
    label: "Labels",
    noun: (count) => frontDoorCount(count, "label", "labels"),
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
