// The shared name-search box for the three catalogue hubs (/artists, /albums, /labels). One quiet,
// debounced text field: the URL is the single source of truth (the /tracks filter contract), so the
// field seeds from the committed `?q=` value, and typing debounce-navigates a fresh `?q=` (each route
// owns the navigation, so the search stays typed to its own route). Reference-register chrome on a
// catalogue page — quiet, bordered, no gold but the focus ring (DESIGN.md's Unlit register + One Sun
// Rule), a Phosphor glass icon only (Iconography).

import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Input } from "@fluncle/ui/components/input";

/** How long the field waits after the last keystroke before it navigates — one debounce, not one nav
 *  per character. Long enough that a fast typist commits once, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

export function HubSearchInput({
  label,
  onSearch,
  placeholder,
  value,
}: {
  /** The field's accessible name — "Search artists by name" (literal chrome). */
  label: string;
  /** Commit a trimmed term (or undefined when cleared) to the URL. The route owns the typed navigate. */
  onSearch: (term: string | undefined) => void;
  placeholder: string;
  /** The committed search term from the URL (`?q=`), or undefined on the bare hub. */
  value: string | undefined;
}) {
  const [term, setTerm] = useState(value ?? "");

  // The route drives navigation, so `onSearch`'s identity can change between renders; hold it in a
  // ref so the debounce effect below never re-fires just because the parent re-rendered.
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  // External URL changes re-seed the field: a "Clear" link, the back button, or a fresh page all set
  // `value`, and the field follows. During typing `value` only changes AFTER the debounce commits, at
  // which point the field already holds the same text, so this is a no-op then.
  useEffect(() => {
    setTerm(value ?? "");
  }, [value]);

  // Debounced commit: navigate only once the term has settled AND differs from the committed value, so
  // a glance that types and deletes back to the same URL navigates nowhere.
  useEffect(() => {
    const next = term.trim() || undefined;

    if (next === value) {
      return;
    }

    const timeout = setTimeout(() => onSearchRef.current(next), SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timeout);
  }, [term, value]);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => setTerm(event.target.value);

  return (
    <div className="hub-search">
      <MagnifyingGlassIcon aria-hidden="true" className="hub-search-icon" size={16} />
      <Input
        aria-label={label}
        autoComplete="off"
        className="hub-search-input"
        onChange={onChange}
        placeholder={placeholder}
        type="search"
        value={term}
      />
      {term.length > 0 ? (
        <button
          aria-label="Clear search"
          className="hub-search-clear"
          onClick={() => setTerm("")}
          type="button"
        >
          <XIcon aria-hidden="true" size={14} />
        </button>
      ) : undefined}
    </div>
  );
}
