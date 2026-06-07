import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colors } from "@fluncle/tokens";
import { type NostalgicCosmosProps } from "./types";
import {
  DitherField,
  Eclipse,
  FloatingType,
  Grain,
  KaleidoMirror,
  Starfield,
  TowerBlocks,
  useBass,
  useBeat,
  useEnergy,
  useOnset,
  withAlpha,
} from "./cosmos";

// "NostalgicCosmos" — the exemplar composition (DESIGN.md visual canon,
// VOICE.md copy canon). A future agent studies this before writing its own
// per-track scenes, so every gesture is intentional and on-brand:
//
// - Deep warm-black space; a drifting Starfield; ONE large Eclipse anchor whose
//   rim is the only Eclipse Gold light source (The One Sun Rule); TowerBlocks
//   grounding the bottom; Grain over EVERYTHING, always.
// - Audio drives intensity: useBass swells the eclipse + city windows, useBeat
//   pulses the disc on the grid, useOnset spikes brief exposure/grain flashes,
//   useEnergy opens up the starfield drift and global float.
// - One KaleidoMirror passage mid-clip is the psychedelic peak.
// - Text: artist mark -> Artist — Title -> Discovered date -> close card.
//
// Determinism: only frame- and seed-derived values. No Math.random / Date.now
// inside the render (remotion random() + the audio arrays only).

// Safe margins: keep all type inside this inset so it never crowds the 1080x1920
// edges (and survives platform-chrome crops on vertical video).
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Scene beats in seconds (the brand grammar; intensity rides the audio).
const T = {
  brandIn: 0.4,
  brandOut: 3.2,
  closeIn: 16.6,
  kaleidoIn: 10.8,
  kaleidoOut: 15.0,
  metaIn: 6.6,
  metaOut: 10.4,
  trackIn: 3.0,
  trackOut: 7.4,
};

export const NostalgicCosmos: React.FC<NostalgicCosmosProps> = ({
  track,
  audio,
  palette,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const sec = frame / fps;

  // --- Audio-reactive scalars ----------------------------------------------
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 8 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.0 });
  const onset = useOnset(audio.onsets, 150);

  // The eclipse is the One Sun: a dark, occluded disc with a BURNING rim, not a
  // flat bright ball. The rim swells with the low end and snaps on the beat; the
  // disc breathes (scale) with bass + beat so it reads as alive, not a static
  // logo. Eclipse Gold lives ONLY at this rim and on one type accent — keeping
  // the lit gold area small honours The One Sun Rule (~10% of the frame).
  const rimIntensity = Math.min(1, 0.42 + bass * 0.45 + pulse * 0.28);
  const eclipseScale = 1 + bass * 0.06 + pulse * 0.045;

  // Tower windows glow with the bass: the lit windows in the towers (DESIGN.md).
  const windowGlow = Math.min(1.4, 0.55 + bass * 0.85 + pulse * 0.15);

  // Energy opens the cosmos up: faster drift + a touch more global float when the
  // tune lifts. The cosmos breathes, it does not scroll, so keep it subtle.
  const driftBoost = 1 + energy * 1.6;
  const floatBoost = 1 + energy * 0.8;

  // Onset = brief exposure spike: an additive gold-veil flash plus a grain kick.
  const exposure = onset * 0.16;
  const grainKick = onset * 0.08;

  // The kaleido passage slowly rotates and intensifies the psychedelic peak.
  const kaleidoActive = sec >= T.kaleidoIn - 0.5 && sec < T.kaleidoOut + 0.5;

  // The eclipse rises gently over the whole clip (the figure floats up out of the
  // towers, the sun sits on the horizon and lifts). Frame-derived, deterministic.
  const eclipseY = interpolate(sec, [0, durationInFrames / fps], [0.42, 0.34], {
    extrapolateRight: "clamp",
  });

  const eclipseSize = Math.min(width, height) * 0.5;

  // The eclipse uses the brand gold rim/glow regardless of the artwork palette:
  // the sun is the reserved gold. The artwork accent colors the cosmos elsewhere
  // (kaleido, dither), keeping the One Sun unambiguous even on cool artwork.
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

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the real clip, trimmed to the analysed window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* A warm vertical wash so the bottom (towers) sits in deeper shadow and the
          eclipse area lifts — depth without a flat black field. */}
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

      {/* Starfield: drifts faster as energy lifts. Always present. */}
      <Starfield
        seed={seed}
        density={150}
        depth={3}
        drift={{ x: 0.004 * driftBoost, y: -0.011 * driftBoost }}
        maxSize={2.8}
        twinkle={0.4}
      />

      {/* The One Sun: a single Eclipse anchor, breathing with the low end. */}
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
          {/* Eclipse occlusion: a dark warm core sits over the burning disc so
              it reads as an ECLIPSE (a body crossing the sun), not a plain sun
              ball. Only the burning rim stays lit — shrinking the gold area to
              honour The One Sun Rule and giving the cover's signature drama.
              The occlusion eases open with the bass so the rim flares on drops. */}
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

      {/* Tower blocks ground the bottom third; windows pulse with the bass. */}
      <TowerBlocks
        palette={towerPalette}
        seed={seed % 7919}
        count={13}
        litWindowDensity={0.2}
        maxHeight={0.3}
        windowGlow={windowGlow}
      />

      {/* The psychedelic peak: a few seconds of kaleidoscope over the cosmos,
          built from the artwork's own accent chroma (not gold — gold is the sun).
          Mounted only during its window so it never costs frames elsewhere. */}
      {kaleidoActive ? (
        <KaleidoPassage palette={palette} seed={seed} bass={bass} sec={sec} width={width} />
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
        {/* 0–3s: the artist as the brand-led opening mark. */}
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
          <div style={{ height: 14 }} />
          <FloatingType
            variant="meta"
            text=""
            track={track}
            fontSize={24}
            drift={5 * floatBoost}
            driftPhase={1.1}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* 3–7s: Artist — Title (the only sanctioned em dash). */}
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

        {/* 7–10s: Discovered date (tabular Oxanium). */}
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

        {/* Final ~3s: the close card — tagline + selector signature. The single
            permitted gold type moment lives here (the brand wordmark). */}
        <CloseCard
          inSec={T.closeIn}
          fps={fps}
          floatBoost={floatBoost}
          width={width}
          height={height}
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

      {/* GRAIN OVER EVERYTHING, ALWAYS (DESIGN.md base texture). The onset kick
          briefly thickens it for a film-exposure flicker. */}
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
  // Rise in from slightly below, settle, lift away on exit.
  const rise = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [26, 0, 0, -18], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return <div style={{ ...style, opacity, transform: `translateY(${rise}px)` }}>{children}</div>;
};

