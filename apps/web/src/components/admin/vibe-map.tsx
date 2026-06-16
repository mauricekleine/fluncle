import { CircleNotchIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useCallback, useRef } from "react";
import { GALAXIES, galaxyForVibe } from "@/lib/galaxies";
import { usePreviewControls } from "@/lib/preview-player";
import { cn } from "@/lib/utils";

// The vibe map: a 2D field where the operator drops a banger relative to the
// others (see docs/admin-tagging.md). X = Light(-1)↔Dark(+1) mood, Y =
// Floaty(-1)↔Driving(+1) energy. The four quadrants are the four galaxies, each
// its own colour. Placement is relative, not absolute — that's what makes review
// fast. Position is never CSS-animated (it tracks the pointer), so reduced-motion
// has nothing to suppress here.

type VibePointInput = {
  artists?: string[];
  title: string;
  trackId: string;
  vibeX: number;
  vibeY: number;
};

type VibeMapProps = {
  // Already-placed findings, drawn faint for relative context.
  points: VibePointInput[];
  value: { x: number; y: number } | null;
  onChange: (x: number, y: number) => void;
};

const clamp = (n: number) => Math.max(-1, Math.min(1, n));
// fraction 0..1 across the box for a coordinate (x: left→right, y: top→bottom).
const leftPct = (x: number) => `${((x + 1) / 2) * 100}%`;
const topPct = (y: number) => `${((1 - y) / 2) * 100}%`;

export function VibeMap({ onChange, points, value }: VibeMapProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const { loadingTrackId, playingTrackId, toggle } = usePreviewControls();

  const positionFromEvent = useCallback((event: React.PointerEvent) => {
    const box = boxRef.current;

    if (!box) {
      return;
    }

    const rect = box.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1);
    const y = clamp((1 - (event.clientY - rect.top) / rect.height) * 2 - 1);

    return { x, y };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      const next = positionFromEvent(event);

      if (!next) {
        return;
      }

      dragging.current = true;
      boxRef.current?.setPointerCapture(event.pointerId);
      onChange(next.x, next.y);
    },
    [onChange, positionFromEvent],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging.current) {
        return;
      }

      const next = positionFromEvent(event);

      if (next) {
        onChange(next.x, next.y);
      }
    },
    [onChange, positionFromEvent],
  );

  const endDrag = useCallback(() => {
    dragging.current = false;
  }, []);

  const activeQuadrant = value ? galaxyForVibe(value.x, value.y) : undefined;

  return (
    <div
      aria-label="Vibe map. Click or drag to place this banger by energy and mood."
      className="relative aspect-square w-full max-w-[34rem] cursor-crosshair touch-none select-none overflow-hidden rounded-xl border border-border bg-background/40"
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      ref={boxRef}
      role="application"
    >
      {/* Quadrant tints */}
      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
        {(["solar", "nebular", "lunar", "astral"] as const).map((key) => (
          <div
            key={key}
            style={{
              background: `radial-gradient(120% 120% at 50% 50%, color-mix(in oklch, ${GALAXIES[key].color} 14%, transparent), transparent 78%)`,
            }}
          />
        ))}
      </div>

      {/* Axes */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />

      {/* Axis labels */}
      <span className="pointer-events-none absolute left-1/2 top-1.5 -translate-x-1/2 text-[10px] font-bold tracking-wide text-muted-foreground">
        DRIVING
      </span>
      <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[10px] font-bold tracking-wide text-muted-foreground">
        FLOATY
      </span>
      <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-bold tracking-wide text-muted-foreground">
        LIGHT
      </span>
      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-bold tracking-wide text-muted-foreground">
        DARK
      </span>

      {/* Quadrant names */}
      {(
        [
          ["solar", "left-2.5 top-6"],
          ["nebular", "right-2.5 top-6 text-right"],
          ["lunar", "bottom-6 left-2.5"],
          ["astral", "bottom-6 right-2.5 text-right"],
        ] as const
      ).map(([key, pos]) => (
        <span
          className={cn("pointer-events-none absolute text-xs font-bold", pos)}
          key={key}
          style={{ color: GALAXIES[key].color, opacity: activeQuadrant === key ? 0.95 : 0.4 }}
        >
          {GALAXIES[key].name}
        </span>
      ))}

      {/* Context dots: the already-placed findings, drawn faint. Hover reveals a
          card with the title + a play button, so you can hear an anchor and place
          the new marker relative to it. The dot stays click-through (drop a marker
          on top of one); only the card swallows the pointer so play never places. */}
      {points.map((point) => {
        const left = leftPct(point.vibeX);
        const top = topPct(point.vibeY);
        const quadrant = galaxyForVibe(point.vibeX, point.vibeY);
        const isPlaying = playingTrackId === point.trackId;
        const isLoading = loadingTrackId === point.trackId;

        return (
          <span
            className="group absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
            key={point.trackId}
            style={{ left, top }}
          >
            <span
              className={cn(
                "pointer-events-none size-2 rounded-full transition-transform duration-150 ease-out group-hover:scale-150 group-hover:opacity-100 motion-reduce:transition-none",
                isPlaying ? "scale-150 opacity-100" : "opacity-60",
              )}
              style={{ background: GALAXIES[quadrant].color }}
            />

            {/* Hover card — interactive only while hovered (group-hover flips on
                pointer-events); a descendant of the dot, so moving onto it keeps
                the hover. stopPropagation keeps the map from placing a marker. */}
            <div
              className="pointer-events-none absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 motion-reduce:transition-none"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="flex max-w-52 items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
                <button
                  aria-label={isPlaying ? `Pause ${point.title}` : `Preview ${point.title}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/70"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(point.trackId);
                  }}
                  type="button"
                >
                  {isLoading ? (
                    <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                  ) : isPlaying ? (
                    <PauseIcon aria-hidden="true" weight="fill" />
                  ) : (
                    <PlayIcon aria-hidden="true" weight="fill" />
                  )}
                </button>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{point.title}</span>
                  {point.artists?.length ? (
                    <span className="block truncate text-muted-foreground">
                      {point.artists.join(", ")}
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          </span>
        );
      })}

      {/* Current marker */}
      {value ? (
        <span
          className="pointer-events-none absolute z-10 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
          style={{
            background: activeQuadrant ? GALAXIES[activeQuadrant].color : undefined,
            boxShadow: activeQuadrant
              ? `0 0 0 6px color-mix(in oklch, ${GALAXIES[activeQuadrant].color} 22%, transparent)`
              : undefined,
            left: leftPct(value.x),
            top: topPct(value.y),
          }}
        />
      ) : (
        <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border border-dashed border-border bg-background/70 px-2 py-1 text-xs text-muted-foreground">
          Click to place
        </span>
      )}
    </div>
  );
}
