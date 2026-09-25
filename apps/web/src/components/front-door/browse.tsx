import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type FrontDoorCounts, frontDoorCount } from "@/lib/front-door";
import { navSections } from "@/lib/nav-model";

type BrowseCard = {
  blurb: string;
  count: (counts: FrontDoorCounts) => number;
  label: string;

  noun: (count: number) => string;
  to: string;
};

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
            <Link className="fd-browse-card" to={card.to as never}>
              <span className="fd-browse-label">{card.label}</span>

              {count > 0 ? <span className="fd-browse-count">{card.noun(count)}</span> : undefined}
              <span className="fd-browse-blurb">{card.blurb}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
