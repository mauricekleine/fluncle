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
import { type CosmosPalette, type NostalgicCosmosProps } from "../types";

// "DancefloorHavoc" — Circadian — Hold That Sucker Down (Armada Music).
//
// ARCHIVED, SELF-CONTAINED COMPOSITION (tracks/20260607-hold-that-sucker-down).
// This file imports ONLY the surviving core (ShaderLayer, GLSL, CloseCard,
// FloatingType, Starfield, Grain, the audio hooks, useJourney, color helpers,
// types) plus remotion/react/@fluncle/tokens. The styled "journey vehicle"
// (JourneyOrb) it used to depend on is INLINED below as `InlineOrb`, so this
// piece stays re-renderable forever even after the vehicle set is deleted.
//
// Concept (one line): a burning ember rises out of the warm-dark field and
// ignites into the full Eclipse limb on the drop, the single light source flaring
// across the frame, then settles into the close.
//
// The tune is a classic anthem reborn as a "commanding, fierce, destructive" d&b
// roller at 172 BPM. Its energy curve has a long quiet breakdown (~7.7-8.9s), a
// re-entry spike at ~9s, then escalates to the two biggest drops at 14.5s and
// 15.65s. The scene is built around that arc.
//
// VEHICLE (One Vehicle Rule): the orb — the Eclipse limb, the single travelling
// medium, on screen from frame ONE as a dim ember at the bottom and rising +
// intensifying across the clip. Everything else (starfield, washes, grain) is
// subordinate.
//
// TEXTURE FAMILY: analog — heavy grain (the orb's grain IS its surface), warm
// broadcast decay, exposure flares punched on every onset.
//
// THE SQUARE FIX: the orb's GPU layer is a square canvas. The body/limb/texture
// terms already resolve inside the disc, but the soft outer glow's exp falloff
// (and the baked surface grain it carries) never reached EXACTLY zero before the
// square layer's edge, so the hard quad clip printed a faint rectangle around the
// disc — and the old external CSS halo div added its own square bounds. This
// version (1) folds the halo entirely into the shader (no external div) and (2)
// multiplies the FINAL color AND alpha by a single circular layer fade computed
// in true square-layer space (uv, not the aspect-bent body coords), driving every
// term — body, limb, texture, glow, grain — to exactly 0.0 well inside the quad.
// The orb dissolves into the starfield with no perceivable boundary at any size.
//
// Determinism: only frame- and seed-derived values; audio reactivity comes from
// the audio.* arrays through the hooks; the orb surface derives u_time/u_seed from
// the frame and seed via ShaderLayer.

// Safe inset so type never crowds the 1080x1920 edges or platform chrome.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds (the grammar; intensity rides the audio). The clip is
// 20s; the type timeline keeps clear of the close (which arrives ~16.6s).
const T = {
  artistIn: 0.5,
  artistOut: 2.2,
  metaIn: 7.0,
  metaOut: 10.0,
  trackIn: 2.4,
  trackOut: 7.0,
};

// The clip's two hardest drops (ms, from the analysed energy curve): the re-entry
// after the breakdown and the main detonation. The orb flares and the frame
// over-exposes hardest here.
const REENTRY_MS = 9000;
const DROP_MS = 15650;

const journeyOpts: UseJourneyOptions = { ease: 2, split: [0.12, 0.83] };

