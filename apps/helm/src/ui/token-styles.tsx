// The run log's shared vocabulary: the pre-flight token styles ([clear]/[hold]/
// [dark], the show.ts grammar) and the LogLine that renders one output line as a
// parsed status row or raw monospace text. One copy for every surface that
// streams a run — the drawer and the feature panels — so the token palette never
// drifts. Voice: recovered terminal — deadpan, no traffic lights.

import { cn } from "@fluncle/ui/lib/utils";

import { type RunLine } from "../contract";
import { parseStatusLine } from "./status-line";

export const TOKEN_STYLES = {
  clear: "font-bold text-foreground",
  dark: "text-muted-foreground",
  hold: "font-bold text-destructive",
} as const;

export function LogLine({ line }: { line: RunLine }) {
  const row = line.stream === "system" ? undefined : parseStatusLine(line.text);

  if (row) {
    return (
      <div className="flex gap-3 whitespace-pre-wrap">
        <span className={TOKEN_STYLES[row.token]}>[{row.token}]</span>
        <span className="text-foreground">{row.label}</span>
        {row.note ? <span className="text-muted-foreground">{row.note}</span> : null}
      </div>
    );
  }

  if (line.stream === "system") {
    return <div className="whitespace-pre-wrap text-muted-foreground">— {line.text}</div>;
  }

  return (
    <div
      className={cn(
        "whitespace-pre-wrap",
        line.stream === "stderr" ? "text-foreground/70" : "text-foreground/90",
      )}
    >
      {line.text}
    </div>
  );
}
