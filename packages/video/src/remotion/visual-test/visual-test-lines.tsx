// "VisualTestLines" — the LINES vehicle, authored for Bugwell — Everything In
// Its Right Place (trackId 0mK92Hp80kOOhn086qcDgZ).
//
// CONCEPT (lines vehicle, fluent texture family). A field of horizontal contour
// ridges — the Unknown Pleasures waveform-as-terrain motif (moodboard:
// waveform-ridge, contour-eclipse-lines) — rendered on the GPU as a flowing,
// grainy heat-haze landscape that the camera travels across. The journey
// departs from a flat cool dawn, builds through rising amber ridges as the 9s
// drop lands, and arrives at a single Eclipse Gold crest under the close card.
//
// RETINT RULE: the artwork is cool (accent #3d6baf broadcast blue, glow
// #72191c oxblood). Steal the technique (line-displacement terrain) and recolor
// to canon: warm-dark Deep Field ground, Starlight Cream ridges, ONE Eclipse
// Gold crest as the single light source (The One Sun Rule), blue surviving only
// as a thin cool counter-glow pooled in the troughs.
//
// "Rendered, not HTML": the whole field is one fragment shader (ShaderLayer on
// ANGLE/Metal — pass --gl=angle). Smooth gradients are dither8'd to kill 8-bit
// banding; grain is organic emulsion grain baked at the GPU level (GLSL.filmGrain),
// so NO CSS <Grain> stacks over the shader (README: bake grain into the shader).
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, useJourney,
// the audio.* curves through the hooks, remotion has no Math.random here).

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
  useBass,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// Safe margins (README authoring rule): keep all type inside this inset so it
// never crowds the 1080x1920 edges or gets cropped by platform chrome.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds. The clip opens AT the drop (startMs 9950), so energy
// is high throughout; the type rides that. The journey arc carries the spatial
// travel; these gate the type timeline.
const T = {
  artistIn: 0.4,
  artistOut: 3.4,
  closeIn: 16.4,
  metaIn: 7.0,
  metaOut: 10.6,
  trackIn: 3.2,
  trackOut: 7.6,
};

// The travelling ridge field. A stack of horizontal contour lines displaced
// upward by an fbm height field; the field scrolls with u_progress so the
// terrain reads as travelling toward the camera. Each ridge is drawn as a thin
// luminous band (a smoothstep around the ridge's screen-Y), retinted through the
// canon ramp, with ONE crest catching Eclipse Gold. Warm-dark ground dominates;
// blue survives only as a cool counter-glow pooled in the low troughs.
const RIDGE_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

uniform float u_arc;        // eased journey arc 0..1 (spatial travel)
uniform float u_rise;       // 0..1, how far the ridges have risen (depart->arrive)
uniform float u_goldLine;   // 0..1 fractional screen-Y of the gold crest
uniform float u_goldGlow;   // 0..1 brightness of the gold crest (rides bass/beat)
uniform vec3  u_coolGlow;   // the retinted blue counter-glow color

