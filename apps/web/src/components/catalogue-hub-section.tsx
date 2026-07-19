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
// ONE navigation model, for humans and crawlers alike: every page — page 1 included — SSRs its own
// slice of tiles behind a real-anchor pager, and (on `/labels` + `/artists`) an A–Z fast lane links
// every region of the alphabet. Nothing loads on scroll, so the footer stays reachable at every
// catalogue size, and every tile past the first page is a real `?page=N` <a> a crawler follows.

import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

// ── THE PAGED SECTION + THE A–Z FAST LANE ────────────────────────────────────────────────────────
//
// Every page renders this: a static SSR slice of one page's tiles behind a real-anchor pager. The
// letter lane is a row of real `?page=N` anchors so any region of the alphabet is two hops away.
// Both are quiet chrome — the light stays with the findings (One Sun).

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
 * Whether a horizontal scroller can move further in each direction, from its scroll metrics. Pure, so
 * it is unit-pinned. A 1px slack absorbs the sub-pixel rounding a browser leaves at the far edge, so a
 * fully-scrolled lane reliably reads as "cannot go further".
 */
export function laneScrollAffordances(metrics: {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}): { canScrollLeft: boolean; canScrollRight: boolean } {
  return {
    canScrollLeft: metrics.scrollLeft > 1,
    canScrollRight: metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - 1,
  };
}

/**
 * The YEAR fast lane — the A–Z lane mechanic mapped onto TIME. The release years present in a
 * time-sorted hub (`/tracks`), newest first, each a real `<a href="?page=N">` to the page that year's
 * first release lands on. Unlike the letter lane there is no fixed alphabet and no "absent" slot: a
 * year is here because the result set holds it.
 *
 * Where the entity hubs' letter lane WRAPS to as many rows as it needs, this is a SINGLE
 * non-wrapping row inside a horizontally-scrollable strip, with a caret on each side that pages it by
 * roughly a viewport; a caret dims and goes inert at the end it would scroll past. The chips stay the
 * shared `.catalogue-letter` chrome (Stardust ink, cream on hover, the Eclipse ring on focus; no gold
 * at rest — One Sun); only the container differs, so the letter lanes are untouched. Every chip is a
 * real anchor in the SSR HTML, so a crawler with no JS still walks the whole strip; the carets are a
 * progressive enhancement over the native overflow scroll. Renders nothing when the set spans no
 * dated release (an all-undated or empty list).
 */
export function HubYearLane({
  buildHref,
  label,
  years,
}: {
  /** Build a hub URL for a page number (page 1 ⇒ the bare hub path). */
  buildHref: (page: number) => string;
  /** The nav's accessible name — "Tracks by year" (literal chrome). */
  label: string;
  years: { page: number; year: string }[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [affordances, setAffordances] = useState({ canScrollLeft: false, canScrollRight: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;

    if (el) {
      setAffordances(laneScrollAffordances(el));
    }
  }, []);

  // Track the scroll position + width so each caret reflects whether there is anywhere left to go.
  // Client-only (the effect never runs on the server); a ResizeObserver re-measures when the strip or
  // its content changes width.
  useEffect(() => {
    const el = scrollerRef.current;

    if (!el) {
      return;
    }

    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  if (years.length === 0) {
    return undefined;
  }

  // Page by roughly a viewport. `scrollBy` with no explicit behavior inherits the container's CSS
  // `scroll-behavior`, which is gated on `prefers-reduced-motion: no-preference` — so the motion is
  // smooth for most and instant for anyone who asked for less.
  const pageBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;

    if (el) {
      el.scrollBy({ left: direction * el.clientWidth * 0.8 });
    }
  };

  return (
    <div className="hub-year-lane">
      <button
        aria-label="Scroll years left"
        className="hub-year-lane-caret"
        disabled={!affordances.canScrollLeft}
        onClick={() => pageBy(-1)}
        type="button"
      >
        <CaretLeftIcon aria-hidden="true" size={16} weight="bold" />
      </button>

      <nav aria-label={label} className="hub-year-lane-scroller" ref={scrollerRef}>
        {years.map((entry) => (
          <a className="catalogue-letter" href={buildHref(entry.page)} key={entry.year}>
            {entry.year}
          </a>
        ))}
      </nav>

      <button
        aria-label="Scroll years right"
        className="hub-year-lane-caret"
        disabled={!affordances.canScrollRight}
        onClick={() => pageBy(1)}
        type="button"
      >
        <CaretRightIcon aria-hidden="true" size={16} weight="bold" />
      </button>
    </div>
  );
}

/**
 * The static, SSR-rendered `?page=N` slice of a hub's findings-free section. Same grid, same tiles,
 * same unlit register as the editorial section above; every tile is in the HTML and the pager below
 * is real anchors, so a crawler that runs no JS walks the whole long tail. `lane` (the A–Z row) rides
 * in the head, `pager` below the grid, exactly like an artist/label entity page.
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
