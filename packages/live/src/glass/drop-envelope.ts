export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0 ? 0 : 1;
  }
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export type DropShape = { riseMs: number; holdMs: number; fallMs: number };

export function dropPulse(nowMs: number, peakMs: number, shape: DropShape): number {
  const rise = smoothstep(peakMs - shape.riseMs, peakMs, nowMs);
  const fall = 1 - smoothstep(peakMs + shape.holdMs, peakMs + shape.holdMs + shape.fallMs, nowMs);
  return clamp01(rise * fall);
}

export const ARC_SPAN_MS = 28000;

export const ARC_CREST_FRACTION = 0.375;

export const CANONICAL_ARC_SHAPE: DropShape = { fallMs: 13000, holdMs: 1500, riseMs: 4000 };

export const REVEAL_SHAPE: DropShape = { fallMs: 8000, holdMs: 700, riseMs: 300 };

export class DropEnvelope {
  private arcOn = false;
  private arcPeakMs = 0;
  private arcEndMs = 0;
  private arcShape: DropShape = CANONICAL_ARC_SHAPE;

  private revealOn = false;
  private revealPeakMs = 0;
  private revealEndMs = 0;

  triggerArc(nowMs: number, spanMs?: number, shape?: DropShape): void {
    const span = spanMs !== undefined && spanMs > 0 ? Math.min(spanMs, ARC_SPAN_MS) : ARC_SPAN_MS;
    this.arcShape = shape ?? CANONICAL_ARC_SHAPE;
    this.arcPeakMs = nowMs + span * ARC_CREST_FRACTION;
    this.arcEndMs = this.arcPeakMs + this.arcShape.holdMs + this.arcShape.fallMs;
    this.arcOn = true;
  }

  clearArc(): void {
    this.arcOn = false;
  }

  fireReveal(nowMs: number): void {
    this.revealPeakMs = nowMs + REVEAL_SHAPE.riseMs;
    this.revealEndMs = this.revealPeakMs + REVEAL_SHAPE.holdMs + REVEAL_SHAPE.fallMs;
    this.revealOn = true;
  }

  get arcActive(): boolean {
    return this.arcOn;
  }
  get revealActive(): boolean {
    return this.revealOn;
  }

  value(nowMs: number, livingIdle: number): number {
    let v = clamp01(livingIdle);
    if (this.arcOn) {
      if (nowMs >= this.arcEndMs) {
        this.arcOn = false;
      } else {
        const a = dropPulse(nowMs, this.arcPeakMs, this.arcShape);
        if (a > v) {
          v = a;
        }
      }
    }
    if (this.revealOn) {
      if (nowMs >= this.revealEndMs) {
        this.revealOn = false;
      } else {
        const r = dropPulse(nowMs, this.revealPeakMs, REVEAL_SHAPE);
        if (r > v) {
          v = r;
        }
      }
    }
    return clamp01(v);
  }
}

export type DropDetectorOptions = {
  dipLevel: number;

  surgeLevel: number;

  dipHoldMs: number;

  confirmMs: number;

  refractoryMs: number;
};

export const DEFAULT_DROP_DETECTOR: DropDetectorOptions = {
  confirmMs: 250,
  dipHoldMs: 1200,
  dipLevel: 0.28,
  refractoryMs: 8000,
  surgeLevel: 0.55,
};

export class DropDetector {
  private readonly opts: DropDetectorOptions;
  private dipStartMs: number | null = null;
  private armed = false;
  private surgeStartMs: number | null = null;
  private lastFireMs = Number.NEGATIVE_INFINITY;

  constructor(opts: DropDetectorOptions = DEFAULT_DROP_DETECTOR) {
    this.opts = opts;
  }

  reset(): void {
    this.dipStartMs = null;
    this.armed = false;
    this.surgeStartMs = null;
    this.lastFireMs = Number.NEGATIVE_INFINITY;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  observe(nowMs: number, energy: number): boolean {
    const o = this.opts;
    if (energy < o.dipLevel) {
      if (this.dipStartMs === null) {
        this.dipStartMs = nowMs;
      }
      if (nowMs - this.dipStartMs >= o.dipHoldMs) {
        this.armed = true;
      }
      this.surgeStartMs = null;
      return false;
    }

    this.dipStartMs = null;
    if (this.armed && energy >= o.surgeLevel) {
      if (this.surgeStartMs === null) {
        this.surgeStartMs = nowMs;
      }
      if (nowMs - this.surgeStartMs >= o.confirmMs && nowMs - this.lastFireMs >= o.refractoryMs) {
        this.lastFireMs = nowMs;
        this.armed = false;
        this.surgeStartMs = null;
        return true;
      }
    } else {
      this.surgeStartMs = null;
    }
    return false;
  }
}
