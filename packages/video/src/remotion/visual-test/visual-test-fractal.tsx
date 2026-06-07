// "VisualTestFractal" — the FRACTAL travelling vehicle (the One Vehicle Rule,
// packages/video/README.md), authored as a real per-track scene for
// Bugwell — "Everything In Its Right Place".
//
// CONCEPT (journey / texture family):
//   The journey is a fall INTO order: a polarFold kaleidoscope tunnel that hangs
//   nearly still through the sparse intro (depart), then — on the drop at ~10s —
//   pulls the camera continuously inward through recursive mirrored wedges
//   (travel), and decelerates as it arrives at the close card. The title wants
//   obsessive symmetry, every filament snapping into its right wedge; the fractal
//   recursion IS that compulsion made spatial. Texture family: PAINT — layered
//   translucent chroma folded through the kaleidoscope (MOODBOARD.md paint pole),
//   built GPU-grade with an fbm interior + engraved line-screen over smooth
//   gradient (the liquid-spectrum-vortex.png technique) so it reads rendered, not
//   flat DOM. The artwork is cool (steely blue accent, oxblood glow), so the
//   Retint Rule applies: blue + oxblood-red carry the wedges as the night's
//   chroma; gold is withheld for ONE moment only.
//
//   THE ONE ECLIPSE GOLD MOMENT: the vortex core. A single burning gold sun sits
//   at the tunnel's convergence point and only fully ignites on the drop and its
//   transients (u_beatPulse + the drop gate). Everywhere else stays blue/oxblood
//   over warm dark — so the gold reads as the one sun we are falling toward.
//
// Determinism: only frame-, seed-, and curve-derived values (useCurrentFrame/fps,
// useJourney, the audio.* curves through ShaderLayer's uniforms, remotion random
// is not needed here). No Math.random / Date.now. GPU shader via ANGLE/Metal
// (render/still with --gl=angle).

import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
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

// Safe margins (README authoring rule): keep all type inside this inset so it
// never crowds the 1080x1920 edges or gets cropped by platform chrome.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// The fractal fragment shader. A polarFold kaleidoscope folds the frame into
// mirrored wedges; the wedge interior is an fbm field run through the Retint
// palette ramp; a journey-driven log-radius zoom pulls the camera continuously
// INTO the vortex; an engraved fine-line groove rides over the smooth gradient
// (the vortex reference); and a single GOLD core burns at the convergence point
// as the One Sun, gated to ignite on the drop and its beat transients.
//
// Custom uniforms (declared below, set per frame from JS, all frame-derived):
//   u_segments  mirrored wedge count
//   u_octaves   fbm octaves for the interior (floored)
//   u_foldRot   total fold rotation (radians): continuous spin + per-beat kick
//   u_zoom      total domain zoom in log e-folds (the travel into the fractal)
//   u_sun       0..1 gold-core ignition gate (drop + transients)
//   u_coolMix   0..1 how strongly to push wedge chroma toward the cool accent
const FRACTAL_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.polarFold}
${GLSL.filmGrain}
${GLSL.vignette}

