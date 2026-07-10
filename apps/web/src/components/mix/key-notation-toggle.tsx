import { useId } from "react";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { Button } from "@fluncle/ui/components/button";

// A quiet segmented toggle flipping every key readout on /mix between musical scale
// text ("F minor") and the Camelot code ("4A") DJs mix by. It writes the shared
// per-operator `useKeyNotation` store (localStorage-backed, SSR-safe: the default
// "scales" renders on the server + first paint, the stored choice is adopted post-mount),
// so the chain chips, candidate chips, and the preview bar all switch together.
const NOTATION_OPTIONS: { label: string; value: KeyNotation }[] = [
  { label: "Scales", value: "scales" },
  { label: "Camelot", value: "camelot" },
];

export function KeyNotationToggle() {
  const { notation, setNotation } = useKeyNotation();
  const labelId = useId();

  return (
    <div aria-labelledby={labelId} className="flex items-center gap-1" role="group">
      <span className="sr-only" id={labelId}>
        Key notation
      </span>
      {NOTATION_OPTIONS.map((option) => (
        <Button
          aria-pressed={notation === option.value}
          key={option.value}
          onClick={() => setNotation(option.value)}
          size="sm"
          variant={notation === option.value ? "secondary" : "ghost"}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
