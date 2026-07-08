import { type ReactNode } from "react";

// A headline stat tile — the shared vocabulary across the two Costs-group stations
// (`/admin/usage` spend, `/admin/costs` ledger): a small labelled icon, the number in
// Oxanium (the brand's numeric face), and a quiet hint under it. `accent` lights the
// icon + value in Eclipse Gold for the one number that matters on the surface.
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
