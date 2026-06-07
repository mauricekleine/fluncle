import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { type CSSProperties } from "react";
import { colors } from "@fluncle/tokens";
import { type NostalgicCosmosProps } from "../types";
import {
  CloseCard,
  FloatingType,
  Grain,
  Starfield,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// "FourSeasonsRidge" — System & Wise — 4 Seasons (Soul Bros. Records).
//
// ARCHIVED, SELF-CONTAINED COMPOSITION. Imports only the surviving core
// (audio hooks, CloseCard, FloatingType, Starfield, Grain, color helpers,
// tokens, remotion/react). The travelling lines vehicle is INLINED below as
// `RidgeField` — adapted from the old JourneyLines (ridge mode only) so this
// file re-renders forever without the deleted Journey vehicle set.
//
// Concept (one line): a travelling waveform-ridge terrain rolls past like the
// seasons turning; the field departs near-flat in the quiet build, then crests
// into mountains on the 9s drop while its single gold crest line IGNITES into
// the One Sun moment — the sun is expressed THROUGH the vehicle, never as a
// second celestial body.
//
// Brand grammar:
//   - ONE DRIVER (One Vehicle Rule): the ridge field is the sole vehicle,
//     visible from frame one (a calm cream terrain) and intensifying across the
//     clip. There is NO celestial disc. The sun lives in the gold crest line.
//   - ONE SUN, expressed through the vehicle: exactly one Eclipse Gold accent
//     line catches the centre crest; it flares and ignites on the drop, its
//     warm bloom washing the sky from the crest, not from a disc.
//   - TEXTURE FAMILY: fluent — a liquid roller breathes, it does not stomp; the
//     motion lives in the rolling ridge surface and a slow gradient wash.
//   - The artwork is cold (teals/greens/slates). Per the Retint Rule and the
//     Loadstar incident, those hues never become a field: they ride as a faint
//     cool counter-wash in the upper sky only, never extinguishing the sun.
//   - Grain over everything, warm darks, the close card.
//
// Determinism: only frame- and seed-derived values + the audio arrays.

const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// The hard drop lands ~9s in (energy/bass jump from ~0.25 to ~0.72). The ridge
// field and the gold crest sun are built to crest/ignite there.
const DROP_SEC = 9;

// Scene beats in seconds. The type rides the music's two halves: the quiet
// build names the artist + track, the drop carries the date, the tail closes.
const T = {
  artistIn: 0.5,
  artistOut: 4.4,
  closeIn: 16.0,
  metaIn: 9.4,
  metaOut: 14.0,
  trackIn: 4.2,
  trackOut: 9.2,
};

// The centre crest peaks toward this fractional sky height — the gold sun
// moment lives here, so the warm sky bloom anchors to it.
const CREST_Y = 0.5;

export const FourSeasonsRidge: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // Shared narrative clock. The ridge field and the close card travel on it.
  const journey = useJourney({ split: [0.12, 0.8] });
  // The arrive phase drives the close card reveal and its legibility scrim.
  const arriveProgress = journey.phase === "arrive" ? journey.phaseProgress : 0;

  // --- Audio-reactive scalars ----------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // The ridge amplitude opens up on the drop: a low calm field through the
  // build, mountains after. The journey arc carries the slow swell; bass adds
  // the snap.
  const dropLift = interpolate(sec, [DROP_SEC - 1.2, DROP_SEC + 0.6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ridgeAmplitude = 0.14 + dropLift * 0.34 + bass * 0.08;

  // THE SUN, THROUGH THE VEHICLE: the gold crest line's ignition. Near-ember in
  // the build, it catches fire on the drop and breathes with the low end and the
  // beat — the single Eclipse Gold light in the frame.
  const crestIgnite = Math.min(1, 0.22 + dropLift * 0.5 + bass * 0.28 + pulse * 0.22);

  // Energy opens the cosmos up: faster drift + a touch more global float.
  const driftBoost = 1 + energy * 1.4;
  const floatBoost = 1 + energy * 0.7;

  // Onset = brief exposure spike at the crest + a grain kick.
  const exposure = onset * 0.14;
  const grainKick = onset * 0.07;

  // The cool artwork hues live ONLY as a faint upper-sky counter-wash. Pick the
  // coldest swatch available; fall back to a slate. Never a field, never gold.
  const coolSwatch = palette.swatches[4] ?? palette.swatches[3] ?? "#578c90";

  // Custom ridge displacement: a travelling terrain that flattens in the build
  // and rolls into peaks after the drop. Pure (x, arc) so it stays deterministic;
  // the journey arc scrolls it left so the seasons read as moving past.
  const phase = journey.arc * Math.PI * 2;
  const ridgeField = (x: number, arc: number): number => {
    const roll =
      0.5 +
      0.3 * Math.sin(x * Math.PI * 5 + phase) +
      0.16 * Math.sin(x * Math.PI * 11 - phase * 1.6) +
      0.08 * Math.sin(x * Math.PI * 19 + phase * 0.7);
    // A centre crest so the one gold accent line peaks toward the sun position.
    const crest = Math.exp(-Math.pow((x - 0.5) / 0.34, 2));
    return Math.min(1, Math.max(0, roll * (0.4 + arc * 0.4) + crest * 0.18));
  };

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to the window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Sky: warm gold bloom anchored to the CREST (the sun lives in the ridge,
          not a disc), a faint COOL counter-wash up top (the artwork's teal/slate,
          kept minor), deeper warm dark at the horizon so the ridge sits in
          shadow. The bloom swells with the crest's ignition. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 64% at 50% ${CREST_Y * 100}%,
            ${withAlpha(colors.eclipseGold, 0.05 + crestIgnite * 0.07)} 0%,
            ${withAlpha(palette.background, 0)} 44%),
            linear-gradient(180deg,
            ${withAlpha(coolSwatch, 0.1)} 0%,
            ${withAlpha(palette.background, 0)} 34%,
            ${withAlpha(colors.deepField, 0.72)} 100%)`,
        }}
      />

      {/* Starfield over the upper sky; drifts faster as energy lifts. */}
      <Starfield
        seed={seed}
        density={130}
        depth={3}
        drift={{ x: 0.003 * driftBoost, y: -0.009 * driftBoost }}
        maxSize={2.6}
        twinkle={0.4}
      />

      {/* THE VEHICLE (One Driver): the travelling ridge field. Visible from frame
          one as a calm cream terrain; it rolls and crests on the drop. The one
          Eclipse Gold accent line catches the centre crest and IGNITES with the
          drop — that is the sun. A vertical mask releases the very top (so the
          sky breathes and the artist mark reads) and the very bottom (so the
          close card has a clean bed); the field stays dense through the middle. */}
      <RidgeField
        displacement={ridgeField}
        lineCount={44}
        amplitude={ridgeAmplitude}
        strokeWidth={2}
        accentIndex={22}
        accentGlow={crestIgnite}
        color={withAlpha(colors.starlightCream, 0.85)}
        accentColor={colors.eclipseGold}
        width={width}
        height={height}
        style={{
          WebkitMaskImage: `linear-gradient(180deg,
            transparent 0%, rgba(0,0,0,1) 14%,
            rgba(0,0,0,1) 76%, transparent 96%)`,
          maskImage: `linear-gradient(180deg,
            transparent 0%, rgba(0,0,0,1) 14%,
            rgba(0,0,0,1) 76%, transparent 96%)`,
        }}
      />

      {/* Close-card scrim (The Legible Sky Rule): a warm-dark wash anchored to
          the lower-left, fading in with the arrive phase so the tagline and the
          gold signature read cleanly over the still-rolling ridge. Above the
          ridge, below the type and grain. */}
      {arriveProgress > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(120% 46% at 28% 86%,
              ${withAlpha(colors.deepField, 0.82 * arriveProgress)} 0%,
              ${withAlpha(colors.deepField, 0.5 * arriveProgress)} 40%,
              ${withAlpha(colors.deepField, 0)} 72%)`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* --- TYPE TIMELINE (all inside the safe inset) ----------------------- */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* Build: the artist as the brand-led opening mark. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
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

        {/* Across the drop: Artist — Title (the only sanctioned em dash). */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{
            bottom: SAFE_BOTTOM + 160,
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

        {/* After the drop: the Discovered date (tabular Oxanium). */}
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

        {/* The close card — driven by the journey's arrive phase, so it reveals
            exactly as the journey settles. Holds the one permitted gold type. */}
        <CloseCard
          arc={arriveProgress}
          floatBoost={floatBoost}
          style={{
            bottom: SAFE_BOTTOM + 220,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        />
      </AbsoluteFill>

      {/* Onset exposure spike: a brief additive gold veil at the crest. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 46% at 50% ${CREST_Y * 100}%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 58%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* GRAIN OVER EVERYTHING, ALWAYS. The onset kick briefly thickens it. */}
      <Grain
        opacity={0.16 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 48%,
            ${withAlpha(colors.deepField, 0)} 55%,
            ${withAlpha(colors.deepField, 0.55)} 100%)`,
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

// --- Inlined vehicle: the ridge field --------------------------------------

type RidgeFieldProps = {
  /** Pure displacement field: (x 0..1, arc 0..1) => 0..1 height. */
  displacement: (x: number, arc: number) => number;
  /** Number of stacked ridge lines. */
  lineCount: number;
  /** Displacement push as a fraction of field height. */
  amplitude: number;
  /** Base stroke width in px. */
  strokeWidth: number;
  /** Index of the ONE gold crest line (the sun). */
  accentIndex: number;
  /**
   * Ignition 0..1 of the gold crest line — the sun expressed through the
   * vehicle. Scales its opacity, stroke and glow so it flares on the drop.
   */
  accentGlow: number;
  /** Cream ink for the field lines. */
  color: string;
  /** Eclipse Gold for the one accent crest. */
  accentColor: string;
  width: number;
  height: number;
  style?: CSSProperties;
};

/**
 * The travelling ridge vehicle, inlined from the (now-deleted) JourneyLines
 * ridge mode. A stack of horizontal polylines pushed upward by the displacement
 * field into receding terrain; far rows ride higher. Exactly one line — the
 * crest — catches Eclipse Gold and ignites via `accentGlow` (the One Sun moment,
 * carried by the vehicle). Pure SVG, deterministic, CPU-friendly.
 */
const RidgeField: React.FC<RidgeFieldProps> = ({
  displacement,
  lineCount,
  amplitude,
  strokeWidth,
  accentIndex,
  accentGlow,
  color,
  accentColor,
  width,
  height,
  style,
}) => {
  const { arc } = useJourney({ split: [0.12, 0.8] });

  const displaceAt = (x: number): number => Math.min(1, Math.max(0, displacement(x, arc)));

  const renderLine = (i: number): React.ReactNode => {
    const isAccent = i === accentIndex;
    const stroke = isAccent ? accentColor : color;
    const baseOpacity = isAccent ? 0.55 + accentGlow * 0.45 : 0.5 + (i / lineCount) * 0.25;

    const rowY = lineCount <= 1 ? 0.5 : i / (lineCount - 1);
    const samples = 64;
    const points: string[] = [];
    for (let s = 0; s <= samples; s++) {
      const x = s / samples;
      const d = displaceAt(x);
      // ridge: each line is a baseline pushed upward by the field; far rows
      // (higher i) ride higher so the stack reads as receding terrain.
      const lift = d * amplitude * (0.5 + rowY * 0.5);
      const py = (rowY - lift) * height;
      points.push(`${(x * width).toFixed(1)},${py.toFixed(1)}`);
    }

    // The gold crest ignites: stroke and glow grow with accentGlow so the line
    // reads as catching fire on the drop — the sun, through the vehicle.
    const accentWidth = strokeWidth * (1.4 + accentGlow * 1.2);
    const glowRadius = strokeWidth * (2 + accentGlow * 7);
    return (
      <polyline
        key={i}
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={isAccent ? accentWidth : strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={baseOpacity}
        style={
          isAccent
            ? {
                filter: `drop-shadow(0 0 ${glowRadius}px ${withAlpha(
                  accentColor,
                  0.35 + accentGlow * 0.5,
                )})`,
              }
            : undefined
        }
      />
    );
  };

  const lines: React.ReactNode[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(renderLine(i));
  }

  return (
    <div
      aria-hidden
      style={{
        height,
        pointerEvents: "none",
        position: "absolute",
        width,
        ...style,
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", height: "100%", width: "100%" }}
      >
        {lines}
      </svg>
    </div>
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
