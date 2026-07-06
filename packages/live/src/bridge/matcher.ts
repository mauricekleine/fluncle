// THE PLAN-SCOPED FINGERPRINT MATCHER — the star of Unit B.
//
// A set is PLANNED: the ordered tracklist exists before the first beat (the
// plan->recording->mixtape spine). So identity is a TINY search — never "which of
// the archive is this?", only "has the PENDING (pointer+1) planned finding started
// yet?". At show start the bridge fingerprints each planned finding's 30s preview
// (log-mel, `mel.ts`); at show time the glass streams 10Hz mel frames; this matcher
// keeps a rolling ~22s window and scores it against the pending fingerprint. A
// confirmed match advances the pointer. MANUAL advance/rewind/goto ALWAYS win.
//
// Design, calibrated against the de-risk spike's real set (mixtape 019.F.1A,
// 17 tracks; see accuracy.ts):
//
//   * The primitive is `bestOffsetScore` — a rolling window (default 22s) slid over
//     the preview fingerprint at the best contiguous offset (mean per-frame cosine).
//   * Liquid DnB previews are spectrally near-identical, so an absolute-threshold
//     baseline is non-discriminative on its own (measured: wrong-track windows reach
//     0.86-0.94). The winning gate is a HYBRID: advance when the pending both clears
//     a mid absolute floor AND beats the CURRENT pointer track by a margin (the mix
//     hand-off), OR clears a HIGH absolute override (a strong, unambiguous hook) —
//     THEN sustained past `sustainMs` (a real hook holds high; baseline spikes are
//     brief), gated by a `minDwellMs` refractory (a longer `firstDwellMs` for the
//     opener) so the pointer cannot cascade. The match TIME is centered on the
//     window so the ~half-window fill latency does not bias the pointer late.
//   * The ENERGY dip->surge detector runs as the PRE-ARM HINT ONLY (RFC §4): on a
//     detected transition it briefly relaxes the gate (`prearmBonus`), raising
//     sensitivity — it NEVER advances on its own (the spike refuted energy as an
//     advance mechanism: liquid mix-ins carry no energy signature).
//
// Pure and deterministic: no I/O, no clock — the host feeds frames + timestamps.
// Everything here is unit-tested (matcher.test.ts) and replay-tested (accuracy.ts).

import { MEL_BINS } from "../contract";

/** A server-side preview fingerprint: SHAPE-normalized log-mel frames + its logId. */
export type Fingerprint = {
  logId: string;
  /** 10Hz shape-normalized log-mel frames (each length MEL_BINS), or null when the
   * finding has no preview (unfingerprintable → the matcher skips over it). */
  frames: Float32Array[] | null;
};

/** All knobs of the matcher, with the spike-calibrated defaults. Times in ms. */
export type MatcherConfig = {
  /** Rolling window length in frames (10Hz). 220 = 22s — long enough to be a
   * contiguous structural match, short enough to confirm inside a mixed hook. */
  windowFrames: number;
  /** Offset step (frames) when sliding the window over a preview. 3 = 300ms. */
  offsetStep: number;
  /** The mid absolute floor for the margin path. */
  midThreshold: number;
  /** How far the pending must beat the current pointer track (the hand-off). */
  margin: number;
  /** The high absolute override (a strong hook that needs no margin). */
  highThreshold: number;
  /** Sustained-match time required to advance. */
  sustainMs: number;
  /** How much sustain a matching frame adds (= the hop, 100ms at 10Hz). */
  sustainStepMs: number;
  /** How much a non-matching frame subtracts (>step so brief spikes decay). */
  sustainDecayMs: number;
  /** Refractory after an auto-advance (per-track min dwell). */
  minDwellMs: number;
  /** A longer dwell before the FIRST auto-advance (the opener always plays a while). */
  firstDwellMs: number;
  /** Threshold relief while the pre-arm hint is active (added to sensitivity). */
  prearmBonus: number;
  /** SKIP-AHEAD floor: pending+1 confirming at/above this (while the pending stays
   * weak) advances TWO — a weak/unmatchable preview must not park the pointer. */
  skipThreshold: number;
  /** How far pending+1 must beat the pending for a skip (clear evidence). */
  skipMargin: number;
  /** Sustain for the skip path — shorter than sustainMs: a skip peak is narrow
   * (tight tail mixing) and the gate is already double-conditioned. */
  skipSustainMs: number;
  /** The mel frame hop (ms). */
  hopMs: number;
};

