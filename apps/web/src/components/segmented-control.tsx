import { ToggleGroup, ToggleGroupItem } from "@fluncle/ui/components/toggle-group";
import { cn } from "@/lib/utils";

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