export const DancefloorHavoc: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // --- Narrative clock --------------------------------------------------------
  // A quick lift-off, a long climbing travel, a settled arrival. The orb and the
  // close card share this exact arc so the whole piece travels on one timeline.
  const { phase, phaseProgress } = useJourney(journeyOpts);

  // --- Audio-reactive scalars -------------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 7 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.4 });
  const onset = useOnset(audio.onsets, 140);

  // Energy opens the cosmos up: faster starfield drift + a touch more float as the
  // tune lifts. Subtle — the cosmos breathes, it does not scroll.
  const driftBoost = 1 + energy * 1.7;
  const floatBoost = 1 + energy * 0.7;

  // Onset = a brief exposure spike (analog film flare) + a grain kick. Heaviest on
  // the two big drops so the detonations read as light, not just sound.
  const dropHeat = Math.max(bell(sec * 1000 - REENTRY_MS, 360), bell(sec * 1000 - DROP_MS, 420));
  const exposure = Math.min(0.34, onset * 0.16 + dropHeat * 0.26);
  const grainKick = onset * 0.07 + dropHeat * 0.06;

  // The ember sits low and small at frame one, then rises to the upper third and
  // grows as it ignites — the cover's figure floating up under the sun. The orb is
  // the vehicle: present from the first frame, never a reveal.
  const orbPath = (arc: number) => ({
    scale: 0.34 + arc * 0.6,
    x: 0.5,
    y: 0.72 - arc * 0.28,
  });

  // The rim heats with bass + beat and detonates on the drops: this is the One Sun
  // moment, kept tight so the lit gold area stays ~10% of the frame.
  const rimIntensity = Math.min(1.3, 0.34 + bass * 0.5 + pulse * 0.22 + dropHeat * 0.5);

  // The eclipse vertical center used by the washes, tracking the orb's rise.
  const sunY = orbPathYAt(sec, durationInFrames, fps, journeyOpts);

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to its window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm vertical wash: the field sits in deeper shadow below, the orb's zone
          lifts. A radial gold breath tracks the orb and swells on the drops so the
          whole sky reacts to the One Sun, not just the disc. Depth without flatness. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 80% at 50% ${sunY * 100}%,
            ${withAlpha(colors.eclipseGold, 0.04 + dropHeat * 0.08)} 0%,
            ${withAlpha(palette.background, 0)} 48%),
            linear-gradient(180deg,
            ${withAlpha(palette.background, 0)} 38%,
            ${withAlpha(colors.deepField, 0.78)} 100%)`,
        }}
      />

      {/* Starfield: drifts faster as energy lifts. Always present, subordinate. */}
      <Starfield
        seed={seed}
        density={140}
        depth={3}
        drift={{ x: 0.0035 * driftBoost, y: -0.012 * driftBoost }}
        maxSize={2.7}
        twinkle={0.45}
      />

      {/* THE VEHICLE: the eclipse on its rising arc, on screen from frame one. The
          "limb" surface keeps the body in warm shadow with a single BURNING edge —
          the cover's signature drama and the One Sun discipline (gold lives only on
          the rim, ~10% of the frame, not a bright disc). Its GPU surface bakes the
          analog grain INTO the material, AND carries the One Sun halo in-shader, so
          there is no external CSS box. Bass breathes it, the beat pulses it, the
          drops detonate the rim. A circular layer fade drives every term to exactly
          zero inside the square quad: no visible boundary. */}
      <InlineOrb
        path={orbPath}
        journey={journeyOpts}
        size={Math.min(width, height) * 0.42}
        palette={palette}
        rimIntensity={rimIntensity}
        beatPulse={0.07}
        beatGrid={audio.beatGrid}
        bassBreath={0.06}
        bassCurve={audio.bassCurve}
        lightAngle={-2.0}
        surfaceGrain={0.62}
        surfaceDetail={3.4}
      />

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------- */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* 0.5-2.2s: the artist as the brand-led opening mark, up top. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 30 }}
        >
          <FloatingArtist artists={track.artists} floatBoost={floatBoost} />
        </TimedBlock>

        {/* 2.4-7s: Artist — Title (the only sanctioned em dash). Sits low so it
            never crowds the rising orb. */}
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
          <TrackLineType track={track} floatBoost={floatBoost} />
        </TimedBlock>

        {/* 7-10s: Discovered date (tabular Oxanium). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 100, left: MARGIN_X, position: "absolute" }}
        >
          <MetaType track={track} floatBoost={floatBoost} />
        </TimedBlock>

        {/* The close card arrives with the journey's "arrive" phase: tagline in
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

      {/* Onset / drop exposure spike: an additive gold veil over the frame, an
          analog film flare punched hardest on the two detonations. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(85% 65% at 50% ${sunY * 100}%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 62%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS (the analog base texture). The onset/drop
          kick briefly thickens it for a film-exposure flicker. */}
      <Grain
        opacity={0.17 + grainKick}
        intensity={0.82}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 44%,
            ${withAlpha(colors.deepField, 0)} 54%,
            ${withAlpha(colors.deepField, 0.58)} 100%)`,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// INLINED VEHICLE: the Eclipse-limb orb, formerly JourneyOrb (variant "limb").
// Self-contained so this archive re-renders forever after the vehicle set is
// deleted. Only the limb path this composition actually used is kept; the plate
// (children) path and the "sun" variant are dropped.
// ---------------------------------------------------------------------------

type InlineOrbPlacement = { x: number; y: number; scale: number };

type InlineOrbProps = {
  size: number;
  path: (arc: number) => InlineOrbPlacement;
  journey: UseJourneyOptions;
  palette: Partial<CosmosPalette>;
  rimIntensity: number;
  beatPulse: number;
  beatGrid: number[];
  bassBreath: number;
  bassCurve: { timeMs: number; energy: number }[];
  lightAngle: number;
  surfaceGrain: number;
  surfaceDetail: number;
  style?: CSSProperties;
};

