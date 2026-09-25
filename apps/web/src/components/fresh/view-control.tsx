import { SegmentedControl } from "@/components/segmented-control";
import { type FreshView } from "@/lib/fresh-releases";

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
