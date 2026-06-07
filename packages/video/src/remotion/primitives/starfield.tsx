import { useMemo } from "react";
import { random, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { withAlpha } from "../color";

export type StarfieldProps = {
  /** Number of stars. Default 140. */
  density?: number;
  /**
   * Parallax depth: how many discrete depth layers, 1..n. Nearer layers (low
   * index) are bigger, brighter, and drift faster. Default 3.
   */
  depth?: number;
  /** Deterministic seed for star positions. Default 1. */
  seed?: number;
  /**
   * Drift vector in screen-fractions per second {x, y}. Subtle by default; the
   * cosmos breathes, it does not scroll. Default { x: 0.004, y: -0.01 }.
   */
  drift?: { x: number; y: number };
  /** Star color (warm white). Default Starlight Cream. */
  color?: string;
  /** Max star radius in px for the nearest layer. Default 2.6. */
  maxSize?: number;
  /** Twinkle amount 0..1; 0 disables. Default 0.35. */
  twinkle?: number;
};

type Star = {
  baseX: number;
  baseY: number;
  layer: number;
  size: number;
  baseOpacity: number;
  phase: number;
};

/**
 * Seeded starfield with subtle parallax drift, on a transparent background.
 *
 * The founding image is a figure floating into a starfield (DESIGN.md). Stars
 * are warm-white (Starlight Cream), positions are seeded via remotion random()
 * so they are stable across renders, and drift is frame-derived (no wall clock).
 *
 * Parallax: nearer layers drift faster and are brighter/larger, selling depth
 * without WebGL. Stars wrap seamlessly so the field never empties.
 */
export const Starfield: React.FC<StarfieldProps> = ({
  density = 140,
  depth = 3,
  seed = 1,
  drift = { x: 0.004, y: -0.01 },
  color = colors.starlightCream,
  maxSize = 2.6,
  twinkle = 0.35,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layers = Math.max(1, Math.round(depth));

  const stars = useMemo<Star[]>(() => {
    const out: Star[] = [];
    for (let i = 0; i < density; i++) {
      const layer = Math.floor(random(`star-layer-${seed}-${i}`) * layers);
      // Nearer layers (lower index) are bigger and brighter.
      const nearness = (layers - layer) / layers;
      out.push({
        baseOpacity: 0.25 + random(`star-o-${seed}-${i}`) * 0.75 * nearness,
        baseX: random(`star-x-${seed}-${i}`),
        baseY: random(`star-y-${seed}-${i}`),
        layer,
        phase: random(`star-p-${seed}-${i}`) * Math.PI * 2,
        size: 0.6 + random(`star-s-${seed}-${i}`) * maxSize * nearness,
      });
    }
    return out;
  }, [density, layers, seed, maxSize]);

  const seconds = frame / fps;

  return (
    <svg
      aria-hidden
      style={{
        height: "100%",
        inset: 0,
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
      }}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
    >
      {stars.map((star, i) => {
        const nearness = (layers - star.layer) / layers;
        const speed = 0.4 + nearness; // nearer drifts faster
        // Wrap into 0..1 so the field tiles seamlessly.
        const x = (((star.baseX + drift.x * speed * seconds) % 1) + 1) % 1;
        const y = (((star.baseY + drift.y * speed * seconds) % 1) + 1) % 1;

        const tw = twinkle > 0 ? 1 - twinkle * 0.5 * (1 + Math.sin(seconds * 2 + star.phase)) : 1;
        const opacity = Math.min(1, star.baseOpacity * tw);

        return (
          <circle
            key={i}
            cx={x * 1000}
            cy={y * 1000}
            r={star.size}
            fill={withAlpha(color, opacity)}
          />
        );
      })}
    </svg>
  );
};
