// "VisualTestOrb" — the ORB vehicle scene for Bugwell — "Everything In Its Right
// Place" (171 BPM roller; analysed window centred on the drop at startMs 9950).
//
// CONCEPT (two sentences): an Eclipse orb departs deep and small in a cold-blue
// void through the track's sparse breakdown, then on the drop (~clip 0.45) the
// field warms and the orb's burning rim ignites into the one Eclipse Gold moment
// as it rises to fill the frame, arriving at the close card. Texture family:
// NEBULA — a grainy fbm gradient wash with a drifting starfield, the orb's own
// surface grain reading as the material (the grain IS the surface), the artwork's
// cool blue kept as a minor counter-accent and recoloured to the canon ramp.
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, remotion
// random via seeded sub-seeds, the audio.* curves). GPU shaders render via
// ANGLE/Metal (pass --gl=angle). Grain + Retint are baked at the GPU level in the
// background shader and the orb surface; the CSS <Grain /> rides as the system
// base texture over the whole frame.

import { colors } from "@fluncle/tokens";
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
  JourneyOrb,
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

// Journey split: hold the depart (cold breakdown) long, let the travel ignite on
// the drop, settle into a generous arrive for the close card. The drop sits at
// ~clip 0.45 of a 20s window, so a 0.46 depart-end lands the warmth on it.
const SPLIT: [number, number] = [0.46, 0.84];

// Scene type beats in seconds (intensity rides the audio; timing is the grammar).
const T = {
  closeIn: 16.6,
  metaIn: 12.6,
  metaOut: 16.2,
  trackIn: 9.4,
  trackOut: 13.0,
};

