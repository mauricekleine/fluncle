const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const closeCardProgress = (progress?: number): number =>
  clamp01(Number.isFinite(progress) ? (progress as number) : 0);

export const closeCardReveal = (p: number): { signatureP: number; taglineP: number } => ({
  signatureP: clamp01((p - 0.3) / 0.7),
  taglineP: clamp01(p / 0.65),
});
