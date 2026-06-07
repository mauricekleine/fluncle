import { colors } from "@fluncle/tokens";
import { FloatingType } from "../primitives";

// <CloseCard> — the constant ending every Fluncle video shares.
//
// Every video ends here (README.md, the brand constants): the tagline small in
// cream, then the selector signature as the ONE permitted Eclipse Gold type
// moment (the other gold is the eclipse rim — The One Sun Rule). Lifted out of
// the nostalgic-cosmos exemplar into a reusable component so every scene ends
// identically.
//
// BRAND LAW this component owns:
//   - The exact copy, verbatim and locked (VOICE.md): the tagline "Drum & bass
//     bangers from another dimension" and the signature "selected by Fluncle".
//     Sentence case, no exclamation marks. The em dash is reserved for
//     "Artist — Title" contexts, so it never appears here.
//   - The type roles: tagline in the system-sans body voice, signature in the
//     Oxanium brandMark voice. The gold lives ONLY on the signature.
//   - Palette awareness: cream/gold default to canon but follow an override.
//
// The agent owns CREATIVITY: WHEN the card arrives. This component does NOT
// compute its own timeline — it accepts the journey's "arrive" phase as an `arc`
// or `progress` 0..1 and renders the reveal from that, so the close stays in lock
// step with whatever journey is driving the scene.
//
// Determinism: the reveal is a pure function of the `arc` value the caller passes
// (itself frame-derived upstream). No random, no wall clock.

export type CloseCardProps = {
  /**
   * The journey's "arrive" phase, 0..1. 0 = the close has not begun (card hidden),
   * 1 = fully arrived (card settled). Drive this from the scene's final-phase
   * progress — e.g. interpolate(sec, [closeIn, closeIn + 0.9], [0, 1]) — so the
   * card reveals exactly as the journey arrives. Aliased by `progress`.
   */
  arc?: number;
  /** Alias for `arc`; pass whichever name reads better at the call site. */
  progress?: number;
  /**
   * Palette override. `ink` colors the tagline (default Starlight Cream); `accent`
   * colors the signature, the one gold moment (default Eclipse Gold). Pass the
   * scene palette to stay coherent; the gold should remain a true canon gold.
   */
  palette?: { ink?: string; accent?: string };
  /** Float amplitude multiplier for the gentle drift on each line. Default 1. */
  floatBoost?: number;
  /** Font size of the tagline in px. Default 30. */
  taglineSize?: number;
  /** Font size of the signature in px. Default 46. */
  signatureSize?: number;
  /** Text alignment of both lines. Default "left". */
  align?: React.CSSProperties["textAlign"];
  /** Extra styles on the wrapping element (position the card in the frame). */
  style?: React.CSSProperties;
};

/** The locked tagline (VOICE.md). Sentence case, no exclamation, no em dash. */
const TAGLINE = "Drum & bass bangers from another dimension";
/** The locked selector signature — the one permitted gold type moment. */
const SIGNATURE = "selected by Fluncle";

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The shared close card. Fades and lifts in from the `arc`/`progress` the caller
 * passes (the journey's arrive phase), then holds. Returns null until the reveal
 * begins so it never costs layout earlier in the clip.
 *
 * Composes over any scene: drop it last, inside the safe inset, above <Grain>.
 */
export const CloseCard: React.FC<CloseCardProps> = ({
  arc,
  progress,
  palette,
  floatBoost = 1,
  taglineSize = 30,
  signatureSize = 46,
  align = "left",
  style,
}) => {
  const p = clamp01(arc ?? progress ?? 0);

  if (p <= 0.001) {
    return null;
  }

  // Lift from slightly below as it arrives; settle at 0.
  const rise = (1 - p) * 22;
  const ink = palette?.ink ?? colors.starlightCream;
  const accent = palette?.accent ?? colors.eclipseGold;

  return (
    <div
      style={{
        alignItems: align === "center" ? "center" : "flex-start",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        opacity: p,
        transform: `translateY(${rise}px)`,
        ...style,
      }}
    >
      {/* Tagline: the system-sans body voice, never Oxanium (The One Voice Rule). */}
      <FloatingType
        variant="body"
        text={TAGLINE}
        fontSize={taglineSize}
        drift={5 * floatBoost}
        driftPhase={0.4}
        align={align}
        color={ink}
      />
      {/* Signature: the Oxanium brand voice in the one permitted gold moment. */}
      <FloatingType
        variant="brandMark"
        mark={SIGNATURE}
        fontSize={signatureSize}
        drift={6 * floatBoost}
        align={align}
        color={accent}
      />
    </div>
  );
};
