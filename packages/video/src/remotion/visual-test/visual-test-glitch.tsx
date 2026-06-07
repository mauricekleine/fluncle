// "VisualTestGlitch" — the GLITCH vehicle as a finished per-track scene.
//
// Track: Bugwell — Everything In Its Right Place (a 171bpm DnB flip of the
// Radiohead title). The props analysis tells the story: a quiet, low-bass intro
// (0–~8.5s), a hard drop at ~9s, sustained high energy through ~17s, a one-bar
// breakdown gap (~17.0–17.25s), then re-entry to the close. Cool artwork (slate
// blue accent #3d6baf, oxblood glow #72191c) — the Retint Rule applies hard:
// the corruption is recolored to warm dark + Eclipse Gold + Re-entry Red.
//
// CONCEPT (journey + texture): the title is the thesis — order resolving out of
// corruption. The frame DEPARTS as scattered 1-bit dither noise (data decay),
// TRAVELS as a corruption front that resolves cell by cell, and ARRIVES with
// everything snapped into its right place: a clean halftone Eclipse disc with a
// single burning gold rim. Texture family: DITHER (the halftone/bitmap matrix
// pole, MOODBOARD halftone-tulip-bloom + dither-hourglass-glitch + green-matrix-
// bloom, all retinted warm). The one Eclipse Gold sun moment lands on the drop,
// when the disc resolves and the rim ignites.
//
// One Vehicle Rule: GLITCH. Everything is the dither corruption travelling and
// resolving across the frame; the type and close card stay subordinate.
//
// The whole texture is ONE GPU <ShaderLayer> (the preferred grain + Retint path):
// halftone dither, the resolving front, the eclipse SDF disc with gold rim,
// organic film grain and the palette ramp all baked into the fragment shader.
// No CSS <Grain> / <Retint> over the shader (README: bake both into the shader).
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, the audio.*
// curves through the hooks, remotion-seeded values). No Math.random / Date.now.
// GPU renders on ANGLE/Metal — stills/renders pass --gl=angle.

import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colors } from "@fluncle/tokens";
import { type NostalgicCosmosProps } from "../types";
import {
  CloseCard,
  FloatingType,
  GLSL,
  ShaderLayer,
  paletteMix,
  useEnergy,
  useJourney,
} from "../cosmos";

// Safe margins: keep all type inside this inset (1080x1920, platform-chrome safe).
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// The drop lands at ~9s in the analysed window; the corruption resolves into the
// disc across the bars before it, ignites on the drop, and the close arrives at
// the tail. Times in seconds (intensity rides the audio).
const T = {
  brandIn: 0.5,
  brandOut: 3.4,
  closeIn: 17.4,
  metaIn: 12.6,
  metaOut: 16.6,
  trackIn: 9.2,
  trackOut: 12.4,
};

// The travelling-and-resolving dither scene. Spreads the GLSL snippet library
// into one fragment shader: a halftone matrix corrupts the frame, a resolution
// FRONT sweeps the corruption into order with u_progress (the journey travel),
// an SDF disc emerges as the Eclipse with a single gold burning rim, then film
// grain + palette ramp + dither8 finish it at the GPU level (the Retint Rule and
// the grain constant, baked in — no CSS layers stacked over the shader).
const GLITCH_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.sdf}
${GLSL.filmGrain}
${GLSL.vignette}

// Resolution front position 0..1 (depart->arrive). u_resolve from the journey arc.
uniform float u_resolve;
// 0..1 ignition of the disc/rim on the drop (energy-gated). u_ignite.
uniform float u_ignite;
// Per-onset corruption jolt 0..1. u_jolt.
uniform float u_jolt;