// Height of the ridge terrain at horizontal x and depth row, 0..1. Two fbm
// octaves summed with a travelling offset; the audio energy lifts the whole
// field. Higher rows (further back) ride higher so the stack recedes.
float ridgeHeight(float x, float depth) {
  vec2 p = vec2(x * 3.2, depth * 2.4 - u_progress * 1.35);
  float h = fbm(p, 5);
  // A second, finer band keeps crests from feeling smooth/SaaS.
  h += 0.18 * fbm(p * 2.7 + 7.3, 3);
  return h;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // Flip so y=0 is the bottom of the frame (terrain grows up from the floor).
  float y = 1.0 - uv.y;

  // The ridge stack lives in the lower ~78% of the frame; the top is open sky.
  // Map screen-y into a "terrain band" coordinate.
  float horizon = 0.82;
  float band = y / horizon;            // 0 at floor, 1 at horizon
  band = clamp(band, 0.0, 1.0);

  // Number of ridges and the per-ridge accumulation. We march a set of contour
  // rows from front (depth 0) to back (depth 1); each contributes a thin lit
  // band where the terrain surface crosses this pixel's screen height.
  const int ROWS = 46;
  float ink = 0.0;        // accumulated cream ridge ink
  float gold = 0.0;       // gold crest accumulation (the One Sun line)
  float cool = 0.0;       // cool counter-glow pooled in troughs

  // Amplitude of the displacement, eased up over the journey (flat dawn -> peaks).
  float amp = mix(0.05, 0.34, u_rise);

  for (int i = 0; i < 46; i++) {
    float depth = float(i) / float(ROWS - 1);
    // Base screen-Y for this row: rows stack from the floor up toward horizon,
    // receding. Far rows compress near the horizon (perspective-ish).
    float baseY = pow(depth, 1.25) * horizon;
    float h = ridgeHeight(uv.x, depth);
    float surfaceY = baseY + h * amp * (0.45 + depth * 0.55);

    // Distance from this pixel to the ridge line; a tight smoothstep draws the
    // contour as a luminous stroke. Far ridges are thinner + dimmer (depth cue).
    float thickness = mix(0.0065, 0.0016, depth);
    float line = smoothstep(thickness, 0.0, abs(y - surfaceY));
    float fade = mix(1.0, 0.32, depth);   // recede into the dark
    ink += line * fade;

    // Cool counter-glow: a thin line of the artwork blue tucked right under each
    // ridge crest (a minor counter-accent, NOT a field — Warm Dark Rule). Tight
    // band + low weight so blue only kisses the immediate underside of a crest.
    float under = smoothstep(0.012, 0.0, y - surfaceY) * step(y, surfaceY);
    cool += under * fade * 0.05;

    // The ONE gold crest: the single ridge whose base sits nearest u_goldLine
    // catches Eclipse Gold (One Sun Rule). Weighted by proximity so exactly one
    // line lights, with a soft falloff to its neighbours.
    float pick = smoothstep(0.06, 0.0, abs(baseY - u_goldLine));
    gold += line * pick;
  }

  ink = clamp(ink, 0.0, 1.0);
  gold = clamp(gold, 0.0, 1.0);
  cool = clamp(cool, 0.0, 1.0);

  // --- Compose the warm-dark ground -----------------------------------------
  // The ground is a warm near-black always (Warm Dark Rule): Deep Field, lifted
  // only slightly toward a warm ember at the very floor. We do NOT run the low
  // end of the field through the red stop (that produced a cold purple sky);
  // instead the warmth is an explicit Eclipse-Gold ember, kept faint and low.
  vec3 deepDark = u_palette[0];                         // warm near-black ground
  vec3 ember = mix(deepDark, u_palette[1], 0.5);        // ground -> re-entry red, warm
  float floorWarm = (1.0 - band);
  floorWarm = floorWarm * floorWarm * 0.5;              // heat hugs the floor only
  vec3 col = mix(deepDark, ember, floorWarm);

  // A warm gold bloom hugging the gold crest line (real light spilling off it),
  // additive so it never cools the ground.
  float crestBloom = smoothstep(0.42, 0.0, abs(y - u_goldLine)) * u_goldGlow;
  col += u_palette[2] * crestBloom * 0.085;

  // Cream ridges: ink stays cream (the system ink), never gold.
  vec3 creamInk = mix(u_palette[3], u_palette[2], 0.10); // cream, faint warm lean
  col = mix(col, creamInk, ink * 0.9);

  // Cool counter-glow in the troughs (the retinted artwork blue): the ONLY cool
  // note, pooled low under the crests so the blue survives as atmosphere.
  col += u_coolGlow * cool;

  // The One Sun: the gold crest. Eclipse Gold, additively, scaled by its glow so
  // it swells on the bass/beat. Kept to one line so gold stays ~10% of frame.
  vec3 goldCol = u_palette[2]; // Eclipse Gold stop
  col += goldCol * gold * (0.55 + u_goldGlow * 0.85);
  // A soft halo just around the gold crest line for real light bleed.
  float halo = smoothstep(0.09, 0.0, abs(y - u_goldLine));
  col += goldCol * halo * u_goldGlow * 0.10;

  // Dim the open sky toward the warm dark so the top stays inky and the type
  // has a clean bed; the terrain owns the lower frame.
  float skyDim = smoothstep(horizon * 0.78, 1.0, y);
  col *= mix(1.0, 0.55, skyDim);

  col *= mix(0.42, 1.0, vignette(uv, 1.02, 0.9));

  // Organic emulsion grain at the GPU level (NOT a CSS Grain over this layer).
  col = filmGrain(col, uv, u_time, 0.15 + u_beatPulse * 0.05);

  // Dither to 8-bit to break gradient banding on the smooth ground.
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

const VisualTestLines: React.FC<NostalgicCosmosProps> = ({ track, audio, palette, seed }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // Narrative clock: the lines field travels along this arc. A quick depart, a
  // long travel through the drop, a settled arrive into the close card.
  const { arc, phase, phaseProgress } = useJourney({ split: [0.12, 0.82] });

  // Audio-reactive scalars.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const onset = useOnset(audio.onsets, 150);

  // The ridges rise from a flat dawn to full terrain as the journey + energy
  // build. Eased by the arc so the lift reads as travel, not a jump.
  const rise = Math.min(1, arc * 0.7 + energy * 0.5);

  // The gold crest sits roughly a third up the frame and lifts gently over the
  // clip (the sun on the horizon rising). Frame-derived, deterministic.
  const goldLine = interpolate(sec, [0, durationInFrames / fps], [0.3, 0.42], {
    extrapolateRight: "clamp",
  });

  // The gold crest swells with the low end and snaps on transients: the One Sun
  // breathing. Kept modest so gold stays a thin lit line, ~10% of the frame.
  const goldGlow = Math.min(1, 0.32 + bass * 0.5 + onset * 0.3);

  // The retinted cool counter-glow: the artwork's blue accent, pulled toward a
  // dim cool tone so it survives only as atmosphere in the troughs (Retint Rule).
  const coolHex = palette.accent || "#3d6baf";
  const cool = hexToVec(withSolid(coolHex), 0.45);

  // Type float lifts a touch with energy.
  const floatBoost = 1 + energy * 0.7;

  // The close card reveals on the journey's arrive phase (clean 0..1).
  const closeArc = phase === "arrive" ? phaseProgress : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed window, trimmed via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* The lines vehicle: the whole travelling ridge field, rendered on GPU.
          Palette is the track's CosmosPalette so the ramp bends to the artwork
          while keeping the warm-dark -> cream shape; gold stays reserved. */}
      <ShaderLayer
        fragmentShader={RIDGE_FRAG}
        seed={seed % 100000}
        beatGrid={audio.beatGrid}
        beatDecay={3.0}
        energyCurve={audio.energyCurve}
        bassCurve={audio.bassCurve}
        paletteStops={[
          palette.background || colors.deepField,
          colors.reentryRed,
          colors.eclipseGold,
          colors.starlightCream,
        ]}
        uniforms={{
          u_arc: arc,
          u_coolGlow: cool,
          u_goldGlow: goldGlow,
          u_goldLine: goldLine,
          u_rise: rise,
        }}
      />

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* 0–3.4s: the artist as the brand-led opening mark + discovery date. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 30 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={82}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
          <div style={{ height: 16 }} />
          <FloatingType
            variant="meta"
            track={track}
            fontSize={24}
            drift={5 * floatBoost}
            driftPhase={1.1}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* 3.2–7.6s: Artist — Title (the only sanctioned em dash). Sits above the
            ridge crests so it never collides with the brightest terrain. */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{
            bottom: SAFE_BOTTOM + 170,
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

        {/* 7–10.6s: Discovered date (tabular Oxanium). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 120, left: MARGIN_X, position: "absolute" }}
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

        {/* Final beats: the close card, revealed on the journey's arrive phase.
            The one permitted gold TYPE moment lives in its signature. */}
        <CloseCard
          arc={closeArc}
          floatBoost={floatBoost}
          style={{
            bottom: SAFE_BOTTOM + 200,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        />
      </AbsoluteFill>

      {/* A faint cinematic vignette in CSS to seat the type over the shader and
          deepen the corners (the shader already vignettes the field; this hugs
          the type). No CSS Grain here — grain is baked into the shader. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(135% 105% at 50% 42%,
            ${withAlpha(colors.deepField, 0)} 58%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

// --- Helpers ---------------------------------------------------------------

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Mounts always (cheap) so layout is stable.
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
  const riseY = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [26, 0, 0, -18], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return <div style={{ ...style, opacity, transform: `translateY(${riseY}px)` }}>{children}</div>;
};

/** Parse a hex into a normalized [r,g,b] vec3, scaled by `scale` for a dimmer tone. */
const hexToVec = (hex: string, scale: number): [number, number, number] => {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r * scale, g * scale, b * scale];
};

/** Ensure a 6-digit hex (expand #rgb), falling back to a canon blue on garbage. */
const withSolid = (hex: string): string => {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
    return "#3d6baf";
  }
  return `#${h}`;
};

export default VisualTestLines;
