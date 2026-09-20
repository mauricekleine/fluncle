// Pure reveal-timing math for <CloseCard>. Split out of close-card.tsx so the
// timing is unit-testable without React / Remotion, and so the "arc trap" fix has
// a regression home.
//
// THE ARC TRAP: the card must never drive its reveal from the journey's GLOBAL `arc`
// (`useJourney().arc`), an eased 0..1 that is already NON-ZERO through most of the clip, because
// that would print the sign-off mid-clip instead of at the arrival. The reveal is driven ONLY by
// `progress` (the "arrive" phase's phaseProgress, ~0 until the close begins); `arc` is deliberately
// unavailable as a fallback driver.

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The single reveal driver, 0..1. Honours `progress` only (see the trap note
 * above). Undefined/NaN collapses to 0 (card hidden).
 */
export const closeCardProgress = (progress?: number): number =>
  clamp01(Number.isFinite(progress) ? (progress as number) : 0);

/**
 * The staggered two-beat reveal: the tagline settles first, the signature lands on
 * its heels. Both are pure remappings of the driver `p`, so the stagger stays
 * locked to the journey's arrive phase.
 */
export const closeCardReveal = (p: number): { signatureP: number; taglineP: number } => ({
  signatureP: clamp01((p - 0.3) / 0.7),
  taglineP: clamp01(p / 0.65),
});
