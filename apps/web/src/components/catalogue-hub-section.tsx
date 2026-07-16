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
