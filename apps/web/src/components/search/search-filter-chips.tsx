// What the language tier understood, echoed back.
//
// Not decoration: it is the only way a reader can see that "in A minor" became a key filter and
// correct it when it did not. A search that quietly reinterprets you is a search you cannot trust.
// Shared by the ⌘K dialog and `/search` so the echo reads the same in both rooms.

import { type ReactNode } from "react";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { filterChips, type SearchFilters } from "@/lib/search-results";

export function SearchFilterChips({ filters }: { filters: SearchFilters }): ReactNode {
  // The key filter echoes in the app-wide notation (Scales/Camelot), like every other key readout.
  // `formatKey` renders an unparseable key verbatim, so a filter the model phrased oddly still
  // shows what it understood.
  const { notation } = useKeyNotation();
  const chips = filterChips(filters, (key) => formatKey(key, notation));

  if (chips.length === 0) {
    return undefined;
  }

  return (
    <div className="search-chips">
      {chips.map((chip) => (
        <span className="search-chip" key={chip}>
          {chip}
        </span>
      ))}
    </div>
  );
}