// Coarse halftone dither: render a smooth value as a grid of dots whose radius
// tracks the value. This is the DITHER family (newsprint/bitmap), the matrix the
// corruption travels over. cell in px; v 0..1.
float halftone(vec2 fragPx, float v, float cell) {
  vec2 g = fragPx / cell;
  vec2 c = fract(g) - 0.5;
  float d = length(c);
  float r = sqrt(clamp(v, 0.0, 1.0)) * 0.72; // dot radius from the value
  return smoothstep(r, r - 0.12, d);          // 1 inside the dot, 0 outside
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 fragPx = gl_FragCoord.xy;
  // Aspect-correct space centered on the disc (slightly above middle).
  float aspect = u_res.x / u_res.y;
  vec2 p = (uv - vec2(0.5, 0.46));
  p.x *= aspect;

  // --- The subject: an eclipse disc (SDF), the One Sun -----------------------
  float radius = 0.27 + u_bass * 0.02 + u_beatPulse * 0.015;
  float disc = sdCircle(p, radius);
  // Thin burning limb only (the One Sun Rule keeps the lit gold area small) —
  // a tight band hugging the edge, not a fat glowing donut.
  float rimBand = 1.0 - smoothstep(0.0, 0.022, abs(disc));     // thin burning rim
  float inside = 1.0 - smoothstep(-0.01, 0.01, disc);          // disc interior
  float core = smoothstep(radius * 0.95, 0.0, length(p));      // occluding core
  float discBody = inside * (1.0 - core * 0.92);
  // The disc only EXISTS once ignited: in the corrupt intro there is no sun,
  // just scattered data; it resolves into being on the drop. Gate its presence
  // on ignition so depart reads as corruption and arrive reads as order.
  rimBand *= u_ignite;
  discBody *= u_ignite;

  // --- The corruption field --------------------------------------------------
  // A drifting fbm field is the "signal"; halftone screens it into dots. Before
  // the resolution front passes a cell, the value is scrambled by hash noise
  // (data decay); after, it settles to the clean field. u_resolve is the front.
  vec2 q = uv * vec2(1.0, 1.0 / aspect);
  float signal = fbm(q * 3.4 + vec2(u_time * 0.04, -u_time * 0.06), 5);
  // Lift the signal where the disc sits so the dots crowd into the sun shape.
  signal = mix(signal, signal * 0.5 + discBody * 0.9 + rimBand * 0.6, 0.85);

  // Per-cell resolution: cells resolve as a soft front crosses them (diagonal),
  // jittered per cell so the edge dissolves rather than wipes like a bar.
  float cellSize = mix(26.0, 13.0, u_resolve); // grid tightens as it resolves
  vec2 cellId = floor(fragPx / cellSize);
  float cellJitter = hash21(cellId) * 0.28;
  float frontPos = u_resolve * 1.5 - 0.25;                 // sweeps past 1.0
  float along = (uv.x * 0.6 + (1.0 - uv.y) * 0.4);          // diagonal coordinate
  float resolved = smoothstep(frontPos + cellJitter, frontPos + cellJitter - 0.16, along);

  // Scrambled (corrupt) vs clean signal per pixel; onset jolt re-corrupts briefly.
  float t = floor(u_time * 20.0);
  float scramble = hash21(cellId + t * 3.1);
  float corruptAmt = (1.0 - resolved) + u_jolt * 0.5 * hash21(cellId + t);
  corruptAmt = clamp(corruptAmt, 0.0, 1.0);
  float value = mix(signal, scramble, corruptAmt);

  // Screen the value through the halftone dot grid (the dither texture).
  float dots = halftone(fragPx, value, cellSize);

  // --- Compose into the warm palette via the Retint ramp ---------------------
  // Map dot coverage + disc heat to a luminance, then ramp through u_palette so
  // everything lands in the canon (warm dark -> Re-entry Red -> Eclipse Gold ->
  // cream). Keep the ground dominant: most of the frame is near-black dust.
  float heat =
      dots * 0.30                        // base cream-ish dither speckle
    + discBody * (0.34 + u_ignite * 0.26) // disc fills with heat as it ignites
    + rimBand * (0.5 + u_ignite * 0.4);   // the thin burning rim, the gold moment
  // A faint horizon lift so the bottom sits deeper than the sun band.
  heat += (1.0 - uv.y) * 0.05;
  heat = clamp(heat, 0.0, 1.0);

  vec3 col = paletteRamp(heat * heat * 0.92);

  // Reserve a true Eclipse Gold burn for the thin rim only (the One Sun).
  vec3 gold = u_palette[2];
  col = mix(col, gold, rimBand * 0.7);

  // Vignette toward the warm dark, then organic film grain (the grain constant,
  // thickened by the onset jolt), then dither8 to kill 8-bit banding.
  col *= mix(0.45, 1.0, vignette(uv, 0.95, 0.85));
  col = filmGrain(col, uv, u_time, 0.15 + u_jolt * 0.06);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

const VisualTestGlitch: React.FC<NostalgicCosmosProps> = ({ track, audio, palette, seed }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const sec = frame / fps;

  // Bend the artwork's cool palette toward the canon (Retint at the data level
  // too): warm-dark ground, reserved gold glow, artwork-derived accent.
  const mixed = paletteMix(palette.swatches);

  // The journey clock. depart = the corrupt intro; travel = the resolving front
  // through the drop; arrive = the close. Splits matched to the drop at ~9s/20s.
  const { phase, phaseProgress, arc } = useJourney({ split: [0.45, 0.87] });

  // Energy gates the ignition: the disc/rim only burn once the drop lands (~9s).
  // The intro energy hovers ~0.45–0.6, so the threshold sits ABOVE that — the
  // gold sun moment is reserved for the sustained peak (energy 0.75+ after 9s),
  // never the quiet, corrupt intro. A small time gate guarantees no disc pre-drop.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const dropGate = interpolate(sec, [8.4, 9.4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ignite =
    dropGate *
    interpolate(energy, [0.62, 0.82], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // The resolution front rides the eased arc, but held back hard in the depart
  // phase so the intro stays visibly scrambled (corruption), then sweeps the
  // frame into order through the drop and arrives fully resolved.
  const resolve = interpolate(arc, [0, 0.35, 1], [0, 0.12, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Per-onset corruption jolt: a deterministic value-noise read on the onset
  // flash so transients re-corrupt the frame briefly (the glitch tearing).
  const onsetFlash = useNearestOnset(audio.onsets, sec, fps);
  const jolt = onsetFlash;

  const floatBoost = 1 + energy * 0.8;

  // Close card arrives with the journey's arrive phase.
  const closeArc = phase === "arrive" ? phaseProgress : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: mixed.background || colors.deepField }}>
      {/* Audio: the analysed clip window. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* THE VEHICLE: one GPU shader carrying the whole dither corruption +
          resolution journey, with grain and Retint baked in. */}
      <ShaderLayer
        fragmentShader={GLITCH_FRAG}
        palette={mixed}
        seed={seed % 100000}
        beatGrid={audio.beatGrid}
        beatDecay={3.0}
        energyCurve={audio.energyCurve}
        bassCurve={audio.bassCurve}
        uniforms={{ u_ignite: ignite, u_jolt: jolt, u_resolve: resolve }}
      />

      {/* --- TYPE TIMELINE (all inside the safe inset) ----------------------- */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* 0.5–3.4s: the artist as the opening brand-led mark (over the corrupt
            intro). */}
        <TimedBlock
          inSec={T.brandIn}
          outSec={T.brandOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 40 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={84}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* 9.2–12.4s: Artist — Title resolves in on the drop (the only sanctioned
            em dash). */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{
            bottom: SAFE_BOTTOM + 150,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <FloatingType
            variant="trackLine"
            track={track}
            fontSize={46}
            drift={6 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* 12.6–16.6s: Discovered date (tabular Oxanium). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 100, left: MARGIN_X, position: "absolute" }}
        >
          <FloatingType
            variant="meta"
            track={track}
            fontSize={32}
            drift={5 * floatBoost}
            driftPhase={0.7}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* Final beats: the close card — tagline + selector signature (the one
            permitted gold type moment, alongside the eclipse rim). */}
        <CloseCard
          arc={closeArc}
          floatBoost={floatBoost}
          style={{
            bottom: SAFE_BOTTOM + 220,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// --- Helpers ---------------------------------------------------------------

/**
 * A deterministic 0..1 onset flash: 1 at the nearest onset, decaying linearly
 * over `windowMs`. Mirrors useOnset but inlined so the jolt uniform stays a pure
 * function of (sec, onsets). Frame-derived; no random, no wall clock.
 */
const useNearestOnset = (onsets: number[], sec: number, _fps: number): number => {
  const nowMs = sec * 1000;
  const windowMs = 160;
  let flash = 0;
  for (const o of onsets) {
    const dt = nowMs - o;
    if (dt >= 0 && dt < windowMs) {
      flash = Math.max(flash, 1 - dt / windowMs);
    }
  }
  return flash;
};

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Returns null outside the window so layout is cheap.
 */
const TimedBlock: React.FC<{
  inSec: number;
  outSec: number;
  fps: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ inSec, outSec, fps, style, children }) => {
  const frame = useCurrentFrame();
  const sec = frame / fps;
  const fade = 0.6;

  const opacity = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rise = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [26, 0, 0, -18], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return <div style={{ ...style, opacity, transform: `translateY(${rise}px)` }}>{children}</div>;
};

export default VisualTestGlitch;
