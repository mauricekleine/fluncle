// THE SEEDING ENTRY — the front door's way into search.
//
// It is the SAME search: one resolver, one dialog, one ranking. `SearchProvider` (mounted in
// `PublicChrome`) owns the dialog and the ⌘K listener; the colophon's quiet glyph and this large
// field are two doors onto that one room. Nothing is duplicated, and there is no second answer
// surface to keep in step.
//
// The front door needs the larger door because a stranger who arrives typing nothing has to be able
// to SEE that search exists before they can use it. The colophon glyph is correct on a deep page and
// invisible on arrival.
//
// ── WHY THE EXAMPLES ARE REAL ────────────────────────────────────────────────────────────────
// The four are `SEARCH_EXAMPLES`, the dialog's own set, imported rather than re-typed so the front
// door can never teach a query the dialog would not answer. Between them they walk every tier of the
// resolver (a name, a label, a natural-language filter, a sonic reference) without ever explaining
// that there are tiers. An example that finds nothing teaches the opposite of what it is for, so
// they stay one list with one owner (docs/search.md).
//
// ── WHY A BUTTON AND NOT A FIELD ─────────────────────────────────────────────────────────────
// A second text input would be a second search: its own state, its own debounce, its own results to
// render. The control is therefore a button dressed as a field, carrying no `aria-label` at all, so
// its accessible name IS its visible text and a voice-control reader can say what they see (WCAG
// 2.5.3). The `⌘K` hint is decorative and hidden, exactly as the colophon trigger does it.
//
// The label is "Search the archive" — the SAME words the colophon door carries, because one action
// takes one label and a new phrase for an existing action is a bug, not a variation (VOICE.md's
// Chrome Rule). What a reader may type belongs in the hint line below, not in the control's name.
// The band's own heading is therefore `sr-only`: it is still a real `<h2>`, so the long scroll's
// outline survives and a screen reader can jump to the band, but it does not print the same three
// words twice above a control that already says them.

import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import {
  SEARCH_EXAMPLES,
  SearchExampleGlyph,
  useIsApple,
  useSearchController,
} from "@/components/search/search-command";

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
            <button className="fd-search-example" onClick={() => open(example.query)} type="button">
              <SearchExampleGlyph className="fd-search-example-icon" icon={example.icon} />
              {example.query}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
