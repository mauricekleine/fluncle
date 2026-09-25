const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export function linearizeChannel(c: number): number {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return LUMA_R * linearizeChannel(r) + LUMA_G * linearizeChannel(g) + LUMA_B * linearizeChannel(b);
}

export function redSaturation(r: number, g: number, b: number): number {
  const sum = r + g + b;
  return sum <= 1e-6 ? 0 : r / sum;
}

export function isSaturatedRed(r: number, g: number, b: number): boolean {
  return redSaturation(r, g, b) >= RED_SATURATION_GATE;
}

export function redValue(r: number, g: number, b: number): number {
  return r - g - b;
}

export const GENERAL_DELTA = 0.1;

export const DARK_CEILING = 0.8;

export const RED_SATURATION_GATE = 0.8;

export const RED_DELTA = 20 / 320;

export const MAX_FLASHES_PER_SECOND = 3;

export const FLASH_WINDOW_MS = 1000;

export const MIN_TRANSITION_MS = 66;

export type QualifyMode = "darker" | "either";

export type PairObservation = {
  flashCompleted: boolean;

  countInWindow: number;
};

export class OpposingPairCounter {
  readonly deltaThreshold: number;
  readonly windowMs: number;
  readonly maxPerWindow: number;
  readonly qualifyMode: QualifyMode;

  private pivotV = 0;
  private pivotGate = false;
  private curDir: -1 | 0 | 1 = 0;
  private curExtremeV = 0;
  private curExtremeGate = false;

  private pendingHalf: -1 | 0 | 1 = 0;
  private flashes: number[] = [];
  private started = false;

  constructor(opts: {
    deltaThreshold: number;
    qualifyMode: QualifyMode;
    windowMs?: number;
    maxPerWindow?: number;
  }) {
    this.deltaThreshold = opts.deltaThreshold;
    this.qualifyMode = opts.qualifyMode;
    this.windowMs = opts.windowMs ?? FLASH_WINDOW_MS;
    this.maxPerWindow = opts.maxPerWindow ?? MAX_FLASHES_PER_SECOND;
  }

  reset(): void {
    this.pivotV = 0;
    this.pivotGate = false;
    this.curDir = 0;
    this.curExtremeV = 0;
    this.curExtremeGate = false;
    this.pendingHalf = 0;
    this.flashes = [];
    this.started = false;
  }

  private prune(tMs: number): void {
    const cutoff = tMs - this.windowMs;
    while (this.flashes.length > 0 && this.flashes[0] <= cutoff) {
      this.flashes.shift();
    }
  }

  countInWindow(tMs: number): number {
    const cutoff = tMs - this.windowMs;
    let n = 0;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if (this.flashes[i] > cutoff) {
        n++;
      } else {
        break;
      }
    }
    return n;
  }

  private pairGateOk(aV: number, aGate: boolean, bV: number, bGate: boolean): boolean {
    if (this.qualifyMode === "either") {
      return aGate || bGate;
    }

    return aV <= bV ? aGate : bGate;
  }

  private registerTransition(sign: -1 | 1, tMs: number): void {
    if (this.pendingHalf === 0) {
      this.pendingHalf = sign;
      return;
    }
    if (this.pendingHalf === -sign) {
      this.flashes.push(tMs);
      this.prune(tMs);
      this.pendingHalf = 0;
      return;
    }

    this.pendingHalf = sign;
  }

  observe(tMs: number, v: number, gate: boolean): PairObservation {
    this.prune(tMs);
    if (!this.started) {
      this.pivotV = v;
      this.pivotGate = gate;
      this.curExtremeV = v;
      this.curExtremeGate = gate;
      this.curDir = 0;
      this.started = true;
      return { countInWindow: this.flashes.length, flashCompleted: false };
    }

    const before = this.flashes.length;

    if (this.curDir === 0) {
      if (v > this.pivotV) {
        this.curDir = 1;
        this.curExtremeV = v;
        this.curExtremeGate = gate;
      } else if (v < this.pivotV) {
        this.curDir = -1;
        this.curExtremeV = v;
        this.curExtremeGate = gate;
      }
    } else if (this.curDir === 1) {
      if (v >= this.curExtremeV) {
        this.curExtremeV = v;
        this.curExtremeGate = gate;
      } else if (this.curExtremeV - v >= this.deltaThreshold) {
        if (
          this.curExtremeV - this.pivotV >= this.deltaThreshold &&
          this.pairGateOk(this.pivotV, this.pivotGate, this.curExtremeV, this.curExtremeGate)
        ) {
          this.registerTransition(1, tMs);
        }
        this.pivotV = this.curExtremeV;
        this.pivotGate = this.curExtremeGate;
        this.curDir = -1;
        this.curExtremeV = v;
        this.curExtremeGate = gate;
      }
    } else {
      if (v <= this.curExtremeV) {
        this.curExtremeV = v;
        this.curExtremeGate = gate;
      } else if (v - this.curExtremeV >= this.deltaThreshold) {
        if (
          this.pivotV - this.curExtremeV >= this.deltaThreshold &&
          this.pairGateOk(this.pivotV, this.pivotGate, this.curExtremeV, this.curExtremeGate)
        ) {
          this.registerTransition(-1, tMs);
        }
        this.pivotV = this.curExtremeV;
        this.pivotGate = this.curExtremeGate;
        this.curDir = 1;
        this.curExtremeV = v;
        this.curExtremeGate = gate;
      }
    }

    return {
      countInWindow: this.flashes.length,
      flashCompleted: this.flashes.length > before,
    };
  }
}

