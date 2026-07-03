// The flash limiter — the real WCAG 2.3.1 math, PURE and isomorphic.
//
// No DOM, no GL, no timers: a value-in/value-out state machine imported by BOTH
// the glass client (source-side scalar + output-side monitor) and bun:test. This
// is the crown of Unit L (RFC §3): the crude luma-slew the seed shipped is
// replaced by first-principles flash safety.
//
// The three nets, all built from ONE counter primitive:
//   1. source-side general-luminance limiter — a 1s ring buffer of OPPOSING PAIRS
//      (WCAG general-flash: a pair of opposing >=10% relative-luminance changes
//      where the darker endpoint is < 0.80). A 4th flash in any trailing second is
//      EASED (the global scalar caps the rise so the pair never forms), never
//      emitted; transitions are held to >= 66ms.
//   2. source-side saturated-red limiter — INDEPENDENT (WCAG red-flash: the same
//      opposing-pair count on the R-G-B signal, gated to saturated red
//      R/(R+G+B) >= 0.8, using the Xbox XAG-118 proxy |d(R-G-B) * 320| > 20, i.e.
//      a >= 20/320 delta on the normalized signal).
//   3. output-side monitor — the same counter fed the DOWNSAMPLED rendered frame
//      (async readback, in the client); on a trip it eases to the holding scene.
//
// Design law (RFC §3): 174 BPM kicks land at 2.9 Hz — 2.9 opposing pairs/second,
// UNDER the 3/second ceiling, so honest kick brightness passes; a faster strobe
// (>3 Hz) trips. Never marketed "epilepsy-safe" — this is a first-principles net.

/** WCAG relative-luminance channel weights (on LINEARIZED sRGB). */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** A single sRGB channel (0..1, gamma-encoded) linearized per the sRGB EOTF. */
export function linearizeChannel(c: number): number {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance L = 0.2126R + 0.7152G + 0.0722B on linearized sRGB. Inputs 0..1 -> 0..1. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return LUMA_R * linearizeChannel(r) + LUMA_G * linearizeChannel(g) + LUMA_B * linearizeChannel(b);
}

/** Saturated-red gate value R/(R+G+B) on gamma sRGB (WCAG red-flash test). 0 for black. */
export function redSaturation(r: number, g: number, b: number): number {
  const sum = r + g + b;
  return sum <= 1e-6 ? 0 : r / sum;
}

/** WCAG red-flash saturation gate: R/(R+G+B) >= 0.8. */
export function isSaturatedRed(r: number, g: number, b: number): boolean {
  return redSaturation(r, g, b) >= RED_SATURATION_GATE;
}

/** The Xbox XAG-118 red-flash signal: (R - G - B), on 0..1 channels -> -2..1. */
export function redValue(r: number, g: number, b: number): number {
  return r - g - b;
}

// ---- thresholds (WCAG 2.3.1 + the XAG-118 proxy) --------------------------------
/** General flash: a >= 10% relative-luminance opposing pair. */
export const GENERAL_DELTA = 0.1;
/** General flash: the darker endpoint of the pair must be below this to count. */
export const DARK_CEILING = 0.8;
/** Red flash: R/(R+G+B) >= 0.8 is "saturated red". */
export const RED_SATURATION_GATE = 0.8;
/** Red flash (XAG-118 proxy): |d(R-G-B) * 320| > 20  <=>  |d(R-G-B)| > 20/320. */
export const RED_DELTA = 20 / 320;
/** No more than three flashes within any one-second window. */
export const MAX_FLASHES_PER_SECOND = 3;
/** The window the ring buffer counts over. */
export const FLASH_WINDOW_MS = 1000;
/** WCAG minimum transition duration; sub-66ms full swings are eased, not emitted. */
export const MIN_TRANSITION_MS = 66;

/** How an opposing pair's gate is satisfied. */
export type QualifyMode = "darker" | "either";

export type PairObservation = {
  /** A full opposing pair (one flash) completed on THIS sample. */
  flashCompleted: boolean;
  /** Flashes currently inside the trailing 1s window (after this sample). */
  countInWindow: number;
};

