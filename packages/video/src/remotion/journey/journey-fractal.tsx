import React, { useMemo } from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { withAlpha } from "../color";
import { useBeat } from "../hooks";
import { type CosmosPalette } from "../types";

// "JourneyFractal" — the FRACTAL travelling vehicle (the One Vehicle Rule, see
// packages/video/README.md). Mirror/kaleido recursion that does not merely spin
// in place: it TRAVELS by zooming continuously through nested mirrored rings, so
// the frame folds inward like falling into the liquid-spectrum-vortex portal.
//
// Moodboard references (MOODBOARD.md, "fractal" vehicle group + Retint Rule):
//   - mirror-quilt-desert.png  : the diamond mirror-tiling of one frame; steal
//     the tiling structure, drop the daylight palette.
//   - posted/plan-b-2.jpg, posted/rainy-days.jpg : the operator's own vertical
//     mirror-fold symmetry (gold moon, Re-entry-Red lit peaks, still-lake fold).
//   - liquid-spectrum-vortex.png : the vortex as a centerpiece portal; the
//     continuous zoom-through is that swirling portal made to travel.
// Retint Rule: kaleido chroma comes from the artwork palette (accent/glow),
// never gold; gold stays the sun on the parent composition (The One Sun Rule).
//
// Determinism: only frame- and seed-derived values plus the beat grid through
// useBeat. No Math.random / Date.now in the render. The kaleido tiling itself is
// pure CSS transforms (self-contained here rather than the KaleidoMirror
// primitive, because this vehicle needs per-ring scale/rotation it does not
// expose; the wedge-mirror technique is the same).

export type JourneyFractalProps = {
  /**
   * Number of mirrored wedge segments per ring. Even values mirror cleanly;
   * 6 or 8 read as a classic kaleidoscope. Odd values give a pinwheel.
   * @default 6
   */
  segments?: number;
  /**
   * How many concentric, progressively-scaled mirror rings are stacked to build
   * the recursion-that-travels. More rings = deeper tunnel, slightly more cost.
   * @default 4
   */
  rings?: number;
  /**
   * Diameter of the assembly in px. Default 1080 (full frame width); the rings
   * extend past the edges so the fold reaches the corners.
   * @default 1080
   */
  size?: number;
  /**
   * Continuous zoom travelled per second, as a scale multiplier. 1 = static;
   * 1.18 means each second the tunnel pulls ~18% deeper. This is the TRAVEL: the
   * camera flies through the mirror tunnel for the whole journey arc.
   * @default 1.16
   */
  zoomPerSec?: number;
  /**
   * Continuous rotation of the whole assembly in degrees per second; the slow
   * twist of the vortex. Combine with foldOnBeat for kicks on top.
   * @default 4
   */
  spinPerSec?: number;
  /**
   * Scale ratio between adjacent rings. <1 nests each ring smaller toward the
   * center (the tunnel); the zoom loops seamlessly when rings are spaced by this.
   * @default 0.62
   */
  ringScale?: number;
  /**
   * When true, each beat kicks an extra segment rotation (a fold) via useBeat,
   * so the kaleidoscope snaps on the grid on top of its continuous spin. Pass
   * beatGrid to enable. No-op without a beat grid.
   * @default true
   */
  foldOnBeat?: boolean;
  /**
   * Peak degrees of the per-beat fold kick when foldOnBeat is on. The kick
   * decays with the beat pulse before the next beat.
   * @default 12
   */
  foldDegrees?: number;
  /**
   * Beat grid in ms offsets relative to clip start (the composition's
   * audio.beatGrid). Required for foldOnBeat to do anything.
   */
  beatGrid?: number[];
  /**
   * How sharply the per-beat fold kick decays (passed to useBeat). Higher =
   * snappier.
   * @default 3.2
   */
  beatDecay?: number;
  /**
   * Brand palette; the mirror wash and ring tints derive from accent/glow
   * (artwork chroma), never gold. Pass the composition palette so a cool track
   * and a warm track fold as different nights.
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Overall layer opacity, 0..1, for fading the vehicle in/out across the arc.
   * @default 1
   */
  opacity?: number;
  /**
   * Per-wedge source content, mirrored into every segment of every ring. This is
   * the CREATIVITY slot: feed an Eclipse limb, a Starfield crop, a DitherField,
   * artwork — whatever the agent wants folded. Falls back to a brand-tinted
   * gradient plate when omitted, so the vehicle is never empty.
   */
  children?: React.ReactNode;
};

// Brand-canon palette defaults (warm dark ground, artwork-derived chroma).
const FALLBACK_PALETTE: CosmosPalette = {
  accent: colors.reentryRed,
  background: colors.deepField,
  glow: colors.eclipseGlow,
  ink: colors.starlightCream,
  swatches: [],
};

/**
 * A single mirrored kaleidoscope ring: `segments` wedge copies of `content`,
 * alternating flipped so adjacent wedges mirror across their shared edge (the
 * same technique as the KaleidoMirror primitive). Pure transforms only.
 */
