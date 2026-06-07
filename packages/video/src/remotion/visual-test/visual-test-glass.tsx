// "VisualTestGlass" — the GLASS travelling vehicle scene for
// Bugwell — Everything In Its Right Place (171 BPM, a cool-palette d&b flip).
//
// CONCEPT (journey + texture family): a GLASS journey that travels from the
// still, breathy intro through the 9s drop and out to the close card. The whole
// frame is a molten flamefold (texture family: FLUENT — liquid gradients with
// motion in the surface; moodboard liquid-glass-flamefold-warm.webp +
// grain-liquid-heat.jpg) seen THROUGH a curtain of vertical fluted glass ribs
// that genuinely refract the flow. One Eclipse Gold SUN is baked into the field
// as the single light source: a low warm disc that the glass bends and crests
// at the drop (The One Sun Rule). The cool artwork blues survive ONLY as a
// minor counter-accent pooled in the deep glass troughs (the Retint Rule) —
// never a field. No towers: this tune wants drift and surface, not the ground.
//
// One Vehicle Rule: GLASS. Everything (the sun, the type, the cool counter-tint)
// is subordinate to the refractive curtain sweeping across the journey arc.
//
// The bar is "rendered, not HTML": the entire visual is a single GPU fragment
// shader through <ShaderLayer> (Retint ramp + organic film grain + dither baked
// in at the GPU level per README). Only the type timeline + the mandatory close
// card sit as DOM above it, under a thin CSS <Grain> so the type itself never
// looks plasticky.
//
// Determinism: every value is frame-, seed- or curve-derived (u_time = frame/fps;
// audio via the curve hooks inside ShaderLayer; useJourney is frame-derived). No
// Math.random / Date.now. GPU renders via ANGLE/Metal (pass --gl=angle).

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
  Grain,
  ShaderLayer,
  useEnergy,
  useJourney,
  withAlpha,
} from "../cosmos";

// Safe margins (1080x1920): keep all type inside this inset.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds. The drop sits at ~9s in this clip's analysis window;
// the type rides the journey around it. The close card opens with the arrive
// phase (driven by useJourney), not a hard-coded second.
const T = {
  artistIn: 0.5,
  artistOut: 4.2,
  metaIn: 13.8,
  metaOut: 16.6,
  trackIn: 9.0, // the drop: the track line lands as the curtain breaks
  trackOut: 13.6,
};

// The glass + flamefold + sun fragment shader. A domain-warped fbm flow field
// (the molten flamefold) carries one baked Eclipse-Gold SUN disc low in the
// frame; the field is then sampled THROUGH a vertical fluted-glass lattice that
// refracts it (real screen-space bend per rib), throws thin cream/gold specular
// crests on rib edges, and pools a faint COOL counter-tint in the deep troughs
// (the only blue, the Retint Rule's "minor counter-accent"). The lattice sweeps
// across the journey arc (the travel). Grain + dither are baked in (GPU-level).
//
// Uniform contract (custom, declared below): u_arc drives the curtain sweep and
// the intro->drop intensity; u_drop is a 0..1 gate that opens the refraction and
// the sun crest at the drop; u_cool is the cool-counter-accent vec3; u_ribs is
// the rib count. u_bass / u_energy / u_beatPulse arrive from ShaderLayer's hooks.
const GLASS_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

uniform float u_ribs;     // rib count across the frame
uniform float u_arc;      // 0..1 eased journey arc (the travel)
uniform float u_drop;     // 0..1 gate: opens refraction + sun crest at the drop
uniform vec3  u_cool;     // cool counter-accent (artwork blue), troughs only

