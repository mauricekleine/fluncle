// Live DSP — the audio texture the whole glass rides on. Mirrors the pipeline's
// band conventions (<150 / 150-2k / >2k) with fast-attack/slow-release followers,
// a rolling-peak normalizer, and a kick transient. Plus the 40-bin log-mel frame
// the bridge streams to Unit B's fingerprint matcher (the agreed {number[40]} shape).
//
// DUAL RESOLUTION (low-latency DSP, operator toggle `l`): the slow/bass/mel signals
// keep the 4096-sample FFT (~85ms window) — frequency resolution below 60Hz needs it
// (1024 → ~47Hz/bin, too coarse). The transient class (kick/onset, the *Fast band
// variants) instead reads a SECOND AnalyserNode at fftSize 1024 (~21ms window) so a
// kick/snare onset reaches the pixels ~60ms sooner. Both analysers run
// smoothingTimeConstant = 0 (the EMAs below own all smoothing). Legacy mode (toggle
// off) routes every signal from the single 4096 path — the exact pre-dual behavior.
//
// The getUserMedia constraints are MANDATED off (RFC §3): Chrome's AGC / noise
// suppression / echo cancellation would pump the energy envelope and gate the
// transients while OBS's copy sounds fine — invisible corruption. `latency: 0.01`
// asks the input chain for the smallest buffer it will give. The AudioContext is
// forced to 48kHz (transport chain) and hinted "interactive" (smallest output buffer).

// `latency` is a spec-defined audio ConstrainDouble (Media Capture and Streams) the
// DOM lib type has not caught up to; widen locally rather than drop the hint.
export const MIC_CONSTRAINTS: MediaTrackConstraints & { latency?: number } = {
  autoGainControl: false,
  echoCancellation: false,
  latency: 0.01,
  noiseSuppression: false,
  sampleRate: 48000,
};

export type DspFrame = {
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  swell: number;
  kick: number;
  // The transient-class *Fast siblings — the low-latency (1024-FFT) band followers
  // when low-latency DSP is on, otherwise a mirror of the slow bands (legacy path).
  bassFast: number;
  midFast: number;
  trebleFast: number;
  energyFast: number;
  /** Live u_audioDrop analog: how far energy sits above the swell baseline. */
  drop: number;
};

const MEL_BINS = 40;
const MEL_MAX_HZ = 8000;
/** The low-latency transient analyser FFT size (~21ms window @ 48kHz). */
const FAST_FFT_SIZE = 1024;
/** The slow / bass / mel analyser FFT size (~85ms window @ 48kHz). */
const SLOW_FFT_SIZE = 4096;

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

// ---- pure DSP helpers (unit-tested; no Web Audio dependency) ----------------

/** Frequency (Hz) of FFT bin `index` for a sample rate and FFT size. */
export function binHz(index: number, sampleRate: number, fftSize: number): number {
  return (index * sampleRate) / fftSize;
}

/**
 * Average linear magnitude in each of the three bands (<150 / 150-2k / 2k-16k Hz)
 * over a getFloatFrequencyData(dB) buffer. Pure; the SAME routine drives the slow
 * 4096 analyser and the low-latency 1024 analyser — only `fftSize` (the bin width)
 * changes, so the band boundaries land on the right bins for either resolution.
 */
export function bandEnergies(
  bins: Float32Array,
  sampleRate: number,
  fftSize: number,
): { bass: number; mid: number; treble: number } {
  let b = 0,
    bn = 0,
    m = 0,
    mn = 0,
    t = 0,
    tn = 0;
  for (let i = 1; i < bins.length; i++) {
    const f = binHz(i, sampleRate, fftSize);
    const mag = Math.pow(10, bins[i] / 20);
    if (f < 150) {
      b += mag;
      bn++;
    } else if (f < 2000) {
      m += mag;
      mn++;
    } else if (f < 16000) {
      t += mag;
      tn++;
    }
  }
  return { bass: b / (bn || 1), mid: m / (mn || 1), treble: t / (tn || 1) };
}

