import { CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { type BoardStep } from "@/components/admin/pipeline/board-model";
import { cn } from "@/lib/utils";

// The shared step glyph — one node, used by Constellation, Lanes, Orbit and Matrix
// so a step reads identically wherever it appears. Two encodings, both legible
// without leaning on the One Sun gold:
//
//   kind  → SHAPE.  auto (an agent) is round; human (your hands) is a rounded square.
//   state → FILL.   open = hollow, running = dashed + spinner, partial = dashed +
//           gold veil, done = solid gold veil + check, stale = dashed warning tint (a
//           bounced TikTok draft — your move again), planned = ghosted dotted.
//
// The shape axis survives colour-blindness and AA on its own, so the board never
// needs a dozen gold cells per row to be scannable.

const SIZE = {
  md: { box: "size-8", glyph: "size-4" },
  sm: { box: "size-6", glyph: "size-3" },
} as const;

// State → border/fill. Human steps that are your move (open, ungated) get a touch
// more presence than a passive open auto step, since that IS the operator's work.
export const STATE_CLASS: Record<BoardStep["state"], string> = {
  done: "border-primary/40 bg-primary/15 text-foreground",
  open: "border-border bg-transparent text-muted-foreground",
  partial: "border-dashed border-primary/60 bg-primary/10 text-foreground",
  planned: "border-dotted border-border/50 bg-transparent text-muted-foreground/45",
  running: "border-dashed border-primary/45 bg-primary/5 text-muted-foreground",
  // A bounced TikTok draft: dashed + a muted destructive tint so it reads as "needs
  // you again", never confusable with the gold `partial` veil or the hollow `open`.
  stale: "border-dashed border-destructive/55 bg-destructive/10 text-foreground",
};

export function StepNode({
  active,
  onClick,
  size = "md",
  step,
}: {
  /** Emphasise this node as the finding's next move (a quiet gold ring). */
  active?: boolean;
  onClick?: () => void;
  size?: "sm" | "md";
  step: BoardStep;
}) {
  const s = SIZE[size];
  const isRound = step.kind === "auto";
  const interactive = step.actionable && Boolean(onClick);
  const title = `${step.label} — ${step.statusLabel}`;

  return (
    <button
      aria-label={title}
      className={cn(
        "group relative flex shrink-0 items-center justify-center border transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none",
        s.box,
        isRound ? "rounded-full" : "rounded-[7px]",
        STATE_CLASS[step.state],
        interactive
          ? "cursor-pointer hover:border-primary/60 hover:bg-primary/10 hover:text-primary"
          : "cursor-default",
        active && "border-primary/70 ring-2 ring-primary/30",
      )}
      disabled={!interactive}
      onClick={onClick}
      title={title}
      type="button"
    >
      {step.state === "running" ? (
        <CircleNotchIcon aria-hidden="true" className={cn(s.glyph, "animate-spin")} weight="bold" />
      ) : (
        <step.Icon
          aria-hidden="true"
          className={s.glyph}
          weight={step.state === "open" || step.state === "planned" ? "regular" : "fill"}
        />
      )}
      {step.state === "done" ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <CheckIcon className="size-2" weight="bold" />
        </span>
      ) : undefined}
    </button>
  );
}