uniform float u_segments;
uniform float u_octaves;
uniform float u_foldRot;
uniform float u_zoom;
uniform float u_sun;
uniform float u_coolMix;

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
  // within-wedge mirror).
  vec2 fold = polarFold(p, max(2.0, u_segments));
  int oct = int(max(1.0, u_octaves) + 0.5);

  // TRAVEL: march the sampled domain inward in (log-radius, angle) space so the
  // tunnel keeps feeding new rings as we fall — endless travel, not a finite
  // plate being scaled. Subtract u_zoom from log-radius so detail flows toward us.
  vec2 fc = fold - 0.5;
  float r = length(fc) + 1e-4;
  float ang = atan(fc.y, fc.x);
  float lr = log(r) - u_zoom;
  vec2 q = vec2(lr * 2.4, ang * (max(2.0, u_segments) / 6.2831853) * 6.2831853 * 0.5);
  q += vec2(u_time * 0.05 + u_seed * 2.3, u_time * 0.02);
  float warp = fbm(q * 0.9 + vec2(0.0, lr), 4);
  float field = fbm(q + warp * 0.85, oct);

  // PAINT texture: layered translucent chroma. Two offset fbm reads cross-fade so
  // the wedge interior reads as overlapping washes rather than one flat field.
  float wash = fbm(q * 0.55 - vec2(lr * 0.6, u_time * 0.03), 4);

  // Warm-dark must win (Warm Dark Rule), but the kaleidoscope FILAMENTS must
  // actually read: lift the lit band so the wedge interior shows its painted
  // chroma, while keeping broad darker troughs between filaments. centerHeat is
  // kept gentle so the center does not wash out before the sun even lights.
  float centerHeat = smoothstep(0.55, 0.1, r) * 0.5;
  float lit = smoothstep(0.28, 0.78, field);
  float t = lit * 0.74 + centerHeat * 0.18 + wash * 0.16;
  t = clamp(t, 0.0, 1.0);

  // Retint: this is a COOL track and gold is withheld for the core only, so the
  // wedge body is painted in the artwork's blue accent (u_palette[1]) and the
  // oxblood glow (u_palette[2]), never reaching gold. Build an explicit cool ramp
  // dark -> accent -> oxblood -> cream-tipped, then blend the canon ramp toward
  // it by u_coolMix. Each band keeps real saturation so the wedges read painted.
  vec3 ramp = paletteRamp(t);
  vec3 cool;
  if (t < 0.5) {
    cool = mix(u_palette[0], u_palette[1], smoothstep(0.05, 0.5, t));   // dark -> accent
  } else if (t < 0.82) {
    cool = mix(u_palette[1], u_palette[2], smoothstep(0.5, 0.82, t));   // accent -> oxblood
  } else {
    cool = mix(u_palette[2], mix(u_palette[2], u_palette[3], 0.6), smoothstep(0.82, 1.0, t));
  }
  vec3 col = mix(ramp, cool, u_coolMix);

  // --- Engraved line-screen overlay (the vortex reference) -----------------
  // Fine spiral grooves etched over the smooth gradient: only darken narrow
  // troughs (engraved look), never wash the color. Bass swells the depth.
  float engraveFreq = 130.0;
  float linePhase = lr * engraveFreq + ang * max(2.0, u_segments) * 1.5;
  float lines = abs(sin(linePhase));
  float grooves = smoothstep(0.0, 0.4, lines);
  float engraveDepth = 0.22 + 0.12 * u_bass;
  col *= 1.0 - engraveDepth * (1.0 - grooves);
  // Concentric rings marching inward give the spokes DEPTH (a tunnel, not a
  // starburst): faint dark rings spaced in log-radius so they crawl toward us.
  float rings = abs(sin(lr * 9.0 - u_time * 0.3));
  float ringGroove = smoothstep(0.0, 0.5, rings);
  col *= 1.0 - 0.12 * (1.0 - ringGroove);

  // --- THE ONE SUN: the gold vortex core -----------------------------------
  // A single SMALL burning Eclipse-Gold disc at the convergence point — a disc,
  // not a cloud (One Sun Rule: gold lives on ~10% of the frame). Withheld
  // (u_sun low) through the sparse intro; ignites on the drop, snaps on the beat.
  // This is the ONLY gold in the frame. Tight radii keep it compact and burning.
  float core = smoothstep(0.05, 0.0, r);   // cream-hot heart, very small
  float disc = smoothstep(0.11, 0.02, r);  // gold body
  float rim  = smoothstep(0.15, 0.10, r);  // burning rim ring
  float ignite = clamp(u_sun, 0.0, 1.0);
  float beat = 0.55 + 0.45 * u_beatPulse;
  // True canon gold/cream regardless of palette tinting (the sun is reserved gold).
  vec3 sunGold = vec3(0.961, 0.722, 0.0);   // #f5b800 Eclipse Gold
  vec3 sunCream = vec3(0.957, 0.918, 0.843); // #f4ead7 Starlight Cream
  // Lay the gold disc OVER the tunnel (mix, not just add) so it occludes the cool
  // interior into a clean burning sun rather than a blown additive haze.
  col = mix(col, sunGold, disc * ignite * 0.92);
  col = mix(col, sunCream, core * ignite * beat);
  col += rim * ignite * beat * 0.5 * sunGold;

  // --- Finish --------------------------------------------------------------
  col *= mix(0.42, 1.0, vignette(uv, 1.1, 0.95));
  col = filmGrain(col, uv, u_time, 0.11);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

