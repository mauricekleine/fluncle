import { getInputProps } from "remotion";
import { colors } from "@fluncle/tokens";
import { FloatingType } from "../primitives/floating-type";
import { closeCardProgress, closeCardReveal } from "./close-card-timing";

// <CloseCard> — the constant ending every Fluncle video shares.
//
// Every video ends here (README.md, the brand constants): the tagline small,
// then the selector signature as the emphasis line — revealed as a staggered
// two-beat sign-off (tagline settles first, the signature lands on its heels).
//
// BRAND LAW this component owns:
//   - The exact copy, verbatim and locked (VOICE.md): the tagline "Drum & bass
//     bangers from another dimension" and the signature "selected by Fluncle".
//     Sentence case, no exclamation marks. The em dash is reserved for
//     "Artist — Title" contexts, so it never appears here.
//   - The type roles and scale: tagline in the system-sans body voice, small
//     and dim; signature in the Oxanium brandMark voice, the loudest type
//     moment of the clip (committed scale contrast, not two similar lines).
//   - Colour follows the COMPOSITION, not the brand: the ink and the signature's
//     emphasis accent are scene-matched, never a fixed gold (it used to force
//     Eclipse Gold here and clashed with non-gold scenes). Gold is the sun,
//     never the type.
//   - PLACEMENT: the card's default home is the SAME lower-left anchor as the
//     TypePlate's identity block — the sign-off lands where the credits were.
//     Predictable information keeps a predictable home; pass `style` only when
//     a scene truly cannot give the lower-left to the close.
//
// The agent owns CREATIVITY: WHEN the card arrives. This component does NOT
// compute its own timeline — it accepts the journey's "arrive" phase as
// `progress` 0..1 and renders the reveal from that, so the close stays in lock
// step with whatever journey is driving the scene.
//
// THE ARC TRAP (fixed): the reveal used to fall back to `arc ?? progress`, and
// callers reach for the journey's GLOBAL `arc` (useJourney().arc) — already
// non-zero through most of the clip — so the sign-off printed mid-clip. The reveal
// is now driven ONLY by `progress` (the "arrive" phase's phaseProgress, ~0 until
// the close begins); `arc` is accepted for runtime-compat with archived
// compositions but IGNORED (see close-card-timing.ts). The timing math lives in
// that pure module with a regression test.
//
// Determinism: the reveal is a pure function of the `progress` value the caller
// passes (itself frame-derived upstream). No random, no wall clock.

export type CloseCardProps = {
  /**
   * The journey's "arrive" phase, 0..1. 0 = the close has not begun (card hidden),
   * 1 = fully arrived (card settled). Drive this from the scene's final-phase
   * progress — e.g. interpolate(sec, [closeIn, closeIn + 0.9], [0, 1]) — so the
   * card reveals exactly as the journey arrives.
   */
  progress?: number;
  /**
   * @deprecated Legacy alias — accepted for runtime-compat with archived
   * compositions but IGNORED. Passing the journey's global `arc` here used to
   * reveal the sign-off mid-clip (the arc trap); drive the card from `progress`
   * instead (the "arrive" phase's phaseProgress). See close-card-timing.ts.
   */
  arc?: number;
  /**
   * Scene-matched palette. `ink` colours the tagline (default Starlight Cream);
   * `accent` colours the signature — its emphasis highlight, drawn from the
   * composition (default: the same `ink`, so it never falls back to gold). Pass
   * both from the scene so the close reads in-palette. Gold is the sun, not text.
   */
  palette?: { ink?: string; accent?: string };
  /** Float amplitude multiplier for the gentle drift on each line. Default 1. */
  floatBoost?: number;
  /** Font size of the tagline in px. Default 25. */
  taglineSize?: number;
  /** Font size of the signature in px. Default 52. */
  signatureSize?: number;
  /** Text alignment of both lines. Default "left". */
  align?: React.CSSProperties["textAlign"];
  /**
   * Extra styles on the wrapping element. By DEFAULT the card positions itself
   * at the shared lower-left anchor (the TypePlate identity slot) — only pass a
   * position when the scene truly cannot give the lower-left to the close.
   */
  style?: React.CSSProperties;
};

