export const SETTLE_MS = 1500;

export const SETTLE_FLOOR = 0.25;

export function settleGain(dwellMs: number): number {
  if (dwellMs <= 0) {
    return SETTLE_FLOOR;
  }
  if (dwellMs >= SETTLE_MS) {
    return 1;
  }
  const x = dwellMs / SETTLE_MS;
  const s = x * x * (3 - 2 * x);
  return SETTLE_FLOOR + (1 - SETTLE_FLOOR) * s;
}
