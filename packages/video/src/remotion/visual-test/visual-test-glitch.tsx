// "VisualTestGlitch" — the GLITCH travelling vehicle, authored as a real scene.
//
// Track: Bugwell — Everything In Its Right Place (171 BPM techy/neuro roller).
// Concept (the journey): SIGNAL LOST → SIGNAL FOUND. We depart inside a corrupted
// transmission: the Eclipse is buried under a dither storm and an RGB channel
// tear, the picture scrambled. As the drop lands, a corruption FRONT travels
// across the frame; by arrival the static has swept off and the sun burns clean —
// everything, at last, in its right place. The one Eclipse Gold sun moment lands
// at arrival, when the corruption clears the disc.
//
// One Vehicle Rule: the GLITCH carries it (JourneyGlitch, sweep + channel-split).
// Texture family: DITHER (the matrix/Discman pole), retinted warm per the Retint
// Rule — cream dither, Eclipse-Gold / Re-entry-Red channel tears, never the
// artwork's cool blue as a field; the blue survives only as a faint star tint.
// Everything else (Starfield, Eclipse, TowerBlocks, type) supports the glitch.
//
// Brand constants held: ONE Eclipse (the sun), Grain over everything, warm darks,
// Artist — Title em dash, Discovered date, the close card with the single gold
// type moment. Determinism: frame-, seed-, and audio-array-derived values only.

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
  Eclipse,
  FloatingType,
  Grain,
  JourneyGlitch,
  Starfield,
  TowerBlocks,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// Safe inset (matches the exemplar): keep all type clear of the 1080x1920 edges.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

