import { type ReactNode } from "react";
import { WrenchIcon } from "@phosphor-icons/react";
import { Button } from "@fluncle/ui/components/button";
import {
  Sheet,
  SheetContent,
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
// own — just the trigger, the right-hand sheet, and the title idiom.
export function BehindTheScenes({
  children,
  label,
  title,
}: {
  children: ReactNode;
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

        Chrome, scoped to this usage (the shared generated sheet also serves admin
        surfaces; aligning it globally is a separate follow-up): `shadow-none` drops
        the generated `shadow-lg` (drop shadows are banned on the public surface —
        DESIGN §4, Through-the-Glass) and the Dialog's `ring-1 ring-foreground/10`
        edges it instead; `.behind-the-scenes-sheet` (styles.css) swaps the opaque
        `bg-popover` for the log plate's glass recipe.
      */}
      <SheetContent
        className="behind-the-scenes-sheet gap-0 overflow-y-auto shadow-none ring-1 ring-foreground/10 motion-reduce:transition-none motion-reduce:duration-0"
        side="right"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

// Grain-family words that carry their own casing — initialisms (VHS, IGN) and the
// one proper noun (Bayer). Everything else reads lowercase.
const GRAIN_WORD_CASING: Record<string, string> = {
  bayer: "Bayer",
  ign: "IGN",
  vhs: "VHS",
};

// The grain family is stored as a camelCase token (e.g. "grainCoarseSilver"); the
// drawer speaks plainly, so drop the "grain" prefix and space the words out,
// keeping known initialisms in their own casing ("grainVhsScanline" → "VHS
// scanline"). (Exported for focused unit tests.)
export function humanizeGrain(grain: string): string {
  return grain
    .replace(/^grain/, "")
    .split(/(?<=[a-z])(?=[A-Z])|(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();

      return GRAIN_WORD_CASING[lower] ?? lower;
    })
    .join(" ")
    .trim();
}

// The machine telemetry line: the RAW stored model identifier plus the reasoning
// effort it ran at, quoted verbatim and mono-set (One Voice Rule — mono speaks only
// for the machine; prettifying this into a byline is what the voice review caught).
// (Exported for focused unit tests.)
export function modelTelemetry(track: Track): string | undefined {
  if (!track.videoModel) {
    return undefined;
  }

  return track.videoModelReasoning
    ? `${track.videoModel} · effort ${track.videoModelReasoning}`
    : track.videoModel;
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
  const telemetry = modelTelemetry(track);

  return (
    <div className="log-behind-scenes">
      <BehindTheScenes label="How I made it" title="How I made it">
        <div className="log-behind-body">
          <p className="log-behind-lede">
            Every finding travels back with its own footage: one moving piece, made for this tune
            and nothing else. I built a machine that listens to the track and composes the whole
            thing from the sound up. Here's what it reached for on this one.
          </p>

          {posterUrl ? (
            <img
              alt="The poster frame of this finding's video"
              className="log-behind-frame"
              loading="lazy"
              src={posterUrl}
            />
          ) : undefined}

          <dl className="log-behind-fields">
            {track.videoVehicle ? (
              <div className="log-behind-field">
                <dt>Vehicle</dt>
                <dd>{track.videoVehicle}</dd>
              </div>
            ) : undefined}
            {grain ? (
              <div className="log-behind-field">
                <dt>Grain</dt>
                <dd>{grain}</dd>
              </div>
            ) : undefined}
            {track.videoRegister ? (
              <div className="log-behind-field">
                <dt>Register</dt>
                <dd>{track.videoRegister}</dd>
              </div>
            ) : undefined}
            {telemetry ? (
              <div className="log-behind-field">
                <dt>Model</dt>
                <dd className="log-behind-telemetry">{telemetry}</dd>
              </div>
            ) : undefined}
          </dl>
        </div>
      </BehindTheScenes>
    </div>
  );
}
