// THE SEEDING ENTRY — the front door's way into search.
//
// It is the SAME search: one resolver, one ranking, one vocabulary. `SearchProvider` (mounted in
// `PublicChrome`) owns the ⌘K dialog and the ⌘K listener; this large field is the front door's way
// into that dialog, because a stranger who arrives typing nothing has to be able to SEE that search
// exists before they can use it, and the colophon glyph is correct on a deep page and invisible on
// arrival.
//
// ── THE EXAMPLES ARE LINKS, NOT SEEDS ────────────────────────────────────────────────────────
// The four pills used to open the dialog pre-filled. They are now real anchors to `/search?q=…`,
// the persistent surface, and that is a deliberate upgrade rather than a change of mind: an example
// query is the best thing on this page for a crawler to follow, a reader to open in a new tab, and
// anyone to send to a mate. A dialog can do none of those. The field beside them still opens the
// palette, so the fast way in is untouched.
//
// The four are `SEARCH_EXAMPLES` (lib/search-results.ts), imported rather than re-typed so the front
// door can never teach a query the other two surfaces would not answer. Between them they walk the
// resolver (a coordinate, a name, a label, a sonic reference) without ever explaining that there are
// tiers, and every one of them is answered DETERMINISTICALLY — an example that finds nothing teaches
// the opposite of what it is for, and the language tier's parse of a sentence varies run to run. One
// list, one owner, enforced offline and in production (docs/search.md).
//
// ── WHY A BUTTON AND NOT A FIELD ─────────────────────────────────────────────────────────────
// A second text input would be a second search: its own state, its own debounce, its own results to
// render. The control is therefore a button dressed as a field, carrying no `aria-label` at all, so
// its accessible name IS its visible text and a voice-control reader can say what they see (WCAG
// 2.5.3). The `⌘K` hint is decorative and hidden, exactly as the colophon trigger does it.
//
// The label is "Search the archive" — the SAME words the colophon door and `/search`'s own field
// carry, because one action takes one label and a new phrase for an existing action is a bug, not a
// variation (VOICE.md's Chrome Rule). What a reader may type belongs in the hint line below, not in
// the control's name. The band's own heading is therefore `sr-only`: it is still a real `<h2>`, so
// the long scroll's outline survives and a screen reader can jump to the band, but it does not print
// the same three words twice above a control that already says them.

import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SearchExampleGlyph } from "@/components/search/search-glyph";
import { useIsApple, useSearchController } from "@/components/search/search-command";
import { SEARCH_EXAMPLES, searchPagePath } from "@/lib/search-results";

export function FrontDoorSearch(): ReactNode {
  const { open } = useSearchController();
  const isApple = useIsApple();

  return (
    <div className="fd-search">
      <button
        aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}
        className="fd-search-field"
        onClick={() => open()}
        type="button"
      >
        <MagnifyingGlassIcon aria-hidden="true" className="fd-search-field-icon" />
        <span className="fd-search-field-label">Search the archive</span>
        {/* Decorative: exposing it would make the visible text "Search the archive ⌘K" while the
            accessible name stayed "Search the archive" — the 2.5.3 mismatch. `aria-keyshortcuts`
            above already announces the shortcut in the form assistive tech expects. */}
        <kbd aria-hidden="true" className="fd-search-field-kbd">
          {isApple ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      <p className="fd-search-hint" id="fd-search-examples-hint">
        Give me a name, a coordinate, or the sound of a track. Try one of these.
      </p>
      <ul aria-labelledby="fd-search-examples-hint" className="fd-search-examples">
        {SEARCH_EXAMPLES.map((example) => (
          <li key={example.query}>
            {/* The href is DATA, not a compile-time route literal, so the cast happens at this one
                boundary exactly as the palette's navigate does. */}
            <Link className="fd-search-example" to={searchPagePath(example.query) as never}>
              <SearchExampleGlyph className="fd-search-example-icon" icon={example.icon} />
              {example.query}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
