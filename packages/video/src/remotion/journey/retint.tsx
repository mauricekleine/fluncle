import { useId } from "react";
import { colors } from "@fluncle/tokens";
import { hexToRgb } from "../color";

// <Retint> — the Retint Rule (MOODBOARD.md) as a component.
//
// Almost every moodboard reference carries off-canon cool hues (phosphor green,
// RGB primaries, broadcast blue, candy pink). The rule: steal the TECHNIQUE,
// recolor everything into the canon — warm dark ground, Eclipse Gold as the one
// light source, Re-entry Red as the heat accent, Starlight Cream as the ink.
// <Retint> is the enforcement: wrap any children (a <Plate>, a <DitherField>,
// any off-canon imagery) and it recolors them to canon via SVG filters.
//
// BRAND LAW this component owns: the canon ramp stops, the desaturate-then-map
// pipeline, and determinism (pure SVG filters, frame-independent — no random,
// no wall clock). The consuming agent owns CREATIVITY: which mode, the strength,
// a custom `stops` ramp, and of course the children it wraps.
//
// TECHNIQUE (verified rendering in headless Chrome, chrome-headless-shell):
//   1. feColorMatrix (Rec. 601 luminance weights) collapses RGB to a single
//      grayscale luminance value per pixel.
//   2. feComponentTransfer with a per-channel `type="table"` maps that luminance
//      through the canon ramp: tableValues are the R/G/B of each ramp stop, so
//      luminance 0 -> first stop, luminance 1 -> last stop, interpolated between.
//   3. `color-interpolation-filters="sRGB"` is REQUIRED — the SVG default is
//      linearRGB, which would gamma-shift the ramp and wash the canon hues.
// This is a known-good, fully-supported SVG filter construction (no experimental
// CSS, no backdrop-filter, no canvas), so it renders identically headless.
//
// `strength` mixes the original back through: the filtered copy sits over an
// untouched copy at `opacity = strength`, so strength 0 = original, 1 = full
// retint, and anything between is a partial recolor.

export type RetintMode = "duotone" | "gradient-map" | "tint";

/** A canon ramp stop as a hex color. The luminance axis maps 0..1 across them. */
export type RetintStop = string;

export type RetintProps = {
  /**
   * How to recolor the children.
   * - "duotone": map luminance through TWO colors (shadows -> highlights). The
   *   strict two-color treatment of the duotone texture family. Defaults to warm
   *   dark (Tape Black) -> Starlight Cream.
   * - "gradient-map": map luminance through a 3-4 stop canon ramp. Defaults to
   *   deep field -> re-entry red -> eclipse gold -> starlight cream (a burning
   *   eclipse tonal map). The richest, most cinematic retint.
   * - "tint": push the whole image toward a single hue (a multiply/overlay-style
   *   wash) while keeping its own tonality. Defaults to Eclipse Gold.
   * Default "gradient-map".
   */
  mode?: RetintMode;
  /**
   * Override the canon ramp. For "duotone" pass exactly 2 stops [shadow,
   * highlight]; for "gradient-map" pass 3-4 stops dark -> light; for "tint" the
   * first stop is the hue pushed onto the image. Every default is canon; override
   * only to draw a stop from the artwork palette (e.g. a swatch as the midtone),
   * never to introduce an off-canon field color.
   */
  stops?: RetintStop[];
  /**
   * How much to apply, 0..1. The retinted copy mixes over the original at this
   * opacity: 0 = untouched original, 1 = full canon retint. Default 1.
   */
  strength?: number;
  /**
   * "tint" only: the blend mode of the single-hue wash over the children.
   * "multiply" deepens (the hue darkens shadows), "overlay" contrasts, "screen"
   * lifts. Default "multiply". Ignored by duotone/gradient-map.
   */
  tintBlend?: React.CSSProperties["mixBlendMode"];
  /** Extra styles on the wrapping element (size, position). */
  style?: React.CSSProperties;
  /** The content to recolor: a <Plate>, a texture, any off-canon imagery. */
  children: React.ReactNode;
};

