// "VisualTestFractal" — a real FRACTAL-vehicle scene (One Vehicle Rule).
//
// Track: Bugwell — Everything In Its Right Place (171 BPM). The clip window opens
// on the drop: a quiet starlit night folds inward through a spinning mirror
// vortex (the JourneyFractal vehicle), then settles back to stillness for the
// close. Everything else (starfield, towers, the One Eclipse, the type timeline)
// stays subordinate to the tunnel.
//
// Journey: depart from a quiet starfield-and-towers night → travel by plunging
// through a beat-folding kaleido vortex built from the artwork's oxblood/blue
// chroma → arrive back to stillness at the close card.
//
// Texture family: PAINT — layered translucent chroma mirrored through the
// recursion. Retint Rule: the artwork's broadcast blue (#3d6baf) is pushed down
// to a minor counter-accent; the oxblood glow (#72191c) is heated toward
// Re-entry Red. Gold stays reserved for the One Sun (the Eclipse rim) and the
// one close-card signature.
//
// Determinism: only frame-/seed-/curve-derived values (Remotion random via the
// primitives, the audio arrays through the hooks). No Math.random / Date.now.

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
  DitherField,
  Eclipse,
  FloatingType,
  Grain,
  JourneyFractal,
  Starfield,
  TowerBlocks,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// Safe margins (the exemplar's insets): keep type clear of the 1080x1920 edges.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds. The vortex owns the middle; type rides the quiet ends.
const T = {
  artistIn: 0.4,
  artistOut: 3.0,
  metaIn: 6.6,
  metaOut: 8.6,
  trackIn: 3.0,
  trackOut: 6.6,
};

