import { type CSSProperties } from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colors } from "@fluncle/tokens";
import { withAlpha } from "../color";
import { GLSL } from "../journey/glsl";
import { ShaderLayer } from "../journey/shader-layer";
import { useJourney, type UseJourneyOptions } from "../journey/use-journey";
import { useBass } from "../hooks/use-bass";
import { useBeat } from "../hooks/use-beat";
import { useEnergy } from "../hooks/use-energy";
import { useOnset } from "../hooks/use-onset";
import { CloseCard } from "../journey/close-card";
import { FloatingType } from "../primitives/floating-type";
import { Grain } from "../primitives/grain";
import { Starfield } from "../primitives/starfield";
import { type NostalgicCosmosProps } from "../types";

// "MomentumPortal" — Aktive & Kate McGill — Momentum (UKF, 2025).
//   trackId 0Cbf9Ds2KVwdMWl2zkMiGF — 173 BPM vocal roller.
//
// ARCHIVED, SELF-CONTAINED COMPOSITION (tracks/20260607-momentum). Imports ONLY
// the surviving core (ShaderLayer, GLSL, CloseCard, FloatingType, Starfield,
// Grain, the audio hooks, useJourney, color helpers, types) plus
// remotion/react/@fluncle/tokens. No styled vehicles, no static assets.
//
// VEHICLE (One Vehicle Rule, doctrine 1): FRACTAL — a kaleidoscopic mirror-fold
// PORTAL flying inward. This is the first fractal vehicle in the archive: the
// cookbook flagged fractal + glass as the open diversity slots, and a real-time
// diversity check showed the concurrent batch had already taken BOTH glass slots
// (two sibling glass-curtain scenes), and the prior batch ran lines/orb/orb/
// glitch — so fractal is the genuinely unrepeated vehicle (doctrine 3). The whole
// vehicle is ONE full-frame GPU <ShaderLayer>: GLSL.polarFold folds the frame
// into N mirrored wedges, the folded coords scale inward along the arc so we FLY
// down a tunnel of mirrored rings, and a single gold core sits at the fold center.
// The One Sun moment is that gold core igniting on the drop and blooming outward
// through the rings — NEVER a second celestial body.
//
// TEXTURE FAMILY: fluent (a vortex/portal lean). The folded rings are a flowing,
// engraved liquid-gradient swirl (moodboard: liquid-spectrum-vortex.png as the
// centerpiece portal, posted/the-portal.jpg's aperture core), retinted to canon.
// The artwork is a notably BLUE cover (swatches #0c2d5c / #2f345e / #4882cd) — by
// the Retint Rule and the paletteMix canon lock that cool hue survives only as a
// faint blue tint on the OUTER rings, a minor counter-accent that burns off as
// the gold core blooms. Gold stays the single sun, at the center.
//
// CONCEPT (two sentences): we hover at the mouth of a slowly-turning mirror-fold
// portal over a warm-dark night, a faint cool blue riding the far rings while
// Kate's vocal floats and the 173 sub pulses the fold inward; at the drop (~clip
// 0.52, the energy=1.0 hit at ~10.5s) the gold core at the portal's heart ignites
// and blooms out through the rings (the One Sun, through the vehicle), surging
// again on the late bass crest (~clip 0.89, the bass=1.0 hit at ~17.85s), then the
// tunnel slows and settles as the love-letter close card arrives. The portal
// fills the frame and holds the centre from frame one (Always-Visible Vehicle).
//
// RESEARCH -> PIXELS (doctrine 5):
//   - Kate McGill is a vocalist; with Aktive's roller this is a VOCAL ANTHEM, and
//     the energy curve confirms a sustained roller (no stomp). -> a hovering,
//     turning PORTAL (awe, ascension, "where do we go") over a harder stomper read.
//   - Aktive = dancefloor D&B / jump up, festival-scale (Let It Roll, Rampage).
//     -> the gold core BLOOMS wide through the rings on the drop, a theatrical
//     full-tunnel flood, not a pinpoint flare.
//   - The cover art is blue-led. -> the artwork hue is admitted ONLY as a cool
//     tint on the outer rings (u_cool), retinted to a minor counter-accent,
//     burning off as the gold core blooms (the Retint Rule made literal).
//   - The track is named "Momentum". -> the fly-inward scaling ACCELERATES with
//     the arc and kicks on the bass, so the tunnel gathers momentum into the drop.
//   - VERIFIED FACT on screen: released 2025 on UKF (the label's own release
//     page, https://ukf.com/listen/releases/momentum-extended-mix/). Rendered as
//     the body line "UKF, 2025" beneath the discovered date on the late surge.
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, the audio.*
// curves through the hooks, remotion-seeded shader values). No Math.random /
// Date.now. GPU renders on ANGLE/Metal — stills/renders pass --gl=angle.
//
// QUAD LAW (doctrine 6): even though the portal layer is full-frame, the shader
// drives final color AND alpha to exactly 0.0 via a radial edgeFade that closes
// before the corners (length(q) reaches ~1.41 there), so the quad never prints.