export const VisualTestFractal: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;

  // Shared narrative clock. A quick depart, a long fall, a settled arrive — the
  // split lands the bulk of the travel across the roller body.
  const { progress, arc, phase, phaseProgress } = useJourney({ split: [0.12, 0.82] });

  // Overall energy opens the spin and the zoom speed through the loud middle.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });

  // --- THE TRAVEL ----------------------------------------------------------
  // Continuous log-domain zoom: a base per-second fall compounded with the eased
  // arc so the camera holds nearly still through the sparse intro and accelerates
  // into the vortex once the journey gets going. Each unit is one e-fold deeper.
  const perSecZoom = Math.log(1.1) * sec * (0.4 + energy * 0.9);
  const clipZoom = Math.log(5.2) * arc;
  const totalZoom = perSecZoom + clipZoom;

  // Fold rotation (radians): slow continuous vortex twist, faster on energy.
  const spinDegPerSec = 5 + energy * 7;
  const foldRot = (spinDegPerSec * sec * Math.PI) / 180;

  // Segments tighten as we fall inward: 6 wedges opening to 8 deep in the tunnel,
  // so the recursion reads as "more order the deeper you go".
  const segments = Math.round(interpolate(arc, [0, 1], [6, 8], { extrapolateRight: "clamp" }));

  // --- THE ONE SUN gate ----------------------------------------------------
  // The gold core stays withheld through the sparse intro and ignites on the
  // drop. The drop in THIS clip lands almost immediately (clip starts at 9.95s
  // into the track, right on the drop), so the sun rises fast and holds, then
  // recedes a touch into the close so the gold never competes with the close-card
  // wordmark gold. Frame-derived envelope; transients ride u_beatPulse in-shader.
  // The sun fully extinguishes before the close card so the ONLY gold left in
  // frame is the close-card signature (One Sun Rule: never two golds competing).
  // The track's roller also breaks at ~17s, so a dark core at the close is the
  // musical truth too.
  const sunGate = interpolate(sec, [0.0, 0.6, 2.0, 13.5, 15.4], [0.0, 0.12, 1.0, 1.0, 0.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Retint blend: cool track, so push the wedge chroma hard toward the artwork's
  // own blue/oxblood (the Retint Rule keeps cool hues as the night's chroma while
  // the sun stays gold). Slightly less cool at the very end so the arrive reads
  // warmer as the tunnel decelerates.
  const coolMix = interpolate(arc, [0, 0.85, 1], [0.82, 0.82, 0.62], {
    extrapolateRight: "clamp",
  });

  // Shader palette stops, dark -> light:
  //   [0] warm-dark ground (Deep Field, nudged to the artwork dark)
  //   [1] the cool accent (steely blue, the wedge mid-chroma)
  //   [2] the oxblood glow as the heat band (Re-entry-Red-adjacent)
  //   [3] cream ink for the brightest filaments
  // The in-shader sun forces true Eclipse Gold/Cream for the core regardless.
  const accentCool = palette.accent ?? colors.reentryRed;
  const oxblood = palette.glow ?? colors.reentryRed;
  const paletteStops: [string, string, string, string] = [
    palette.background ?? colors.deepField,
    accentCool,
    oxblood,
    colors.starlightCream,
  ];

  // Type timeline (seconds). Artist mark opens, Artist — Title rides the roller,
  // Discovered date, then the close card on the arrive phase.
  const T = {
    brandIn: 0.4,
    brandOut: 3.4,
    metaIn: 7.0,
    metaOut: 10.6,
    trackIn: 3.2,
    trackOut: 7.6,
  };

  const floatBoost = 1 + energy * 0.7;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* The fractal vehicle: the GPU kaleidoscope tunnel. Fills the frame; all
          grain + retint are baked in the shader (no CSS <Grain> over a shader). */}
      <ShaderLayer
        fragmentShader={FRACTAL_FRAG}
        paletteStops={paletteStops}
        seed={seed}
        progress={progress}
        beatGrid={audio.beatGrid}
        beatDecay={3.0}
        energyCurve={audio.energyCurve}
        bassCurve={audio.bassCurve}
        uniforms={{
          u_coolMix: coolMix,
          u_foldRot: foldRot,
          u_octaves: 6,
          u_segments: segments,
          u_sun: sunGate,
          u_zoom: totalZoom,
        }}
      />

      {/* A whisper of warm light only right around the gold core so it seats into
          the warm dark (Warm Dark Rule) without becoming a cloud. Kept tight. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(22% 16% at 50% 50%,
            ${withAlpha(colors.eclipseGold, 0.05 * sunGate)} 0%,
            ${withAlpha(colors.deepField, 0)} 70%)`,
          mixBlendMode: "screen",
          pointerEvents: "none",
        }}
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
        {/* 0–3s: the artist as the brand-led opening mark. */}
        <TimedBlock
          inSec={T.brandIn}
          outSec={T.brandOut}
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

        {/* 3–7.6s: Artist — Title (the only sanctioned em dash). Bottom-seated so
            it sits clear of the bright vortex core in the middle of the frame. */}
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

        {/* 7–10.6s: Discovered date (tabular Oxanium). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 96, left: MARGIN_X, position: "absolute" }}
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

        {/* The close card on the arrive phase: tagline + selector signature, the
            one permitted gold TYPE moment (the in-shader sun has receded by now). */}
        {phase === "arrive" ? (
          <CloseCard
            progress={phaseProgress}
            floatBoost={floatBoost}
            style={{
              bottom: SAFE_BOTTOM + 200,
              left: MARGIN_X,
              position: "absolute",
              right: MARGIN_X,
            }}
          />
        ) : null}
      </AbsoluteFill>

      {/* A faint cinematic vignette to seat the type and hold the warm dark over
          the whole frame (the shader vignettes the tunnel; this seats the type). */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(135% 105% at 50% 50%,
            ${withAlpha(colors.deepField, 0)} 58%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* GRAIN is baked in the shader for the vortex; a whisper of CSS Grain over
          the TYPE keeps the type seated in the same emulsion as everything else
          (kept low so it never double-grains the rendered tunnel). */}
      <Grain
        opacity={0.06}
        intensity={0.9}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />
    </AbsoluteFill>
  );
};

// --- Helpers ---------------------------------------------------------------

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Returns null outside its window so it never costs
 * layout elsewhere.
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

export default VisualTestFractal;
