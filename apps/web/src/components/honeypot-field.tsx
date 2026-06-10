import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Spam honeypot: visually hidden, skipped by tab order, filled only by bots.
export function HoneypotField({
  id,
  onChange,
  value,
}: {
  id: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <Label aria-hidden="true" className="sr-only" htmlFor={id}>
      Website
      <Input
        autoComplete="off"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        tabIndex={-1}
        value={value}
      />
    </Label>
  );
}