// Safe inset so type never crowds the 1080x1920 edges or platform chrome.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// The clip is 20s. Type staging chosen musically for THIS tune (doctrine 4): the
// artist mark rides the early lift at ~5s up top, the track line anchors low
// across the main drop, the verified meta fact rides the late bass surge, and the
// close card arrives on the journey's settle.
const T = {
  artistIn: 1.2,
  artistOut: 4.6,
  // The meta fact rides the lead-IN to the late surge and clears BEFORE the close
  // card arrives (~17.6s) so the two never overlap; the surge's gold bloom then
  // fires in-shader under the arriving close card — the ending lands on the One
  // Sun's last flare.
  metaIn: 14.4,
  metaOut: 17.0,
  trackIn: 8.2,
  trackOut: 13.4,
};

// Drop windows in ms, derived from the analysed energy/bass curves: the main
// energy=1.0 detonation at ~10.5s and the late bass=1.0 crest at ~17.85s. The
// gold core ignites and blooms through the rings at both.
const DROP_MS = 10500;
const SURGE_MS = 17850;

// A quick depart, a long flying-inward travel, a settled arrival. The portal and
// the close card share this one arc so the whole piece travels on one timeline.
const journeyOpts: UseJourneyOptions = { ease: 2, split: [0.14, 0.88] };

