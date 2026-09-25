import { type ReactNode } from "react";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { filterChips, type SearchFilters } from "@/lib/search-results";

export function SearchFilterChips({ filters }: { filters: SearchFilters }): ReactNode {
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
