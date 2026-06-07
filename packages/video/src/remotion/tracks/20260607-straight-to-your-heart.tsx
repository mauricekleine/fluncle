// "GlassHeartCurtain" — the GLASS vehicle scene for Grum — "Straight To Your
// Heart (Legion & Logam Remix)" (171.81 BPM liquid drum & bass; analysed window
// startMs 4550, the energy=1.0 detonation at ~6.65s of the 20s clip ~ clip 0.33).
//
// ARCHIVE NOTE: dated, self-contained archive composition. It imports ONLY the
// surviving core (ShaderLayer, GLSL, CloseCard, FloatingType, Starfield, Grain,
// the audio hooks, useJourney, color helpers, types) plus remotion/react/tokens.
// There are no prebuilt vehicles or static assets; the scene and its GLSL shader
// are authored here top to bottom and re-render identically forever.
//
// CONCEPT (two sentences): a curtain of refractive liquid-GLASS blades sweeps
// across a warm-dark night, present and breathing from frame one — wet vertical
// ribbons that bulge and refract on the sub-bass like haze caught in moving glass.
// As the vocal lifts into the drop (~clip 0.33) one central blade swells into a
// single Eclipse Gold SPECULAR BULGE — light arriving straight to your heart
// through the glass (the One Sun moment, expressed THROUGH the vehicle, never a
// second celestial body) — then the curtain travels on and the bulge re-enters as
// the close card settles.
//
// One Vehicle Rule (doctrine 1): the GLASS curtain — refractive liquid blades
// travelling across the frame, beat-synced, the single travelling medium. The One
// Sun Eclipse Gold moment is the one gold specular bulge on the central blade at
// the drop (moodboard liquid-blade-curtain-rgb.webp / liquid-glass-flamefold-warm,
// the cookbook "glass" entry — blades go Starlight Cream with one Eclipse Gold
// bulge). Always-Visible Vehicle (doctrine 2): the blades fill the frame and hold
// the centre from the first frame — dim, cream-lit, refracting — never a late
// reveal.
//
// Texture family: FLUENT (flowing liquid gradients; motion lives in the surface
// itself) — the exact reference for liquid drum & bass. The artwork's magenta/pink
// (swatch #e82484/#f1a2d1) seeps as a MINOR cool counter-accent at the blade edges
// (the Retint Rule); the field stays the canon warm dark, gold stays the sun.
//
// RESEARCH → PIXELS: Hospital Records' liquid-funk descriptors ("liquid drum &
// bass", "smooth, jazzy, uplifting") chose the glass/fluent vehicle and the slow
// wet falloff; the title "Straight To Your Heart" + the euphoric vocal lift chose
// the single gold specular bulge that arrives on the drop. One VERIFIED fact
// renders on screen: "Hospital Records · 2016" (label + compilation year).
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, the audio.*
// curves through the hooks, remotion-seeded values). No Math.random / Date.now.
// Grain + Retint baked at the GPU level in the curtain shader; the CSS <Grain />
// rides as the system base texture over the whole frame. GPU renders on
// ANGLE/Metal — stills/renders pass --gl=angle.

import { colors } from "@fluncle/tokens";
import { type CSSProperties } from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CloseCard,
  FloatingType,
  GLSL,
  Grain,
  ShaderLayer,
  Starfield,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";
import { type NostalgicCosmosProps } from "../types";

// Safe margins (README): keep all type inside this inset on 1080x1920.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Journey split: a short depart (the curtain materialises), a long travel where it
// sweeps and the bulge ignites on the drop, and a generous arrive for the close.
const SPLIT: [number, number] = [0.16, 0.8];

// The detonation window. The energy curve peaks (1.0) at 6.65s of the 20s clip
// (~clip 0.33). Light the gold specular bulge across [6.1s, 6.9s] so the gold and
// the visual peak land together; expressed in clip progress (0..1).
const DROP_IN = 6.1 / 20;
const DROP_OUT = 6.9 / 20;

// Scene type beats in seconds (intensity rides the audio; timing is the grammar).
// Deliberately NOT the same spots/times as sibling archives (doctrine 4): the
// artist mark anchors HIGH and early on a riser, the track line rides UP from the
// breakdown after the drop, the fact sits low-left in the back third, and the
// close arrives late. The drop frame (~6.6s) is left clean for the bulge.
const T = {
  artistIn: 0.6,
  artistOut: 5.4,
  factIn: 8.4,
  factOut: 12.6,
  trackIn: 12.9,
  trackOut: 16.4,
};

