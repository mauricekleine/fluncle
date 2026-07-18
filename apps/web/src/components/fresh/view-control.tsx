// `/fresh` — the view pills. Three ways to read the frontier: everything at once (the default
// layout), the flat track stream on its own, or the album records brought to the centre. The choice
// rides the `?view=` search param, so a view is its own shareable link; the control is pure chrome, so
// it is named in the plainest literal words there are (VOICE.md's Chrome Rule).

import { SegmentedControl } from "@/components/segmented-control";
import { type FreshView } from "./data";

const VIEW_OPTIONS: readonly { label: string; value: FreshView }[] = [
  { label: "All", value: "all" },
  { label: "Tracks", value: "tracks" },
  { label: "Albums & EPs", value: "albums" },
];

export function FreshViewControl({
  onChange,
  view,
}: {
  onChange: (view: FreshView) => void;
  view: FreshView;
}) {
  return (
    <div className="fresh-views">
      <SegmentedControl label="View" onChange={onChange} options={VIEW_OPTIONS} value={view} />
    </div>
  );
}