const DUOTONE_DEFAULT: RetintStop[] = [colors.tapeBlack, colors.starlightCream];

// deep field -> re-entry red -> eclipse gold -> starlight cream: a tonal map that
// reads as the burning eclipse, dark sky climbing through heat into the light.
const GRADIENT_MAP_DEFAULT: RetintStop[] = [
  colors.deepField,
  colors.reentryRed,
  colors.eclipseGold,
  colors.starlightCream,
];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// Rec. 601 luminance matrix: collapse RGB -> grayscale, preserve alpha.
const LUMINANCE_MATRIX = [
  "0.299 0.587 0.114 0 0",
  "0.299 0.587 0.114 0 0",
  "0.299 0.587 0.114 0 0",
  "0 0 0 1 0",
].join("  ");

/** tableValues string for one channel: each stop's channel value 0..1. */
const channelTable = (stops: RetintStop[], channel: "r" | "g" | "b"): string =>
  stops.map((hex) => (hexToRgb(hex)[channel] / 255).toFixed(4)).join(" ");

/**
 * Recolor any children to the canon palette via SVG filters (the Retint Rule).
 *
 * Composes naturally with the rest of the kit: wrap a <Plate> in <Retint> to pull
 * an off-canon photo into the night sky, and lay <Grain> over the result. Gold
 * stays the reserved sun, so prefer "duotone"/"gradient-map" for full fields and
 * keep any gold the ramp introduces small (The One Sun Rule).
 *
 * Determinism: pure SVG filters, no per-frame state. The same children render the
 * same retint on every frame and in every render process.
 */
export const Retint: React.FC<RetintProps> = ({
  mode = "gradient-map",
  stops,
  strength = 1,
  tintBlend = "multiply",
  style,
  children,
}) => {
  // useId gives a render-stable, collision-free filter id even with many
  // <Retint>s mounted (a global "retint" id would cross-wire them). It is stable
  // across the SSR/headless render, so it does not break determinism.
  const rawId = useId().replace(/:/g, "");
  const filterId = `retint-${rawId}`;
  const s = clamp01(strength);

  // "tint" is a single-hue wash, not a luminance map: render the children, then
  // overlay the hue at `strength` with the chosen blend mode. Keeps the image's
  // own tonality while pulling its color toward one canon hue.
  if (mode === "tint") {
    const hue = stops?.[0] ?? colors.eclipseGold;
    return (
      <div style={{ position: "relative", ...style }}>
        {children}
        <div
          aria-hidden
          style={{
            backgroundColor: hue,
            inset: 0,
            mixBlendMode: tintBlend,
            opacity: s,
            pointerEvents: "none",
            position: "absolute",
          }}
        />
      </div>
    );
  }

  const ramp =
    stops && stops.length >= 2
      ? stops
      : mode === "duotone"
        ? DUOTONE_DEFAULT
        : GRADIENT_MAP_DEFAULT;

  return (
    <div style={{ position: "relative", ...style }}>
      {/* Original copy underneath: strength<1 lets it show through the retint. */}
      {children}
      {/* Retinted copy on top at `strength` opacity. */}
      <div
        aria-hidden
        style={{
          filter: `url(#${filterId})`,
          inset: 0,
          opacity: s,
          pointerEvents: "none",
          position: "absolute",
        }}
      >
        {children}
      </div>
      <svg aria-hidden style={{ height: 0, pointerEvents: "none", position: "absolute", width: 0 }}>
        <defs>
          {/* sRGB is REQUIRED so the canon ramp lands on the right hues. */}
          <filter id={filterId} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={LUMINANCE_MATRIX} />
            <feComponentTransfer>
              <feFuncR type="table" tableValues={channelTable(ramp, "r")} />
              <feFuncG type="table" tableValues={channelTable(ramp, "g")} />
              <feFuncB type="table" tableValues={channelTable(ramp, "b")} />
            </feComponentTransfer>
          </filter>
        </defs>
      </svg>
    </div>
  );
};