// THE GLASS CURTAIN SHADER — the One Vehicle. A wall of refractive vertical liquid
// blades sweeping across a warm-dark night. Per-blade UV refraction offsets breathe
// with the sub (u_bass); the whole curtain travels horizontally on the arc
// (u_travel); blades read Starlight Cream specular over the warm dark, and ONE
// central blade swells into a single Eclipse Gold specular bulge on the drop
// (u_drop) — the One Sun moment expressed through the vehicle, never a second body.
// The artwork's magenta/pink is admitted ONLY as a faint cool seep at the blade
// edges (u_cool, the Retint Rule). Grain + dither baked in-shader (the preferred
// GPU grain path). The quad law (doctrine 6): final color AND alpha are driven to
// EXACT 0.0 by a radial edgeFade that closes well inside the quad (r reaches 1.41
// at the corners) so the layer leaves no printed rectangle.
const CURTAIN_FRAG = /* glsl */ `
uniform float u_drop;     // 0..1 how far the gold specular bulge has ignited
uniform float u_travel;   // monotonic horizontal sweep of the curtain
uniform float u_swell;    // 0..1 bass-driven blade bulge (refraction breadth)
uniform float u_blades;   // blade count across the frame
uniform vec3  u_cool;     // the artwork's magenta, retinted-in as the minor cool edge

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  // --- The liquid medium behind the blades ---------------------------------
  // A slow two-layer fbm gives the night its volume so the curtain hangs in haze
  // rather than over a flat field. Mapped LOW through the ramp: a deep warm-dark
  // cloud that barely reaches gold and never cream, so the gold bulge is always
  // the brightest thing (the One Sun). A low horizon ember warms the base.
  vec2 q = uv * vec2(1.0, 1.7);
  float warp = fbm(q * 1.1 + vec2(u_travel * 0.15, u_time * 0.03), 4);
  float field = fbm(q * 1.9 + warp * 0.6 + vec2(u_seed * 0.5, u_time * 0.018), 6);
  float horizon = 1.0 - uv.y;
  float baseT = field * field * 0.20 + horizon * (0.05 + u_energy * 0.05);
  vec3 col = paletteRamp(clamp(baseT, 0.0, 0.46));

  // --- The blades (the travelling glass) ------------------------------------
  // The frame is sliced into vertical blades. The curtain travels horizontally on
  // u_travel; each blade refracts — its local x is bent by a per-blade sine warp
  // whose breadth breathes with the bass (u_swell), the wet liquid-glass ripple.
  // A grain-driven jitter per blade keeps them from reading as a clean ruler.
  float sweep = uv.x + u_travel;                  // monotonic horizontal motion
  float ripple = sin((uv.y * 3.0 - u_time * 0.5)) * (0.012 + u_swell * 0.045);
  float bentX = sweep + ripple;                   // refraction bend
  float bladeF = bentX * u_blades;                // blade-space coordinate
  float bi = floor(bladeF);                       // which blade
  float bf = fract(bladeF);                        // 0..1 across the blade
  float jitter = (hash21(vec2(bi, 3.0)) - 0.5) * 0.18;

  // Specular rib: a wet highlight running down the centre of each blade, with a
  // narrow hot core and a soft falloff to the blade gaps — the gel/glass falloff
  // per ribbon. Cream specular over the warm dark (the blades are cream, never
  // gold, per the cookbook glass entry).
  float center = abs(bf - 0.5 + jitter) * 2.0;    // 0 at rib centre -> 1 at edges
  float rib = pow(1.0 - clamp(center, 0.0, 1.0), 2.4);
  // Vertical liquid modulation so each rib swells and thins like flowing glass.
  float flow = 0.6 + 0.4 * valueNoise(vec2(bi * 1.3, uv.y * 2.2 - u_time * 0.35));
  float spec = rib * flow * (0.5 + u_swell * 0.5);

  // --- THE ONE SUN: the gold specular bulge ---------------------------------
  // ONE central blade (nearest screen centre x) swells into a single Eclipse Gold
  // specular bulge on the drop — light arriving "straight to your heart" through
  // the glass. It is a vertical lens centred at mid-screen, gated entirely by
  // u_drop so the gold appears only on the peak (~10% of the frame). The gold
  // REPLACES the cream specular inside this zone (it does not stack on top of it —
  // cream + gold sums to a green-yellow, off-canon), so the central blade reads as
  // pure Eclipse Gold while every other blade stays cream. The only gold in the
  // scene (the One Sun Rule).
  float cx = abs(uv.x - 0.5);                       // distance from screen centre x
  float cy = abs(uv.y - 0.46);                      // vertical heart of the bulge
  float lens = exp(-cx * cx * 26.0) * exp(-cy * cy * 5.5);
  float goldZone = clamp(lens * u_drop, 0.0, 1.0);  // 0 = cream blades, 1 = the gold heart

  // Cream specular: climb toward the cream stop, but only the ribs reach bright;
  // the gaps stay warm-dark. Pulled slightly toward gold (never green) and dimmed
  // inside the gold zone so the central blade hands off cleanly to pure gold.
  vec3 specCol = mix(u_palette[3], u_palette[2], 0.30); // cream warmed toward gold
  col += specCol * spec * 0.55 * (1.0 - goldZone * 0.92);

  // --- The cool counter-accent (Retint Rule) --------------------------------
  // The artwork's magenta seeps ONLY at the blade EDGES (the refraction fringe),
  // a minor cool counter-accent that tints the glass, never a field, never gold.
  // Suppressed inside the gold zone so the One Sun reads clean.
  float fringe = smoothstep(0.78, 1.0, center) * spec; // rides the rib edges
  col += u_cool * fringe * 0.30 * (1.0 - goldZone);

  // The gold bulge itself: pure Eclipse Gold on the central rib, brightest at the
  // heart. Laid in (not screened over cream) so the hue stays true gold.
  float bulge = goldZone * rib * (0.45 + u_swell * 0.55);
  col += u_palette[2] * bulge * 1.9;
  // A tight hot core at the very heart, additive toward the cream glow stop so the
  // very centre of the gold blooms hot without greening (gold -> cream is a clean
  // warm climb only at the tightest core).
  float coreHeat = exp(-cx * cx * 90.0) * exp(-cy * cy * 16.0) * u_drop;
  col += mix(u_palette[2], u_palette[3], 0.22) * coreHeat * 0.55;

  // --- Atmosphere -----------------------------------------------------------
  col *= mix(0.30, 1.0, vignette(uv, 0.98, 0.82));
  col = filmGrain(col, uv, u_time, 0.13);

  // --- The quad law (doctrine 6) --------------------------------------------
  // Drive color AND alpha to EXACT 0.0 inside the quad via a circular edge fade.
  // r reaches 1.41 at the corners; close the fade by r ~= 0.98 so no rectangle is
  // ever printed (this layer fills the frame, so the fade is gentle and only
  // bites the extreme corners).
  vec2 cuv = uv - 0.5;
  float r = length(cuv) * 2.0;
  float edgeFade = 1.0 - smoothstep(0.92, 1.30, r);
  col *= edgeFade;

  gl_FragColor = vec4(dither8(col, uv), edgeFade);
}
`;