/**
 * The mid-clip psychedelic peak: a kaleidoscope of the artwork's own chroma over
 * the cosmos. Gold stays reserved for the sun; this draws from the palette accent
 * and swatches. It fades in/out so it reads as a passage, not a permanent layer.
 */
const KaleidoPassage: React.FC<{
  palette: NostalgicCosmosProps["palette"];
  seed: number;
  bass: number;
  sec: number;
  width: number;
}> = ({ palette, seed, bass, sec, width }) => {
  const opacity = interpolate(
    sec,
    [T.kaleidoIn - 0.5, T.kaleidoIn + 0.6, T.kaleidoOut - 0.6, T.kaleidoOut + 0.5],
    [0, 0.55, 0.55, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Slow continuous rotation drives the kaleidoscope; bass nudges the speed.
  const rotation = sec * (14 + bass * 22);
  const size = width * 1.5;

  // Source: layered accent/swatch dither + a soft chroma core, mirrored.
  const accent = palette.accent;
  const swatch = palette.swatches[2] ?? palette.swatches[0] ?? accent;

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        mixBlendMode: "screen",
        opacity,
        pointerEvents: "none",
      }}
    >
      <KaleidoMirror segments={8} size={size} rotation={rotation} sourceScale={1.6}>
        <AbsoluteFill
          style={{
            background: `radial-gradient(circle at 42% 40%,
              ${withAlpha(swatch, 0.85)} 0%,
              ${withAlpha(accent, 0.55)} 35%,
              ${withAlpha(palette.background, 0)} 70%)`,
          }}
        />
        <DitherField
          pattern="halftone"
          scale={26}
          color={accent}
          threshold={0.42 + bass * 0.25}
          opacity={0.8}
          blendMode="screen"
        />
        <DitherField
          pattern="pixel"
          scale={40}
          color={swatch}
          threshold={0.3}
          opacity={0.5}
          seed={seed % 503}
          blendMode="screen"
        />
      </KaleidoMirror>
    </AbsoluteFill>
  );
};

/**
 * Close card (final ~3s): the tagline small + the selector signature. This holds
 * the single permitted Eclipse Gold type moment (the wordmark), per the One Sun
 * Rule (the other gold is the eclipse rim).
 */
const CloseCard: React.FC<{
  inSec: number;
  fps: number;
  floatBoost: number;
  width: number;
  height: number;
}> = ({ inSec, fps, floatBoost }) => {
  const frame = useCurrentFrame();
  const sec = frame / fps;

  const opacity = interpolate(sec, [inSec, inSec + 0.8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rise = interpolate(sec, [inSec, inSec + 0.9], [22, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return (
    <div
      style={{
        alignItems: "flex-start",
        bottom: SAFE_BOTTOM + 220,
        display: "flex",
        flexDirection: "column",
        gap: 18,
        left: MARGIN_X,
        opacity,
        position: "absolute",
        right: MARGIN_X,
        transform: `translateY(${rise}px)`,
      }}
    >
      <FloatingType
        variant="body"
        text="Drum & bass bangers from another dimension"
        fontSize={30}
        drift={5 * floatBoost}
        driftPhase={0.4}
        color={colors.starlightCream}
      />
      <FloatingType
        variant="brandMark"
        mark="selected by Fluncle"
        fontSize={46}
        drift={6 * floatBoost}
        color={colors.eclipseGold}
      />
    </div>
  );
};
