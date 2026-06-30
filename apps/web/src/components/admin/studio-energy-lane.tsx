import { useCallback, useMemo, useRef } from "react";
import {
  type StudioEnvelope,
  type TimelineRegion,
  clipToRegion,
  msToFraction,
} from "@/lib/studio-clip";

// The Studio editor's one quiet energy lane: the
// set's loudness curve under the preview, drawn in the warm-neutral ink ramp —
// Stardust curve, Starlight-Cream played portion (NOT galaxy tints; the panel found
// they fail AA on the dark plate). It reads the ONE clock (the video's currentMs)
// for the playhead and renders three region families with the canon colour
// governance: dashed-Stardust suggestion ghosts (candidates), a Gold-Veil committed
// band per existing clip, and a brighter dashed Starlight-Cream active band.
//
// It is suggestion-FIRST but degrades gracefully: with no envelope (the box hasn't
// staged it) there is no curve and no suggestions — just the rail, the playhead, the
// committed clips, and the active band, so manual in/out still works.
//
// Interaction (the VibeMap pointer model): a click seeks; a horizontal drag paints
// an in/out band. Keyboard seek/in/out/mark/create live at the page (the lane is a
// supplementary visual; its values are mirrored into the page aria-live readout).

// Downsample the ~100ms-hop curve (a 72-min set is ~43k points) to a screen-scale
// column count via max-pooling — peaks survive, the path stays light.
const CURVE_COLUMNS = 600;
const VIEW_W = 1000;
const VIEW_H = 120;
// A drag past this fraction of the lane counts as a band paint, not a seek click.
const DRAG_THRESHOLD = 0.01;

function maxPool(values: number[], columns: number): number[] {
  if (values.length === 0) {
    return [];
  }

  if (values.length <= columns) {
    return values;
  }

  const out: number[] = Array.from({ length: columns }, () => 0);
  const per = values.length / columns;

  for (let c = 0; c < columns; c++) {
    const lo = Math.floor(c * per);
    const hi = Math.min(values.length, Math.floor((c + 1) * per));
    let m = 0;

    for (let i = lo; i < hi; i++) {
      const v = values[i] ?? 0;

      if (v > m) {
        m = v;
      }
    }

    out[c] = m;
  }

  return out;
}

// Build a closed SVG area path (baseline → curve → baseline) for a 0..1 curve.
function areaPath(curve: number[]): string {
  if (curve.length === 0) {
    return "";
  }

  const step = VIEW_W / Math.max(1, curve.length - 1);
  const top = (v: number) => VIEW_H - Math.max(0, Math.min(1, v)) * VIEW_H;
  let d = `M 0 ${VIEW_H}`;

  for (let i = 0; i < curve.length; i++) {
    d += ` L ${(i * step).toFixed(2)} ${top(curve[i] ?? 0).toFixed(2)}`;
  }

  d += ` L ${VIEW_W} ${VIEW_H} Z`;

  return d;
}

type Clip = { id: string; inMs: number; outMs: number };

