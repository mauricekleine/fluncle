import { type ReactNode } from "react";

/**
 * The quiet gate notice (the /chat crew-door grammar): a lede, one line of context, and the
 * single literal control that opens the way (the Chrome Rule — the prose carries the voice, the
 * button names the action). An outline control, never a gold fill (One Sun).
 *
 * One definition for every door that asks a stranger for something before it opens — /chat and
 * /recommendations today. The copy is always the caller's; this only holds the shape, so two
 * doors cannot quietly drift into two different silhouettes.
 */
export function GateNotice({
  action,
  body,
  lede,
}: {
  action: ReactNode;
  body: string;
  lede: string;
}) {
  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <div className="space-y-1.5">
        <p className="text-base text-foreground">{lede}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}
