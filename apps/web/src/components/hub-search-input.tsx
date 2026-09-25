import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Input } from "@fluncle/ui/components/input";

const SEARCH_DEBOUNCE_MS = 300;

export function HubSearchInput({
  label,
  onSearch,
  placeholder,
  value,
}: {
  label: string;

  onSearch: (term: string | undefined) => void;
  placeholder: string;

  value: string | undefined;
}) {
  const [term, setTerm] = useState(value ?? "");

  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(() => {
    setTerm(value ?? "");
  }, [value]);

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
