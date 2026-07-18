// The "more <entities>" section: the SECOND section of each hub (`/labels`, `/albums`, `/artists`).
//
// The hub leads with Fluncle's editorial list — the entities he has certified a finding off. This
// section is everything BELOW that: the INDEXABLE findings-free entities the crawler minted a page
// for on crawled content alone. It is honestly quieter — the unlit register (DESIGN.md) — and its
// copy never NAMES the tier (the word "catalogue" never appears in public copy) or claims Fluncle
// found/logged/certified these (docs/album-entity.md, the unnamed tier). The heading names the
// SUPERSET ("More labels"), which the Unlit Rule permits. The tiles are the SAME grid as the
// section above; only the light drops.
//
// Data flows exactly like the homepage feed (routes/index.tsx): a `useInfiniteQuery` seeded from
// the loader's first page (`initialData`), a slug keyset for `getNextPageParam`, and an
// IntersectionObserver that pages the rest in. Public → `refetchOnWindowFocus: false`. The query
// re-hits the SAME `createServerFn` the loader used; no oRPC op, no second unseeded fetch.

import { CircleNotchIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef } from "react";
import { type CatalogueHubPage } from "@/lib/server/labels";

export function CatalogueHubSection<Entry extends { slug: string }>({
  gridClassName,
  headingId,
  heading,
  initialPage,
  lane,
  listLabel,
  queryFn,
  queryKey,
  renderTile,
}: {
  /** The grid class shared with the section above: "artist-grid" (covers) or "artist-avatar-grid". */
  gridClassName: string;
  /** The section's quiet heading — names the superset, e.g. "More labels" (never the tier). */
  heading: string;
  /** DOM id linking the heading to its <section> (aria-labelledby). */
  headingId: string;
  /** The loader's first page — the SSR seed; the section renders nothing when it is empty. */
  initialPage: CatalogueHubPage<Entry>;
  /**
   * The crawl nav rendered ABOVE the grid: the A–Z fast lane (artists/labels) or the numbered pager
   * (albums). This is the human page's ONLY crawlable path into the deeper `?page=N` tiles the
   * infinite scroll loads with JS — a crawler follows it, a reader keeps scrolling.
   */
  lane?: ReactNode;
  /** The grid's accessible name — names the TRACKS/entities, never the tier. */
  listLabel: string;
  /** Fetch the next page for a cursor (undefined = first page); the route's createServerFn. */
  queryFn: (cursor: string | undefined) => Promise<CatalogueHubPage<Entry>>;
  /** A stable react-query key, unique per hub (e.g. "labels-catalogue"). */
  queryKey: string;
  /** Render one tile — a hub-specific <li> (cover vs avatar, logo fallback, the target route). */
  renderTile: (entry: Entry) => ReactNode;
}) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialData: { pageParams: [undefined], pages: [initialPage] },
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => queryFn(pageParam),
    queryKey: [queryKey],
    refetchOnWindowFocus: false,
  });

  const sentinelRef = useRef<HTMLLIElement | null>(null);

  // Auto-fetch when the trailing sentinel drifts near the viewport bottom. The page scrolls the
  // document (no ScrollArea here), so the observer roots on the viewport. It re-arms after each
  // page settles; the sentinel is only in the tree while there is a next page to pull.
  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "480px" },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const entries = data.pages.flatMap((page) => page.items);

  // An empty first page renders NOTHING — no heading, no empty state (the unnamed-tier rule: a
  // heading over an absent band is how a real page turns into a doorway page).
  if (entries.length === 0) {
    return undefined;
  }

  return (
    <section aria-labelledby={headingId} className="catalogue-section catalogue-hub">
      <div className="catalogue-hub-head">
        <h2 className="catalogue-hub-heading" id={headingId}>
          {heading}
        </h2>
        {lane}
      </div>

      <ul aria-label={listLabel} className={`${gridClassName} catalogue-grid`}>
        {entries.map((entry) => renderTile(entry))}
        {hasNextPage ? (
          <li aria-hidden="true" className="catalogue-hub-sentinel" ref={sentinelRef}>
            {isFetchingNextPage ? (
              <CircleNotchIcon className="animate-spin" weight="bold" />
            ) : undefined}
          </li>
        ) : undefined}
      </ul>
    </section>
  );
}

// ── THE CRAWLABLE VARIANTS: the static `?page=N` section + the A–Z fast lane ─────────────────────
//
// These render for a crawler or a deep link, never on the param-free page (which keeps the infinite
// scroll above). The paged section is the SAME grid + register, but a static SSR slice of one page
// with a real-anchor pager; the letter lane is a row of real `?page=N` anchors so any region of the
// alphabet is two hops away. Both are quiet chrome — the light stays with the findings (One Sun).

const HUB_LETTERS = ["#", ..."abcdefghijklmnopqrstuvwxyz".split("")] as const;

/**
 * The A–Z fast lane over a name-sorted hub (`/artists`, `/labels`). Every present letter is a real
 * `<a href="?page=N">` to the page its first entity lands on; an absent letter sits dimmer and is
 * `aria-hidden` (nothing to reach). "#" collects the digit-led slugs. Renders nothing when the hub
 * has no findings-free entities at all.
 */
export function HubLetterLane({
  buildHref,
  label,
  letters,
}: {
  /** Build a hub URL for a page number (page 1 ⇒ the bare hub path). */
  buildHref: (page: number) => string;
  /** The nav's accessible name — "Artists A to Z" / "Labels A to Z" (literal chrome). */
  label: string;
  letters: { letter: string; page: number }[];
}) {
  if (letters.length === 0) {
    return undefined;
  }

  const pageByLetter = new Map(letters.map((entry) => [entry.letter, entry.page]));

  return (
    <nav aria-label={label} className="catalogue-letters">
      {HUB_LETTERS.map((letter) => {
        const display = letter === "#" ? "#" : letter.toUpperCase();
        const page = pageByLetter.get(letter);

        return page === undefined ? (
          <span aria-hidden="true" className="catalogue-letter catalogue-letter-empty" key={letter}>
            {display}
          </span>
        ) : (
          <a className="catalogue-letter" href={buildHref(page)} key={letter}>
            {display}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * The static, SSR-rendered `?page=N` slice of a hub's findings-free section — the crawler's view.
 * Same grid, same tiles, same unlit register as the infinite-scroll section; the difference is that
 * every tile is in the HTML and the pager below is real anchors. `lane` (the A–Z row) rides in the
 * head, `pager` below the grid, exactly like an artist/label entity page.
 */
export function CatalogueHubPageSection<Entry extends { slug: string }>({
  gridClassName,
  headingId,
  heading,
  items,
  lane,
  listLabel,
  pager,
  renderTile,
}: {
  gridClassName: string;
  heading: string;
  headingId: string;
  /** The page's tiles — the OFFSET slice the loader resolved for this `?page=N`. */
  items: Entry[];
  lane?: ReactNode;
  listLabel: string;
  /** The real-anchor pager below the grid (CataloguePager). */
  pager?: ReactNode;
  renderTile: (entry: Entry) => ReactNode;
}) {
  if (items.length === 0) {
    return undefined;
  }

  return (
    <section aria-labelledby={headingId} className="catalogue-section catalogue-hub">
      <div className="catalogue-hub-head">
        <h2 className="catalogue-hub-heading" id={headingId}>
          {heading}
        </h2>
        {lane}
      </div>

      <ul aria-label={listLabel} className={`${gridClassName} catalogue-grid`}>
        {items.map((entry) => renderTile(entry))}
      </ul>

      {pager}
    </section>
  );
}