export function StudioEnergyLane({
  band,
  clips,
  currentMs,
  durationMs,
  envelope,
  onBandPaint,
  onSeekFraction,
  suggestions,
}: {
  /** The active hand-pick band as two edge fractions, or null when none is pending. */
  band: { aFraction: number; bFraction: number } | null;
  clips: Clip[];
  /** The playhead, from the one clock (ms). */
  currentMs: number;
  durationMs: number;
  envelope: StudioEnvelope | undefined;
  /** A horizontal drag painted a band (two edge fractions, unordered). */
  onBandPaint: (aFraction: number, bFraction: number) => void;
  /** A click (no drag) sought to this fraction of the set. */
  onSeekFraction: (fraction: number) => void;
  /** The suggestion windows to ghost (already derived from the envelope). */
  suggestions: TimelineRegion[];
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);
  const dragMoved = useRef(false);

  const curvePath = useMemo(() => {
    if (!envelope || envelope.energy.length === 0) {
      return "";
    }

    return areaPath(maxPool(envelope.energy, CURVE_COLUMNS));
  }, [envelope]);

  const playheadFraction = msToFraction(currentMs, durationMs);

  const fractionFromEvent = useCallback((event: React.PointerEvent): number | null => {
    const lane = laneRef.current;

    if (!lane) {
      return null;
    }

    const rect = lane.getBoundingClientRect();

    if (rect.width <= 0) {
      return null;
    }

    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      const fraction = fractionFromEvent(event);

      if (fraction === null) {
        return;
      }

      // Record the grab; don't paint a band yet — a bare click is a SEEK and must
      // not wipe a pending band to zero width. The band is painted only once the
      // pointer actually drags past the threshold (handlePointerMove).
      dragStart.current = fraction;
      dragMoved.current = false;
      laneRef.current?.setPointerCapture(event.pointerId);
    },
    [fractionFromEvent],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = dragStart.current;

      if (start === null) {
        return;
      }

      const fraction = fractionFromEvent(event);

      if (fraction === null) {
        return;
      }

      if (Math.abs(fraction - start) > DRAG_THRESHOLD) {
        dragMoved.current = true;
      }

      // Paint only once it's a real drag, so a click-to-seek leaves the band alone.
      if (dragMoved.current) {
        onBandPaint(start, fraction);
      }
    },
    [fractionFromEvent, onBandPaint],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const start = dragStart.current;
      dragStart.current = null;

      if (start === null) {
        return;
      }

      // A click with no real drag is a seek; a drag leaves the band painted.
      if (!dragMoved.current) {
        const fraction = fractionFromEvent(event) ?? start;
        onSeekFraction(fraction);
      }
    },
    [fractionFromEvent, onSeekFraction],
  );

  const bandRegion =
    band === null
      ? null
      : {
          left: Math.min(band.aFraction, band.bFraction),
          width: Math.abs(band.bFraction - band.aFraction),
        };

  return (
    <div className="studio-lane-wrap">
      <div
        aria-label="Set energy lane. Click to seek, drag to paint a clip in/out band."
        className="studio-lane"
        onPointerCancel={endDrag}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        ref={laneRef}
        role="group"
      >
        {/* The curve (warm-neutral ramp): Stardust rail + a Starlight-Cream played
            portion, clipped to the playhead. With no envelope only the flat rail
            shows. */}
        <svg
          aria-hidden="true"
          className="studio-lane-svg"
          preserveAspectRatio="none"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        >
          {curvePath ? (
            <>
              <defs>
                <clipPath id="studio-played">
                  <rect height={VIEW_H} width={VIEW_W * playheadFraction} x="0" y="0" />
                </clipPath>
              </defs>
              <path className="studio-lane-curve" d={curvePath} />
              <path
                className="studio-lane-curve-played"
                clipPath="url(#studio-played)"
                d={curvePath}
              />
            </>
          ) : (
            <line className="studio-lane-flat" x1="0" x2={VIEW_W} y1={VIEW_H - 1} y2={VIEW_H - 1} />
          )}
        </svg>

        {/* Committed clips — Gold-Veil bands (one sun governance: the only gold-tinted
            fill; the Create action is the only saturated gold). */}
        {clips.map((clip) => {
          const region = clipToRegion(clip, durationMs);

          return (
            <span
              className="studio-region studio-region-clip"
              key={clip.id}
              style={{
                left: `${region.leftFraction * 100}%`,
                width: `${region.widthFraction * 100}%`,
              }}
            />
          );
        })}

        {/* Suggestion ghosts — dashed Stardust candidates. */}
        {suggestions.map((region, index) => (
          <span
            className="studio-region studio-region-suggestion"
            // Suggestions are positional ghosts off the same ordered envelope list.
            // oxlint-disable-next-line no-array-index-key
            key={`suggestion-${index}`}
            style={{
              left: `${region.leftFraction * 100}%`,
              width: `${region.widthFraction * 100}%`,
            }}
          />
        ))}

        {/* The active hand-pick band — a brighter dashed Starlight-Cream band. */}
        {bandRegion ? (
          <span
            className="studio-region studio-region-band"
            style={{ left: `${bandRegion.left * 100}%`, width: `${bandRegion.width * 100}%` }}
          />
        ) : null}

        {/* The playhead — Starlight Cream (clock-tracked content motion, never gated). */}
        <span className="studio-playhead" style={{ left: `${playheadFraction * 100}%` }} />
      </div>
    </div>
  );
}
