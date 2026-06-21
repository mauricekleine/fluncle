import { useCurrentFrame } from "remotion";
import { random } from "remotion";

export type GrainProps = {
  /** Overall opacity of the grain layer, 0..1. Default 0.12. */
  opacity?: number;
  /**
   * feTurbulence base frequency. Higher = finer, denser grain. Default 0.9.
   * Think of it as grain size: lower is chunkier film, higher is fine 16mm.
   */
  intensity?: number;
  /** Deterministic seed; the per-frame turbulence seed derives from this. */
  seed?: number;
  /**
   * How many distinct turbulence frames to cycle through. Re-seeding every
   * single frame is the most "alive" but also the most flicker; cycling a small
   * pool reads as film grain and is cheaper. Default 12.
   */
  framePool?: number;
  /** Blend mode for the grain over its parent. Default "overlay". */
  blendMode?: React.CSSProperties["mixBlendMode"];
};

/**
 * Animated film grain via SVG feTurbulence, covering the parent absolutely.
 *
 * Grain over everything is the brand's base texture (DESIGN.md / cover art).
 * Determinism: the turbulence `seed` is derived from the frame via remotion's
 * random() helper, never Math.random(). The same frame always yields the same
 * grain.
 *
 * CPU note: feTurbulence is rasterized per frame by the headless browser. We
 * cycle a small pool of seeds (framePool) rather than a unique seed per frame to
 * keep the filter cache warm while still reading as motion.
 */
export const Grain: React.FC<GrainProps> = ({
  opacity = 0.12,
  intensity = 0.9,
  seed = 1,
  framePool = 12,
  blendMode = "overlay",
}) => {
  const frame = useCurrentFrame();

  const poolIndex = frame % Math.max(1, framePool);
  // Derive a stable per-frame turbulence seed deterministically.
  const turbulenceSeed = Math.floor(random(`grain-${seed}-${poolIndex}`) * 1000);

  return (
    <svg
      aria-hidden
      style={{
        height: "100%",
        inset: 0,
        mixBlendMode: blendMode,
        opacity,
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
      }}
    >
      <filter id={`grain-${seed}`}>
        <feTurbulence
          type="fractalNoise"
          baseFrequency={intensity}
          numOctaves={2}
          seed={turbulenceSeed}
          stitchTiles="stitch"
        />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
    </svg>
  );
};