export const MomentumPortal: React.FC<NostalgicCosmosProps> = ({ track, audio, palette, seed }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const sec = frame / fps;
  const ms = sec * 1000;

  // --- Narrative clock --------------------------------------------------------
  const { phase, phaseProgress, arc } = useJourney(journeyOpts);

  // --- Audio-reactive scalars -------------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 7 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 2.8 });
  const onset = useOnset(audio.onsets, 130);

  // Energy opens the cosmos up a touch (drift + float). The cosmos breathes; it
  // does not scroll to the beat (Starfield law).
  const driftBoost = 1 + energy * 1.4;
  const floatBoost = 1 + energy * 0.6;

  // The gold ignition at the portal core. A bell on each drop window builds a
  // 0..1 "ignite" scalar floored low so the intro is never stone-cold (the core
  // always has a faint warm pilot light), peaking on the two crests. This drives
  // the gold core bloom through the rings — the One Sun moment.
  const dropBell = bell(ms - DROP_MS, 900);
  const surgeBell = bell(ms - SURGE_MS, 760);
  const ignite = clamp01(0.1 + Math.max(dropBell, surgeBell * 0.92) * 0.95 + bass * 0.12);

  // "Momentum": the inward fly speed gathers along the arc and kicks on the bass,
  // so the tunnel accelerates into the drop. Passed to the shader as u_flyIn.
  const flyIn = arc * 1.0 + bass * 0.25 + pulse * 0.05;

  // A brief additive exposure flare on the hard onsets, heaviest on the drops, so
  // the detonations read as light. Kept tight so gold stays ~10% of the frame.
  const exposure = Math.min(0.3, onset * 0.12 + Math.max(dropBell, surgeBell) * 0.2);
  const grainKick = onset * 0.06 + Math.max(dropBell, surgeBell) * 0.05;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to its window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm centered wash beneath the portal: the field sits in deeper shadow at
          the edges, lifting toward the portal core where the gold bloom rides.
          Swells with the ignite scalar so the whole sky reacts to the One Sun. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 42% at 50% 47%,
            ${withAlpha(colors.eclipseGold, ignite * 0.07)} 0%,
            ${withAlpha(palette.background, 0)} 55%),
            linear-gradient(180deg,
            ${withAlpha(colors.deepField, 0.5)} 0%,
            ${withAlpha(palette.background, 0)} 30%,
            ${withAlpha(palette.background, 0)} 66%,
            ${withAlpha(colors.deepField, 0.7)} 100%)`,
        }}
      />

      {/* Starfield: drifts a little faster as energy lifts. Monotonic orbital
          drift; audio touches brightness/twinkle only, never position. */}
      <Starfield
        seed={seed}
        density={130}
        depth={3}
        drift={{ x: 0.003 * driftBoost, y: -0.011 * driftBoost }}
        maxSize={2.5}
        twinkle={0.4 + energy * 0.2}
      />

      {/* THE VEHICLE: the mirror-fold portal. One full-frame GPU layer is the whole
          vehicle — polarFold folds the frame into mirrored wedges, the folded
          coords fly inward along the arc (a tunnel of mirrored rings), a faint cool
          blue tints the OUTER rings (the artwork hue, retinted to a minor counter-
          accent), and ONE gold core sits at the fold center, igniting and blooming
          out on the drops (the One Sun moment THROUGH the portal). Present and
          turning from frame one (Always-Visible Vehicle). Quad law: a radial
          edgeFade drives color AND alpha to exactly 0.0 inside the corners, so the
          full-frame quad never prints. */}
      <AbsoluteFill>
        <ShaderLayer
          fragmentShader={PORTAL_FRAG}
          // Explicit CANON ramp (Deep Field -> Re-entry Red -> Eclipse Gold ->
          // Cream), NOT the artwork palette: the pipeline set this cover's accent
          // and glow both to gold, which would collapse the warm range and turn
          // the whole field olive. The artwork's own (blue) hue enters only as the
          // u_coolCol counter-accent below (the Retint Rule). Gold stays the sun.
          paletteStops={[
            colors.deepField,
            colors.reentryRed,
            colors.eclipseGold,
            colors.starlightCream,
          ]}
          seed={(seed % 9973) + 1}
          progress={arc}
          beatGrid={audio.beatGrid}
          beatDecay={2.8}
          energyCurve={audio.energyCurve}
          bassCurve={audio.bassCurve}
          uniforms={{
            u_beatKick: pulse,
            // The cool ring tint strength: present early, burning off as gold blooms.
            u_cool: clamp01(0.5 - ignite * 0.55),
            // The artwork's cool counter-accent, retinted toward canon blue-grey.
            u_coolCol: hexToVec3(pickCool(palette.swatches)),
            u_flyIn: flyIn,
            u_ignite: ignite,
          }}
        />
      </AbsoluteFill>

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------- */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* ~1.2-4.6s: the artists as the brand-led opening mark, riding the early
            lift, sitting high so it never crowds the portal core. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP + 40 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={72}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* ~8.2-13.4s: Artist — Title (the only sanctioned em dash), anchored low
            and held across the main drop so the title lands with the ignition. */}
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
            fontSize={46}
            drift={6 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* ~16.4-18.6s: the discovered date + the VERIFIED fact (UKF, 2025), riding
            the late bass surge. Tabular Oxanium via the meta variant for the date;
            the label/year fact is a body line beneath it (cited in the header). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 96, left: MARGIN_X, position: "absolute" }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FloatingType
              variant="meta"
              track={track}
              fontSize={32}
              drift={5 * floatBoost}
              color={colors.stardust}
            />
            <FloatingType
              variant="body"
              text="UKF, 2025"
              fontSize={26}
              drift={5 * floatBoost}
              driftPhase={0.6}
              color={colors.stardust}
            />
          </div>
        </TimedBlock>

        {/* The close card arrives with the journey's "arrive" phase: the tagline in
            cream + the one permitted gold signature. */}
        <CloseCard
          arc={phase === "arrive" ? phaseProgress : 0}
          palette={{ accent: colors.eclipseGold, ink: colors.starlightCream }}
          floatBoost={floatBoost}
          style={{
            bottom: SAFE_BOTTOM + 220,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        />
      </AbsoluteFill>

      {/* Onset / drop exposure spike: an additive gold veil at the portal core,
          punched hardest on the two crests. The detonations read as light. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(55% 45% at 50% 47%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS (the system base texture for the non-shader
          layers). The onset/drop kick briefly thickens it for a film flicker. */}
      <Grain
        opacity={0.16 + grainKick}
        intensity={0.8}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(128% 100% at 50% 46%,
            ${withAlpha(colors.deepField, 0)} 56%,
            ${withAlpha(colors.deepField, 0.56)} 100%)`,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// THE MIRROR-FOLD PORTAL SHADER (the whole vehicle in one full-frame fragment).