// Defaults calibrated against the de-risk spike's real set (mixtape 019.F.1A;
// accuracy.ts) in the SHAPE-normalized domain (mean-subtract + L2 — see mel.ts):
// self-at-hook cosines run ~0.6-0.9 while foreign material sits ~0.0-0.5, so the
// gate floors live far lower than plain-L2 cosines would suggest. The operating
// point keeps the pointer monotone with zero phantom/out-of-order advances; a
// weak/unmatchable preview (a remix mismatch, a preview-less finding) is escaped by
// the skip-ahead rule or the manual nudge rather than lowering the floors.
export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  firstDwellMs: 200_000,
  highThreshold: 0.8,
  hopMs: 100,
  margin: 0.1,
  midThreshold: 0.6,
  minDwellMs: 100_000,
  offsetStep: 3,
  prearmBonus: 0.03,
  skipMargin: 0.08,
  skipSustainMs: 1_500,
  skipThreshold: 0.7,
  sustainDecayMs: 200,
  sustainMs: 4_000,
  sustainStepMs: 100,
  windowFrames: 220,
};

/** Cosine of two L2-normalized frames = their dot product. */
export function frameCosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < MEL_BINS; i++) {
    d += a[i] * b[i];
  }
  return d;
}

/**
 * Best contiguous alignment of the rolling `window` against a preview `fp`: slide
 * the shorter over the longer at `offsetStep` and return the max mean per-frame
 * cosine. Returns 0 when either side is empty. Symmetric in length (early in a
 * show the window is shorter than the preview; both branches are covered).
 */
export function bestOffsetScore(
  window: Float32Array[],
  fp: Float32Array[],
  offsetStep: number,
): number {
  const w = window.length;
  const p = fp.length;
  if (w === 0 || p === 0) {
    return 0;
  }
  const step = Math.max(1, offsetStep);
  // Slide the shorter sequence over the longer one.
  const [short, long] = w <= p ? [window, fp] : [fp, window];
  const s = short.length;
  const l = long.length;
  let best = -1;
  for (let o = 0; o + s <= l; o += step) {
    let acc = 0;
    for (let m = 0; m < s; m++) {
      acc += frameCosine(short[m], long[o + m]);
    }
    const score = acc / s;
    if (score > best) {
      best = score;
    }
  }
  return best < 0 ? 0 : best;
}

/**
 * The energy dip->surge PRE-ARM detector (RFC §4 parameters). Consumes a per-frame
 * energy value (the sum of the raw mel frame BEFORE L2-normalization is the natural
 * energy proxy; the host passes it alongside the normalized frame). Fast-attack /
 * slow-release followers on two timescales; a dip below `swell·dipRatio` held past
 * `minDipMs`, then a surge above `swell·surgeRatio`, fires the hint (subject to a
 * refractory). This is a HINT source only — it never advances the pointer.
 */
export class EnergyPrearm {
  private sEnergy = 0;
  private swell = 0;
  private dipping = false;
  private dipStartMs = -1;
  private lastFireMs = -1e9;

  // RFC §4 params (100ms hop).
  private readonly sAttack = 0.882;
  private readonly sRelease = 0.31;
  private readonly swAttack = 0.114;
  private readonly swRelease = 0.059;
  private readonly dipRatio = 0.45;
  private readonly surgeRatio = 1.15;
  private readonly minDipMs = 2_000;
  private readonly refractoryMs = 90_000;
  private readonly silenceFloor = 0.08;

