import { MEL_BINS } from "../contract";

export type Fingerprint = {
  logId: string;

  frames: Float32Array[] | null;
};

export type MatcherConfig = {
  windowFrames: number;

  offsetStep: number;

  midThreshold: number;

  margin: number;

  highThreshold: number;

  sustainMs: number;

  sustainStepMs: number;

  sustainDecayMs: number;

  minDwellMs: number;

  firstDwellMs: number;

  prearmBonus: number;

  skipThreshold: number;

  skipMargin: number;

  skipSustainMs: number;

  hopMs: number;
};

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

export function frameCosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < MEL_BINS; i++) {
    d += a[i] * b[i];
  }
  return d;
}

export const OFFSET_POSITION_BUDGET = 150;

export function budgetedOffsetStep(
  shortLen: number,
  longLen: number,
  floorStep: number,
  budget = OFFSET_POSITION_BUDGET,
): number {
  const floor = Math.max(1, floorStep);
  const span = longLen - shortLen;
  if (span <= 0 || budget <= 0) {
    return floor;
  }
  return Math.max(floor, Math.ceil(span / budget));
}

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

  const [short, long] = w <= p ? [window, fp] : [fp, window];
  const s = short.length;
  const l = long.length;

  const step = budgetedOffsetStep(s, l, offsetStep);
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

export class EnergyPrearm {
  private sEnergy = 0;
  private swell = 0;
  private dipping = false;
  private dipStartMs = -1;
  private lastFireMs = -1e9;

  private readonly sAttack = 0.882;
  private readonly sRelease = 0.31;
  private readonly swAttack = 0.114;
  private readonly swRelease = 0.059;
  private readonly dipRatio = 0.45;
  private readonly surgeRatio = 1.15;
  private readonly minDipMs = 2_000;
  private readonly refractoryMs = 90_000;
  private readonly silenceFloor = 0.08;

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

  activeAt(tMs: number, windowMs: number): boolean {
    return tMs - this.lastFireMs < windowMs;
  }
}

export type MatchTick = {
  advanced: boolean;
  pointer: number;

  pending: number;

  score: number;

  currentScore: number;

  prearmed: boolean;

  sustainMs: number;
};

export type PointerSource = "boot" | "manual" | "fingerprint";

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

  private pendingAfter(from: number): number {
    let p = from + 1;
    while (p < this.fps.length && this.fps[p].frames === null) {
      p++;
    }
    return p;
  }

  pushFrame(frame: Float32Array, energy: number, tMs: number): MatchTick {
    this.window.push(frame);
    if (this.window.length > this.cfg.windowFrames) {
      this.window.shift();
    }
    this.prearm.push(energy, tMs);
    const prearmed = this.prearm.activeAt(tMs, this.prearmActiveMs);

    const pending = this.pendingAfter(this.pointer);

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

  advance(tMs: number): void {
    if (this.pointer < this.fps.length - 1) {
      this.pointer++;
      this.commitManual(tMs);
    }
  }

  rewind(tMs: number): void {
    if (this.pointer > 0) {
      this.pointer--;
      this.commitManual(tMs);
    }
  }

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

  snapshot(): { pointer: number; source: PointerSource; score: number; currentScore: number } {
    return {
      currentScore: this.lastCurrentScore,
      pointer: this.pointer,
      score: this.lastScore,
      source: this.source,
    };
  }
}
