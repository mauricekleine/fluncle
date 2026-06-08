// ARCHIVE — Bugwell "Everything In Its Right Place" (0mK92Hp80kOOhn086qcDgZ).
// The first Fluncle video ever rendered; the original NostalgicCosmos exemplar.
//
// Self-contained per the dated-archive doctrine: tracks/YYYYMMDD-<slug>.tsx are
// committed forever and re-renderable forever. This file therefore inlines the
// styled primitives it relies on (Eclipse, TowerBlocks, DitherField,
// KaleidoMirror) verbatim, since those are being removed from the package. It
// imports ONLY the surviving core: ShaderLayer + GLSL, Starfield, Grain,
// FloatingType, the audio hooks, color helpers, types — plus remotion, react,
// @fluncle/tokens. Creative output is unchanged from the exemplar.
//
// One permitted change vs. the original: there was no static plate-image layer
// to begin with (the comp draws everything procedurally), so nothing was
// removed on that account — see the report.

import { type CSSProperties, useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  random,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colors } from "@fluncle/tokens";
import { type CosmosPalette, type NostalgicCosmosProps } from "../types";
import { mix, withAlpha } from "../color";
import { Grain } from "../primitives/grain";
import { Starfield } from "../primitives/starfield";
import { FloatingType } from "../primitives/floating-type";
import { GLSL } from "../journey/glsl";
import { ShaderLayer } from "../journey/shader-layer";
import { useBass } from "../hooks/use-bass";
import { useBeat } from "../hooks/use-beat";
import { useEnergy } from "../hooks/use-energy";
import { useOnset } from "../hooks/use-onset";

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

        {/* Recovered-telemetry stamp: the finding's Log ID coordinate burned
            into the top-right corner for the whole clip (archive crop-mark, not
            a headline). Subordinate to the music and the One Sun. */}
        <LogIdStamp track={track} floatBoost={floatBoost} />
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
 * Recovered-telemetry stamp: the finding's Log ID coordinate as a small archive
 * crop-mark in the top-right corner — a HUD designation, not a headline. It
 * fades up early and rides the whole clip (the artifact is always stamped), held
 * subordinate to the music and the One Sun: dimmed Stardust, Oxanium tabular via
 * FloatingType's logId variant (which inherits the contrast guarantee). A short
 * gold crop-tick keys it to the archive without becoming a second sun. Pure:
 * opacity is frame-derived, no randomness. Renders nothing if there's no Log ID.
 */
