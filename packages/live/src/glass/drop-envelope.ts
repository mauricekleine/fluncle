// The drop-reveal envelope engine — PURE + isomorphic (no DOM, no GL, no timers),
// imported by BOTH the glass client and bun:test.
//
// THE GAP it closes: plate-era compositions build toward a reveal driven by their drop
// envelope (u_audioDrop and its friends). In an OFFLINE render the analyzer's detected
// drop time fires that envelope so the peak SHOWS once (rise -> hold -> fall around the
// musical moment — the `dropEnvelope` hook in packages/video). LIVE, the glass fed
// u_audioDrop a slow energy-over-swell proxy that never crests — the swell baseline
// catches up to a sustained loud section, so the buildup plays but the payoff can't fire
// (025.5.5T the blood-red warship stays veiled forever). This module produces the drop
// value each frame as the MAX of three sources:
//
//   1. livingIdle  — the ambient DSP drop proxy: the world's living, breathing floor.
//   2. scriptedArc — a one-shot buried -> crest -> settle arc over the scene's span, fired
//                    on a fresh arrival at (or a replay `v` of) a drop-reactive plate scene.
//                    The composition's authored dramaturgy, replayed. (PRONG 1.)
//   3. reveal      — a fast-attack / slow-release punch fired LIVE by the drop DETECTOR or
//                    the operator's MANUAL reveal key, timed to the real drop. (PRONG 2.)
//
// max() means the crest always wins and, once it settles, the world hands back to its
// living idle — never a snap in either direction. The flash limiter (the output-side
// monitor over the rendered pixels) stays authoritative over any flood: the arc/reveal
// are seconds-long smooth rises, not strobes, so they never form a flash pair by
// construction, and a scene the source-side net can't model still trips the output net.

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** GLSL-style smoothstep, matching the offline `dropEnvelope` hook exactly. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0 ? 0 : 1;
  }
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** The drop envelope SHAPE: a rise/hold/fall pulse around a peak (ms). */
export type DropShape = { riseMs: number; holdMs: number; fallMs: number };

/**
 * The rise/hold/fall pulse value at `nowMs` for a peak at `peakMs` — the SAME math the
 * offline `dropEnvelope` hook uses: rise = smoothstep(peak - rise, peak); fall = 1 -
 * smoothstep(peak + hold, peak + hold + fall). 0 before the rise and after the fall,
 * 1 at the crest.
 */
export function dropPulse(nowMs: number, peakMs: number, shape: DropShape): number {
  const rise = smoothstep(peakMs - shape.riseMs, peakMs, nowMs);
  const fall = 1 - smoothstep(peakMs + shape.holdMs, peakMs + shape.holdMs + shape.fallMs, nowMs);
  return clamp01(rise * fall);
}

// ── PRONG 1: the scripted arrival arc ────────────────────────────────────────
/** The canonical arc span (ms) when the scene carries no archived timing. */
export const ARC_SPAN_MS = 28000;
/** The crest lands here into the span — ~10.5s, the authored "35-40% through" moment. */
export const ARC_CREST_FRACTION = 0.375;
/** The canonical arc shape: ~4s surge, a brief hold, a slow settle over the span's tail. */
export const CANONICAL_ARC_SHAPE: DropShape = { fallMs: 13000, holdMs: 1500, riseMs: 4000 };

// ── PRONG 2: the live reveal punch ───────────────────────────────────────────
/** The live reveal: a fast ~300ms attack, a brief hold, a slow ~8s release to the idle. */
export const REVEAL_SHAPE: DropShape = { fallMs: 8000, holdMs: 700, riseMs: 300 };

/**
 * The drop envelope engine. Holds the (optional) active scripted arc and the (optional)
 * active live reveal; `value()` folds them with the living idle each frame. No per-frame
 * allocation: state is a handful of scalars, and the pulses are computed in place.
 */
export class DropEnvelope {
  // scripted arc (prong 1)
  private arcOn = false;
  private arcPeakMs = 0;
  private arcEndMs = 0;
  private arcShape: DropShape = CANONICAL_ARC_SHAPE;

  // live reveal (prong 2)
  private revealOn = false;
  private revealPeakMs = 0;
  private revealEndMs = 0;

