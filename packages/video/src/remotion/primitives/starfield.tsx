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

  // ORBIT, NOT A SEESAW. Callers commonly pass an audio-reactive drift vector
  // (e.g. base * (1 + energy)) to "drift faster on the beat". But position here
  // is drift * seconds, i.e. we treat drift as a velocity yet multiply it by
  // absolute time — so any beat-driven change to the magnitude retroactively
  // rewrites the whole past trajectory, dragging stars forward then back. That
  // reads as a seesaw synced to the beat, not an orbit.
  //
  // The fix: position depends ONLY on the drift DIRECTION (a unit vector) and a
  // fixed reference speed. Direction is constant for the life of a clip (every
  // caller scales x and y by the same positive boost, preserving direction), so
  // position is strictly linear in `seconds` and never reverses. The magnitude
  // the caller passes — the part that used to wobble position — is folded into a
  // gentle brightness lift instead, so the beat still reads, just off the
  // position axis. Determinism is preserved (frame-derived, seeded only).
  const driftMag = Math.hypot(drift.x, drift.y);
  // Reference speed: the magnitude of the default drift vector. Audio boosts
  // above this baseline ride brightness, never position.
  const referenceSpeed = Math.hypot(0.004, 0.01);
  // Unit direction; fall back to the default heading if a zero vector slips in.
  const dirX = driftMag > 1e-9 ? drift.x / driftMag : 0.004 / referenceSpeed;
  const dirY = driftMag > 1e-9 ? drift.y / driftMag : -0.01 / referenceSpeed;
  // How much the caller's magnitude exceeds baseline → a subtle, clamped glow
  // lift. 0 when at/below baseline, up to ~0.3 when energy is pumping.
  const energyLift = Math.min(0.3, Math.max(0, driftMag / referenceSpeed - 1) * 0.25);

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
        // Strictly monotonic orbit: a unit direction times a fixed reference
        // speed times absolute time. d(position)/d(seconds) is the constant
        // (dir * referenceSpeed * speed) — same sign every frame, never wobbles.
        const advance = referenceSpeed * speed * seconds;
        // Wrap into 0..1 so the field tiles seamlessly.
        const x = (((star.baseX + dirX * advance) % 1) + 1) % 1;
        const y = (((star.baseY + dirY * advance) % 1) + 1) % 1;

        const tw = twinkle > 0 ? 1 - twinkle * 0.5 * (1 + Math.sin(seconds * 2 + star.phase)) : 1;
        // Beat/energy rides brightness, not position: lift opacity (and let it
        // clamp) when the caller's drift magnitude exceeds baseline.
        const opacity = Math.min(1, star.baseOpacity * tw * (1 + energyLift));

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
