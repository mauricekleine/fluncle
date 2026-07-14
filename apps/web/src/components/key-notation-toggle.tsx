import { SegmentedControl } from "@/components/segmented-control";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";

// The app-wide key-notation choice, flipping every key readout between musical scale
// text ("F minor") and the Camelot code ("4A") DJs mix by. A thin skin over the shared
// SegmentedControl (which owns the selected-state treatment); the value rides the shared
// `useKeyNotation` store — device-local for everyone, mirrored to the profile when
// signed in — so the chain chips, candidate rows, the /log key field, and the search
// filter echo all switch together.
const NOTATION_OPTIONS: readonly { label: string; value: KeyNotation }[] = [
  { label: "Scales", value: "scales" },
  { label: "Camelot", value: "camelot" },
];

export function KeyNotationToggle() {
  const { notation, setNotation } = useKeyNotation();

  return (
    <SegmentedControl
      label="Key notation"
      onChange={setNotation}
      options={NOTATION_OPTIONS}
      value={notation}
    />
  );
}
