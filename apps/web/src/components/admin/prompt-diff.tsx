import { useMemo } from "react";
import { cn } from "@/lib/utils";

type DiffKind = "add" | "context" | "remove";

export type DiffLine = { kind: DiffKind; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const rows = left.length;
  const columns = right.length;

  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: columns + 1 }, () => 0),
  );
  const at = (i: number, j: number): number => lengths[i]?.[j] ?? 0;

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const row = lengths[i];
      if (!row) {
        continue;
      }

      row[j] = left[i] === right[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      lines.push({ kind: "context", text: left[i] ?? "" });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      lines.push({ kind: "remove", text: left[i] ?? "" });
      i += 1;
    } else {
      lines.push({ kind: "add", text: right[j] ?? "" });
      j += 1;
    }
  }

  while (i < rows) {
    lines.push({ kind: "remove", text: left[i] ?? "" });
    i += 1;
  }

  while (j < columns) {
    lines.push({ kind: "add", text: right[j] ?? "" });
    j += 1;
  }

  return lines;
}

export function diffTally(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  };
}

const GUTTER: Record<DiffKind, string> = { add: "+", context: " ", remove: "-" };

export function PromptDiff({
  after,
  afterLabel,
  before,
  beforeLabel,
  emptyMessage = "Nothing moves. This is word for word what is running.",
}: {
  after: string;
  afterLabel: string;
  before: string;
  beforeLabel: string;
  emptyMessage?: string;
}) {
  const lines = useMemo(() => diffLines(before, after), [after, before]);
  const tally = useMemo(() => diffTally(lines), [lines]);
  const changed = tally.added > 0 || tally.removed > 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {beforeLabel} <span aria-hidden="true">→</span> {afterLabel}
        </span>
        {changed ? (
          <span className="tabular-nums">
            <span className="text-primary">+{tally.added}</span>{" "}
            <span className="text-destructive">-{tally.removed}</span>
          </span>
        ) : undefined}
      </div>

      {changed ? (
        <div className="max-h-80 overflow-auto rounded-md border border-border bg-card/60">
          <pre className="m-0 p-0 font-mono text-[0.78rem] leading-5">
            {lines.map((line, index) => (
              <div
                key={`${index}-${line.kind}`}
                className={cn(
                  "flex gap-2 px-2",
                  line.kind === "add" && "bg-primary/10",
                  line.kind === "remove" && "bg-destructive/10",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "w-2 shrink-0 select-none text-center",
                    line.kind === "add" && "text-primary",
                    line.kind === "remove" && "text-destructive",
                    line.kind === "context" && "text-muted-foreground/50",
                  )}
                >
                  {GUTTER[line.kind]}
                </span>
                <span
                  className={cn(
                    "whitespace-pre-wrap break-words",
                    line.kind === "context" && "text-muted-foreground",
                  )}
                >
                  {line.text === "" ? " " : line.text}
                </span>
              </div>
            ))}
          </pre>
        </div>
      ) : (
        <p className="rounded-md border border-border bg-card/60 px-3 py-2.5 text-xs text-muted-foreground">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