  /**
   * Fire the scripted arrival arc: buried -> crest -> settle over `spanMs` from `nowMs`,
   * crest at ARC_CREST_FRACTION. A `shape` (the scene's archived reactivity.drop timing)
   * overrides the canonical surge/settle when present. Re-fires cleanly — a replay `v` (or
   * a fresh arrival) restarts the arc from its buried floor, so the peak shows again.
   */
  triggerArc(nowMs: number, spanMs?: number, shape?: DropShape): void {
    // A track's duration is minutes; the composition's dramaturgy is a ~28s arc. Cap the
    // span so the crest lands in a natural viewing window rather than 90s deep.
    const span = spanMs !== undefined && spanMs > 0 ? Math.min(spanMs, ARC_SPAN_MS) : ARC_SPAN_MS;
    this.arcShape = shape ?? CANONICAL_ARC_SHAPE;
    this.arcPeakMs = nowMs + span * ARC_CREST_FRACTION;
    this.arcEndMs = this.arcPeakMs + this.arcShape.holdMs + this.arcShape.fallMs;
    this.arcOn = true;
  }

  /** Cancel any active scripted arc (an abstract-era arrival, or replay turned off). */
  clearArc(): void {
    this.arcOn = false;
  }

  /**
   * Fire a live reveal (the drop DETECTOR or the operator's MANUAL key). The peak lands one
   * attack (REVEAL_SHAPE.riseMs) after `nowMs`, then holds and releases over ~8s. Re-firing
   * mid-release simply re-anchors the punch (the operator can slam it again).
   */
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

  /**
   * The drop value this frame: max(livingIdle, scriptedArc, reveal), clamped 0..1. Retires
   * an arc / reveal once its pulse has fully fallen back so a settled world reads exactly its
   * living idle. Deterministic in `nowMs`, so it unit-tests directly.
   */
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

// ── PRONG 2a: the live drop DETECTOR ─────────────────────────────────────────
// The classic DnB drop signature: a sustained broadband-energy DIP (the breakdown)
// followed by a sustained broadband-energy SURGE (the slam). A pure hysteresis state
// machine fed the smoothed broadband energy (0..1) each frame; `observe` returns true on
// the single frame a drop fires. Conservative by design — a wrong-positive is a gentle
// unearned flood (the output rails still bound it), a wrong-negative is the status quo —
// so the thresholds are tuned to FIRE on real drops: a clear dip band below the surge band
// (the hysteresis gap), a dwell requirement on the dip (arm), a confirm dwell on the surge
// (fire), and a refractory window so one drop fires once.

export type DropDetectorOptions = {
  /** Energy below this = in a dip / breakdown. */
  dipLevel: number;
  /** Energy above this (while armed) = a slam. Must sit clearly above `dipLevel`. */
  surgeLevel: number;
  /** The dip must persist this long to ARM (a breakdown, not a momentary lull). */
  dipHoldMs: number;
  /** The surge must persist this long to FIRE (a sustained slam, not a single kick). */
  confirmMs: number;
  /** No second fire within this window of the last — one drop, one reveal. */
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

  /** Armed = a breakdown has been seen; the next sustained slam fires (outside refractory). */
  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * Feed one frame's smoothed broadband energy (0..1). Returns true on the frame a drop
   * fires. Pure state machine — no timers, no allocation.
   */
  observe(nowMs: number, energy: number): boolean {
    const o = this.opts;
    if (energy < o.dipLevel) {
      // In the dip: accrue dwell -> arm. Not surging.
      if (this.dipStartMs === null) {
        this.dipStartMs = nowMs;
      }
      if (nowMs - this.dipStartMs >= o.dipHoldMs) {
        this.armed = true;
      }
      this.surgeStartMs = null;
      return false;
    }
    // Out of the dip.
    this.dipStartMs = null;
    if (this.armed && energy >= o.surgeLevel) {
      // In the slam: accrue confirm dwell -> fire (once past the refractory window).
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
      // Between the bands (the buildup ramp) or not yet armed: hold, don't confirm.
      this.surgeStartMs = null;
    }
    return false;
  }
}
