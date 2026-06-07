import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { withAlpha } from "../color";
import { useBeat } from "../hooks";
import { type CosmosPalette } from "../types";
import { type EnergySample } from "../types";
import { GLSL } from "./glsl";
import { ShaderLayer } from "./shader-layer";

// "JourneyFractal" — the FRACTAL travelling vehicle (the One Vehicle Rule, see
// packages/video/README.md), rebuilt as a GPU fragment shader. A polarFold
// kaleidoscope folds the frame into mirrored wedges; the wedge interior is a
// procedural fbm field run through the Retint palette ramp; and a u_progress-
// driven scale of the sampled domain pulls the camera continuously INTO the
// fractal so the journey reads as travelling through a portal. The fold count is
// a uniform; on the beat the segment rotation kicks (foldOnBeat). An engraved
// fine-line texture sits over the smooth gradient per the vortex reference.
//
// Moodboard references (MOODBOARD.md, "fractal" vehicle group + Retint Rule):
//   - liquid-spectrum-vortex.png : the centerpiece portal spiral with fine
//     ENGRAVED line texture over a smooth woven gradient — the continuous
//     zoom-through is that vortex made to travel; the engrave lines are the
//     line-screen overlay here.
//   - mirror-quilt-desert.png    : the diamond mirror-tiling of one frame; the
//     polarFold is that kaleido structure, made silky and continuous.
//   - posted/plan-b-2.jpg, posted/rainy-days.jpg : the operator's vertical
//     mirror-fold symmetry.
// Retint Rule: kaleido chroma comes from the artwork palette (accent/glow),
// never gold; gold stays the One Sun on the parent composition.
//
// Two modes:
//   - SHADER MODE (default): the GPU kaleidoscope. Silky continuous edges, no DOM
//     mirror seams, real continuous zoom. No children needed.
//   - CSS-MIRROR MODE (cssMirror, with children): the legacy CSS-transform
//     kaleidoscope kept as a fallback that can fold arbitrary DOM children (an
//     Eclipse limb, a Starfield crop) into every wedge when you must mirror real
//     DOM rather than a procedural interior. Pass children to feed it.
//
// Determinism: only frame-, seed- and curve-derived values plus the beat grid
// through useBeat / the shader's u_beatPulse. No Math.random / Date.now.