  /** Feed one frame's energy; returns true on the frame a transition fires. */
  push(energy: number, tMs: number): boolean {
    const ema = (state: number, v: number, a: number, d: number): number =>
      v > state ? state + (v - state) * a : state + (v - state) * d;
    this.sEnergy = ema(this.sEnergy, energy, this.sAttack, this.sRelease);
    this.swell = ema(this.swell, this.sEnergy, this.swAttack, this.swRelease);
    if (this.swell < this.silenceFloor) {
      this.dipping = false;
      this.dipStartMs = -1;
      return false;
    }
    if (this.sEnergy < this.swell * this.dipRatio) {
      if (!this.dipping) {
        this.dipping = true;
        this.dipStartMs = tMs;
      }
    } else if (this.dipping && this.sEnergy > this.swell * this.surgeRatio) {
      const dipHeld = tMs - this.dipStartMs >= this.minDipMs;
      this.dipping = false;
      this.dipStartMs = -1;
      if (dipHeld && tMs - this.lastFireMs >= this.refractoryMs) {
        this.lastFireMs = tMs;
        return true;
      }
    }
    return false;
  }

  /** Whether a fired hint is still within its active window. */
  activeAt(tMs: number, windowMs: number): boolean {
    return tMs - this.lastFireMs < windowMs;
  }
}

/** What `pushFrame` reports back to the host each frame. */
export type MatchTick = {
  /** True on the frame the pointer auto-advanced. */
  advanced: boolean;
  pointer: number;
  /** The pending (next fingerprintable) index the matcher is watching. */
  pending: number;
  /** Best score of the window vs the pending fingerprint this frame (0..1). */
  score: number;
  /** Best score vs the current pointer track (for the margin gate). */
  currentScore: number;
  /** The pre-arm hint is currently active. */
  prearmed: boolean;
  /** Accumulated sustain (ms) toward the advance threshold. */
  sustainMs: number;
};

/** How the pointer last moved (mirrors ShowState.plan.source). */
export type PointerSource = "boot" | "manual" | "fingerprint";

/**
 * The streaming plan matcher. Owns the pointer over an ordered fingerprint list.
 * The host pushes mel frames; manual advance/rewind/goto override instantly.
 */
export class PlanMatcher {
  private readonly cfg: MatcherConfig;
  private readonly fps: Fingerprint[];
  private readonly window: Float32Array[] = [];
  private readonly prearm = new EnergyPrearm();
  private pointer = 0;
  private source: PointerSource = "boot";
  private sustain = 0;
  private skipSustain = 0;
  private lastAdvanceMs = 0;
  private advanceCount = 0;
  private lastScore = 0;
  private lastCurrentScore = 0;
  /** The pre-arm hint stays active this long after firing (relaxes the gate). */
  private readonly prearmActiveMs = 8_000;

  constructor(fingerprints: Fingerprint[], config: Partial<MatcherConfig> = {}) {
    this.fps = fingerprints;
    this.cfg = { ...DEFAULT_MATCHER_CONFIG, ...config };
  }

  get pointerIndex(): number {
    return this.pointer;
  }

  get pointerSource(): PointerSource {
    return this.source;
  }

  /** The next fingerprintable index after `from` (skips preview-less findings). */
  private pendingAfter(from: number): number {
    let p = from + 1;
    while (p < this.fps.length && this.fps[p].frames === null) {
      p++;
    }
    return p;
  }