export const VisualTestGlitch: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // Shared narrative clock. A quick depart, a long travel through the corruption,
  // a settled arrival where the picture resolves.
  const { arc, phase, phaseProgress } = useJourney({ split: [0.18, 0.8] });

  // --- Audio-reactive scalars ----------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 7 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.4 });
  const onset = useOnset(audio.onsets, 140);

  // The sun resolves as the journey arrives: buried at depart, burning at arrive.
  // The corruption clearing off the disc IS the one gold moment, so let the rim
  // brighten with `arc` (the resolve) on top of the bass/beat swell.
  const resolve = arc; // 0 scrambled → 1 resolved
  const rimIntensity = Math.min(1, 0.2 + resolve * 0.72 + bass * 0.3 + pulse * 0.2);
  const eclipseScale = 1 + resolve * 0.04 + bass * 0.05 + pulse * 0.04;

  // As the picture resolves, the eclipse occlusion eases open so more of the
  // burning disc shows: the sun goes from a thin ghost rim (scrambled) to a full
  // hero disc (arrived). This is the "signal found" payoff.
  const occlusionMid = 52 + bass * 8 - resolve * 14;
  const occlusionEnd = 78 + bass * 6 - resolve * 6;

  // The eclipse rises gently as the figure floats up out of the towers.
  const eclipseY = interpolate(arc, [0, 1], [0.46, 0.36], { extrapolateRight: "clamp" });
  const eclipseSize = Math.min(width, height) * 0.5;

  // Tower windows pulse with the low end; brighter once the picture resolves.
  const windowGlow = Math.min(1.4, 0.4 + resolve * 0.35 + bass * 0.8 + pulse * 0.15);

  // Energy opens the cosmos up (drift + float), subtly.
  const driftBoost = 1 + energy * 1.5;
  const floatBoost = 1 + energy * 0.7;

  // Onset = brief exposure spike + grain kick (a neuro track snaps hard).
  const exposure = onset * 0.18;
  const grainKick = onset * 0.1;

  // The corruption fades OUT as the journey arrives: the storm clears so the sun
  // can hold the frame clean at the end. Driven by the arrive phase.
  const glitchOpacity =
    phase === "arrive"
      ? interpolate(phaseProgress, [0, 0.55], [0.92, 0.06], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : interpolate(resolve, [0, 1], [1, 0.78], { extrapolateRight: "clamp" });

  // The sun keeps the brand gold rim regardless of the cool artwork (One Sun).
  const sunPalette = {
    accent: colors.eclipseGold,
    background: palette.background,
    glow: colors.eclipseGlow,
  };
  const towerPalette = sunPalette;

  // Glitch palette: warm-retinted channels (the Retint Rule). Cream body,
  // Re-entry-Red as the heat channel. The artwork's cool blue never becomes a
  // field here; it only tints the starfield faintly below.
  const glitchPalette = {
    accent: colors.reentryRed,
    ink: colors.starlightCream,
  };

  // Close-card arrive timing: reveal in the back third as the picture resolves.
  const closeArc = interpolate(
    sec,
    [durationInFrames / fps - 3.4, durationInFrames / fps - 2.4],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm depth wash: the eclipse area lifts, the towers sit in deeper dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 80% at 50% ${eclipseY * 100}%,
            ${withAlpha(colors.eclipseGold, 0.05)} 0%,
            ${withAlpha(palette.background, 0)} 45%),
            linear-gradient(180deg,
            ${withAlpha(palette.background, 0)} 38%,
            ${withAlpha(colors.deepField, 0.72)} 100%)`,
        }}
      />

      {/* Starfield: the artwork's blue survives only here, as a faint cool tint
          on the stars (a minor counter-accent per the Retint Rule). */}
      <Starfield
        seed={seed}
        density={150}
        depth={3}
        drift={{ x: 0.004 * driftBoost, y: -0.011 * driftBoost }}
        maxSize={2.8}
        twinkle={0.42}
        color={palette.swatches[4] ?? colors.starlightCream}
      />

      {/* The GLITCH vehicle carries the journey. It corrupts the cosmos+sun layer
          beneath it: a sweep front travels across as the drop lands, RGB-warm
          channel tears kick on every onset. The corruption is the transmission
          we're tuning through; it clears as we arrive. */}
      <JourneyGlitch
        mode="sweep"
        sweepAngle={108}
        travelPerSec={0.085}
        feather={0.3}
        density="onset"
        ditherPattern="pixel"
        cellSize={13}
        splitStrength={11}
        onsets={audio.onsets}
        energyCurve={audio.energyCurve}
        palette={glitchPalette}
        seed={seed % 7919}
        opacity={glitchOpacity}
      >
        {/* The content being corrupted: the One Sun rising over the towers. */}
        <AbsoluteFill>
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
              {/* Eclipse occlusion: a warm dark core so only the burning rim
                  lights, honouring the One Sun Rule. */}
              <div
                style={{
                  background: `radial-gradient(circle at 50% 50%,
                    ${withAlpha(colors.deepField, 0.97)} 0%,
                    ${withAlpha(colors.deepField, 0.95)} ${occlusionMid}%,
                    ${withAlpha(colors.deepField, 0)} ${occlusionEnd}%)`,
                  borderRadius: "50%",
                  inset: 0,
                  pointerEvents: "none",
                  position: "absolute",
                }}
              />
            </div>
          </AbsoluteFill>

          <TowerBlocks
            palette={towerPalette}
            seed={seed % 6151}
            count={13}
            litWindowDensity={0.2}
            maxHeight={0.3}
            windowGlow={windowGlow}
          />
        </AbsoluteFill>
      </JourneyGlitch>

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* Opening mark: the artist, scrambling in. */}
        <TimedBlock
          inSec={0.4}
          outSec={3.4}
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

        {/* Artist — Title (the only sanctioned em dash). */}
        <TimedBlock
          inSec={3.2}
          outSec={8.0}
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
          inSec={8.0}
          outSec={12.0}
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

        {/* The close card: the single permitted gold type moment, arriving as the
            picture resolves. */}
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

      {/* Onset exposure spike: a brief additive gold veil at the sun. */}
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

      {/* GRAIN OVER EVERYTHING, ALWAYS. Onset kicks thicken it briefly. */}
      <Grain
        opacity={0.16 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* Cinematic vignette to seat the type and hold the warm dark. */}
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

// --- Helpers ---------------------------------------------------------------

/** Fade + float in/out over a [inSec, outSec) window. Pure, frame-derived. */
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