const LogIdStamp: React.FC<{
  track: NostalgicCosmosProps["track"];
  floatBoost: number;
}> = ({ track, floatBoost }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;

  if (!track.logId) {
    return null;
  }

  // Eases up over the first ~1.2s, then holds — recovered telemetry that stays
  // burned into the corner of the frame for the whole clip.
  const opacity = interpolate(sec, [0.6, 1.8], [0, 0.78], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return (
    <div
      style={{
        alignItems: "flex-end",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity,
        position: "absolute",
        right: MARGIN_X,
        top: SAFE_TOP,
      }}
    >
      {/* Crop-tick: a short gold corner mark keying the stamp to the archive,
          kept tiny so it never reads as a second light source. */}
      <div
        style={{
          backgroundColor: withAlpha(colors.eclipseGold, 0.55),
          height: 2,
          width: 22,
        }}
      />
      <FloatingType
        variant="logId"
        track={track}
        align="right"
        fontSize={22}
        drift={4 * floatBoost}
        driftPhase={2.2}
        color={colors.stardust}
      />
    </div>
  );
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

// ===========================================================================
// INLINED STYLED PRIMITIVES
//
// Copied verbatim from the now-deleted package primitives so this archive stays
// self-contained and re-renderable forever. Eclipse, TowerBlocks, DitherField,
// and KaleidoMirror lived in src/remotion/primitives/. ShaderLayer + GLSL and
// Grain remain in the surviving core and are imported above.
// ===========================================================================

// --- Eclipse (was primitives/eclipse.tsx) ----------------------------------

type EclipseProps = {
  /** Diameter of the orb in px. Default 520. */
  size?: number;
  /**
   * Palette to draw from. The orb body uses accent/glow; the rim is the bright
   * limb. Defaults to the full brand palette (the one-sun moment).
   */
  palette?: Partial<CosmosPalette>;
  /**
   * Brightness of the bright rim / limb, 0..1. The signature "burning eclipse"
   * edge. Drive this with useBass/useBeat for a swelling sun. Default 0.85.
   */
  rimIntensity?: number;
  /** Grain opacity layered over the orb, 0..1. Default 0.1. */
  grainAmount?: number;
  /** Deterministic seed for the orb's grain. Default 7. */
  seed?: number;
  /**
   * Eclipse style. "limb" is a lit planet limb (bright crescent rim, dark body).
   * "sun" is a full burning disc (bright center bleeding to rim). Default "limb"
   * to match the cover's eclipse; "sun" is the brighter one-sun hero variant.
   */
  variant?: "limb" | "sun";
};

/**
 * The brand's signature grainy gradient orb: a radial gradient built from the
 * palette with a bright rim like a sun eclipse / planet limb.
 *
 * This is the single light source of the system (DESIGN.md, The One Sun Rule).
 * Compose exactly one per piece. Grain is baked over the orb so it sits in the
 * same texture as everything else.
 *
 * Pure: no randomness beyond the seeded grain, no wall clock. Animate it from
 * the outside by feeding rimIntensity from the audio hooks.
 */
const Eclipse: React.FC<EclipseProps> = ({
  size = 520,
  palette,
  rimIntensity = 0.85,
  grainAmount = 0.1,
  seed = 7,
  variant = "limb",
}) => {
  const accent = palette?.accent ?? colors.eclipseGold;
  const glow = palette?.glow ?? colors.eclipseGlow;
  const background = palette?.background ?? colors.deepField;

  // The rim color heats from accent toward glow as rimIntensity rises.
  const rim = mix(accent, glow, Math.min(1, rimIntensity));
  const rimAlpha = 0.4 + rimIntensity * 0.6;

  // A warm dark body so the eclipse reads as an occluded disc, not a flat circle.
  const bodyDark = mix(background, accent, 0.08);

  const body =
    variant === "sun"
      ? // Burning disc: bright glow core bleeding outward to the rim.
        `radial-gradient(circle at 50% 50%,
          ${withAlpha(glow, 0.95)} 0%,
          ${withAlpha(accent, 0.9)} 28%,
          ${withAlpha(mix(accent, colors.reentryRed, 0.35), 0.75)} 62%,
          ${withAlpha(rim, rimAlpha)} 82%,
          ${withAlpha(rim, 0)} 100%)`
      : // Lit limb: dark body, bright crescent rim biased to the upper-left light.
        `radial-gradient(circle at 38% 36%,
          ${withAlpha(rim, rimAlpha)} 0%,
          ${withAlpha(rim, rimAlpha * 0.5)} 8%,
          ${withAlpha(bodyDark, 0.96)} 34%,
          ${withAlpha(bodyDark, 0.98)} 78%,
          ${withAlpha(mix(bodyDark, accent, 0.18), 0.9)} 100%)`;

  // Outer atmospheric glow bleed (the burning halo), sized beyond the disc.
  const halo = `radial-gradient(circle at 50% 50%,
    ${withAlpha(glow, 0.22 * rimIntensity)} 0%,
    ${withAlpha(accent, 0.12 * rimIntensity)} 40%,
    ${withAlpha(accent, 0)} 70%)`;

  return (
    <div
      aria-hidden
      style={{
        height: size,
        pointerEvents: "none",
        position: "relative",
        width: size,
      }}
    >
      {/* Atmospheric halo, larger than the disc. */}
      <div
        style={{
          background: halo,
          borderRadius: "50%",
          height: size * 1.9,
          left: "50%",
          position: "absolute",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: size * 1.9,
        }}
      />
      {/* The disc itself. */}
      <div
        style={{
          background: body,
          borderRadius: "50%",
          inset: 0,
          overflow: "hidden",
          position: "absolute",
        }}
      >
        <Grain opacity={grainAmount} seed={seed} intensity={1.1} blendMode="soft-light" />
      </div>
    </div>
  );
};

// --- TowerBlocks (was primitives/tower-blocks.tsx) --------------------------

type TowerBlocksProps = {
  /** Palette; silhouettes derive from background, lit windows from glow/accent. */
  palette?: Partial<CosmosPalette>;
  /** Deterministic seed for block layout and lit-window pattern. Default 1. */
  seed?: number;
  /** Fraction of windows that are lit, 0..1. Default 0.22. */
  litWindowDensity?: number;
  /** Height of the tallest block as a fraction of container height. Default 0.42. */
  maxHeight?: number;
  /** Number of blocks across the NEAREST depth layer. Default 11. */
  count?: number;
  /**
   * Brightness multiplier for lit windows, 0..1+. Drive from useBass/useEnergy
   * so the city pulses with the low end. Default 1.
   */
  windowGlow?: number;
  /**
   * Number of parallax depth layers, 1..3. Deeper layers sit higher (further
   * up the frame), are hazier/lighter, and have smaller/denser blocks, giving
   * the skyline photographic depth. Default 3.
   */
  depth?: number;
  /**
   * Atmospheric haze strength 0..1: how much each deeper layer washes toward the
   * sky tone, plus how much fog rises from the horizon. Higher = mistier, more
   * distant city. Default 0.55.
   */
  haze?: number;
  /** Layer opacity 0..1. Default 1. */
  opacity?: number;
  /** Blend mode over the parent. Default "normal". */
  blendMode?: CSSProperties["mixBlendMode"];
};

// The skyline shader. A rendered-grade city instead of flat CSS rects: 2-3
// parallax depth layers of varying-height blocks rising from the bottom, each
// deeper layer lighter and hazier (aerial perspective) with fog pooling at the
// horizon, emissive window dots that bloom and flicker on a slow seeded clock,
// and soft top edges (no razor rectangles). Built on ShaderLayer so it grains
// and dithers with the rest of the GPU stack.
//
// Moodboard: posted/infinity.jpg (hazy distant moon-lit world, soft tonal
// bands), the founding image's lit windows in dark towers, photographic
// atmosphere over flat graphics.
//
// Custom uniforms (fed from TowerBlocks):
//   u_count      blocks across the nearest layer
//   u_litDensity fraction of windows lit
//   u_maxHeight  tallest block as a fraction of frame height
//   u_winGlow    live window brightness (bass/energy)
//   u_depth      number of parallax layers (1..3)
//   u_haze       atmospheric haze strength
const TOWERS_FRAG = /* glsl */ `
uniform float u_count;
uniform float u_litDensity;
uniform float u_maxHeight;
uniform float u_winGlow;
uniform float u_depth;
uniform float u_haze;

${GLSL.hash}
${GLSL.valueNoise}

// Per-block height for column index c in a given layer (stable, seeded). Returns
// the block's top as a fraction of frame height (0 = bottom of frame).
float blockTop(float c, float layerSeed) {
  float h = hash21(vec2(c * 1.37 + layerSeed * 7.0, layerSeed * 3.1));
  return (0.42 + 0.58 * h) * u_maxHeight;
}

// One depth layer. uv is full-frame 0..1 (y up). depthT 0 = nearest, 1 =
// farthest. Writes the layer's color into col and returns its coverage alpha
// (1 inside a building, soft at the top edge, fog-faded near the horizon).
float skylineLayer(vec2 uv, float depthT, inout vec3 col) {
  // Deeper layers: more, narrower columns; shorter; lifted up the frame so they
  // peek behind the nearer rows.
  float cols = u_count * mix(1.0, 2.1, depthT);
  float baseLift = depthT * u_maxHeight * 0.55; // distant skyline sits higher
  float heightScale = mix(1.0, 0.6, depthT);

  // Column coordinate. A per-layer horizontal offset destacks the rows so blocks
  // don't line up across depths.
  float layerSeed = 11.0 + depthT * 23.0 + u_seed;
  float xoff = hash21(vec2(layerSeed, 2.0)) * 3.7;
  float fx = uv.x * cols + xoff;
  float c = floor(fx);
  float inCol = fract(fx);

  float top = baseLift + blockTop(c, layerSeed) * heightScale;

  // Soft top edge instead of a razor rect: a few px of feather, plus a tiny
  // per-column roofline jitter so tops aren't all flat.
  float roof = top + (hash21(vec2(c, layerSeed + 5.0)) - 0.5) * 0.006;
  float feather = 0.006 + depthT * 0.01;
  float cov = smoothstep(roof + feather, roof - feather, uv.y);

  // Thin gaps between blocks so the skyline reads as separate towers, softened
  // for distance.
  float gap = smoothstep(0.02, 0.06, inCol) * smoothstep(0.02, 0.06, 1.0 - inCol);
  cov *= mix(1.0, mix(0.0, 1.0, gap), 0.9 - depthT * 0.4);

  // --- Silhouette tone (aerial perspective) --------------------------------
  // Nearest layer is near-black warm; deeper layers wash toward the sky/haze
  // tone (palette stop 1, the warm accent-dark) so distance reads as lighter,
  // lower-contrast, exactly like a hazy real skyline.
  // Near towers are an almost-black warm silhouette (just off the Deep Field
  // ground); distance washes them gently toward the haze tone. Keep the accent
  // mix small so the city reads as dark warm concrete, not a red wall.
  vec3 nearTone = mix(u_palette[0], u_palette[1], 0.04);
  vec3 farTone = mix(u_palette[0], u_palette[1], 0.30);
  vec3 silhouette = mix(nearTone, farTone, depthT * u_haze * 1.4);
  // A faint vertical gradient on each building: a touch brighter near its base
  // where ground light pools.
  float baseGlow = smoothstep(top, 0.0, uv.y) * 0.08 * (1.0 - depthT);
  silhouette += u_palette[1] * baseGlow;

  // --- Emissive windows -----------------------------------------------------
  // A regular grid of window cells inside each building; a seeded subset is lit.
  // Lit windows are soft dots (gaussian) that bloom slightly and flicker on a
  // slow per-window clock — never a hard rect. Distant windows shrink and dim.
  float winCols = 3.0;
  float winRows = mix(10.0, 6.0, depthT);
  vec2 wcell = vec2(inCol * winCols, (uv.y / max(top, 1e-3)) * winRows);
  vec2 wid = floor(wcell);
  vec2 wf = fract(wcell) - 0.5;
  // Stable per-window random.
  float wr = hash21(vec2(c * 31.0 + wid.x, wid.y * 17.0 + layerSeed));
  float lit = step(1.0 - u_litDensity, wr);
  // Soft round window: gaussian dot, scaled so windows are dots not panes.
  float winShape = exp(-dot(wf, wf) * mix(34.0, 70.0, depthT));
  // Slow seeded flicker: a low-frequency sine per window, subtle (stays mostly
  // lit). Phase from the window's own random so they're out of sync.
  float flick = 0.78 + 0.22 * sin(u_time * (0.5 + wr * 1.5) + wr * 28.0);
  // Only inside the building, only above the ground.
  float windows =
    lit * winShape * flick * cov * smoothstep(0.0, 0.04, uv.y) * smoothstep(0.01, 0.05, top - uv.y);
  // Distant windows dim into the haze.
  windows *= mix(1.0, 0.35, depthT);
  // Window color: warm glow -> ink core (lit panes), riding u_winGlow.
  vec3 winCol = mix(u_palette[2], u_palette[3], 0.4);
  float winAmt = windows * u_winGlow;
  // Slight bloom halo: a wider, softer dot under the core.
  float bloom = lit * exp(-dot(wf, wf) * mix(10.0, 22.0, depthT)) * cov * flick * 0.35;
  bloom *= smoothstep(0.0, 0.04, uv.y) * mix(1.0, 0.3, depthT);

  vec3 layerCol = silhouette + winCol * (winAmt + bloom * u_winGlow * 0.6);

  // Composite over what's behind (nearer alpha already written): this layer only
  // fills where the nearer ones didn't.
  col = mix(col, layerCol, cov);
  return cov;
}

void main() {
  // gl_FragCoord.y is 0 at the BOTTOM in WebGL, so uv.y is already "y up": the
  // towers grow from uv.y = 0 (bottom of the frame) up to their roofline.
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 sky = vec2(uv.x, 1.0 - uv.y); // sky-space: 0 at top, for the horizon fog

  // Start transparent; accumulate coverage so the skyline composites over the
  // scene below it (the sky/orb show through above the rooftops).
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  int layers = int(clamp(u_depth, 1.0, 3.0));
  // Draw farthest -> nearest so nearer towers occlude distant ones.
  for (int i = 2; i >= 0; i--) {
    if (i >= layers) continue;
    float depthT = layers > 1 ? float(i) / float(layers - 1) : 0.0;
    vec3 layerCol = col;
    float cov = skylineLayer(uv, depthT, layerCol);
    col = mix(col, layerCol, cov);
    alpha = max(alpha, cov);
  }

  // --- Fog rising from the horizon -----------------------------------------
  // A soft band of warm haze pooling among the rooftops near the bottom of the
  // frame and thinning upward, drawn as added coverage so it veils the bases of
  // the towers and lifts off into the sky. uv.y is 0 at the bottom, so the band
  // peaks low and fades up. Wisps come from drifting value noise.
  float horizon = smoothstep(u_maxHeight * 1.1, 0.0, uv.y);
  float fogNoise = valueNoise(vec2(uv.x * 5.0 + u_time * 0.05, uv.y * 8.0)) * 0.5 + 0.5;
  float fog = horizon * fogNoise * u_haze * 0.6;
  vec3 fogCol = mix(u_palette[0], u_palette[1], 0.45);
  col = mix(col, fogCol, fog);
  alpha = max(alpha, fog * 0.85);

  // Grain baked through the city (the system's base texture), light so the global
  // <Grain /> still leads; here it just keeps the skyline from reading as clean
  // vector art.
  col = dither8(col, uv);

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Procedural city skyline the figure floats out of: rendered-grade GPU light,
 * not flat CSS rects. 2-3 parallax depth layers of varying-height blocks rise
 * from the bottom, each deeper layer lighter and hazier (aerial perspective)
 * with fog pooling at the horizon; window dots bloom and flicker on a slow
 * seeded clock; tops are soft, not razor edges.
 *
 * Same prop API surface as before (palette, seed, litWindowDensity, maxHeight,
 * count, windowGlow) plus depth/haze for the atmosphere. Deterministic: layout
 * and lit windows come from hash(seed) in-shader; the flicker is frame-derived;
 * no Math.random / wall clock.
 *
 * Moodboard: posted/infinity.jpg (hazy distant world), the founding image's lit
 * windows. Pure: animate brightness from outside via windowGlow (audio-reactive).
 */
const TowerBlocks: React.FC<TowerBlocksProps> = ({
  palette,
  seed = 1,
  litWindowDensity = 0.22,
  maxHeight = 0.42,
  count = 11,
  windowGlow = 1,
  depth = 3,
  haze = 0.55,
  opacity = 1,
  blendMode = "normal",
}) => {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <ShaderLayer
        fragmentShader={TOWERS_FRAG}
        palette={palette}
        seed={seed}
        opacity={opacity}
        blendMode={blendMode}
        uniforms={{
          u_count: Math.max(1, Math.round(count)),
          u_depth: Math.max(1, Math.min(3, Math.round(depth))),
          u_haze: haze,
          u_litDensity: litWindowDensity,
          u_maxHeight: maxHeight,
          u_winGlow: windowGlow,
        }}
      />
    </AbsoluteFill>
  );
};

// --- DitherField (was primitives/dither-field.tsx) -------------------------

// remotion's deterministic random() used as a stable per-cell hash.
const ditherHash = (key: string): number => random(key);

type DitherPattern = "halftone" | "checker" | "pixel";

type DitherFieldProps = {
  /** Which matrix texture to render. Default "halftone". */
  pattern?: DitherPattern;
  /** Cell size in px (the texture's base unit). Default 16. */
  scale?: number;
  /** Texture color. Default Starlight Cream. */
  color?: string;
  /**
   * 0..1 fill threshold. For halftone it is dot radius; for checker it biases
   * which cells fill; for pixel it is the per-cell on-probability cut. Default 0.5.
   */
  threshold?: number;
  /** Overall layer opacity, 0..1. Default 1. */
  opacity?: number;
  /** Deterministic seed for the "pixel" pattern. Default 1. */
  seed?: number;
  /** Blend mode over the parent. Default "normal". */
  blendMode?: React.CSSProperties["mixBlendMode"];
};

/**
 * Bitmap / matrix texture fields for the glitch pole of the brand (the squared,
 * machine-label side of Oxanium and the Discman).
 *
 * Implemented as a tiled CSS background (halftone, checker) or a seeded SVG grid
 * (pixel) so it is cheap to rasterize headless: no per-pixel canvas work, just a
 * repeated tile. Pure and deterministic; the "pixel" pattern uses remotion's
 * deterministic hashing via a seed-derived grid, not Math.random().
 *
 * Covers the parent absolutely.
 */
const DitherField: React.FC<DitherFieldProps> = ({
  pattern = "halftone",
  scale = 16,
  color = colors.starlightCream,
  threshold = 0.5,
  opacity = 1,
  seed = 1,
  blendMode = "normal",
}) => {
  const t = Math.min(1, Math.max(0, threshold));

  const style = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      height: "100%",
      inset: 0,
      mixBlendMode: blendMode,
      opacity,
      pointerEvents: "none",
      position: "absolute",
      width: "100%",
    };

    if (pattern === "halftone") {
      // Radial dots on a square lattice; threshold drives dot radius.
      const r = (t * scale) / 2;
      return {
        ...base,
        backgroundColor: "transparent",
        backgroundImage: `radial-gradient(circle at center, ${color} ${r}px, transparent ${r + 0.5}px)`,
        backgroundSize: `${scale}px ${scale}px`,
      };
    }

    if (pattern === "checker") {
      // Two diagonal half-cell gradients build a checkerboard tile.
      const c = withAlpha(color, t < 0.5 ? t * 2 : 1);
      return {
        ...base,
        backgroundColor: "transparent",
        backgroundImage: `
          linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%),
          linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%)`,
        backgroundPosition: `0 0, ${scale / 2}px ${scale / 2}px`,
        backgroundSize: `${scale}px ${scale}px`,
      };
    }

    return base;
  }, [pattern, scale, color, t, opacity, blendMode]);

  if (pattern === "pixel") {
    // Seeded on/off pixel grid via SVG rects. Deterministic by seed.
    return (
      <PixelGrid
        scale={scale}
        color={color}
        threshold={t}
        opacity={opacity}
        seed={seed}
        blendMode={blendMode}
      />
    );
  }

  return <div aria-hidden style={style} />;
};

type PixelGridProps = Required<
  Pick<DitherFieldProps, "scale" | "color" | "opacity" | "seed" | "blendMode">
> & { threshold: number };

const PixelGrid: React.FC<PixelGridProps> = ({
  scale,
  color,
  threshold,
  opacity,
  seed,
  blendMode,
}) => {
  // Render a small tile of cells and repeat it via SVG pattern so cost stays low.
  const tile = 8; // cells per tile edge
  const cells = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        // Deterministic hash from seed + cell coords (remotion random()).
        const on = ditherHash(`pixel-${seed}-${x}-${y}`) < threshold;
        if (on) {
          out.push({ x, y });
        }
      }
    }
    return out;
  }, [seed, threshold]);

  const tilePx = tile * scale;

  return (
    <svg
      aria-hidden
      style={{
        height: "100%",
        inset: 0,
        mixBlendMode: blendMode,
        opacity,
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
      }}
    >
      <defs>
        <pattern id={`pixel-${seed}`} width={tilePx} height={tilePx} patternUnits="userSpaceOnUse">
          {cells.map((c, i) => (
            <rect
              key={i}
              x={c.x * scale}
              y={c.y * scale}
              width={scale}
              height={scale}
              fill={color}
            />
          ))}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#pixel-${seed})`} />
    </svg>
  );
};