// The molten flamefold backdrop carrying ONE baked Eclipse-Gold sun disc.
// Sampled at an already-refracted uv so the glass ribs bend the whole field,
// the sun included. Warm dark stays dominant; the ramp only climbs into
// gold/cream where the fold crests or the sun sits.
vec3 flamefold(vec2 uv, float flowLive, float dropLive) {
  vec2 q = (uv - 0.5) * vec2(1.0, 1.45);
  // Slow molten drift; energy speeds it. Seed offsets the field per track.
  float ts = u_time * (0.04 + 0.07 * flowLive) + u_seed * 3.17;
  // Two fbm passes: the first warps the domain of the second -> the liquid S-fold.
  float warp = fbm(q * 1.25 + vec2(ts * 0.55, ts * 0.22), 4);
  float fold = fbm(q * 2.0 + warp * 0.95 + vec2(-ts * 0.3, ts * 0.5), 6);
  // A gentle diagonal S-bias for liquid flow, kept low so the field stays
  // balanced rather than pooling all the heat on one side.
  float sBias = 0.5 + 0.5 * sin((uv.x * 1.1 + uv.y * 0.8 + warp * 1.2) * 3.14159);
  float t = mix(fold, sBias, 0.3);
  // WARM DARK GROUND dominant: square the field to crush most of it toward black,
  // with only a faint low-center bloom and horizon lift so heat reads as light
  // through the dark, not a bright wall. Gold/cream only where the field crests.
  t = t * t;
  float bloom = (1.0 - smoothstep(0.0, 0.75, distance(uv, vec2(0.5, 0.46)))) * 0.18;
  t = t * 0.8 + bloom + (1.0 - uv.y) * 0.05;

  // The ONE SUN: a burning Eclipse limb low-center, seated on the dark field. A
  // thin bright RIM is the gold light; the interior stays the warm-dark occluded
  // disc (the cover's eclipse). Capped into the gold band (not cream) so it reads
  // as a burning limb, not a grey ring. It CRESTS at the drop (u_drop opens it).
  vec2 sunPos = vec2(0.5, 0.46);
  float sd = distance((uv - sunPos) * vec2(1.0, 1.12), vec2(0.0));
  float sunR = 0.15 + 0.014 * u_bass;
  // Narrow burning rim (the limb). Pull the interior DOWN toward dark (the
  // eclipse occlusion) so the only lit thing is the edge.
  float rim = smoothstep(sunR + 0.022, sunR + 0.002, sd) * smoothstep(sunR - 0.055, sunR - 0.006, sd);
  float occl = smoothstep(sunR, sunR * 0.5, sd); // 1 inside the disc, fades at rim
  float halo = smoothstep(sunR + 0.14, sunR + 0.01, sd) * 0.1; // faint outer glow
  t -= occl * t * 0.6; // darken the eclipse interior
  float sunHeat = (rim + halo) * (0.32 + 0.68 * dropLive) * (0.85 + 0.4 * u_beatPulse);
  // Cap the rim into the GOLD stop band (~0.66..0.85 of the ramp), never cream.
  t = mix(t, clamp(0.66 + sunHeat * 0.18, 0.0, 0.86), clamp(sunHeat, 0.0, 1.0));

  vec3 col = paletteRamp(clamp(t, 0.0, 1.0));

  // Cool counter-accent: only where the field sits DARK (the troughs / shadows),
  // and never near the sun. A whisper of the artwork blue so the cool track reads
  // without ever becoming a cool field (the Retint Rule).
  float shadow = smoothstep(0.22, 0.02, t) * (1.0 - smoothstep(0.0, sunR + 0.12, sd));
  col = mix(col, mix(col, u_cool, 0.5), shadow * 0.22);
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  // Live audio folded into the gates so the curtain is calm in the intro and
  // snaps alive on the drop.
  float flowLive = u_energy;
  float dropLive = clamp(u_drop + u_bass * 0.3, 0.0, 1.0);

  // --- The rib lattice (the GLASS curtain) --------------------------------
  // Sweep horizontally across the journey arc (the travel). A bass breath widens
  // the effective rib period so the curtain pulses with the low end.
  float breath = 1.0 + 0.12 * u_bass * dropLive;
  float ribX = uv.x * u_ribs / breath + u_arc * u_ribs * 0.9;
  float ribId = floor(ribX);
  float ribF = fract(ribX);          // 0..1 across one rib
  float centered = ribF - 0.5;       // -0.5..0.5, 0 at rib center

  // Per-rib jitter + a slow vertical wobble so ribs read molten, not ruled.
  float jitter = (hash21(vec2(ribId, 7.0 + u_seed)) - 0.5);
  float wobble = sin(uv.y * 2.3 + ribId * 0.7 + u_time * 0.5) * 0.18;

  // Each rib is a half-cylinder lens: thickness peaks at center, slope (the
  // refracting normal) peaks at the edges. The field bends hardest at rib edges
  // and runs straight through the center — the fluted-glass read.
  float xp = clamp(centered * 2.0, -1.0, 1.0);
  float lens = sqrt(max(0.0, 1.0 - xp * xp));
  float slope = xp;
  // Refraction OPENS at the drop: near-flat glass in the breathy intro, wet bend
  // on the drop. Honours the energy curve's long quiet head.
  float refrBase = mix(0.045, 0.2, dropLive);
  float refrAmt = refrBase * (0.7 + 0.4 * u_bass) / max(2.0, u_ribs);

  // --- Screen-space refraction (chromatic split at rib edges) -------------
  vec2 baseOff = vec2(slope * refrAmt + jitter * refrAmt * 0.4, wobble * refrAmt * 0.6);
  float ca = refrAmt * 0.5 * dropLive;
  vec3 col;
  col.r = flamefold(uv + baseOff + vec2(ca, 0.0), flowLive, dropLive).r;
  col.g = flamefold(uv + baseOff, flowLive, dropLive).g;
  col.b = flamefold(uv + baseOff - vec2(ca, 0.0), flowLive, dropLive).b;

  // Wet gel falloff: rib center reads brighter/cleaner, edges sink darker.
  float gel = mix(0.74, 1.1, lens);
  col *= gel;

  // --- Specular crests on rib edges (the one gold trim, edge-bound) -------
  float lit = smoothstep(0.02, 0.16, ribF) * smoothstep(0.34, 0.18, ribF);
  float litFar = smoothstep(0.66, 0.82, ribF) * smoothstep(0.98, 0.84, ribF);
  float glint = 0.45 + 0.55 * smoothstep(0.35, 0.85,
    fbm(vec2(uv.y * 4.5 + ribId * 1.3, ribId * 0.7 + u_time * 0.25 + u_seed), 3));
  float specGain = (0.5 + 0.5 * flowLive) * (1.0 + 0.6 * u_beatPulse) * (0.4 + 0.7 * dropLive);
  float spec = (lit * 1.0 + litFar * 0.32) * glint * specGain;
  vec3 specCol = mix(u_palette[3], u_palette[2], 0.45); // cream core, gold inner
  col += spec * 0.7 * specCol;

  // Crisp dark seam in the trough between ribs (the striation lines).
  float seam = 1.0 - smoothstep(0.0, 0.07, abs(centered) - 0.43);
  col *= 1.0 - seam * 0.5;

  // A faint full-curtain sheen sweeping with the travel, tying ribs into a sheet.
  float sheen = smoothstep(0.16, 0.0, abs(fract(uv.x * 0.6 - u_arc) - 0.5));
  col += sheen * 0.05 * (0.6 + 0.4 * flowLive) * u_palette[3];

  // --- Finish: vignette, organic grain, dither (GPU-level brand law) ------
  col *= mix(0.58, 1.0, vignette(uv, 1.12, 0.9));
  col = filmGrain(col, uv, u_time, 0.12);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

const hexToVec3 = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const VisualTestGlass: React.FC<NostalgicCosmosProps> = ({ track, audio, palette, seed }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const sec = frame / fps;

  // Shared narrative clock: a quick lift-off, a long travel, a settled arrival.
  const { arc, phase, phaseProgress } = useJourney({ split: [0.12, 0.84] });

  // Overall energy for the global float; the shader reads the curves itself.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const floatBoost = 1 + energy * 0.7;

  // The DROP gate: the analysed energy lifts hard around 9s in this window. Open
  // the glass refraction + sun crest there, frame-derived (deterministic).
  const drop = interpolate(sec, [8.4, 9.4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Cool counter-accent from the artwork (Retint Rule: blue survives only as a
  // minor trough tint). Prefer a brighter swatch so it reads in shadow.
  const coolHex = palette.swatches?.[0] ?? palette.accent ?? "#3d6baf";

  const shaderUniforms = {
    u_arc: arc,
    u_cool: hexToVec3(coolHex),
    u_drop: drop,
    u_ribs: 11,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip window. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* THE VEHICLE: a single GPU fragment shader — molten flamefold + baked
          Eclipse sun, refracted through the fluted-glass curtain, swept across
          the journey arc. Warm canon ramp; gold reserved for the sun + rib
          crests. Grain + dither baked in at the GPU level. */}
      <ShaderLayer
        fragmentShader={GLASS_FRAG}
        seed={seed % 100000}
        beatGrid={audio.beatGrid}
        beatDecay={3.0}
        energyCurve={audio.energyCurve}
        bassCurve={audio.bassCurve}
        uniforms={shaderUniforms}
      />

      {/* --- TYPE TIMELINE (inside the safe inset) ------------------------- */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* Intro: the artist as the brand-led opening mark, over the calm glass. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 30 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={84}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* The drop: Artist — Title lands as the curtain breaks open. */}
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

        {/* Discovered date (tabular Oxanium). */}
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

        {/* The mandatory close card, revealed by the journey's ARRIVE phase. The
            one permitted gold type moment lives here (the selector signature). */}
        <CloseCard
          arc={phase === "arrive" ? phaseProgress : 0}
          floatBoost={floatBoost}
          style={{
            bottom: SAFE_BOTTOM + 210,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        />
      </AbsoluteFill>

      {/* A whisper of CSS grain over the DOM type so the wordmark never looks
          plasticky against the rendered field (the shader has its own grain). */}
      <Grain
        opacity={0.07}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* Faint cinematic vignette to seat the type in the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 44%,
            ${withAlpha(colors.deepField, 0)} 58%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived.
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

export default VisualTestGlass;