/** The locked tagline (VOICE.md). Sentence case, no exclamation, no em dash. */
const TAGLINE = "Drum & bass bangers from another dimension";
/** The locked selector signature — the emphasis line; ink follows the scene. */
const SIGNATURE = "selected by Fluncle";

/**
 * The shared close card. Fades and lifts in from the `progress` the caller passes
 * (the journey's arrive phase), then holds. Returns null until the reveal begins
 * so it never costs layout earlier in the clip.
 *
 * Composes over any scene: drop it last, inside the safe inset, above the scene.
 */
// The shared lower-left anchor — the TypePlate's identity slot. The sign-off
// lands where the credits were (one predictable home for predictable words).
const MARGIN_X = 96;
const SAFE_BOTTOM = 230;

// Static container layout — the fixed lower-anchor stack. Only the cross-axis
// alignment varies per render (from `align`), so the rest lives here and stays
// stable across frames.
const CONTAINER_STYLE: React.CSSProperties = {
  bottom: SAFE_BOTTOM,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  left: MARGIN_X,
  position: "absolute",
  right: MARGIN_X,
};

export const CloseCard: React.FC<CloseCardProps> = ({
  arc,
  progress,
  palette,
  floatBoost = 1,
  taglineSize = 25,
  signatureSize = 52,
  align = "left",
  style,
}) => {
  // Drive from `progress` only; `arc` is accepted but ignored (the arc trap).
  const p = closeCardProgress(progress, arc);

  if (p <= 0.001) {
    return null;
  }

  // The text-free cut (radio.fluncle.com): suppress the baked-in sign-off so a
  // host UI owns the metadata. Read from inputProps so it gates every
  // self-contained composition without touching the composition. CloseCard has no
  // hooks, so an early return here is safe.
  if ((getInputProps() as { hideOverlay?: boolean }).hideOverlay) {
    return null;
  }

  // Two-beat reveal: the tagline settles first, the signature lands on its
  // heels. Both are pure remappings of `progress`, so the stagger stays locked to
  // the journey's arrive phase (close-card-timing.ts).
  const { signatureP, taglineP } = closeCardReveal(p);

  const ink = palette?.ink ?? colors.starlightCream;
  // The signature is the emphasis line; its ink follows the COMPOSITION, not a
  // fixed gold (it used to force Eclipse Gold and clashed with non-gold scenes).
  // Default to the tagline ink so a missing override never reintroduces gold;
  // pass palette.accent a scene-derived highlight to emphasise it in-palette.
  const accent = palette?.accent ?? ink;

  return (
    <div
      style={{
        ...CONTAINER_STYLE,
        alignItems: align === "center" ? "center" : "flex-start",
        ...style,
      }}
    >
      {/* Tagline: the system-sans body voice, never Oxanium (The One Voice Rule).
          Small and dim — it whispers; the signature speaks. */}
      <div
        style={{
          opacity: taglineP,
          transform: `translateY(${(1 - taglineP) * 16}px)`,
        }}
      >
        <FloatingType
          variant="body"
          text={TAGLINE}
          fontSize={taglineSize}
          drift={5 * floatBoost}
          driftPhase={0.4}
          align={align}
          color={ink}
        />
      </div>
      {/* Signature: the Oxanium brand voice, the loudest type moment of the clip
          — its ink follows the composition (palette.accent), never a fixed gold. */}
      <div
        style={{
          opacity: signatureP,
          transform: `translateY(${(1 - signatureP) * 22}px)`,
        }}
      >
        <FloatingType
          variant="brandMark"
          mark={SIGNATURE}
          fontSize={signatureSize}
          drift={6 * floatBoost}
          align={align}
          color={accent}
        />
      </div>
    </div>
  );
};