//
// Structure, bottom of the file for readability:
//   1. The fold — GLSL.polarFold folds the frame into N mirrored wedges around
//      the center, turning slowly with time so the kaleido seams rotate.
//   2. The fly-inward — the folded radius is scaled by u_flyIn so we travel down
//      a tunnel of mirrored rings ("Momentum"); the rings are an engraved liquid
//      gradient (fbm over the folded coords) mapped LOW through paletteRamp so
//      they stay a deep warm cloud, never cream.
//   3. The cool ring tint — the artwork blue admitted ONLY on the OUTER rings as
//      a minor counter-accent (u_cool), screened in faint, burning off as gold
//      blooms.
//   4. The One Sun gold core — a hot gold disc at the fold center (r -> 0) that,
//      on ignition (u_ignite), blooms outward through the rings: the single
//      Eclipse Gold moment expressed THROUGH the portal, never a second body.
//      Kept tight so the lit gold stays ~10% of the frame.
//   5. Grain baked into the surface + dither8 to kill banding.
//   6. THE QUAD KILL — a radial edgeFade on color AND alpha, closing before the
//      corners so the full-frame quad never prints.
// ---------------------------------------------------------------------------

const PORTAL_FRAG = /* glsl */ `
uniform float u_ignite;   // 0..1 gold-core ignition strength
uniform float u_flyIn;    // travel-inward scalar (accumulated arc + bass)
uniform float u_beatKick; // 0..1 beat pulse (ring shimmer kick)
uniform float u_cool;     // 0..1 cool-tint strength (burns off as gold blooms)
uniform vec3  u_coolCol;  // the artwork's cool counter-accent color

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.polarFold}
${GLSL.filmGrain}
${GLSL.vignette}

// Mirrored wedges around the center. Even count keeps clean bilateral seams.
const float SEGMENTS = 8.0;

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;

  // Aspect-correct centered coords so the fold + rings are round, not stretched.
  vec2 c = uv - 0.5;
  c.x *= aspect;
  float r = length(c);                       // 0 at center .. ~0.5+ at edges

  // --- 1. The fold ----------------------------------------------------------
  // Rotate slowly so the kaleido seams turn (a turning portal, not a frozen one),
  // then fold into mirrored wedges via the core helper.
  float ang = u_time * 0.12;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 rc = rot * c + 0.5;                    // back to 0..1 space for polarFold
  vec2 folded = polarFold(rc, SEGMENTS) - 0.5;

  // --- 2. The fly-inward rings ----------------------------------------------
  // Scale the folded coords inward over time so concentric rings stream toward
  // us ("Momentum"). The ring field is an engraved liquid gradient: fbm over the
  // flown coords + a radial ripple, mapped VERY LOW so it stays a warm-dark
  // cloud (Deep Field -> a touch of Re-entry Red), NEVER reaching gold; gold
  // lives only at the core (the One Sun). Squaring the field keeps most of the
  // frame near Deep Field, so the portal reads as a dark turning tunnel, not a
  // bright disc — the same discipline the down-with-your-love field uses.
  float zoom = 1.0 + u_flyIn * 2.2 + u_time * 0.18;
  vec2 fp = folded * zoom;
  float rings = sin(r * 26.0 - u_flyIn * 9.0 - u_time * 1.2) * 0.5 + 0.5; // streaming rings
  float field = fbm(fp * 2.2 + vec2(u_seed, u_time * 0.05), 5);
  // The engraved line-screen keeps the gradient from feeling clean/SaaS.
  float engrave = smoothstep(0.42, 0.5, fract(field * 7.0 + r * 3.0)) * 0.04;
  // Heat falls off from the core outward: the red is a HEAT accent radiating from
  // the portal's heart, strongest near center and fading to inky Deep Field at the
  // rim, so the ground is warm-dark (One Sun / Warm Dark Rules), not a red wash.
  float heatFall = exp(-r * 3.0);
  // field*field pushes the cloud toward Deep Field; the small cap keeps even the
  // brightest ring crests barely into Re-entry Red — gold lives only at the core.
  float ringT = (field * field * 0.16 + rings * 0.03 + engrave) * heatFall;
  ringT = clamp(ringT, 0.0, 0.16);
  vec3 col = paletteRamp(ringT);

  // --- 3. The cool ring tint (artwork hue, minor counter-accent) ------------
  // The blue lives ONLY on the OUTER rings (away from center) and only while
  // u_cool is up; it burns off as the gold core blooms. Screened in faint so
  // gold always wins and the night never turns cold.
  float outer = smoothstep(0.12, 0.42, r);
  col = col + u_coolCol * (outer * u_cool * 0.22);

  // --- 4. The One Sun gold core (through the portal) ------------------------
  // A hot gold disc at the fold center (r -> 0). On ignition it BLOOMS outward
  // through the rings. The core radius stays small so the lit gold is ~10% of
  // the frame; the bloom rides u_ignite so it only floods on the crests and is
  // gone (a faint pilot) through the intro/breakdown.
  // The bloom only fires above the pilot floor, so the intro/breakdown show just
  // a faint warm core, and the gold flood is reserved for the actual crests.
  float blaze = clamp((u_ignite - 0.12) / 0.88, 0.0, 1.0);
  float coreR = 0.04 + blaze * 0.06;
  float core = smoothstep(coreR, 0.0, r);                 // the hot center
  float bloom = exp(-r * (16.0 - blaze * 7.0)) * blaze;   // outward gold flood
  float gold = clamp(core * (0.5 + blaze * 0.5) + bloom * 0.55, 0.0, 1.0);
  vec3 goldCol = mix(u_palette[2], u_palette[3], 0.2);    // eclipse gold -> a touch cream
  col = mix(col, goldCol, gold);
  // A bright cream pinprick right at the very center on full ignition (the sun's
  // hottest point), kept tiny.
  col += u_palette[3] * smoothstep(0.025, 0.0, r) * blaze * 0.6;

  // --- 5. Surface grain + banding kill --------------------------------------
  // Grain baked into the surface (light touch, like the exemplar). A strong
  // vignette multiply seats the warm dark and keeps the corners inky.
  col = filmGrain(col, uv, u_time, 0.14);
  col *= mix(0.3, 1.0, vignette(uv, 0.95, 0.75));

  // --- 6. THE QUAD KILL ------------------------------------------------------
  // A radial fade in layer space (length(q) reaches ~1.41 at the corners). It
  // closes by 0.97 so EVERY corner is driven to exactly 0.0 — color AND alpha —
  // and the full-frame quad never prints a rectangle edge.
  vec2 q = (uv - 0.5) * 2.0;
  float edgeFade = 1.0 - smoothstep(0.86, 1.18, length(q));
  col *= edgeFade;

  gl_FragColor = vec4(dither8(col, uv), edgeFade);
}
`;

