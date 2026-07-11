import { type ReactNode } from "react";
import { WrenchIcon } from "@phosphor-icons/react";
import { Button } from "@fluncle/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@fluncle/ui/components/sheet";
import { trackMedia } from "@/lib/media";
import { type Track } from "@/lib/tracks";

// The behind-the-scenes drawer: a quiet, for-the-curious detail that opens from
// the right, the way a maker pulls a mate aside to show how a thing came together.
// The operator wants this to become the standard behind-the-scenes pattern, so the
// SHELL (trigger + right sheet + title idiom) stays free of any one surface's
// specifics; the video content below fills it. Voice is the builder's tour
// (VOICE.md §5) — Fluncle walking you through the workshop, not a spec sheet.

// The reusable shell. Placement is the caller's job (a behind-the-scenes trigger
// belongs in a different spot on every surface), so this carries no layout of its
// own — just the trigger, the right-hand sheet, and the title/description idiom.
export function BehindTheScenes({
  children,
  description,
  label,
  title,
}: {
  children: ReactNode;
  description?: string;
  label: string;
  title: string;
}) {
  return (
    <Sheet>
      <SheetTrigger render={<Button size="sm" variant="ghost" />}>
        <WrenchIcon aria-hidden="true" />
        {label}
      </SheetTrigger>
      {/*
        The slide honours prefers-reduced-motion (DESIGN "reduced-motion" rail) —
        the sheet still opens, it just stops sliding. Base-ui keeps focus trap +
        Escape + restore regardless.
      */}
      <SheetContent
        className="gap-0 overflow-y-auto motion-reduce:transition-none motion-reduce:duration-0"
        side="right"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : undefined}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

// The grain family is stored as a camelCase token (e.g. "grainCoarseSilver"); the
// drawer speaks plainly, so drop the "grain" prefix and space the words out.
// (Exported for focused unit tests.)
export function humanizeGrain(grain: string): string {
  return grain
    .replace(/^grain/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

// Known authoring models get a proper name; anything else degrades to the slug
// after the provider prefix so a new model still reads cleanly, never "anthropic/…".
const MODEL_NAMES: Record<string, string> = {
  "anthropic/claude-opus-4-8": "Claude Opus 4.8",
};

// (exported for focused unit tests)
export function humanizeModel(model: string): string {
  return MODEL_NAMES[model] ?? model.split("/").at(-1) ?? model;
}

// The authoring model's thinking effort — the dial it ran at, not a rationale.
const EFFORT_LABELS: Record<string, string> = {
  high: "high reasoning",
  low: "low reasoning",
  max: "max reasoning",
  medium: "medium reasoning",
  xhigh: "extra-high reasoning",
};

// (exported for focused unit tests) Maps a stored effort level to its label, falling
// back to "<value> reasoning" so an unknown dial still reads cleanly.
export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? `${effort} reasoning`;
}

/**
 * True when a finding carries the video composition ledger — a rendered video AND
 * at least the travelling vehicle. The vehicle/grain/register fields are written
 * together when the video is uploaded, so older findings that predate the ledger
 * have none; those get no trigger and no empty drawer.
 */
export function hasVideoBehindTheScenes(track: Track): boolean {
  return Boolean(track.videoUrl && track.videoVehicle);
}

// The video content that fills the shell for a /log finding. Owns its own placement
// class (`log-behind-scenes`) so the route just drops it in under the footage.
export function VideoBehindTheScenes({ track }: { track: Track }) {
  if (!hasVideoBehindTheScenes(track)) {
    return null;
  }

  const posterUrl = track.logId ? trackMedia(track.logId).posterUrl : undefined;
  const grain = track.videoGrain ? humanizeGrain(track.videoGrain) : undefined;
  const model = track.videoModel ? humanizeModel(track.videoModel) : undefined;
  const effort = track.videoModelReasoning ? effortLabel(track.videoModelReasoning) : undefined;

  return (
    <div className="log-behind-scenes">
      <BehindTheScenes
        description="Here's how this one's video came together."
        label="How I made it"
        title="How I made it"
      >
        <div className="log-behind-body">
          <p className="log-behind-lede">
            Every finding travels back with its own video — one moving piece, made for this track
            and nothing else. I hand the tune to a model and it composes the whole thing from the
            sound up. Here's what it reached for on this one.
          </p>

          {posterUrl ? (
            <img alt="" className="log-behind-frame" loading="lazy" src={posterUrl} />
          ) : undefined}

          <dl className="log-fields">
            {track.videoVehicle ? (
              <div className="log-field">
                <dt>Vehicle</dt>
                <dd>{track.videoVehicle}</dd>
              </div>
            ) : undefined}
            {grain ? (
              <div className="log-field">
                <dt>Grain</dt>
                <dd>{grain}</dd>
              </div>
            ) : undefined}
            {track.videoRegister ? (
              <div className="log-field">
                <dt>Register</dt>
                <dd>{track.videoRegister}</dd>
              </div>
            ) : undefined}
            {model ? (
              <div className="log-field">
                <dt>Composed by</dt>
                <dd>
                  {model}
                  {effort ? <span className="log-behind-effort"> · {effort}</span> : undefined}
                </dd>
              </div>
            ) : undefined}
          </dl>
        </div>
      </BehindTheScenes>
    </div>
  );
}