// The orb surface shader. Renders a rendered-grade celestial limb into the
// (square) layer that wraps it: an SDF disc whose body is an fbm-textured
// material, a hot fresnel-style burning edge (the solar-eclipse / planet limb),
// a soft outer glow with physical falloff (the One Sun halo, drawn in-shader so
// it grains and dithers with the body instead of reading as a flat CSS rect),
// and emulsion grain baked INTO the surface.
//
// THE QUAD KILL (every term -> exactly 0.0 inside the square edge):
//   The square canvas buffer is the full portrait video resolution (u_res), but
//   the layer is displayed as a SQUARE, so `uv` (0..1 over the buffer) maps 1:1
//   to the displayed square. The body coords `p` use that same uv, so the disc
//   is already circular on screen. The bug was that the glow's exp falloff (and
//   the surface grain riding on it) never reached 0 before the square's edge, and
//   `length(p)` reaches the edge MIDPOINTS at 1.0 but the CORNERS at ~1.41 — so a
//   radial fade tuned to 1.0 still leaks into the corners, printing a faint box.
//   Fix: compute a single `layerFade` in true square space (the same uv) that hits
//   0 by length(q)=0.90 — inside every edge midpoint AND well inside the corners —
//   and multiply BOTH the final color AND the alpha by it. With straight-alpha
//   compositing (blendMode normal) zero alpha => zero contribution, so no quad.
const ORB_FRAG = /* glsl */ `
uniform float u_rim;
uniform float u_lightAng;
uniform float u_grainAmt;
uniform float u_detail;
uniform float u_aspect;

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}

void main() {
  // Aspect-correct, centered coords: p in roughly [-1,1] across the shorter
  // axis, origin at the disc center. The disc has radius ~0.78 so the glow has
  // room to fall off inside the (square) layer before the edge.
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * 2.0;
  p.x *= u_aspect;

  float r = length(p);
  float radius = 0.78;

  // Light direction (screen space). The limb burns on the edge facing the light.
  vec2 L = vec2(cos(u_lightAng), sin(u_lightAng));
  vec2 n = r > 1e-4 ? p / r : vec2(0.0);
  float ndl = dot(n, L); // -1 (away from light) .. 1 (toward light)

  // --- Body texture: fbm IS the material -----------------------------------
  vec2 sp = p * u_detail;
  float warp = fbm(sp * 0.7 + vec2(u_seed, u_time * 0.02), 4);
  float relief = fbm(sp + warp * 0.8 + vec2(u_time * 0.015, u_seed * 1.7), 6);
  float mott = (relief - 0.5);

  // --- Shading the body (limb: body in shadow, one burning terminator) ------
  float sphere = sqrt(max(0.0, 1.0 - min(r / radius, 1.0) * (r / radius)));
  float day = smoothstep(-0.35, 0.55, ndl);

  float lit = day * (0.42 + sphere * 0.22);
  float bodyT = clamp(
    0.30 + lit * 0.52 + mott * (0.40 + u_grainAmt * 0.40),
    0.0, 0.88
  );
  vec3 body = paletteRamp(bodyT);
  float core = smoothstep(0.55, 0.0, r / radius) * day;
  body += (u_palette[2] - u_palette[1]) * core * 0.18;

  // --- The hot fresnel limb (the burning edge) ------------------------------
  float edge = smoothstep(radius, radius - 0.05, r) * smoothstep(radius - 0.16, radius - 0.04, r);
  float fres = pow(clamp(r / radius, 0.0, 1.0), 6.0);
  float limbGate = smoothstep(-0.1, 0.7, ndl);
  float limb = edge * fres * limbGate;
  vec3 limbCol = mix(u_palette[2], u_palette[3], 0.55);
  float rimAmt = limb * (0.9 + u_rim * 1.6);

  // --- Soft outer glow with falloff (the One Sun halo, in-shader) -----------
  float outside = smoothstep(radius - 0.02, radius + 0.02, r);
  float glowFall = exp(-max(0.0, r - radius) * 6.5);
  float glow = outside * glowFall * (0.55 + u_rim * 0.9);
  vec3 glowCol = mix(u_palette[2], u_palette[1], 0.35);

  // --- Composite ------------------------------------------------------------
  float inside = 1.0 - outside;
  vec3 col = body * inside + glowCol * glow;
  col += limbCol * rimAmt;

  // Grain baked into the MATERIAL.
  float grainShape = mix(0.35, 1.0, inside);
  col = filmGrain(col, uv, u_time, u_grainAmt * 0.7 * grainShape);

  // Alpha: opaque disc, falling-off glow halo, transparent beyond.
  float alpha = clamp(inside + glow * 1.2, 0.0, 1.0);

  // --- THE QUAD KILL --------------------------------------------------------
  // A single circular fade in true square-layer space (uv-derived, NOT the
  // aspect-bent body coords). q reaches 1.0 at the square's edge MIDPOINTS and
  // ~1.41 at its CORNERS, so a fade that ends at 0.90 forces EVERY term — body,
  // limb, texture, glow, baked grain, alpha — to exactly 0.0 well inside every
  // edge and corner. Applied to BOTH color and alpha so the layer's quad never
  // prints, at any orb size.
  vec2 q = (uv - 0.5) * 2.0;
  float layerFade = 1.0 - smoothstep(0.62, 0.90, length(q));
  col *= layerFade;
  alpha *= layerFade;

  gl_FragColor = vec4(dither8(col, uv), alpha);
}
`;

