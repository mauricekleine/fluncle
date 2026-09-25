import { CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { type BoardStep } from "@/components/admin/pipeline/board-model";
import { cn } from "@/lib/utils";

const SIZE = {
  md: { box: "size-8", glyph: "size-4" },
  sm: { box: "size-6", glyph: "size-3" },
} as const;

export const STATE_CLASS: Record<BoardStep["state"], string> = {
  done: "border-primary/40 bg-primary/15 text-foreground",
  open: "border-border bg-transparent text-muted-foreground",
  partial: "border-dashed border-primary/60 bg-primary/10 text-foreground",
  planned: "border-dotted border-border/50 bg-transparent text-muted-foreground/45",
  running: "border-dashed border-primary/45 bg-primary/5 text-muted-foreground",

  stale: "border-dashed border-destructive/55 bg-destructive/10 text-foreground",
};

export function StepNode({
  active,
  onClick,
  size = "md",
  step,
}: {
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