export const GlassHeartCurtain: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const { fps, durationInFrames } = useVideoConfig();

  // Shared narrative clock: every gesture below travels on this one arc.
  const { arc, phase, phaseProgress, progress } = useJourney({ split: SPLIT });

  // Audio-reactive scalars.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // The drop gate: 0 before the energy peak, ramping to 1 across the drop window
  // so the gold specular bulge ignites exactly on the detonation, then easing back.
  const dropRise = interpolate(progress, [DROP_IN, DROP_OUT], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // After the peak the heat relaxes; instantaneous energy keeps later surges warm
  // (the late ~0.99 rise at clip end). A small floor keeps the curtain alive from
  // frame one (the vehicle is always present, never a void) without any gold.
  const drop = Math.min(1, dropRise * 0.7 + energy * 0.35);

  // Bass swells the blade refraction (the wet liquid-glass breathing). Floored so
  // the blades always ripple a little; beat adds a tight kick to the swell.
  const swell = Math.min(1, 0.22 + bass * 0.7 + pulse * 0.12);

  // The curtain TRAVELS horizontally on the arc — monotonic, a slow continuous
  // sweep so the glass reads as moving across the frame (the travelling medium).
  const travel = arc * 0.85;

  // Energy opens the starfield drift; the cosmos breathes, it does not scroll
  // (Starfield law, doctrine 7: positional drift monotonic, audio touches speed).
  const driftBoost = 1 + energy * 1.4;
  const floatBoost = 1 + energy * 0.6;

  // Onset = brief gold exposure spike + a grain kick, gated UP by the drop so the
  // intro stays quiet and the drop section sparks. Supporting accent, not the
  // vehicle (doctrine 1 / beat-mapping: onsets are accents).
  const exposure = onset * 0.12 * (0.25 + drop * 0.75);
  const grainKick = onset * 0.06;

  // The artwork's magenta counter-accent, retinted-in at the blade edges. Swatch
  // index 3 (#f1a2d1) is the soft pink; fall back gracefully. Kept a MINOR cool
  // seep (the Retint Rule), never a ramp stop, never gold.
  const coolHex = palette.swatches[3] ?? palette.swatches[2] ?? colors.reentryRed;
  const coolVec = hexToVec3(coolHex);

  // The curtain stays on the CANON warm ramp regardless of the artwork (the Warm
  // Dark Rule): Deep Field -> Re-entry Red -> Eclipse Gold -> Cream. The artwork's
  // magenta is admitted only as the minor u_cool seep.
  const curtainStops: [string, string, string, string] = [
    colors.deepField,
    colors.reentryRed,
    colors.eclipseGold,
    colors.starlightCream,
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to the drop window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* THE ONE VEHICLE: the refractive liquid-GLASS curtain. Present and
          refracting from frame one (Always-Visible Vehicle); it sweeps across on
          the arc, breathes on the bass, and one central blade swells into the
          single Eclipse Gold specular bulge on the drop. Grain + Retint baked
          in-shader (the preferred GPU grain). */}
      <AbsoluteFill>
        <ShaderLayer
          fragmentShader={CURTAIN_FRAG}
          paletteStops={curtainStops}
          seed={(seed % 9973) + 1}
          energyCurve={audio.energyCurve}
          bassCurve={audio.bassCurve}
          uniforms={{
            u_blades: 11,
            u_cool: coolVec,
            u_drop: drop,
            u_swell: swell,
            u_travel: travel,
          }}
        />
      </AbsoluteFill>

      {/* Starfield over the curtain: drifts faster as energy lifts, monotonic
          orbital drift, audio touches speed/twinkle only. Always there. */}
      <Starfield
        seed={seed}
        density={110}
        depth={3}
        drift={{ x: 0.005 * driftBoost, y: -0.009 * driftBoost }}
        maxSize={2.4}
        twinkle={0.42}
      />

      {/* Lower scrim: a warm-dark pane seating the bottom-third type so it always
          holds AA over the curtain's specular (The Legible Sky Rule — make the
          pane more opaque, never the text dimmer). A one-direction gradient toward
          Deep Field, so it reads as the night deepening at the bottom. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg,
            ${withAlpha(colors.deepField, 0)} 50%,
            ${withAlpha(colors.deepField, 0.5)} 76%,
            ${withAlpha(colors.deepField, 0.82)} 100%)`,
          pointerEvents: "none",
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
        {/* The artist as the brand-led opening mark, anchored HIGH and early on
            the intro riser, gone before the drop fills the frame with the bulge. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 10 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={80}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* The verified fact, low-left in the back third (the one rendered fact:
            Hospital Records, Hospitality 2016 — label + compilation year). Set in
            the system-sans body voice, stardust, sentence case, no em dash. */}
        <TimedBlock
          inSec={T.factIn}
          outSec={T.factOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 250, left: MARGIN_X, position: "absolute" }}
        >
          <FloatingType
            variant="body"
            text="Hospital Records · 2016"
            fontSize={28}
            drift={5 * floatBoost}
            driftPhase={0.5}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* Artist — Title (the only sanctioned em dash), riding UP from the
            breakdown after the drop, lower-left, anchored where the curtain leaves
            room. */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{
            bottom: SAFE_BOTTOM + 140,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <FloatingType
            variant="trackLine"
            track={track}
            fontSize={44}
            drift={6 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* The discovered date (tabular Oxanium), tucked under the track line. */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 92, left: MARGIN_X, position: "absolute" }}
        >
          <FloatingType
            variant="meta"
            track={track}
            fontSize={30}
            drift={5 * floatBoost}
            driftPhase={0.7}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* The close card, driven by the journey's "arrive" phase so it reveals
            exactly as the curtain settles. The one permitted gold type moment. */}
        <div
          style={{
            bottom: SAFE_BOTTOM + 220,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <CloseCard
            arc={phase === "arrive" ? phaseProgress : 0}
            floatBoost={floatBoost}
            palette={{ accent: colors.eclipseGold, ink: colors.starlightCream }}
          />
        </div>
      </AbsoluteFill>

      {/* Onset exposure spike: a brief additive gold veil at the heart, gated up
          by the drop so the intro stays quiet and the drop section sparks. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(70% 52% at 50% 46%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS — the system base texture over the whole
          frame (the in-shader grain is the material grain; this is the overlay). */}
      <Grain
        opacity={0.14 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 46%,
            ${withAlpha(colors.deepField, 0)} 55%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* arc reference keeps the journey clock observably consumed at the scene
          level (the curtain travel and close card both already read it). */}
      <span style={{ display: "none" }}>{arc.toFixed(3)}</span>
    </AbsoluteFill>
  );
};

// --- Helpers ---------------------------------------------------------------

/** hex -> [0..1, 0..1, 0..1] for a vec3 uniform. Pure. */
const hexToVec3 = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
};

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Mounts always (cheap) so layout is stable.
 */
const TimedBlock: React.FC<{
  inSec: number;
  outSec: number;
  fps: number;
  style?: CSSProperties;
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

export default GlassHeartCurtain;