export type MelFilter = { lo: number; hi: number; peak: number };

/** The 40-band triangular mel filterbank (0-8kHz), built once for the analyser geometry. */
export function buildMelFilters(): MelFilter[] {
  const melLo = hzToMel(0);
  const melHi = hzToMel(MEL_MAX_HZ);
  const points: number[] = [];
  for (let i = 0; i < MEL_BINS + 2; i++) {
    points.push(melToHz(melLo + ((melHi - melLo) * i) / (MEL_BINS + 1)));
  }
  const filters: MelFilter[] = [];
  for (let m = 1; m <= MEL_BINS; m++) {
    filters.push({ hi: points[m + 1], lo: points[m - 1], peak: points[m] });
  }
  return filters;
}

/**
 * The 40-bin log-mel frame the bridge fingerprint-matches against. Pure, and reads
 * ONLY the buffer it is given — CALIBRATION-CRITICAL: the matcher's thresholds are
 * tuned on this exact computation over the 4096 path, so the low-latency dual-
 * analyser work must never reach it. (Regression: dsp.test.ts locks the output.)
 */
export function computeMelFrame(
  bins: Float32Array,
  sampleRate: number,
  fftSize: number,
  filters: MelFilter[],
): number[] {
  const out: number[] = Array.from({ length: filters.length }, () => 0);
  for (let m = 0; m < filters.length; m++) {
    const f = filters[m];
    let acc = 0;
    for (let i = 1; i < bins.length; i++) {
      const hz = binHz(i, sampleRate, fftSize);
      if (hz < f.lo || hz > f.hi) {
        continue;
      }
      const mag = Math.pow(10, bins[i] / 20);
      const w =
        hz <= f.peak
          ? (hz - f.lo) / Math.max(f.peak - f.lo, 1e-6)
          : (f.hi - hz) / Math.max(f.hi - f.peak, 1e-6);
      acc += mag * Math.max(0, w);
    }
    out[m] = Math.log(1 + acc);
  }
  return out;
}

export class Dsp {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly fastAnalyser: AnalyserNode;
  /** Low-latency DSP: transient signals ride the 1024 analyser. Operator toggle `l`. */
  lowLatency = true;
  private sink: GainNode;
  private bins: Float32Array<ArrayBuffer>;
  private fastBins: Float32Array<ArrayBuffer>;
  private source: MediaStreamAudioSourceNode | null = null;

  // slow (4096) followers
  private sBass = 0;
  private sMid = 0;
  private sTreble = 0;
  private sEnergy = 0;
  private swell = 0;
  private kickSlow = 0;
  private prevBass = 0;
  private peak = 1e-6;
  private dropEnv = 0;

  // fast (1024) transient followers
  private sBassFast = 0;
  private sMidFast = 0;
  private sTrebleFast = 0;
  private sEnergyFast = 0;
  private kickFast = 0;
  private prevBassFast = 0;
  private peakFast = 1e-6;

