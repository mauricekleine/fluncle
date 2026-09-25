// THE STYLE CHIP ROW — a way in by sound for a listener who knows the sound they want but no artist
// to type.
//
// One scrolling line of quiet pills, one per style in the lexicon (lib/search-styles.ts). Each is a
// real anchor, so a chip is crawlable, shareable, and opens in a new tab like any destination; on
// `/tracks` it toggles `?sound=` beside the other filters, and everywhere else it lands on
// `/tracks?sound=<style>`, the list ranked closest first by that style's sound.
//
// Chrome, not prose (VOICE.md's Chrome Rule): the chip says the style's name and nothing else. The
// pressed chip reads as pressed through ink and edge, never a gold fill — the One Sun on these pages
// stays the focus ring and the lit rows (DESIGN.md).

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SEARCH_STYLES, type SearchStyle, styleTracksPath } from "@/lib/search-styles";
import { cn } from "@/lib/utils";

export function StyleChips({
  active,
  className,
  hrefFor = (style) => styleTracksPath(style.slug),
  label,
  labelId,
}: {
  /** The slug of the style the page is ranked by, if any. */
  active?: string;
  className?: string;
  /** Where a chip goes. Defaults to `/tracks?sound=<slug>`. */
  hrefFor?: (style: SearchStyle, active: boolean) => string;
  /** The visible line that introduces the row; the row is named by it. */
  label: string;
  labelId: string;
}): ReactNode {
  return (
    <div className={cn("style-chips", className)}>
      <p className="style-chips-label" id={labelId}>
        {label}
      </p>
      <ul aria-labelledby={labelId} className="style-chips-row">
        {SEARCH_STYLES.map((style) => {
          const pressed = style.slug === active;

          return (
            <li key={style.slug}>
              <Link
                // The chip's own pressed state is the only "current" it states: the router's
                // active-link marking would call the pressed chip (a link back to the unranked
                // list) the current page, so it is held to an exact match that never occurs.
                activeOptions={{ exact: true, includeSearch: true }}
                // The pressed chip takes the ranking off: its name says so, starting with the
                // visible text (WCAG 2.5.3).
                aria-current={pressed ? "true" : undefined}
                aria-label={pressed ? `${style.label}, clear sound` : undefined}
                className="style-chip"
                data-active={pressed ? "" : undefined}
                // The href is DATA (a composed `/tracks?…` URL), so the cast happens at this one
                // boundary, exactly as the search rows do it.
                to={hrefFor(style, pressed) as never}
              >
                {style.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