export type FlashResult = {
  scalar: number;

  eased: boolean;
  general: { count: number; tripAvoided: boolean };
  red: { count: number; tripAvoided: boolean };
};

export class FlashLimiter {
  private general = new OpposingPairCounter({
    deltaThreshold: GENERAL_DELTA,
    qualifyMode: "darker",
  });
  private red = new OpposingPairCounter({ deltaThreshold: RED_DELTA, qualifyMode: "either" });

  private scalar = 1;
  private lastMs: number | null = null;
  private easeCount = 0;

  private readonly recoverPerMs = 1 / MIN_TRANSITION_MS;

  reset(): void {
    this.general.reset();
    this.red.reset();
    this.scalar = 1;
    this.lastMs = null;
    this.easeCount = 0;
  }

  get trips(): number {
    return this.easeCount;
  }

  status(tMs: number): { generalCount: number; redCount: number; eases: number } {
    return {
      eases: this.easeCount,
      generalCount: this.general.countInWindow(tMs),
      redCount: this.red.countInWindow(tMs),
    };
  }

  push(tMs: number, lum: number, red?: { value: number; saturated: boolean }): FlashResult {
    const dt = this.lastMs === null ? 16.7 : Math.max(0, tMs - this.lastMs);
    this.lastMs = tMs;

    const gCount = this.general.countInWindow(tMs);
    const rCount = this.red.countInWindow(tMs);
    const atGeneralLimit = gCount >= MAX_FLASHES_PER_SECOND;
    const atRedLimit = rCount >= MAX_FLASHES_PER_SECOND;

    let target = 1;
    if (atGeneralLimit && lum > 1e-4) {
      const emitted = lum * this.scalar;
      const cap = Math.max(0, emitted - GENERAL_DELTA * 0.5) / lum;
      target = Math.min(target, Math.max(0, cap));
    }
    if (atRedLimit && red && red.saturated && lum > 1e-4) {
      target = Math.min(target, this.scalar * 0.9);
    }

    const eased = target < this.scalar - 1e-4;
    if (target < this.scalar) {
      this.scalar = target;
    } else {
      this.scalar = Math.min(target, this.scalar + this.recoverPerMs * dt);
    }
    this.scalar = Math.min(1, Math.max(0, this.scalar));
    if (eased) {
      this.easeCount++;
    }

    const emittedLum = lum * this.scalar;
    const g = this.general.observe(tMs, emittedLum, emittedLum < DARK_CEILING);
    let r: PairObservation = { countInWindow: rCount, flashCompleted: false };
    if (red) {
      r = this.red.observe(tMs, red.value * this.scalar, red.saturated);
    }

    return {
      eased,
      general: { count: g.countInWindow, tripAvoided: atGeneralLimit },
      red: { count: r.countInWindow, tripAvoided: atRedLimit },
      scalar: this.scalar,
    };
  }
}

export type MonitorResult = {
  flash: boolean;

  tripped: boolean;
  general: number;
  red: number;
};

export class FlashMonitor {
  private general = new OpposingPairCounter({
    deltaThreshold: GENERAL_DELTA,
    qualifyMode: "darker",
  });
  private red = new OpposingPairCounter({ deltaThreshold: RED_DELTA, qualifyMode: "either" });
  private trips = 0;

  reset(): void {
    this.general.reset();
    this.red.reset();
    this.trips = 0;
  }

  get tripCount(): number {
    return this.trips;
  }

  push(tMs: number, r: number, g: number, b: number): MonitorResult {
    const lum = relativeLuminance(r, g, b);
    const gObs = this.general.observe(tMs, lum, lum < DARK_CEILING);
    const rObs = this.red.observe(tMs, redValue(r, g, b), isSaturatedRed(r, g, b));
    const tripped =
      gObs.countInWindow > MAX_FLASHES_PER_SECOND || rObs.countInWindow > MAX_FLASHES_PER_SECOND;
    if (tripped) {
      this.trips++;
    }
    return {
      flash: gObs.flashCompleted || rObs.flashCompleted,
      general: gObs.countInWindow,
      red: rObs.countInWindow,
      tripped,
    };
  }
}