const InlineOrb: React.FC<InlineOrbProps> = ({
  size,
  path,
  journey,
  palette,
  rimIntensity,
  beatPulse,
  beatGrid,
  bassBreath,
  bassCurve,
  lightAngle,
  surfaceGrain,
  surfaceDetail,
  style,
}) => {
  const { arc } = useJourney(journey);

  // Audio-reactive scale + rim modifiers, each gated on its source being present.
  const { pulse } = useBeat(beatGrid);
  const hasBeat = beatGrid.length > 0;
  const beatKick = hasBeat ? pulse * beatPulse : 0;

  const bass = useBass(bassCurve);
  const hasBass = bassCurve.length > 0;
  const breath = hasBass ? bass * bassBreath : 0;

  const placement = path(arc);
  const effectiveScale = placement.scale * (1 + beatKick + breath);
  const px = size * effectiveScale;

  // The rim/limb heats with bass + beat when curves are present.
  const glowStrength = hasBass
    ? Math.min(1.4, rimIntensity * (0.7 + bass * 0.6) + (hasBeat ? pulse * 0.25 : 0))
    : rimIntensity;

  // The GPU surface layer is square, centered on the disc, oversized past the
  // disc so the in-shader glow + circular fade have room to resolve to zero
  // before the canvas edge.
  const layer = px * 1.9;

  return (
    <div
      aria-hidden
      style={{
        height: px,
        left: `${placement.x * 100}%`,
        pointerEvents: "none",
        position: "absolute",
        top: `${placement.y * 100}%`,
        transform: "translate(-50%, -50%)",
        width: px,
        ...style,
      }}
    >
      <div
        style={{
          height: layer,
          left: "50%",
          position: "absolute",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: layer,
        }}
      >
        <AbsoluteFill>
          <ShaderLayer
            fragmentShader={ORB_FRAG}
            palette={palette}
            seed={(size % 9973) + 1}
            uniforms={{
              u_aspect: 1,
              u_detail: surfaceDetail,
              u_grainAmt: surfaceGrain,
              u_lightAng: lightAngle,
              u_rim: glowStrength,
            }}
          />
        </AbsoluteFill>
      </div>
    </div>
  );
};

// --- Helpers ---------------------------------------------------------------

/** Smooth bell falloff around 0 (in the same unit as `x`), `spread` the width. */
function bell(x: number, spread: number): number {
  const t = x / Math.max(0.0001, spread);
  return Math.exp(-(t * t));
}

/**
 * Recompute the orb's vertical center for a given second, mirroring the orb path
 * and the journey easing so the washes track the disc exactly. Pure: derives only
 * from the frame-equivalent second and the clip metadata.
 */
function orbPathYAt(
  sec: number,
  durationInFrames: number,
  fps: number,
  opts: UseJourneyOptions,
): number {
  const span = Math.max(1, durationInFrames - 1);
  const progress = Math.min(1, Math.max(0, (sec * fps) / span));
  const arc = easeArc(progress, opts.ease ?? 2);
  return 0.72 - arc * 0.28;
}

/** Smoothstep slow-in/slow-out, re-applied `ease` times (matches useJourney). */
function easeArc(t: number, ease: number): number {
  const c = Math.min(1, Math.max(0, t));
  let out = c * c * (3 - 2 * c);
  for (let i = 1; i < ease; i++) {
    out = out * out * (3 - 2 * out);
  }
  return out;
}

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Returns null outside the window so it costs nothing.
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

// Thin wrappers over FloatingType keep the JSX above readable; each is a single
// sanctioned type role from the kit.
const FloatingArtist: React.FC<{ artists: string[]; floatBoost: number }> = ({
  artists,
  floatBoost,
}) => (
  <FloatingType
    variant="brandMark"
    mark={artists.join(", ")}
    fontSize={84}
    drift={7 * floatBoost}
    color={colors.starlightCream}
  />
);

const TrackLineType: React.FC<{
  track: NostalgicCosmosProps["track"];
  floatBoost: number;
}> = ({ track, floatBoost }) => (
  <FloatingType
    variant="trackLine"
    track={track}
    fontSize={46}
    drift={6 * floatBoost}
    color={colors.starlightCream}
  />
);

const MetaType: React.FC<{
  track: NostalgicCosmosProps["track"];
  floatBoost: number;
}> = ({ track, floatBoost }) => (
  <FloatingType
    variant="meta"
    track={track}
    fontSize={32}
    drift={5 * floatBoost}
    driftPhase={0.7}
    color={colors.stardust}
  />
);