export const VisualTestFractal: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // --- Narrative clock: the fractal travels along this single arc ------------
  // Quick lift-off, a long fall through the tunnel, a settled arrival.
  const { arc, phase, phaseProgress } = useJourney({ split: [0.16, 0.82] });

  // --- Audio-reactive scalars ----------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.2 });
  const onset = useOnset(audio.onsets, 150);

  // Retint Rule. The artwork is cool (blue accent, oxblood glow). Push the
  // oxblood toward Re-entry Red as the heat, keep the blue as a minor counter-
  // accent. Gold is NOT used here — it is reserved for the One Sun.
  const heat = palette.glow || colors.reentryRed; // oxblood → heat
  const counter = palette.accent || "#3d6baf"; // broadcast blue → counter-accent
  const fractalPalette = {
    accent: heat,
    background: palette.background || colors.deepField,
    glow: heat,
    ink: colors.starlightCream,
    swatches: palette.swatches,
  };

  // The vortex fades in as we leave the quiet depart and fades back out at the
  // arrival, so the fractal reads as a passage we fall through, not a backdrop.
  const fractalOpacity = interpolate(arc, [0.05, 0.22, 0.78, 0.95], [0, 0.82, 0.82, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // The travel itself: the tunnel pulls deeper as the drop hits. Energy widens
  // the zoom; the spin leans faster through the loud middle.
  const zoomPerSec = 1.1 + energy * 0.16;
  const spinPerSec = 5 + energy * 7;

  // The One Sun: a single Eclipse anchored at the vortex center. Its rim is the
  // only Eclipse Gold light — it swells with the low end and snaps on the beat,
  // flaring hardest on the drop. The disc breathes so it reads as alive.
  const rimIntensity = Math.min(1, 0.4 + bass * 0.46 + pulse * 0.26);
  const eclipseScale = 1 + bass * 0.07 + pulse * 0.05;
  const eclipseSize = Math.min(width, height) * 0.34;
  const sunPalette = {
    accent: colors.eclipseGold,
    background: palette.background || colors.deepField,
    glow: colors.eclipseGlow,
  };

  // The sun sits at the dead center of the tunnel (the point we fall toward); it
  // rises a touch over the clip so the journey lifts, echoing the cover figure.
  const eclipseY = interpolate(arc, [0, 1], [0.5, 0.44], { extrapolateRight: "clamp" });

  // Tower windows glow with the bass; the towers ground the quiet ends and sink
  // into shadow as the vortex swallows the frame.
  const windowGlow = Math.min(1.4, 0.5 + bass * 0.85 + pulse * 0.15);
  const towerOpacity = interpolate(arc, [0.12, 0.3], [1, 0.25], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const towerPalette = {
    accent: colors.eclipseGold,
    background: palette.background || colors.deepField,
    glow: colors.eclipseGlow,
  };

  // Energy opens the cosmos: faster drift, a touch more global float.
  const driftBoost = 1 + energy * 1.5;
  const floatBoost = 1 + energy * 0.7;

  // Onset = brief exposure spike: an additive gold-veil flash + a grain kick.
  const exposure = onset * 0.14;
  const grainKick = onset * 0.08;

  // The close-card reveal rides the arrive phase's clean 0..1.
  const closeArc = phase === "arrive" ? phaseProgress : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip window, trimmed via startFrom/endAt. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm radial wash centered on the sun + a bottom shadow ramp: depth
          without a flat black field, every neutral leaning warm. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 80% at 50% ${eclipseY * 100}%,
            ${withAlpha(colors.eclipseGold, 0.05)} 0%,
            ${withAlpha(palette.background, 0)} 45%),
            linear-gradient(180deg,
            ${withAlpha(palette.background, 0)} 40%,
            ${withAlpha(colors.deepField, 0.7)} 100%)`,
        }}
      />

      {/* Starfield: the quiet night the journey departs from; drifts faster as
          energy lifts. Always present. */}
      <Starfield
        seed={seed}
        density={140}
        depth={3}
        drift={{ x: 0.004 * driftBoost, y: -0.011 * driftBoost }}
        maxSize={2.6}
        twinkle={0.4}
      />

      {/* Tower blocks ground the bottom; they sink into shadow as the vortex
          takes the frame. */}
      <AbsoluteFill style={{ opacity: towerOpacity }}>
        <TowerBlocks
          palette={towerPalette}
          seed={seed % 7919}
          count={13}
          litWindowDensity={0.2}
          maxHeight={0.3}
          windowGlow={windowGlow}
        />
      </AbsoluteFill>

      {/* THE VEHICLE: the fractal vortex we fall through. Built from the
          artwork's heated oxblood + a soft paint plate, mirrored into every
          wedge; folds on the beat; spins and zooms through the loud middle.
          Gold stays out of the fractal (Retint Rule + One Sun Rule). */}
      <JourneyFractal
        segments={8}
        rings={5}
        size={width * 1.25}
        zoomPerSec={zoomPerSec}
        spinPerSec={spinPerSec}
        ringScale={0.6}
        foldOnBeat
        foldDegrees={14}
        beatGrid={audio.beatGrid}
        beatDecay={3.2}
        palette={fractalPalette}
        opacity={fractalOpacity}
      >
        {/* Paint-family wedge source: layered translucent chroma over warm dark.
            The HEAT (oxblood → Re-entry Red) leads; the cool blue survives only as
            a thin minor counter-accent at the wedge edge (the Retint Rule). The
            background sits dark so warm-dark wins and the gold sun stays loudest. */}
        <AbsoluteFill
          style={{ background: withAlpha(palette.background || colors.deepField, 0.55) }}
        />
        <AbsoluteFill
          style={{
            background: `radial-gradient(circle at 42% 36%,
              ${withAlpha(heat, 0.95)} 0%,
              ${withAlpha(heat, 0.55)} 34%,
              ${withAlpha(palette.background, 0)} 70%)`,
          }}
        />
        {/* The cool counter-accent: a single restrained edge glaze, never a field. */}
        <AbsoluteFill
          style={{
            background: `linear-gradient(150deg,
              ${withAlpha(counter, 0.32)} 0%,
              ${withAlpha(palette.background, 0)} 36%)`,
            mixBlendMode: "screen",
          }}
        />
        <DitherField
          pattern="halftone"
          scale={24}
          color={heat}
          threshold={0.4 + bass * 0.25}
          opacity={0.6}
          blendMode="multiply"
        />
      </JourneyFractal>

      {/* The One Sun: a single Eclipse at the vortex center, breathing with the
          low end. The dark warm occlusion core keeps it reading as an eclipse,
          shrinking the lit gold area to honour The One Sun Rule. */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start" }}>
        <div
          style={{
            left: "50%",
            position: "absolute",
            top: `${eclipseY * 100}%`,
            transform: `translate(-50%, -50%) scale(${eclipseScale})`,
          }}
        >
          <Eclipse
            size={eclipseSize}
            palette={sunPalette}
            rimIntensity={rimIntensity}
            grainAmount={0.16}
            seed={seed % 1000}
            variant="sun"
          />
          <div
            style={{
              background: `radial-gradient(circle at 50% 50%,
                ${withAlpha(colors.deepField, 0.97)} 0%,
                ${withAlpha(colors.deepField, 0.95)} ${52 + bass * 8}%,
                ${withAlpha(colors.deepField, 0)} ${78 + bass * 6}%)`,
              borderRadius: "50%",
              inset: 0,
              pointerEvents: "none",
              position: "absolute",
            }}
          />
        </div>
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
        {/* 0–3s: the artist as the brand-led opening mark. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
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

        {/* 3–6.6s: Artist — Title (the only sanctioned em dash). */}
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

        {/* 6.6–8.6s: Discovered date (tabular Oxanium). */}
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

        {/* The close card: the constant ending, revealed on the arrive phase.
            Holds the single permitted Eclipse Gold type moment (signature). */}
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

      {/* Onset exposure spike: a brief additive gold veil over the whole frame. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 60% at 50% ${eclipseY * 100}%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS. The onset kick thickens it briefly. */}
      <Grain
        opacity={0.16 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* Faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 46%,
            ${withAlpha(colors.deepField, 0)} 55%,
            ${withAlpha(colors.deepField, 0.55)} 100%)`,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

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
