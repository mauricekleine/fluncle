import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SearchExampleGlyph } from "@/components/search/search-glyph";
import { StyleChips } from "@/components/search/style-chips";
import {
  prefetchSearchDialog,
  useIsApple,
  useSearchController,
} from "@/components/search/search-command";
import { SEARCH_EXAMPLES, searchPagePath } from "@/lib/search-results";
import { STYLE_CHIPS_LINE } from "@/lib/search-styles";

export function FrontDoorSearch(): ReactNode {
  const { open } = useSearchController();
  const isApple = useIsApple();

  return (
    <div className="fd-search">
      <button
        aria-keyshortcuts={isApple ? "Meta+K" : "Control+K"}
        className="fd-search-field"
        onClick={() => open()}
        onFocus={prefetchSearchDialog}
        onPointerEnter={prefetchSearchDialog}
        type="button"
      >
        <MagnifyingGlassIcon aria-hidden="true" className="fd-search-field-icon" />
        <span className="fd-search-field-label">Search the archive</span>

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
            <Link
              className="fd-search-example"
              preload={false}
              to={searchPagePath(example.query) as never}
            >
              <SearchExampleGlyph className="fd-search-example-icon" icon={example.icon} />
              {example.query}
            </Link>
          </li>
        ))}
      </ul>

      <StyleChips
        className="search-style-chips"
        label={STYLE_CHIPS_LINE}
        labelId="fd-search-styles"
      />
    </div>
  );
}
