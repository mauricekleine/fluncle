import { CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// One cell in the pipeline checklist (`/admin`). Every stage of a finding —
// Enrich, Tag, YouTube, TikTok — renders as one of these, so the board reads as a
// grid of binary-legible cells: is this step done or not, and if not, the cell IS
// the button that does it.
//
// The state is carried by SHAPE, not hue — hollow → dashed → solid — so the board
// stays legible without spending the One Sun gold on every cell (DESIGN: gold ≤10%,
// and it would blow the budget to paint four action buttons gold down every row).
// Gold appears only where it earns it: the faint Gold Veil fill on touched cells,
// the small "done" check, and the Ignition heat an OPEN cell takes on hover. The
// shape axis is also colour-independent, so the three states survive AA + colour
// vision the same way.
//
//   open     — nothing done yet. A hollow outline button (the action verb); heats
//              toward gold on hover. This is the only resting state with no fill.
//   running  — an async step in flight (enrichment on Spinup). Dashed + a spinner;
//              not actionable while it runs.
//   partial  — touched but not closed (a pushed-but-not-live TikTok/YouTube draft).
//              Dashed border over the Gold Veil: lit, circuit still open. Clicking
//              re-opens the step (e.g. to paste the live URL).
//   done     — closed. Solid border over the Gold Veil + a gold check. Still
//              clickable to re-open (re-tag, edit the live URL, re-run enrichment).

export type StageState = "open" | "running" | "partial" | "done";

type StageCellProps = {
  /** Leading identity glyph — the action/platform icon, or a coloured galaxy dot. */
  icon: ReactNode;
  /** The resting label: the verb when open ("Enrich"), the state otherwise ("live"). */
  label: string;
  /** A quiet second line (bpm/key, galaxy name) — shown under the label when present. */
  detail?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  state: StageState;
  /** Hover/long-press hint; defaults to the label. */
  title?: string;
};

const STATE_CLASS: Record<StageState, string> = {
  done: "border-primary/30 bg-primary/10 text-foreground hover:border-primary/50 hover:bg-primary/15",
  open: "border-border bg-transparent text-foreground hover:border-primary/60 hover:bg-primary/5 hover:text-primary",
  partial:
    "border-dashed border-primary/55 bg-primary/10 text-foreground hover:border-primary/75 hover:bg-primary/15",
  running: "cursor-default border-dashed border-primary/40 bg-primary/5 text-muted-foreground",
};

export function StageCell({
  icon,
  label,
  detail,
  disabled,
  onClick,
  state,
  title,
}: StageCellProps) {
  const isRunning = state === "running";

  return (
    <button
      aria-label={title ?? label}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium outline-none transition-[color,background-color,border-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
        STATE_CLASS[state],
      )}
      disabled={disabled || isRunning}
      onClick={onClick}
      title={title ?? label}
      type="button"
    >
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate">{label}</span>
        {detail ? (
          <span className="block truncate text-[10px] font-normal text-muted-foreground tabular-nums">
            {detail}
          </span>
        ) : undefined}
      </span>
      {isRunning ? (
        <CircleNotchIcon aria-hidden="true" className="shrink-0 animate-spin" weight="bold" />
      ) : state === "done" ? (
        <CheckIcon aria-hidden="true" className="shrink-0 text-primary" weight="bold" />
      ) : undefined}
    </button>
  );
}
