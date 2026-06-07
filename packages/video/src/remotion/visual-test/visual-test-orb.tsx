// "VisualTestOrb" — a real orb-vehicle scene for Bugwell — Everything In Its
// Right Place. Texture family: NEBULA (soft Starfield + grainy gradient washes,
// the orb as a rim-lit planet). One Vehicle: the orb (the Eclipse sun). Journey:
// a cool, distant planet drifts up out of the tower blocks, crosses the warm
// starfield, and arrives as the full burning hero sun over the city — awe and
// melancholy, the cover art set to one roller.
//
// Brand constants kept: Grain over EVERYTHING; ONE Eclipse Gold moment (the orb
// rim is the single light source, plus the close-card signature); warm darks via
// paletteMix; Oxanium marks/numerals through FloatingType; "Artist — Title" em
// dash; "Discovered" date; the close card. The artwork's cool blue chroma colors
// the cosmos wash — gold stays reserved for the sun.
//
// Determinism: frame- and seed-derived only. Audio reactivity comes from the
// audio.* arrays through the hooks; no Math.random / Date.now in the render.

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
  JourneyOrb,
  paletteMix,
  Starfield,
  TowerBlocks,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";

// Safe margins (README authoring rules): keep all type inside this inset.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds. The big drop in this clip lands ~9s in (the energy
// curve jumps from a breakdown into full roller); that is where the orb's rim
// flares and the city lifts.
const T = {
  brandIn: 0.4,
  brandOut: 3.0,
  metaIn: 5.4,
  metaOut: 8.6,
  trackIn: 3.0,
  trackOut: 8.6,
};

