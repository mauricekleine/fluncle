// "VisualTestLines" — the lines vehicle scene for Bugwell — Everything In Its
// Right Place (a 171 roller: long quiet intro, then a drop that lands and stays
// in the pocket). The clip window opens right on that drop.
//
// One Vehicle Rule: LINES. A waveform-ridge terrain travels across the frame as
// a signal-landscape (the Unknown Pleasures motif from the moodboard). Journey:
// we depart from a flat silent plain, the terrain swells into mountains as the
// drop rolls, we fly low over the data-landscape under a single rising sun, and
// arrive as the ridges settle into the close card.
//
// Texture family: ANALOG — heavy Grain, exposure flares on onsets, a warm CRT
// vignette. The cool steel-blue artwork palette takes the Retint Rule: the
// terrain reads Starlight Cream over warm dark, with ONE Eclipse Gold crest as
// the single light source (The One Sun Rule). Everything else supports the lines.
//
// Determinism: only frame- and seed-derived values, plus the audio.* arrays
// through the hooks. No Math.random / Date.now.

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
  JourneyLines,
  Starfield,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// Safe margins (NostalgicCosmos convention): keep all type inside this inset.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds. The drop is already at the clip head, so the brand
// mark opens fast and the track line lands while the roller is in full flow.
const T = {
  brandIn: 0.4,
  brandOut: 3.4,
  metaIn: 7.0,
  metaOut: 10.6,
  trackIn: 3.2,
  trackOut: 7.6,
};