// The nebula background shader: a slow domain-warped fbm field pushed through the
// canon Retint ramp, vertically biased so a warm horizon glow blooms low and the
// upper field falls into Deep Field. A cold-blue counter-accent (the artwork) is
// allowed to seep in only in the dim breakdown via u_chill, then burns off as the
// drop warms the whole field via u_warm. Grain + dither baked in-shader (the
// preferred GPU grain), so this is rendered light, not a CSS gradient.
const NEBULA_FRAG = /* glsl */ `
uniform float u_warm;   // 0..1 how far the field has warmed toward the drop
uniform float u_chill;  // 0..1 cold-blue counter-accent strength (breakdown only)
uniform vec3  u_cold;   // the artwork's cool swatch, retinted-in as a minor seep

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  // Two-layer fbm: a warp field flows a second field so the nebula drifts and
  // folds organically rather than scrolling. Slow time so it breathes.
  vec2 q = uv * vec2(1.0, 1.7);
  float warp = fbm(q * 1.3 + vec2(0.0, u_time * 0.045), 4);
  float field = fbm(q * 2.2 + warp * 0.7 + vec2(u_time * 0.025, u_seed * 0.7), 6);

  // Warm horizon: the ramp only climbs into heat where the field peaks and low in
  // the frame (a sun sitting just under the horizon). The drop (u_warm) lifts the
  // whole field's temperature and energy widens the bloom.
  float horizon = (1.0 - uv.y);
  // Keep the field a deep warm-dark: the breakdown is near-black inky cloud, the
  // drop only lifts a low horizon ember so the orb stays the brightest thing in
  // the frame (the One Sun). Heat is capped low; the ramp barely reaches gold in
  // the field, never cream.
  float heat = mix(0.03, 0.16, u_warm) + u_energy * 0.05;
  float t = field * field * (0.22 + u_warm * 0.26) + horizon * heat;
  vec3 col = paletteRamp(clamp(t, 0.0, 0.72));

  // Cold-blue counter-accent: in the breakdown a FAINT cool seep pools only in
  // the brightest wisps of the upper field (the Retint Rule — the artwork's blue
  // survives only as a minor counter-accent, never a field), screened in and
  // fully burned off by the drop. Kept small so the night stays warm and inky.
  float coolPool = smoothstep(0.62, 0.98, field) * smoothstep(0.50, 0.0, horizon);
  col = mix(col, col + u_cold * 0.5, coolPool * u_chill * 0.14);

  // Vignette toward warm dark, then organic film grain over the whole field, then
  // dither to kill 8-bit banding on the smooth gradient.
  col *= mix(0.30, 1.0, vignette(uv, 0.95, 0.80));
  col = filmGrain(col, uv, u_time, 0.13);
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

const VisualTestOrb: React.FC<NostalgicCosmosProps> = ({ track, audio, palette, seed }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // Shared narrative clock: every gesture below travels on this one arc.
  const { arc, phase, phaseProgress, progress } = useJourney({ split: SPLIT });

  // Audio-reactive scalars.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // The drop gate: 0 through the breakdown, ramping to 1 across the drop window so
  // the warmth and the Eclipse Gold ignition land together. Frame-derived.
  const warm = interpolate(progress, [0.4, 0.5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Cold counter-accent fades out as the warmth comes up.
  const chill = 1 - warm;

  // Energy opens the starfield drift; the cosmos breathes, it does not scroll.
  const driftBoost = 1 + energy * 1.5;
  const floatBoost = 1 + energy * 0.7;

  // Onset = brief gold exposure spike + a grain kick, but only once the drop has
  // landed (the breakdown stays cold and quiet, the drop sparks).
  const exposure = onset * 0.14 * warm;
  const grainKick = onset * 0.07;

  // The orb path: rises from low and small (departing through the cold field) to
  // upper-centre and full as it arrives, with a faint horizontal sway so it drifts
  // rather than tracks a straight line. The sway settles to centre by arrival.
  const orbPath = (a: number) => {
    const sway = Math.sin(a * Math.PI * 1.5) * 0.05 * (1 - a);
    return {
      scale: 0.42 + a * 0.78,
      x: 0.5 + sway,
      y: 0.66 - a * 0.24,
    };
  };

  // The orb's current placement (same arc JourneyOrb travels), used to mask its
  // square GPU surface layer to a circle. JourneyOrb draws its surface into a
  // square layer (size*scale*1.9) and the in-shader outer glow fills that square,
  // so it clips to a visible RECTANGLE against the warm-dark field. A radial mask
  // centred on the orb, opaque through the glow footprint and feathering out just
  // inside the square edge, dissolves the seam so only the disc + circular glow
  // remain — keeping it "rendered, not HTML".
  const orbBase = Math.min(width, height) * 0.52;
  const place = orbPath(arc);
  const orbPx = orbBase * place.scale;
  const footprint = orbPx * 1.9; // the square layer JourneyOrb renders into
  // Mask radius in px (circle inscribed in the square, feathered before the edge).
  const maskInner = footprint * 0.34;
  const maskOuter = footprint * 0.49;
  const orbMask = `radial-gradient(circle at ${place.x * 100}% ${place.y * 100}%,
    #000 ${maskInner}px, transparent ${maskOuter}px)`;

  // The orb stays an occluded ECLIPSE (a dark, mottled body with a BURNING rim),
  // not a lit ball — so Eclipse Gold lives only on the rim (~10% of the frame,
  // the One Sun Rule). The cold breakdown keeps the rim a dim ember; the drop
  // ignites it and bass + beat make it swell. Capped so it never blazes flat.
  const rimIntensity = Math.min(
    0.95,
    0.14 + warm * 0.42 + bass * 0.34 * warm + pulse * 0.22 * warm,
  );
  // Always the limb variant: the body falls into shadow along the terminator, one
  // edge burns. The drop lights that edge hotter, it never flips to a full sun.
  const orbVariant = "limb" as const;

  // The artwork's cool swatch, retinted-in as the minor counter-accent seep.
  const coolHex = palette.swatches[0] ?? palette.accent ?? colors.starlightCream;
  const coolVec = hexToVec3(coolHex);

  // The nebula field stays on the CANON warm ramp regardless of the artwork (the
  // Warm Dark Rule): Deep Field -> Re-entry Red -> Eclipse Gold -> Cream. The
  // artwork's cool blue is admitted only as the minor u_cold seep, never as a
  // ramp stop, so the night stays warm and inky, not blue.
  const nebulaStops: [string, string, string, string] = [
    colors.deepField,
    colors.reentryRed,
    colors.eclipseGold,
    colors.starlightCream,
  ];

  // The orb is the One Sun: its surface burns GOLD, so the rim/limb reaches
  // Eclipse Gold rather than the artwork's oxblood. Background stays the warm
  // near-black; accent is the Re-entry-Red heat under the gold glow.
  const sunPalette = {
    accent: colors.reentryRed,
    background: palette.background || colors.deepField,
    glow: colors.eclipseGold,
    ink: colors.starlightCream,
  };

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to the drop window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* NEBULA FIELD: the rendered background. Grain + Retint baked in-shader. */}
      <AbsoluteFill>
        <ShaderLayer
          fragmentShader={NEBULA_FRAG}
          paletteStops={nebulaStops}
          seed={(seed % 9973) + 1}
          energyCurve={audio.energyCurve}
          bassCurve={audio.bassCurve}
          uniforms={{
            u_chill: chill,
            u_cold: coolVec,
            u_warm: warm,
          }}
        />
      </AbsoluteFill>

      {/* Starfield over the nebula: drifts faster as energy lifts. Always there. */}
      <Starfield
        seed={seed}
        density={130}
        depth={3}
        drift={{ x: 0.004 * driftBoost, y: -0.01 * driftBoost }}
        maxSize={2.6}
        twinkle={0.4}
      />

      {/* THE ONE VEHICLE: the orb riding the journey arc. Its GPU surface is the
          rendered Eclipse (fbm body, fresnel limb, baked grain). The rim is the
          single Eclipse Gold light source, ignited only on the drop. The radial
          mask dissolves the square surface-layer seam (see orbMask above). */}
      <AbsoluteFill
        style={{
          WebkitMaskImage: orbMask,
          maskImage: orbMask,
        }}
      >
        <JourneyOrb
          size={Math.min(width, height) * 0.52}
          path={orbPath}
          journey={{ split: SPLIT }}
          palette={sunPalette}
          variant={orbVariant}
          rimColor={colors.eclipseGold}
          rimIntensity={rimIntensity}
          beatPulse={0.05}
          beatGrid={audio.beatGrid}
          bassBreath={0.045}
          bassCurve={audio.bassCurve}
          lightAngle={-2.2}
          surfaceGrain={0.32}
          surfaceDetail={3.4}
        />
      </AbsoluteFill>

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* The artist as the brand-led opening mark, lifting through the cold
            breakdown, gone before the drop fills the frame. */}
        <TimedBlock
          inSec={0.5}
          outSec={8.6}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", top: SAFE_TOP - 30 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={80}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* On the drop: Artist — Title (the only sanctioned em dash). */}
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

        {/* The close card, driven by the journey's "arrive" phase so it reveals
            exactly as the orb settles. The one permitted gold type moment. */}
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

      {/* Onset exposure spike (drop only): a brief additive gold veil. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 60% at 50% 42%,
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
          background: `radial-gradient(130% 100% at 50% 44%,
            ${withAlpha(colors.deepField, 0)} 55%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* arc reference keeps the journey clock observably consumed at the scene
          level (the orb and close card both already read it). */}
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

export default VisualTestOrb;
