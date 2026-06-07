// "VisualTestGlass" — the GLASS travelling vehicle for one track.
//
// One Vehicle Rule: GLASS. A curtain of refractive blades (<JourneyGlass>)
// sweeps across the frame over the journey arc; everything else (starfield,
// one Eclipse limb, tower blocks, type) is subordinate. The blades breathe on
// the bass and roll their warm flamefold across the clip — the travel.
//
// Track: Bugwell — Everything In Its Right Place. The analysed clip starts deep
// in the tune (startMs 9950) and rides a sustained ~171 BPM roller, so the scene
// is mostly chorus: it breathes hard and the curtain travels the whole way.
//
// Journey (named): the cover-art astronaut's view DEPARTS the tower blocks,
// TRAVELS through a warm glass curtain refracting the deep field, and ARRIVES at
// the close card. Three phases share one useJourney clock.
//
// Texture family: FLUENT (liquid glass ribs, the flamefold) leading, with a thin
// analog grain pass over everything.
//
// Retint Rule: the artwork is cool (blue accent #3d6baf, dark-red glow #72191c).
// I bend the curtain field toward the warm canon (Re-entry Red field, gold crest)
// and let a single cool blue swatch survive only as a minor counter-accent in the
// star colour and one specular tint — never a field.
//
// Constants kept: Grain over everything; exactly ONE Eclipse (a limb, the sun);
// the one Eclipse Gold type moment is the close-card signature; warm darks;
// Artist — Title + Discovered date; the close card. Determinism: frame-/seed-/
// curve-derived only.

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
  JourneyGlass,
  Starfield,
  TowerBlocks,
  mix,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// Safe inset (the exemplar's contract): keep all type clear of the 1080x1920
// edges and platform chrome.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