export const VisualTestLines: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // Shared narrative clock: the lines vehicle and the eclipse ride one arc. A
  // quick depart, a long travel (the roller holds), a settled arrive.
  const { arc, phase, phaseProgress } = useJourney({ split: [0.12, 0.82] });

  // --- Audio-reactive scalars ----------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.2 });
  const onset = useOnset(audio.onsets, 150);

  // The terrain amplitude grows as we travel then SETTLES as we arrive: a flat
  // plain at depart, mountains in the pocket, ridges easing back down into the
  // close. A raised-bell over the arc (peaks mid-travel) gives the settle so the
  // type reads at the arrival; energy keeps it alive throughout.
  const arcBell = Math.sin(Math.min(1, Math.max(0, arc)) * Math.PI); // 0→1→0
  const amplitude = 0.14 + arcBell * 0.36 + energy * 0.12;

  // The sun (one Eclipse) rises over the ridge horizon as the journey travels,
  // its rim burning on the low end and snapping on the beat. The crest line in
  // the field catches the same gold — the One Sun reading carries into the terrain.
  const rimIntensity = Math.min(1, 0.4 + bass * 0.46 + pulse * 0.26);
  const eclipseScale = 1 + bass * 0.05 + pulse * 0.04;
  const eclipseY = interpolate(arc, [0, 1], [0.46, 0.34], { extrapolateRight: "clamp" });
  const eclipseSize = Math.min(width, height) * 0.42;

  // Energy opens the cosmos; onsets spike a brief warm exposure + grain kick
  // (the analog flare). The roller's relentless onsets keep it flickering.
  const driftBoost = 1 + energy * 1.4;
  const floatBoost = 1 + energy * 0.7;
  const exposure = onset * 0.14;
  const grainKick = onset * 0.09;

  // The sun keeps the brand gold rim/glow regardless of the cool artwork: the
  // One Sun is always gold. The blue swatches color the cosmos elsewhere.
  const sunPalette = {
    accent: colors.eclipseGold,
    background: palette.background,
    glow: colors.eclipseGlow,
  };

  // The close card arrives on the journey's "arrive" phase (a clean 0..1).
  const closeArc = phase === "arrive" ? phaseProgress : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip window, trimmed via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm vertical wash: the horizon area lifts toward gold, the floor sits
          in deeper shadow. Depth without a flat black field. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 70% at 50% ${eclipseY * 100}%,
            ${withAlpha(colors.eclipseGold, 0.06)} 0%,
            ${withAlpha(palette.background, 0)} 48%),
            linear-gradient(180deg,
            ${withAlpha(palette.background, 0)} 38%,
            ${withAlpha(colors.deepField, 0.78)} 100%)`,
        }}
      />

      {/* Starfield over the horizon: drifts faster as energy lifts. Subordinate
          to the lines, kept sparse so the terrain stays the subject. */}
      <Starfield
        seed={seed}
        density={90}
        depth={3}
        drift={{ x: 0.003 * driftBoost, y: -0.009 * driftBoost }}
        maxSize={2.2}
        twinkle={0.35}
      />

      {/* The One Sun: a single Eclipse rising over the ridge horizon, breathing
          with the low end. Occluded core so it reads as an ECLIPSE, gold only
          on the burning rim. Sits behind the terrain. */}
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
                ${withAlpha(colors.deepField, 0.95)} ${50 + bass * 8}%,
                ${withAlpha(colors.deepField, 0)} ${76 + bass * 6}%)`,
              borderRadius: "50%",
              inset: 0,
              pointerEvents: "none",
              position: "absolute",
            }}
          />
        </div>
      </AbsoluteFill>

      {/* THE VEHICLE — the travelling line field. A waveform-ridge terrain whose
          amplitude swells as we travel; the field scrolls with the journey arc.
          One crest catches Eclipse Gold (the One Sun discipline in the terrain).
          Displacement is a custom field: a travelling double-sine gated by the
          smoothed energy so the silence-to-drop curve flattens, then erupts. */}
      <JourneyLines
        mode="ridge"
        journey={{ split: [0.12, 0.82] }}
        audio={audio}
        lineCount={56}
        amplitude={amplitude}
        strokeWidth={2}
        travel={1.4}
        accentIndex={Math.round(56 * 0.62)}
        accentColor={colors.eclipseGold}
        color={colors.starlightCream}
        displacement={(x, a) => {
          // Travelling terrain: two scrolled sines, gated by a raised-bell over
          // the arc so the plain rises into mountains mid-travel and SETTLES back
          // toward a calm horizon as we arrive (legible close). Pure (x, arc).
          const bellGate = Math.sin(Math.min(1, Math.max(0, a)) * Math.PI);
          const ph = a * 1.4 * Math.PI * 2;
          const wave =
            0.5 +
            0.34 * Math.sin(x * Math.PI * 7 + ph) +
            0.18 * Math.sin(x * Math.PI * 15 - ph * 1.6);
          return Math.min(1, Math.max(0, wave * (0.28 + bellGate * 0.72)));
        }}
        height={height}
        width={width}
        style={{ left: 0, top: 0 }}
      />

      {/* Legible Sky Rule: a warm-dark scrim rises from the bottom with the close
          so the cream tagline + gold signature hold contrast over the settling
          terrain. Painted UNDER the type timeline that follows. */}
      {closeArc > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `linear-gradient(180deg,
              ${withAlpha(colors.deepField, 0)} 56%,
              ${withAlpha(colors.deepField, 0.82 * closeArc)} 84%,
              ${withAlpha(colors.deepField, 0.9 * closeArc)} 100%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* 0–3.4s: the artist as the brand-led opening mark. */}
        <TimedBlock
          inSec={T.brandIn}
          outSec={T.brandOut}
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

        {/* 3.2–7.6s: Artist — Title (the only sanctioned em dash). */}
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
            fontSize={44}
            drift={6 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* 7–10.6s: Discovered date (tabular Oxanium). */}
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

        {/* The close card — arrives on the journey's "arrive" phase. Holds the
            single permitted gold type moment (the selector signature). */}
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

      {/* Onset exposure spike: a brief additive warm veil over the frame (analog
          flare). Centered on the horizon so the sun area blooms on transients. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 55% at 50% ${eclipseY * 100}%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS. The analog family runs it heavy; the
          onset kick briefly thickens it for a film-exposure flicker. */}
      <Grain
        opacity={0.18 + grainKick}
        intensity={0.82}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* Cinematic vignette to seat the type and hold the warm dark. */}
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

// --- Helpers ---------------------------------------------------------------

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

export default VisualTestLines;