// --- KaleidoMirror (was primitives/kaleido-mirror.tsx) ---------------------

type KaleidoMirrorProps = {
  /**
   * Number of mirrored wedge segments. Even values give clean mirror symmetry;
   * 6 or 8 read as a classic kaleidoscope. Default 6.
   */
  segments?: number;
  /** Diameter of the kaleidoscope in px. Default 1080 (full width). */
  size?: number;
  /** Static rotation of the whole assembly in degrees. Default 0. */
  rotation?: number;
  /**
   * Scale applied to the children inside each wedge, to push the interesting
   * part of the source toward the center seam. Default 1.4.
   */
  sourceScale?: number;
  /** The source content mirrored into every wedge. */
  children: React.ReactNode;
};

/**
 * Kaleidoscope mirroring of children.
 *
 * HTML-IN-CANVAS DECISION: not used. Remotion's <HtmlInCanvas> (built into the
 * `remotion` package) is explicitly experimental and unstable per the docs
 * (https://www.remotion.dev/docs/html-in-canvas.md): it needs Chrome 149+ with
 * the chrome://flags/#canvas-draw-element flag, draws DOM into a real canvas
 * context, cannot be nested, and the docs warn Chrome may change or remove it.
 * That makes it unsuitable for a CPU-friendly headless render of this primitive.
 * So this is the sanctioned CSS-transform fallback: N rotated-and-mirrored copies
 * of the children inside a clipped circular container. No canvas, no WebGL, just
 * transforms and a conic clip-path; cheap to rasterize headless.
 *
 * Each wedge is a `(360/segments)`-degree slice; alternating wedges are flipped
 * (scaleX(-1)) so adjacent slices mirror across their shared edge, which is what
 * gives the true kaleidoscope symmetry. Deterministic: pure transforms, no time
 * or randomness of its own (animate by animating the children or `rotation`).
 */