export type JourneyFractalProps = {
  /**
   * Number of mirrored wedge segments. Even values mirror cleanly; 6 or 8 read
   * as a classic kaleidoscope. The polarFold mirrors within each wedge for clean
   * seams regardless of parity.
   * @default 6
   */
  segments?: number;
  /**
   * SHADER MODE: how many fbm octaves build the wedge interior (richer = more
   * filigree, slightly more cost). CSS-MIRROR MODE: ignored.
   * @default 6
   */
  octaves?: number;
  /**
   * CSS-MIRROR MODE only: how many concentric mirror rings are stacked to build
   * the legacy recursion. Ignored in shader mode (the zoom is continuous there).
   * @default 4
   */
  rings?: number;
  /**
   * Diameter of the CSS-mirror assembly in px. Ignored in shader mode (the
   * shader always fills the frame).
   * @default 1080
   */
  size?: number;
  /**
   * Continuous zoom travelled per second, as a scale multiplier of the sampled
   * domain. 1 = static; 1.16 means each second the tunnel pulls ~16% deeper.
   * This is the TRAVEL. In shader mode it compounds with the u_progress journey
   * zoom so the camera flies inward for the whole arc.
   * @default 1.16
   */
  zoomPerSec?: number;
  /**
   * Total domain zoom multiplier travelled across the WHOLE clip via u_progress.
   * Layered on top of zoomPerSec so the fractal reads as a journey INTO itself,
   * not just an idle spin. 1 disables the progress-driven travel.
   * @default 3.2
   */
  zoomOverClip?: number;
  /**
   * Continuous rotation of the whole assembly in degrees per second; the slow
   * twist of the vortex. Combine with foldOnBeat for kicks on top.
   * @default 4
   */
  spinPerSec?: number;
  /**
   * CSS-MIRROR MODE only: scale ratio between adjacent rings. Ignored in shader
   * mode.
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
   * Peak degrees of the per-beat fold kick when foldOnBeat is on. The kick decays
   * with the beat pulse before the next beat.
   * @default 12
   */
  foldDegrees?: number;
  /**
   * Beat grid in ms offsets relative to clip start (the composition's
   * audio.beatGrid). Required for foldOnBeat to do anything; also feeds the
   * shader's u_beatPulse.
   */
  beatGrid?: number[];
  /** How sharply the per-beat fold kick decays (passed to useBeat). Default 3.2. */
  beatDecay?: number;
  /**
   * Energy curve (composition audio.energyCurve). SHADER MODE: lifts the interior
   * brightness and the zoom speed through the loud middle. Optional.
   */
  energyCurve?: EnergySample[];
  /**
   * Bass curve (composition audio.bassCurve). SHADER MODE: breathes the engraved
   * line texture and the center bloom on the low end. Optional.
   */
  bassCurve?: EnergySample[];
  /** Per-track seed for the procedural interior. Default 1. */
  seed?: number;
  /**
   * The journey progress, 0..1, driving the continuous zoom-through. Pass the
   * raw `progress` (or eased `arc`) from useJourney so the fractal travels on the
   * shared narrative clock. When omitted, ShaderLayer's frame/(duration-1) is
   * used.
   */
  progress?: number;
  /**
   * Brand palette; the wedge interior and ring tints derive from accent/glow
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
   * Switch to the legacy CSS-transform kaleidoscope (fallback mode). Lets you
   * fold arbitrary DOM `children` into every wedge instead of the shader's
   * procedural interior. Default false (use the GPU shader).
   * @default false
   */
  cssMirror?: boolean;
  /**
   * CSS-MIRROR MODE only: per-wedge source content mirrored into every segment.
   * Falls back to a brand-tinted gradient plate when omitted. In SHADER MODE
   * children are ignored (the interior is procedural).
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

// The fractal fragment shader. polarFold mirrors uv into a wedge; we zoom the
// sampled domain by u_progress (the travel into the fractal) compounded with a
// per-second zoom; an fbm interior is run through paletteRamp; an engraved
// line-screen rides over the smooth gradient (the vortex reference); a center
// bloom marks the convergence point. The fold rotation is u_foldRot (continuous
// spin + per-beat kick), passed as a uniform from JS.
const FRACTAL_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.polarFold}
${GLSL.filmGrain}
${GLSL.vignette}

uniform float u_segments;   // mirrored wedge count
uniform float u_octaves;    // fbm octaves for the interior (as float; floored)
uniform float u_foldRot;    // total fold rotation (radians): spin + beat kick
uniform float u_zoom;       // total domain zoom (the travel into the fractal)
uniform float u_engrave;    // 0..1 engraved line-screen strength
uniform float u_flow;       // energy gate (1/0), * u_energy in main

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // Aspect-correct around center so the fold stays circular on a 9:16 frame.
  float aspect = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + 0.5;

  // Rotate the whole field (the vortex twist + the per-beat fold kick).
  vec2 c = p - 0.5;
  float cs = cos(u_foldRot);
  float sn = sin(u_foldRot);
  c = mat2(cs, -sn, sn, cs) * c;
  p = c + 0.5;

  // Kaleidoscope: mirror into a single wedge (silky seams from polarFold's
  // within-wedge mirror). int() the octaves uniform once.
  vec2 fold = polarFold(p, max(2.0, u_segments));
  int oct = int(max(1.0, u_octaves) + 0.5);

  // TRAVEL: zoom the sampled domain toward the center. fract() of a log-spiral
  // radius lets the tunnel loop seamlessly as we fall inward, so the fractal
  // reads as endless travel rather than a finite plate being scaled up.
  float flowLive = u_flow * u_energy;
  vec2 fc = fold - 0.5;
  float r = length(fc) + 1e-4;
  float ang = atan(fc.y, fc.x);
  // Log-radius lets concentric detail march outward as we zoom; subtract the
  // travel so detail flows toward us (into the portal).
  float lr = log(r) - u_zoom;
  // Build the interior in (log-radius, angle) space: a woven swirl that keeps
  // feeding new rings as we travel. Domain combines the marching log-radius with
  // a slow angular shear for the spiral weave.
  vec2 q = vec2(lr * 2.4, ang * (max(2.0, u_segments) / 6.2831853) * 6.2831853 * 0.5);
  q += vec2(u_time * 0.04 + u_seed * 2.3, u_time * 0.02);
  float warp = fbm(q * 0.9 + vec2(0.0, lr), 4);
  float field = fbm(q + warp * 0.8, oct);

  // Heat toward the center (the portal core glows), warm-dark toward the rim.
  // Keep the warm-dark ground dominant (Warm Dark Rule): the ramp only climbs
  // into the bright stops where the fbm field genuinely peaks, so most of the
  // wedge stays in the dark->heat band rather than washing into gold/cream.
  float centerHeat = smoothstep(0.42, 0.02, r);
  // Warm-dark must win: bias the field down hard so only its strongest peaks lift
  // into heat, leaving broad near-Deep-Field troughs between the lit filaments.
  float lit = smoothstep(0.42, 0.92, field);
  float t = lit * 0.72 + centerHeat * 0.3;
  t = clamp(t, 0.0, 1.0);
  vec3 col = paletteRamp(t);

  // --- Engraved line-screen overlay (the vortex reference) -----------------
  // Fine spiral grooves etched over the smooth gradient: a high-freq pattern in
  // log-radius woven with the angle, multiplied in so it only darkens narrow
  // troughs (engraved look), never washes the color. Bass swells the depth a
  // touch. Higher freq + a sharp groove profile reads as engraving, not stripes.
  float engraveFreq = 150.0;
  float linePhase = lr * engraveFreq + ang * max(2.0, u_segments) * 1.5;
  float lines = abs(sin(linePhase));        // 0 in the groove, 1 on the ridge
  float grooves = smoothstep(0.0, 0.32, lines); // thin dark grooves only
  float engraveDepth = u_engrave * (0.2 + 0.12 * u_bass);
  col *= 1.0 - engraveDepth * (1.0 - grooves);

  // --- Center bloom: the convergence / portal mouth ------------------------
  // A clean glowing mouth at the vortex center (artwork chroma, not gold): heat
  // core fading out. Snaps a little on the beat. Kept compact so it reads as a
  // portal we fall toward, not a flare.
  float bloom = smoothstep(0.26, 0.0, r);
  col = mix(col, mix(u_palette[1], u_palette[2], 0.35), bloom * (0.45 + 0.35 * flowLive));
  col += smoothstep(0.08, 0.0, r) * (0.3 + 0.4 * u_beatPulse) * u_palette[2];

  // --- Finish --------------------------------------------------------------
  col *= mix(0.45, 1.0, vignette(uv, 1.06, 0.95));
  col = filmGrain(col, uv, u_time, 0.12);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

/**
 * A single mirrored kaleidoscope ring for the CSS-mirror fallback: `segments`
 * wedge copies of `content`, alternating flipped so adjacent wedges mirror across
 * their shared edge. Pure transforms only.
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
  octaves = 6,
  rings = 4,
  size = 1080,
  zoomPerSec = 1.16,
  zoomOverClip = 3.2,
  spinPerSec = 4,
  ringScale = 0.62,
  foldOnBeat = true,
  foldDegrees = 12,
  beatGrid,
  beatDecay = 3.2,
  energyCurve,
  bassCurve,
  seed = 1,
  progress,
  palette,
  opacity = 1,
  cssMirror = false,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const seconds = frame / fps;

  const pal = { ...FALLBACK_PALETTE, ...palette };

  // Per-beat fold kick (decays with the beat pulse). useBeat is always called
  // (hooks must be unconditional); we gate its effect on foldOnBeat + a grid.
  const beat = useBeat(beatGrid ?? [], { decay: beatDecay });
  const foldKickDeg = foldOnBeat && beatGrid && beatGrid.length > 0 ? beat.pulse * foldDegrees : 0;

  // --- SHADER MODE ---------------------------------------------------------
  if (!cssMirror) {
    const clipProgress = progress ?? Math.min(1, frame / Math.max(1, durationInFrames - 1));
    // The travel: a per-second zoom compounded with a whole-clip zoom (u_progress).
    // Expressed in log-domain units (the shader subtracts u_zoom from log-radius),
    // so each unit is one e-fold of magnification.
    const perSecZoom = Math.log(Math.max(1.0001, zoomPerSec)) * seconds;
    const clipZoom = Math.log(Math.max(1, zoomOverClip)) * clipProgress;
    const totalZoom = perSecZoom + clipZoom;
    // Fold rotation in radians: continuous spin + the per-beat kick.
    const foldRot = ((spinPerSec * seconds + foldKickDeg) * Math.PI) / 180;

    const hasEnergy = !!energyCurve && energyCurve.length > 0;

    return (
      <AbsoluteFill
        aria-hidden
        style={{
          backgroundColor: pal.background,
          opacity,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <ShaderLayer
          fragmentShader={FRACTAL_FRAG}
          palette={palette}
          seed={seed}
          progress={clipProgress}
          beatGrid={beatGrid}
          beatDecay={beatDecay}
          energyCurve={energyCurve}
          bassCurve={bassCurve}
          uniforms={{
            u_engrave: 1,
            u_flow: hasEnergy ? 1 : 0,
            u_foldRot: foldRot,
            u_octaves: Math.max(1, Math.round(octaves)),
            u_segments: Math.max(2, Math.round(segments)),
            u_zoom: totalZoom,
          }}
        />
      </AbsoluteFill>
    );
  }

  // --- CSS-MIRROR FALLBACK MODE -------------------------------------------
  const ringCount = Math.max(1, Math.round(rings));
  const zoomPerSecSafe = Math.max(1.0001, zoomPerSec);
  const ringScaleSafe = Math.min(0.95, Math.max(0.2, ringScale));
  const loopSec = Math.log(1 / ringScaleSafe) / Math.log(zoomPerSecSafe);
  const depthPhase = (seconds / loopSec) % 1;
  const travelZoom = Math.pow(ringScaleSafe, -depthPhase);
  const spin = seconds * spinPerSec;

  const wedgeContent: React.ReactNode = children ?? (
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
          transform: `scale(${travelZoom}) rotate(${spin + foldKickDeg}deg)`,
          transformOrigin: "50% 50%",
          width: size,
        }}
      >
        {Array.from({ length: ringCount }).map((_, i) => {
          const ringZoom = Math.pow(ringScaleSafe, i);
          const ringSpin = i % 2 === 0 ? 0 : wedgeAngleFor(segments) / 2;
          const ringFade = interpolateFade(i - depthPhase, ringCount);
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

// Linear ring cross-fade for the CSS fallback (kept inline to avoid pulling
// remotion's interpolate into the shader path).
const interpolateFade = (x: number, ringCount: number): number => {
  const pts = [-0.9, 0, ringCount - 1.2, ringCount - 0.2];
  if (x <= pts[0] || x >= pts[3]) {
    return 0;
  }
  if (x < pts[1]) {
    return (x - pts[0]) / (pts[1] - pts[0]);
  }
  if (x <= pts[2]) {
    return 1;
  }
  return 1 - (x - pts[2]) / (pts[3] - pts[2]);
};
