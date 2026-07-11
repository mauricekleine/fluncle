import { useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";
import { OXANIUM_STACK, SPACE_GROTESK_STACK } from "../fonts";
import { withAlpha } from "../color";
import { type CosmosTrack } from "../types";

export type FloatingTypeVariant = "brandMark" | "trackLine" | "meta" | "body" | "logId";

// --- The contrast guarantee (the video sibling of DESIGN.md's Legible Sky Rule)
//
// Over a bright shader region (a burning nebula, a lit curtain) the cream ink
// loses against the ground and disappears. DESIGN.md's doctrine: when content
// and sky fight you make the GROUND yield, you never dim the type. Baked here so
// EVERY composition inherits it for free — composition authors never think about
// it. One mechanism, warm and through-the-glass:
//
//   An inky multi-layer TEXT-SHADOW HALO toned to Deep Field (#090a0b), never
//   pure black, never a hard 1px outline: several increasingly-blurred warm
//   shadows stack into a soft glow-out that bleeds the warm dark a few px past
//   each glyph edge, lifting the ink off any bright wisp directly behind it.
//
// (There used to be a second mechanism — a radial scrim pooled behind the line —
// but over bright passages its rectangular footprint read as a smudged backdrop
// box, so it died. The halo carries the contrast alone, helped upstream by the
// TypePlate's calm fixed corners and its text-free drop window.)
//
// The halo scales with font size so the 24px date and the 72px mark feather
// alike. It never recolors or dims the ink; the type stays full-strength in
// whatever scene-derived ink the composition chose (gold is the sun, never the
// type).

/**
 * The inky glow-out halo, scaled to the glyph size. Layers of Deep-Field-toned
 * shadow at growing blur (kept off pure black, no hard outline) so the warm dark
 * bleeds softly past each glyph and the ink lifts off bright ground. Tuned a
 * touch heavier for the bigger brand voices, which sit largest over the field.
 */
const inkHalo = (fontSizePx: number, heavy: boolean): string => {
  // Unit scaled to the canonical trackLine size, with a FLOOR: small telemetry
  // type (21-24px) needs proportionally MORE halo than its size suggests, or a
  // bright passage swallows it (caught in the hostile-field battle test).
  const u = Math.max(fontSizePx, 32) / 40;
  const ink = colors.deepField; // warm near-black, never pure #000
  const core = heavy ? 0.78 : 0.7;
  // A soft glow-out: tight inky cores tucked against each glyph, then wider warm
  // halos. With the scrim gone the halo carries the whole contrast guarantee, so
  // the tight layers run denser at the glyph edge; the wide layers still bleed
  // atmosphere, never an outline.
  return [
    `0 0 ${(1 * u).toFixed(2)}px ${withAlpha(ink, core)}`,
    `0 0 ${(2 * u).toFixed(2)}px ${withAlpha(ink, core)}`,
    `0 0 ${(4 * u).toFixed(2)}px ${withAlpha(ink, core * 0.92)}`,
    `0 0 ${(8 * u).toFixed(2)}px ${withAlpha(ink, core * 0.78)}`,
    `0 0 ${(14 * u).toFixed(2)}px ${withAlpha(ink, core * 0.55)}`,
    `0 ${(1 * u).toFixed(2)}px ${(22 * u).toFixed(2)}px ${withAlpha(ink, core * 0.38)}`,
  ].join(", ");
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
  /** trackLine / meta / logId: the track to format. */
  track?: Pick<CosmosTrack, "title" | "artists" | "discoveredAt" | "logId">;
  /** body: free text (sentence case, no exclamation marks per VOICE.md). */
  text?: string;
  /**
   * logId: prefix the coordinate with the `fluncle://` URI scheme. Default
   * false — the bare coordinate (`007.8.1B`) reads cleanest as a telemetry
   * stamp; both forms are sanctioned (VOICE.md §6).
   */
  uri?: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Found Jun 4" — the found date, tabular, no leading zero (VOICE.md's Found Rule). */
const formatDiscovered = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "Found";
  }
  // Use UTC so the same ISO always renders the same date regardless of host TZ
  // (determinism: renders must not depend on the machine's clock/timezone).
  return `Found ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/**
 * Typography primitive for the four sanctioned roles, with a gentle float.
 *
 * Brand rules baked in (DESIGN.md + VOICE.md):
 * - The One Voice Rule: Oxanium speaks for the brand and the numbers (brandMark
 *   at 800; meta and logId tabular), and Space Grotesk carries the reading
 *   (trackLine, body). Both faces are EMBEDDED — a rendered frame has no system
 *   stack to fall back to (The Canon Travels Rule), and both carry the One Box
 *   Rule metrics, so a coordinate sits on the same optical centre line as the
 *   title beside it.
 * - Space Grotesk tops out at 700; trackLine asks for 700, never 800 (an 800
 *   request would clamp silently).
 * - trackLine renders `Artist — Title` with an em dash, the ONLY sanctioned em
 *   dash in the system. Multiple artists join with ", ".
 * - meta renders the "Found Jun 4" found date, tabular (The Found Rule).
 * - logId renders the finding's coordinate (`007.8.1B`, or `fluncle://007.8.1B`
 *   with `uri`) as recovered telemetry: Oxanium tabular, tracked out, dimmed to
 *   Stardust so it stays subordinate to the music (DESIGN.md's Tabular Rule,
 *   VOICE.md §3/§6).
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
  uri = false,
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
      // Ink follows the COMPOSITION (doctrine 4): default cream, never gold —
      // gold is the sun, not the type. Pass `color` a scene-derived emphasis ink.
      color: color ?? colors.starlightCream,
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
      fontFamily: SPACE_GROTESK_STACK,
      fontSize: size,
      // 700 is Space Grotesk's heaviest cut; asking for 800 clamps silently.
      fontWeight: 700,
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
  } else if (variant === "logId") {
    // The finding's coordinate, set as recovered telemetry: Oxanium tabular so
    // it never jitters (DESIGN.md's Tabular Rule), tracked out a touch like a
    // machine designation, dimmed to Stardust so it stays subordinate to the
    // music and the One Sun. Shown bare (`007.8.1B`) by default; `fluncle://`
    // is the canonical URI — both sanctioned (VOICE.md §6).
    size = fontSize ?? 22;
    const coord = track?.logId ?? "";
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: OXANIUM_STACK,
      fontSize: size,
      fontVariantNumeric: "tabular-nums",
      fontWeight: 500,
      letterSpacing: "0.12em",
    };
    content = coord ? (uri ? `fluncle://${coord}` : coord) : "";
  } else {
    // body
    size = fontSize ?? 24;
    glyph = {
      color: color ?? colors.stardust,
      fontFamily: SPACE_GROTESK_STACK,
      fontSize: size,
      fontWeight: 400,
      lineHeight: 1.25,
    };
    content = text ?? "";
  }

  // Outer stays block-level (preserving each caller's flow + alignment); the
  // inner shrinks to the line. textAlign on the outer positions the inner
  // within its box.
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
          ...glyph,
          display: "inline-block",
          margin: 0,
          // The inky glow-out halo lifts the ink off any bright wisp behind it —
          // the whole contrast guarantee since the scrim died.
          textShadow: inkHalo(size, heavy),
        }}
      >
        {content}
      </span>
    </div>
  );
};
