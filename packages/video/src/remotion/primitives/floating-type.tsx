import { useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { OXANIUM_STACK } from "../fonts";
import { withAlpha } from "../color";
import { type CosmosTrack } from "../types";

export type FloatingTypeVariant = "brandMark" | "trackLine" | "meta" | "body";

// --- The contrast guarantee (the video sibling of DESIGN.md's Legible Sky Rule)
//
// Over a bright shader region (a burning nebula, a lit curtain) the cream ink
// loses against the ground and disappears. DESIGN.md's doctrine: when content
// and sky fight you make the GROUND yield, you never dim the type. Baked here so
// EVERY composition inherits it for free — composition authors never think about
// it. Two cooperating mechanisms, both warm, grainy, through-the-glass:
//
//   1. A soft warm-dark LOCAL SCRIM behind the glyphs: a radial gradient of Deep
//      Field at partial opacity with a generous feather, so it reads as an
//      atmospheric vignette pooled under the line, never a box or a pill. It is
//      laid behind the text only (mix-blend "normal"); over the near-black field
//      Deep-Field-on-Deep-Field is a near-no-op, so it stays invisible on dark
//      ground and only bites where the ground is bright.
//
//   2. An inky multi-layer TEXT-SHADOW HALO toned to Deep Field (#090a0b), never
//      pure black, never a hard 1px outline: several increasingly-blurred warm
//      shadows stack into a soft glow-out that bleeds the warm dark a few px past
//      each glyph edge, lifting the cream off any bright wisp directly behind it.
//
// Both scale with font size so the 26px date and the 80px mark feather alike.
// Neither recolors or dims the ink; the type stays full-strength cream/gold.

/**
 * The inky glow-out halo, scaled to the glyph size. Layers of Deep-Field-toned
 * shadow at growing blur (kept off pure black, no hard outline) so the warm dark
 * bleeds softly past each glyph and the ink lifts off bright ground. Tuned a
 * touch heavier for the bigger brand voices, which sit largest over the field.
 */
const inkHalo = (fontSizePx: number, heavy: boolean): string => {
  const u = fontSizePx / 40; // unit scaled to the canonical trackLine size
  const ink = colors.deepField; // warm near-black, never pure #000
  const core = heavy ? 0.62 : 0.56;
  // A soft glow-out: tight inky cores tucked against each glyph, then wider warm
  // halos. The tight first layers do the contrast work right at the edge so the
  // scrim can stay faint; the wide layers bleed atmosphere, never an outline.
  return [
    `0 0 ${(1.5 * u).toFixed(2)}px ${withAlpha(ink, core)}`,
    `0 0 ${(3 * u).toFixed(2)}px ${withAlpha(ink, core)}`,
    `0 0 ${(6 * u).toFixed(2)}px ${withAlpha(ink, core * 0.82)}`,
    `0 0 ${(12 * u).toFixed(2)}px ${withAlpha(ink, core * 0.62)}`,
    `0 ${(1 * u).toFixed(2)}px ${(20 * u).toFixed(2)}px ${withAlpha(ink, core * 0.42)}`,
  ].join(", ");
};

/**
 * The feathered warm-dark scrim laid behind a line of type. A radial Deep Field
 * gradient, generously feathered to read as a soft vignette pooled under the
 * text rather than a box. Padded out past the glyphs and centred on the line so
 * the falloff is gentle on every edge. Over the near-black field it is a
 * near-no-op; over a bright region it yields the ground just enough.
 */
const Scrim: React.FC<{ align: React.CSSProperties["textAlign"]; padX: number; padY: number }> = ({
  align,
  padX,
  padY,
}) => {
  const ink = colors.deepField;
  // Horizontal centre of the pool follows the text alignment so the vignette
  // sits under the glyphs, not floating off to one side.
  const cx = align === "center" ? "50%" : align === "right" ? "82%" : "18%";
  return (
    <div
      aria-hidden
      style={{
        background: `radial-gradient(135% 165% at ${cx} 50%,
          ${withAlpha(ink, 0.4)} 0%,
          ${withAlpha(ink, 0.3)} 22%,
          ${withAlpha(ink, 0.14)} 46%,
          ${withAlpha(ink, 0)} 72%)`,
        bottom: -padY,
        left: -padX,
        pointerEvents: "none",
        position: "absolute",
        right: -padX,
        top: -padY,
        zIndex: 0,
      }}
    />
  );
};

export type FloatingTypeProps = {
  /** Which typographic role to render. */
  variant: FloatingTypeVariant;
  /**
   * Gentle float amplitude in px (the type drifts up and down like the figure).
   * 0 disables. Default 6.
   */
  drift?: number;
  /** Float period in seconds. Default 5. */
  driftPeriodSec?: number;
  /** Phase offset so stacked lines don't bob in lockstep. Default 0. */
  driftPhase?: number;
  /** Ink color override; defaults per variant. */
  color?: string;
  /** Font size in px override; defaults per variant. */
  fontSize?: number;
  /** Text align. Default "left". */
  align?: React.CSSProperties["textAlign"];

  // --- variant data ---
  /** brandMark: the wordmark text. Default "Fluncle". */
  mark?: string;
  /** trackLine / meta: the track to format. */
  track?: Pick<CosmosTrack, "title" | "artists" | "discoveredAt">;
  /** body: free text (sentence case, no exclamation marks per VOICE.md). */
  text?: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Discovered Jun 4" — discovery date, tabular, no leading zero (VOICE.md). */
const formatDiscovered = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "Discovered";
  }
  // Use UTC so the same ISO always renders the same date regardless of host TZ
  // (determinism: renders must not depend on the machine's clock/timezone).
  return `Discovered ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/**
 * Typography primitive for the four sanctioned roles, with a gentle float.
 *
 * Brand rules baked in (DESIGN.md + VOICE.md):
 * - Oxanium speaks for the brand and numbers: brandMark uses Oxanium 800, meta
 *   uses Oxanium tabular-nums for the date. trackLine + body read in the system
 *   sans (The One Voice Rule).
 * - trackLine renders `Artist — Title` with an em dash, the ONLY sanctioned em
 *   dash in the system. Multiple artists join with ", ".
 * - meta renders the "Discovered Jun 4" discovery date, tabular.
 * - Sentence case by default; no exclamation marks anywhere (The Dry Rule). This
 *   component never adds punctuation; it only formats what it is given.
 *
 * Determinism: float is frame-derived (sine of frame/fps), never wall-clock; the
 * date is formatted in UTC.
 */
export const FloatingType: React.FC<FloatingTypeProps> = ({
  variant,
  drift = 6,
  driftPeriodSec = 5,
  driftPhase = 0,
  color,
  fontSize,
  align = "left",
  mark = "Fluncle",
  track,
  text,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const seconds = frame / fps;
  const dy =
    drift > 0 ? Math.sin((seconds / driftPeriodSec) * Math.PI * 2 + driftPhase) * drift : 0;

  // Resolve the variant's glyph styling, content, and size, then render through
  // one shared wrapper that bakes in the contrast guarantee (scrim + halo) so
  // EVERY variant — and so every composition and the CloseCard — inherits it.
  let glyph: React.CSSProperties;
  let content: React.ReactNode;
  let size: number;
  let heavy = false; // the bigger brand voices get a slightly heavier halo

  if (variant === "brandMark") {
    size = fontSize ?? 72;
    heavy = true;
    glyph = {
      color: color ?? colors.eclipseGold,
      fontFamily: OXANIUM_STACK,
      fontSize: size,
      fontWeight: 800,
      letterSpacing: "-0.02em",
      lineHeight: 1,
    };
    content = mark;
  } else if (variant === "trackLine") {
    size = fontSize ?? 40;
    heavy = true;
    const artists = track?.artists?.join(", ") ?? "";
    const title = track?.title ?? "";
    // The only sanctioned em dash in the system (VOICE.md mechanics).
    const line = artists && title ? `${artists} — ${title}` : artists || title;
    glyph = {
      color: color ?? colors.starlightCream,
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontSize: size,
      fontWeight: 800,
      letterSpacing: "-0.01em",
      lineHeight: 1.18,
    };
    content = line;
  } else if (variant === "meta") {
    size = fontSize ?? 26;
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: OXANIUM_STACK,
      fontSize: size,
      fontVariantNumeric: "tabular-nums",
      fontWeight: 400,
      letterSpacing: "-0.02em",
    };
    content = track ? formatDiscovered(track.discoveredAt) : "";
  } else {
    // body
    size = fontSize ?? 24;
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontSize: size,
      fontWeight: 400,
      lineHeight: 1.25,
    };
    content = text ?? "";
  }

  // Scrim padding scales with the glyph size so the feathered vignette pools a
  // little past the line on every edge regardless of role.
  const padX = Math.round(size * 1.3);
  const padY = Math.round(size * 1.0);

  // Outer stays block-level (preserving each caller's flow + alignment); the
  // inner shrinks to the line so the scrim hugs the glyphs rather than the whole
  // column. textAlign on the outer still positions the inner within its box.
  return (
    <div
      style={{
        margin: 0,
        textAlign: align,
        transform: `translateY(${dy}px)`,
      }}
    >
      <span
        style={{
          display: "inline-block",
          position: "relative",
          textAlign: align,
        }}
      >
        <Scrim align={align} padX={padX} padY={padY} />
        <span
          style={{
            ...glyph,
            margin: 0,
            // The inky glow-out halo lifts the ink off any bright wisp behind it.
            position: "relative",
            textShadow: inkHalo(size, heavy),
            zIndex: 1,
          }}
        >
          {content}
        </span>
      </span>
    </div>
  );
};