  // mel filterbank (built once)
  private melFilters: MelFilter[] = buildMelFilters();

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: "interactive", sampleRate: 48000 });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = SLOW_FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.fastAnalyser = this.ctx.createAnalyser();
    this.fastAnalyser.fftSize = FAST_FFT_SIZE;
    this.fastAnalyser.smoothingTimeConstant = 0;
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    // Both analysers feed the muted sink so both stay in the active render graph.
    this.analyser.connect(this.sink);
    this.fastAnalyser.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    this.fastBins = new Float32Array(this.fastAnalyser.frequencyBinCount);
  }

  /** Attach a live input stream (replaces any previous source). Feeds BOTH analysers. */
  connect(stream: MediaStream): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // already gone
      }
    }
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.source.connect(this.fastAnalyser);
  }

  /** The slow analyser — the demo synth feeds this (and fastAnalyserNode) directly. */
  get analyserNode(): AnalyserNode {
    return this.analyser;
  }

  /** The low-latency analyser — the demo synth must feed this too. */
  get fastAnalyserNode(): AnalyserNode {
    return this.fastAnalyser;
  }

  update(): DspFrame {
    // --- slow (4096) path: bass / mid / treble / energy / swell / drop / mel ---
    this.analyser.getFloatFrequencyData(this.bins);
    const slow = bandEnergies(this.bins, this.ctx.sampleRate, SLOW_FFT_SIZE);
    this.peak = Math.max(slow.bass, slow.mid, this.peak * 0.9995, 1e-6);
    const nb = Math.min(1, slow.bass / this.peak);
    const nm = Math.min(1, slow.mid / this.peak);
    const nt = Math.min(1, slow.treble / (this.peak * 0.35));
    const ema = (s: number, v: number, a: number, d: number): number =>
      v > s ? s + (v - s) * a : s + (v - s) * d;
    this.sBass = ema(this.sBass, nb, 0.5, 0.12);
    this.sMid = ema(this.sMid, nm, 0.4, 0.1);
    this.sTreble = ema(this.sTreble, nt, 0.5, 0.15);
    this.sEnergy = ema(this.sEnergy, nb * 0.5 + nm * 0.35 + nt * 0.15, 0.3, 0.06);
    this.swell = ema(this.swell, this.sEnergy, 0.02, 0.01);
    // legacy kick: 4096 bass delta (the exact pre-dual transient).
    const delta = Math.max(0, nb - this.prevBass);
    this.prevBass = nb;
    this.kickSlow = Math.max(this.kickSlow * 0.86, Math.min(1, delta * 4));
    // drop: smoothstep of energy across the swell baseline
    const lo = this.swell * 0.9;
    const hi = this.swell * 1.4 + 0.05;
    const x = Math.min(Math.max((this.sEnergy - lo) / Math.max(hi - lo, 1e-4), 0), 1);
    const dropTarget = x * x * (3 - 2 * x);
    this.dropEnv += (dropTarget - this.dropEnv) * 0.07;

    // --- fast (1024) path: the transient class, snappier followers ---
    this.fastAnalyser.getFloatFrequencyData(this.fastBins);
    const fast = bandEnergies(this.fastBins, this.ctx.sampleRate, FAST_FFT_SIZE);
    this.peakFast = Math.max(fast.bass, fast.mid, this.peakFast * 0.9995, 1e-6);
    const nbF = Math.min(1, fast.bass / this.peakFast);
    const nmF = Math.min(1, fast.mid / this.peakFast);
    const ntF = Math.min(1, fast.treble / (this.peakFast * 0.35));
    this.sBassFast = ema(this.sBassFast, nbF, 0.85, 0.35);
    this.sMidFast = ema(this.sMidFast, nmF, 0.8, 0.3);
    this.sTrebleFast = ema(this.sTrebleFast, ntF, 0.85, 0.35);
    this.sEnergyFast = ema(this.sEnergyFast, nbF * 0.5 + nmF * 0.35 + ntF * 0.15, 0.7, 0.25);
    const deltaF = Math.max(0, nbF - this.prevBassFast);
    this.prevBassFast = nbF;
    this.kickFast = Math.max(this.kickFast * 0.86, Math.min(1, deltaF * 4));

    const low = this.lowLatency;
    return {
      bass: this.sBass,
      bassFast: low ? this.sBassFast : this.sBass,
      drop: this.dropEnv,
      energy: this.sEnergy,
      energyFast: low ? this.sEnergyFast : this.sEnergy,
      kick: low ? this.kickFast : this.kickSlow,
      mid: this.sMid,
      midFast: low ? this.sMidFast : this.sMid,
      swell: this.swell,
      treble: this.sTreble,
      trebleFast: low ? this.sTrebleFast : this.sTreble,
    };
  }

  /** The 40-bin log-mel frame (0-8kHz) the bridge streams to the matcher. */
  melFrame(): number[] {
    // bins already filled by update() this frame — the SAME 4096 path, unchanged.
    return computeMelFrame(this.bins, this.ctx.sampleRate, SLOW_FFT_SIZE, this.melFilters);
  }
}