/**
 * OpposingPairCounter — the shared primitive.
 *
 * Tracks a scalar signal `v` with a per-sample boolean `gate`, detects reversals
 * (peaks/troughs) whose swing meets `deltaThreshold`, and counts OPPOSING PAIRS
 * (one up-swing + one down-swing = one flash) inside a 1s ring buffer. A square
 * wave of f Hz yields f flashes/second (each period is one pair) — so the 3/sec
 * ceiling maps to a 3 Hz strobe, and 2.9 Hz (174 BPM) sits just under it.
 */
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
  /** The pending half-transition's sign (0 = none). A pair completes when the next
   *  qualifying transition opposes it. */
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

  /** Flashes inside the trailing window as of `tMs` (does not mutate the stream state). */
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
    // "darker": the endpoint with the smaller v must be gated (WCAG: darker < ceiling).
    return aV <= bV ? aGate : bGate;
  }

  /** Register a confirmed transition (a completed half-swing) and pair it. */
  private registerTransition(sign: -1 | 1, tMs: number): void {
    if (this.pendingHalf === 0) {
      this.pendingHalf = sign;
      return;
    }
    if (this.pendingHalf === -sign) {
      // opposing half -> one full pair (one flash)
      this.flashes.push(tMs);
      this.prune(tMs);
      this.pendingHalf = 0;
      return;
    }
    // Same sign again (degenerate): restart the pending half.
    this.pendingHalf = sign;
  }

  /**
   * Feed one sample. `gate` is the per-sample gate flag (general: v < 0.80;
   * red: saturated). Returns whether a flash completed and the window count.
   */
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
        // reversed down by >= threshold: the up-swing pivot->extreme is complete.
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
      // curDir === -1
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
  /** The global output scalar to multiply the frame by (<= 1). 1 = pass-through. */
  scalar: number;
  /** Easing was applied this frame (the scalar dipped below the free target). */
  eased: boolean;
  general: { count: number; tripAvoided: boolean };
  red: { count: number; tripAvoided: boolean };
};

/**
 * FlashLimiter — the SOURCE-side net. Each frame the renderer proposes an intended
 * global luminance (0..1, the reactive brightness drive) plus the intended frame's
 * saturated-red signal; the limiter returns a scalar that caps brightness/red RISES
 * whenever the trailing second already holds 3 flashes, so a 4th never forms. The
 * scalar is slewed so an eased transition is never faster than 66ms.
 */
export class FlashLimiter {
  private general = new OpposingPairCounter({
    deltaThreshold: GENERAL_DELTA,
    qualifyMode: "darker",
  });
  private red = new OpposingPairCounter({ deltaThreshold: RED_DELTA, qualifyMode: "either" });

  private scalar = 1;
  private lastMs: number | null = null;
  private easeCount = 0;

  /** How fast the eased scalar may recover (per ms), so a swing back up spans >= 66ms. */
  private readonly recoverPerMs = 1 / MIN_TRANSITION_MS;

  reset(): void {
    this.general.reset();
    this.red.reset();
    this.scalar = 1;
    this.lastMs = null;
    this.easeCount = 0;
  }

  /** Total number of frames the limiter has eased since the last reset (HUD). */
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

  /**
   * @param tMs      frame time (ms)
   * @param lum      intended global luminance 0..1 (the reactive brightness drive)
   * @param red      intended frame's red signal, if the caller can estimate it
   */
  push(tMs: number, lum: number, red?: { value: number; saturated: boolean }): FlashResult {
    const dt = this.lastMs === null ? 16.7 : Math.max(0, tMs - this.lastMs);
    this.lastMs = tMs;

    const gCount = this.general.countInWindow(tMs);
    const rCount = this.red.countInWindow(tMs);
    const atGeneralLimit = gCount >= MAX_FLASHES_PER_SECOND;
    const atRedLimit = rCount >= MAX_FLASHES_PER_SECOND;

    // The free target: no cap. When at a limit, cap so an intended bright rise
    // cannot form a new opposing pair (hold the emitted level near the current one).
    let target = 1;
    if (atGeneralLimit && lum > 1e-4) {
      const emitted = lum * this.scalar;
      const cap = Math.max(0, emitted - GENERAL_DELTA * 0.5) / lum;
      target = Math.min(target, Math.max(0, cap));
    }
    if (atRedLimit && red && red.saturated && lum > 1e-4) {
      target = Math.min(target, this.scalar * 0.9);
    }

    // Slew the scalar toward the target. Dropping (easing) is allowed fast; recovering
    // is rate-limited so a swing back up cannot be faster than MIN_TRANSITION_MS.
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

    // Count on the EMITTED (post-scalar) signal — the source-side net verifies itself.
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
  /** A flash just completed (general or red). */
  flash: boolean;
  /** The trailing-second flash count exceeded the ceiling — ease to the holding scene. */
  tripped: boolean;
  general: number;
  red: number;
};

/**
 * FlashMonitor — the OUTPUT-side net. Fed the DOWNSAMPLED rendered frame's average
 * colour (from an async FBO readback, in the client), it runs the SAME counters and
 * reports a trip when a 4th flash lands in any trailing second. On a trip the client
 * eases to the holding scene and logs — this is the second, honest net that catches
 * anything the source-side scalar missed (e.g. a scene the limiter couldn't model).
 */
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

  /** Feed the mean colour of the downsampled frame (channels 0..1). */
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