const MirrorRing: React.FC<{
  segments: number;
  content: React.ReactNode;
  sourceScale: number;
}> = ({ segments, content, sourceScale }) => {
  const count = Math.max(1, Math.round(segments));
  const wedgeAngle = 360 / count;
  const half = wedgeAngle / 2 + 0.5;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const x1 = 50 + 80 * Math.sin(rad(-half));
  const y1 = 50 - 80 * Math.cos(rad(-half));
  const x2 = 50 + 80 * Math.sin(rad(half));
  const y2 = 50 - 80 * Math.cos(rad(half));
  const wedgeClip = `polygon(50% 50%, ${x1.toFixed(3)}% ${y1.toFixed(3)}%, ${x2.toFixed(3)}% ${y2.toFixed(3)}%)`;

  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const angle = i * wedgeAngle;
        const flip = i % 2 === 1 ? -1 : 1;
        return (
          <div
            key={i}
            style={{
              clipPath: wedgeClip,
              inset: 0,
              position: "absolute",
              transform: `rotate(${angle}deg)`,
              transformOrigin: "50% 50%",
            }}
          >
            <div
              style={{
                inset: 0,
                position: "absolute",
                transform: `scaleX(${flip}) scale(${sourceScale})`,
                transformOrigin: "50% 50%",
              }}
            >
              {content}
            </div>
          </div>
        );
      })}
    </>
  );
};

export const JourneyFractal: React.FC<JourneyFractalProps> = ({
  segments = 6,
  rings = 4,
  size = 1080,
  zoomPerSec = 1.16,
  spinPerSec = 4,
  ringScale = 0.62,
  foldOnBeat = true,
  foldDegrees = 12,
  beatGrid,
  beatDecay = 3.2,
  palette,
  opacity = 1,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;

  const pal = { ...FALLBACK_PALETTE, ...palette };
  const ringCount = Math.max(1, Math.round(rings));

  // Per-beat fold kick (decays with the beat pulse). useBeat is always called
  // (hooks must be unconditional); we gate its effect on foldOnBeat + a grid.
  const beat = useBeat(beatGrid ?? [], { decay: beatDecay });
  const foldKick = foldOnBeat && beatGrid && beatGrid.length > 0 ? beat.pulse * foldDegrees : 0;

  // TRAVEL: a continuous zoom-through. We cycle a 0..1 depth phase and map it to
  // a scale so the tunnel loops seamlessly: as the outer ring grows past the
  // frame, the next ring takes its place. Pure function of frame.
  const zoomPerSecSafe = Math.max(1.0001, zoomPerSec);
  const ringScaleSafe = Math.min(0.95, Math.max(0.2, ringScale));
  // Seconds it takes the zoom to advance exactly one ring-step (for seamless loop).
  const loopSec = Math.log(1 / ringScaleSafe) / Math.log(zoomPerSecSafe);
  const depthPhase = (seconds / loopSec) % 1; // 0..1 within one ring-step
  const travelZoom = Math.pow(ringScaleSafe, -depthPhase); // 1 .. 1/ringScale

  const spin = seconds * spinPerSec;

  // The mirrored source for each wedge: caller's children, or a brand-tinted
  // gradient plate so the vehicle is never empty.
  const wedgeContent = useMemo<React.ReactNode>(() => {
    if (children) {
      return children;
    }
    return (
      <div
        aria-hidden
        style={{
          backgroundImage: `radial-gradient(circle at 38% 30%, ${withAlpha(
            pal.glow,
            0.55,
          )} 0%, ${withAlpha(pal.accent, 0.4)} 34%, ${withAlpha(
            pal.background,
            0.9,
          )} 72%, ${pal.background} 100%)`,
          height: "100%",
          width: "100%",
        }}
      />
    );
  }, [children, pal.glow, pal.accent, pal.background]);

  return (
    <div
      aria-hidden
      style={{
        alignItems: "center",
        display: "flex",
        height: "100%",
        inset: 0,
        justifyContent: "center",
        opacity,
        overflow: "hidden",
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
      }}
    >
      <div
        style={{
          borderRadius: "50%",
          height: size,
          overflow: "hidden",
          position: "relative",
          transform: `scale(${travelZoom}) rotate(${spin + foldKick}deg)`,
          transformOrigin: "50% 50%",
          width: size,
        }}
      >
        {Array.from({ length: ringCount }).map((_, i) => {
          // Each ring is nested smaller toward the center; the deepest rings
          // counter-rotate slightly so the tunnel reads as recursive, not flat.
          const ringZoom = Math.pow(ringScaleSafe, i);
          const ringSpin = i % 2 === 0 ? 0 : wedgeAngleFor(segments) / 2;
          // Outer rings fade as the zoom pulls past them (depthPhase), so the
          // hand-off between rings during travel is seamless.
          const ringFade = interpolate(
            i - depthPhase,
            [-0.9, 0, ringCount - 1.2, ringCount - 0.2],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          );
          return (
            <div
              key={i}
              style={{
                inset: 0,
                opacity: ringFade,
                position: "absolute",
                transform: `scale(${ringZoom}) rotate(${ringSpin}deg)`,
                transformOrigin: "50% 50%",
              }}
            >
              <MirrorRing segments={segments} content={wedgeContent} sourceScale={1.4} />
            </div>
          );
        })}
        {/* Center vortex bloom: a soft chroma core where the tunnel converges,
            drawn from artwork glow, keeping gold out of the fractal. */}
        <div
          style={{
            backgroundImage: `radial-gradient(circle at center, ${withAlpha(
              pal.glow,
              0.45,
            )} 0%, transparent 38%)`,
            inset: 0,
            mixBlendMode: "screen",
            position: "absolute",
          }}
        />
      </div>
    </div>
  );
};

// Wedge angle helper kept module-scope so the ring offset can reference it.
const wedgeAngleFor = (segments: number): number => 360 / Math.max(1, Math.round(segments));