// --- Helpers ---------------------------------------------------------------

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Smooth bell falloff around 0 (in the same unit as `x`), `spread` the width. */
function bell(x: number, spread: number): number {
  const t = x / Math.max(0.0001, spread);
  return Math.exp(-(t * t));
}

/** Parse a #rrggbb hex into a 0..1 vec3 tuple for a shader uniform. */
function hexToVec3(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Pick the artwork's coolest swatch to tint the outer rings (the minor counter-
 * accent, Retint Rule). Falls back to a canon blue-grey if none of the swatches
 * lean cool, so the tint is always a restrained off-canon hue, never something
 * that could rival the gold. Pure: scans the provided swatches only.
 */
function pickCool(swatches: string[] | undefined): string {
  const fallback = "#3a4a78"; // restrained canon-adjacent blue-grey
  if (!swatches || swatches.length === 0) {
    return fallback;
  }
  let best = fallback;
  let bestScore = -1;
  for (const hex of swatches) {
    const [r, g, b] = hexToVec3(hex);
    // "Coolness": blue dominance minus warmth. We want a clearly blue swatch.
    const score = b - Math.max(r, g) * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = hex;
    }
  }
  // If nothing is meaningfully cool, keep the restrained fallback.
  return bestScore > 0.05 ? best : fallback;
}

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Returns null outside the window so it costs nothing.
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
  const rise = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [24, 0, 0, -16], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return <div style={{ ...style, opacity, transform: `translateY(${rise}px)` }}>{children}</div>;
};
