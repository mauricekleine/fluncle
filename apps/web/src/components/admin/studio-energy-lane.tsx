import { useCallback, useMemo, useRef } from "react";
import {
  type StudioEnvelope,
  type TimelineRegion,
  clipToRegion,
  msToFraction,
} from "@/lib/studio-clip";

const CURVE_COLUMNS = 600;
const VIEW_W = 1000;
const VIEW_H = 120;

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

type CueTick = { outOfOrder: boolean; startMs: number; trackId: string };

export function StudioEnergyLane({
  band,
  clips,
  cues,
  currentMs,
  durationMs,
  envelope,
  onBandPaint,
  onSeekFraction,
  suggestions,
}: {
  band: { aFraction: number; bFraction: number } | null;
  clips: Clip[];

  cues?: CueTick[];

  currentMs: number;
  durationMs: number;
  envelope: StudioEnvelope | undefined;

  onBandPaint: (aFraction: number, bFraction: number) => void;

  onSeekFraction: (fraction: number) => void;

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
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a labelled pointer-driven lane, not a form-control grouping; `fieldset`/`legend` would be wrong markup here.
        role="group"
      >
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

        {suggestions.map((region, index) => (
          <span
            className="studio-region studio-region-suggestion"

            key={`suggestion-${index}`}
            style={{
              left: `${region.leftFraction * 100}%`,
              width: `${region.widthFraction * 100}%`,
            }}
          />
        ))}

        {bandRegion ? (
          <span
            className="studio-region studio-region-band"
            style={{ left: `${bandRegion.left * 100}%`, width: `${bandRegion.width * 100}%` }}
          />
        ) : null}

        {(cues ?? []).map((cue) => (
          <span
            className="studio-cue-tick"
            data-out-of-order={cue.outOfOrder ? "true" : undefined}
            key={cue.trackId}
            style={{ left: `${msToFraction(cue.startMs, durationMs) * 100}%` }}
          />
        ))}

        <span className="studio-playhead" style={{ left: `${playheadFraction * 100}%` }} />
      </div>
    </div>
  );
}