export const VisualTestOrb: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette: rawPalette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // Bend the artwork's own swatches toward the brand anchors. This artwork reads
  // cool (broadcast blues), so the accent stays the artwork's blue and the gold
  // is reserved entirely for the sun — a cool night under the same warm sun.
  const palette = paletteMix(rawPalette.swatches, { backgroundDrift: 0.16 });

  // --- Audio-reactive scalars ----------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // The shared narrative clock. A quick depart, a long drift, a settled arrive —
  // the orb and the close card travel along the identical arc.
  const { phase, phaseProgress } = useJourney();

  // Energy opens the cosmos: faster starfield drift + a touch more float when
  // the roller lifts. The cosmos breathes, it does not scroll.
  const driftBoost = 1 + energy * 1.5;
  const floatBoost = 1 + energy * 0.7;

  // Onset = brief exposure spike: an additive gold-veil flash + a grain kick.
  const exposure = onset * 0.15;
  const grainKick = onset * 0.08;

  // Tower windows glow with the bass: the lit windows in the city the figure
  // floats out of (DESIGN.md).
  const windowGlow = Math.min(1.4, 0.5 + bass * 0.9 + pulse * 0.15);

  // The orb travels along a custom path: it rises up out of the towers (low and
  // small), drifts toward upper-center, and arrives large as the hero sun. A
  // gentle horizontal drift keeps it floaty rather than rail-straight.
  const orbPath = (arc: number) => ({
    scale: 0.5 + arc * 0.7,
    x: 0.5 + Math.sin(arc * Math.PI) * 0.06,
    y: 0.7 - arc * 0.32,
  });

  // The sun keeps the brand gold rim/glow regardless of the cool artwork: the
  // Eclipse is the reserved One Sun. Its body leans on the warm dark background.
  const sunPalette = {
    accent: colors.eclipseGold,
    background: palette.background,
    glow: colors.eclipseGlow,
  };

  // Tower palette: warm silhouettes, gold-lit windows (the One Sun reading).
  const towerPalette = {
    accent: colors.eclipseGold,
    background: palette.background,
    glow: colors.eclipseGlow,
  };

  // The wash centers on the orb's vertical travel so the lit region rises with it.
  const washY = interpolate(sec, [0, durationInFrames / fps], [0.68, 0.36], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the real clip, trimmed to the analysed window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* Warm vertical wash + a cool nebula bloom from the artwork chroma, so the
          bottom sits in deeper shadow and the orb area lifts. Gold stays tiny and
          on the sun; the artwork's blue colors the cosmos, never the sun. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 85% at 50% ${washY * 100}%,
            ${withAlpha(colors.eclipseGold, 0.045)} 0%,
            ${withAlpha(palette.accent, 0.08)} 32%,
            ${withAlpha(palette.background, 0)} 60%),
            linear-gradient(180deg,
            ${withAlpha(palette.background, 0)} 38%,
            ${withAlpha(colors.deepField, 0.72)} 100%)`,
        }}
      />

      {/* Starfield: warm-white stars drifting faster as the roller lifts. */}
      <Starfield
        seed={seed}
        density={160}
        depth={3}
        drift={{ x: 0.004 * driftBoost, y: -0.012 * driftBoost }}
        maxSize={2.7}
        twinkle={0.42}
      />

      {/* The One Vehicle: the orb travelling the journey arc, rising out of the
          towers into the hero sun. The surface is the canon grainy Eclipse with a
          dark warm occlusion core over it, so it reads as an ECLIPSE (a body
          crossing the sun) — only the burning rim stays lit, shrinking the gold
          area to honour The One Sun Rule. The occlusion eases open with the bass
          so the rim flares on the drop. The rim swells with the low end and snaps
          on the beat. */}
      <JourneyOrb
        size={Math.min(width, height) * 0.46}
        path={orbPath}
        palette={sunPalette}
        variant="sun"
        rimIntensity={0.5 + bass * 0.4 + pulse * 0.22}
        beatPulse={0.05}
        beatGrid={audio.beatGrid}
        bassBreath={0.05}
        bassCurve={audio.bassCurve}
      >
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Eclipse
            size={Math.min(width, height) * 0.46}
            palette={sunPalette}
            rimIntensity={0.5 + bass * 0.4 + pulse * 0.22}
            grainAmount={0.16}
            seed={seed % 1000}
            variant="sun"
          />
          {/* Eclipse occlusion: a dark warm core over the burning disc so only
              the rim stays lit. Eases open with the bass so the rim flares on
              drops (the cover's signature drama). */}
          <div
            style={{
              background: `radial-gradient(circle at 50% 50%,
                ${withAlpha(colors.deepField, 0.97)} 0%,
                ${withAlpha(colors.deepField, 0.95)} ${50 + bass * 9}%,
                ${withAlpha(colors.deepField, 0)} ${76 + bass * 7}%)`,
              borderRadius: "50%",
              inset: 0,
              pointerEvents: "none",
              position: "absolute",
            }}
          />
        </AbsoluteFill>
      </JourneyOrb>

      {/* Tower blocks ground the bottom; windows pulse with the bass. */}
      <TowerBlocks
        palette={towerPalette}
        seed={seed % 7919}
        count={13}
        litWindowDensity={0.2}
        maxHeight={0.28}
        windowGlow={windowGlow}
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
        {/* 0–3s: the artist as the brand-led opening mark + the date. */}
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

        {/* 3–8.6s: Artist — Title (the only sanctioned em dash). */}
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

        {/* 5.4–8.6s: Discovered date (tabular Oxanium). */}
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

        {/* The close card reveals exactly as the journey ARRIVES: drive it with
            the arrive phase's clean 0..1. The one permitted gold type moment. */}
        <div
          style={{
            bottom: SAFE_BOTTOM + 320,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <CloseCard
            arc={phase === "arrive" ? phaseProgress : 0}
            palette={{ accent: colors.eclipseGold, ink: colors.starlightCream }}
            floatBoost={floatBoost}
          />
        </div>
      </AbsoluteFill>

      {/* Onset exposure spike: a brief additive gold veil over the frame. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 60% at 50% ${washY * 100}%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
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

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Returns null outside its window so it never costs
 * layout elsewhere in the clip.
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