const KaleidoMirror: React.FC<KaleidoMirrorProps> = ({
  segments = 6,
  size = 1080,
  rotation = 0,
  sourceScale = 1.4,
  children,
}) => {
  const count = Math.max(1, Math.round(segments));
  const wedgeAngle = 360 / count;

  // A clip-path triangle wedge fanning out from the center, slightly wider than
  // the exact slice so adjacent wedges overlap and leave no seam gap.
  const half = wedgeAngle / 2 + 0.5;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  // Points on a generous radius so the wedge always covers its slice.
  const x1 = 50 + 80 * Math.sin(rad(-half));
  const y1 = 50 - 80 * Math.cos(rad(-half));
  const x2 = 50 + 80 * Math.sin(rad(half));
  const y2 = 50 - 80 * Math.cos(rad(half));
  const wedgeClip = `polygon(50% 50%, ${x1.toFixed(3)}% ${y1.toFixed(3)}%, ${x2.toFixed(3)}% ${y2.toFixed(3)}%)`;

  return (
    <div
      aria-hidden
      style={{
        borderRadius: "50%",
        height: size,
        overflow: "hidden",
        position: "relative",
        transform: `rotate(${rotation}deg)`,
        width: size,
      }}
    >
      {Array.from({ length: count }).map((_, i) => {
        const angle = i * wedgeAngle;
        const flip = i % 2 === 1 ? -1 : 1;
        return (
          <div
            key={i}
            style={{
              clipPath: wedgeClip,
              inset: 0,
              position: "absolute",
              transform: `rotate(${angle}deg)`,
              transformOrigin: "50% 50%",
            }}
          >
            <div
              style={{
                inset: 0,
                position: "absolute",
                transform: `scaleX(${flip}) scale(${sourceScale})`,
                transformOrigin: "50% 50%",
              }}
            >
              {children}
            </div>
          </div>
        );
      })}
    </div>
  );
};
