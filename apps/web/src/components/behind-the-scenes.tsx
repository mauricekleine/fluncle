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

function BehindTheScenes({
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

const GRAIN_WORD_CASING: Record<string, string> = {
  bayer: "Bayer",
  ign: "IGN",
  vhs: "VHS",
};

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

export function modelTelemetry(track: Track): string | undefined {
  if (!track.videoModel) {
    return undefined;
  }

  return track.videoModelReasoning
    ? `${track.videoModel} · effort ${track.videoModelReasoning}`
    : track.videoModel;
}

export function hasVideoBehindTheScenes(track: Track): boolean {
  return Boolean(track.videoUrl && track.videoVehicle);
}

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
