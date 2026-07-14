import { ToggleGroup, ToggleGroupItem } from "@fluncle/ui/components/toggle-group";
import { cn } from "@/lib/utils";

// The app's ONE segmented single-choice control — a radio in segmented clothing, built on
// the Shadcn toggle-group. Two invariants fix the failures its hand-rolled predecessor
// shipped (operator-flagged 2026-07-14: "which one is active?"):
//
//   1. THE ACTIVE SEGMENT IS UNMISTAKABLE, and it speaks the same accent grammar as the
//      Tabs control (`data-active:bg-accent text-accent-foreground`): the gold fill means
//      "current selection" here exactly as it does on the sign-in tabs — one page, one
//      meaning for the accent (DESIGN.md's ignition signal). Inactive segments hover to
//      FOREGROUND, never to gold: gold-on-hover-of-inactive inverted the grammar.
//   2. EXACTLY ONE SEGMENT IS ALWAYS ON. A click on the active segment (which the toggle
//      primitive would treat as a deselect) is ignored, so the control can never present
//      an empty choice.

export type SegmentedOption<Value extends string> = {
  label: string;
  value: Value;
};

export function SegmentedControl<Value extends string>({
  className,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  /** Accessible name for the group (visible labels ride the segments themselves). */
  label: string;
  onChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  value: Value;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      className={cn("rounded-lg border border-border bg-secondary/40 p-0.5", className)}
      multiple={false}
      onValueChange={(next) => {
        const picked = next[0];

        if (typeof picked === "string" && picked !== value) {
          onChange(picked as Value);
        }
      }}
      spacing={1}
      value={[value]}
    >
      {options.map((option) => (
        <ToggleGroupItem
          className="h-7 px-3 text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          key={option.value}
          value={option.value}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
