import { SegmentedControl } from "@/components/segmented-control";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";

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
