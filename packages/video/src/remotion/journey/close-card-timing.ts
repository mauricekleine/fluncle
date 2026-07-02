// Pure reveal-timing math for <CloseCard>. Split out of close-card.tsx so the
// timing is unit-testable without React / Remotion, and so the "arc trap" fix has
// a regression home.
//
// THE ARC TRAP (fixed here): the card used to drive its reveal from `arc ??
// progress`. Callers reach for the journey's GLOBAL `arc` (useJourney().arc) — an
// eased 0..1 that is already NON-ZERO through most of the clip — so the sign-off
// printed mid-clip instead of at the arrival. The reveal is now driven ONLY by
// `progress` (the "arrive" phase's phaseProgress, ~0 until the close begins). The
// legacy `arc` prop is accepted for runtime-compat with archived compositions but
// intentionally IGNORED, so an archived comp that passed both now gets the correct
// (late) timing instead of the early one.

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The single reveal driver, 0..1. Honours `progress` only; `arc` is accepted but
 * ignored (see the trap note above). Undefined/NaN collapses to 0 (card hidden).
 */
export const closeCardProgress = (progress?: number, _arc?: number): number =>
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