export const VisualTestGlass: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  // Shared narrative clock. A quick depart, a long glass travel, a settled
  // arrive — the curtain owns the middle, the close card owns the end.
  const { arc, phase, phaseProgress } = useJourney({ ease: 1, split: [0.16, 0.82] });

  // Audio-reactive scalars. This is a roller that hits hard once it lands, so
  // the gain is generous: the curtain breathes, the limb rim swells.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // Retint: warm-canon field, cool blue as a minor counter-accent only.
  const warmField = colors.reentryRed; // the flamefold field
  const coolCounter = palette.swatches[0] ?? palette.accent; // the surviving blue
  const starColor = mix(colors.starlightCream, coolCounter, 0.1); // a cool whisper, minor

  // The glass curtain palette: warm dark ground, Re-entry-Red field, gold-glow
  // crest. Keeps the glass subordinate to the single Eclipse sun.
  const glassPalette = {
    accent: warmField,
    background: palette.background || colors.deepField,
    glow: colors.eclipseGlow,
    ink: colors.starlightCream,
    swatches: palette.swatches,
  };

  // The curtain fades in as we depart, holds through travel, and thins as we
  // arrive so the close card reads clean. Travel is its loudest moment.
  const curtainOpacity =
    phase === "depart"
      ? interpolate(phaseProgress, [0, 1], [0.35, 0.85], { extrapolateRight: "clamp" })
      : phase === "travel"
        ? interpolate(phaseProgress, [0, 0.85, 1], [0.85, 0.92, 0.7])
        : interpolate(phaseProgress, [0, 1], [0.7, 0.32], { extrapolateRight: "clamp" });

  // The ONE Eclipse: a burning limb, the sun behind the glass. It rises gently
  // along the arc (the figure floating up out of the towers) and its rim swells
  // with the low end + beat. Gold lives here and on the close signature. Sized
  // and lit strong so it still reads as the One Sun THROUGH the curtain rather
  // than washing out into a pale blob.
  const eclipseY = interpolate(arc, [0, 1], [0.5, 0.36]);
  const eclipseSize = Math.min(width, height) * 0.52;
  const rimIntensity = Math.min(1, 0.55 + bass * 0.4 + pulse * 0.26);
  const eclipseScale = 1 + bass * 0.05 + pulse * 0.04;

  // Tower windows pulse with the bass; the city the figure leaves behind.
  const windowGlow = Math.min(1.4, 0.5 + bass * 0.8 + pulse * 0.15);

  // Energy opens the cosmos; onsets kick the grain for a film flicker.
  const driftBoost = 1 + energy * 1.5;
  const floatBoost = 1 + energy * 0.7;
  const grainKick = onset * 0.08;
  const exposure = onset * 0.14;

  // Type windows (seconds), inside the safe inset.
  const sec = frame / fps;
  const T = { metaIn: 7.4, metaOut: 12.0, trackIn: 2.6, trackOut: 8.4 };

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm depth wash: lifts the eclipse area, sinks the towers in shadow. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 80% at 50% ${eclipseY * 100}%,
            ${withAlpha(colors.eclipseGold, 0.05)} 0%,
            ${withAlpha(palette.background, 0)} 46%),
            linear-gradient(180deg,
            ${withAlpha(palette.background, 0)} 38%,
            ${withAlpha(colors.deepField, 0.72)} 100%)`,
        }}
      />

      {/* THE VEHICLE: the glass curtain. It sweeps right across the journey and
          refracts everything behind it — the starfield, the one Eclipse limb,
          the towers. The travel is the sweep; the breathing is the bass. */}
      <JourneyGlass
        bladeCount={11}
        sweep="right"
        sweepPerSec={0.05}
        refraction={0.66}
        breathe={0.6}
        bassCurve={audio.bassCurve}
        energyCurve={audio.energyCurve}
        palette={glassPalette}
        opacity={curtainOpacity}
      >
        {/* Behind the glass: the cover-art cosmos. Subordinate to the curtain. */}
        <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
          <Starfield
            seed={seed}
            density={150}
            depth={3}
            drift={{ x: 0.004 * driftBoost, y: -0.011 * driftBoost }}
            color={starColor}
            maxSize={2.8}
            twinkle={0.42}
          />

          {/* The One Sun: a single Eclipse limb, breathing, rising on the arc. */}
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
                palette={{
                  accent: colors.eclipseGold,
                  background: palette.background,
                  glow: colors.eclipseGlow,
                }}
                rimIntensity={rimIntensity}
                grainAmount={0.16}
                seed={seed % 1000}
                variant="limb"
              />
              {/* Warm occlusion core: a dark body crosses the disc so it reads as
                  an ECLIPSE (a burning crescent rim), not a flat gold ball. Only
                  the rim stays lit — shrinking the gold area (One Sun Rule) and
                  cutting the pale-blob wash from the glass in front. Eases open
                  with the bass so the rim flares on drops. */}
              <div
                style={{
                  background: `radial-gradient(circle at 50% 50%,
                    ${withAlpha(colors.deepField, 0.96)} 0%,
                    ${withAlpha(colors.deepField, 0.94)} ${50 + bass * 8}%,
                    ${withAlpha(colors.deepField, 0)} ${76 + bass * 6}%)`,
                  borderRadius: "50%",
                  inset: 0,
                  pointerEvents: "none",
                  position: "absolute",
                }}
              />
            </div>
          </AbsoluteFill>

          {/* Tower blocks ground the bottom; windows pulse with the bass. */}
          <TowerBlocks
            palette={{
              accent: colors.eclipseGold,
              background: palette.background,
              glow: colors.eclipseGlow,
            }}
            seed={seed % 7919}
            count={13}
            litWindowDensity={0.2}
            maxHeight={0.28}
            windowGlow={windowGlow}
          />
        </AbsoluteFill>
      </JourneyGlass>

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* Artist — Title (the only sanctioned em dash). */}
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

        {/* Discovered date (tabular Oxanium). */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 110, left: MARGIN_X, position: "absolute" }}
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

        {/* The close card, driven by the journey's ARRIVE phase. The one
            permitted Eclipse Gold type moment (the selector signature). */}
        <CloseCard
          arc={phase === "arrive" ? phaseProgress : 0}
          floatBoost={floatBoost}
          style={{
            bottom: SAFE_BOTTOM + 320,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        />
      </AbsoluteFill>

      {/* Onset exposure spike: a brief additive warm veil over the frame. */}
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

      {/* GRAIN OVER EVERYTHING, ALWAYS. Onset briefly thickens it. */}
      <Grain
        opacity={0.16 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to hold the warm dark and seat the type. */}
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
 * envelope is frame-derived. Mirrors the exemplar's TimedBlock.
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
