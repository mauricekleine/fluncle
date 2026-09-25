import { type ReactNode } from "react";

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
