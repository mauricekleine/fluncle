import { type ReactNode } from "react";

const OXANIUM_STACK = '"Oxanium", ui-sans-serif, system-ui, sans-serif';

export function StatTile({
  accent,
  hint,
  icon,
  label,
  value,
}: {
  accent?: boolean;
  hint: ReactNode;
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={accent ? "text-primary" : undefined}>{icon}</span>
        <span>{label}</span>
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? "text-primary" : ""}`}
        style={{ fontFamily: OXANIUM_STACK }}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