  /** Feed one 10Hz mel frame (shape-normalized) + its raw energy + timestamp. */
  pushFrame(frame: Float32Array, energy: number, tMs: number): MatchTick {
    this.window.push(frame);
    if (this.window.length > this.cfg.windowFrames) {
      this.window.shift();
    }
    this.prearm.push(energy, tMs);
    const prearmed = this.prearm.activeAt(tMs, this.prearmActiveMs);

    const pending = this.pendingAfter(this.pointer);
    // Nothing left to match, or the window has not filled yet.
    if (pending >= this.fps.length || this.window.length < this.cfg.windowFrames) {
      this.lastScore = 0;
      this.lastCurrentScore = 0;
      return this.tick(false, pending, 0, 0, prearmed);
    }

    const pendingFp = this.fps[pending].frames;
    const sPend = pendingFp ? bestOffsetScore(this.window, pendingFp, this.cfg.offsetStep) : 0;
    const currentFp = this.fps[this.pointer]?.frames ?? null;
    const sCur = currentFp ? bestOffsetScore(this.window, currentFp, this.cfg.offsetStep) : 0;
    this.lastScore = sPend;
    this.lastCurrentScore = sCur;

    const dwell = this.advanceCount === 0 ? this.cfg.firstDwellMs : this.cfg.minDwellMs;
    const eligible = tMs - this.lastAdvanceMs >= dwell;
    // Pre-arm relaxes both the margin floor and the absolute override slightly.
    const bonus = prearmed ? this.cfg.prearmBonus : 0;
    const marginOk =
      sPend >= this.cfg.midThreshold - bonus && sPend >= sCur + this.cfg.margin - bonus;
    const absOk = sPend >= this.cfg.highThreshold - bonus;
    const gateOpen = eligible && (marginOk || absOk);

    if (gateOpen) {
      this.sustain += this.cfg.sustainStepMs;
    } else {
      this.sustain = Math.max(0, this.sustain - this.cfg.sustainDecayMs);
    }

    // SKIP-AHEAD: a weak/unmatchable pending preview (a remix mismatch) must not
    // park the pointer for the rest of the show. When pending+1 confirms STRONGLY
    // while the pending stays clearly weaker, advance TWO — still monotone-forward,
    // gated by the same dwell + its own sustain accumulator (measured: t12 of the
    // calibration set never exceeds ~0.48 anywhere while t13 hits 0.79 at its hook).
    const pending2 = this.pendingAfter(pending);
    let sSkip = 0;
    if (eligible && pending2 < this.fps.length) {
      const skipFp = this.fps[pending2].frames;
      sSkip = skipFp ? bestOffsetScore(this.window, skipFp, this.cfg.offsetStep) : 0;
      const skipOk =
        sSkip >= this.cfg.skipThreshold - bonus && sSkip >= sPend + this.cfg.skipMargin;
      if (skipOk) {
        this.skipSustain += this.cfg.sustainStepMs;
      } else {
        this.skipSustain = Math.max(0, this.skipSustain - this.cfg.sustainDecayMs);
      }
    } else {
      this.skipSustain = 0;
    }

    if (this.sustain >= this.cfg.sustainMs) {
      this.pointer = pending;
      return this.commitAuto(tMs, sPend, sCur, prearmed);
    }
    if (this.skipSustain >= this.cfg.skipSustainMs) {
      this.pointer = pending2;
      return this.commitAuto(tMs, sSkip, sCur, prearmed);
    }
    return this.tick(false, pending, sPend, sCur, prearmed);
  }

  /** Shared bookkeeping for a fingerprint-driven pointer move. */
  private commitAuto(tMs: number, score: number, sCur: number, prearmed: boolean): MatchTick {
    this.source = "fingerprint";
    this.lastAdvanceMs = tMs;
    this.advanceCount++;
    this.sustain = 0;
    this.skipSustain = 0;
    return this.tick(true, this.pendingAfter(this.pointer), score, sCur, prearmed);
  }

  private tick(
    advanced: boolean,
    pending: number,
    score: number,
    currentScore: number,
    prearmed: boolean,
  ): MatchTick {
    return {
      advanced,
      currentScore,
      pending,
      pointer: this.pointer,
      prearmed,
      score,
      sustainMs: this.sustain,
    };
  }

  /** MANUAL next — always wins, instantly. Resets the refractory + sustain. */
  advance(tMs: number): void {
    if (this.pointer < this.fps.length - 1) {
      this.pointer++;
      this.commitManual(tMs);
    }
  }

  /** MANUAL previous — always wins. */
  rewind(tMs: number): void {
    if (this.pointer > 0) {
      this.pointer--;
      this.commitManual(tMs);
    }
  }

  /** MANUAL jump — always wins. Clamped to the plan. */
  goto(index: number, tMs: number): void {
    this.pointer = Math.min(Math.max(index, 0), Math.max(0, this.fps.length - 1));
    this.commitManual(tMs);
  }

  private commitManual(tMs: number): void {
    this.source = "manual";
    this.lastAdvanceMs = tMs;
    this.advanceCount++;
    this.sustain = 0;
    this.skipSustain = 0;
  }

  /** Diagnostics for the state/HUD without pushing a frame. */
  snapshot(): { pointer: number; source: PointerSource; score: number; currentScore: number } {
    return {
      currentScore: this.lastCurrentScore,
      pointer: this.pointer,
      score: this.lastScore,
      source: this.source,
    };
  }
}
