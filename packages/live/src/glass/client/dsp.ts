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

  bassFast: number;
  midFast: number;
  trebleFast: number;
  energyFast: number;

  drop: number;
};

const MEL_BINS = 40;
const MEL_MAX_HZ = 8000;

const FAST_FFT_SIZE = 1024;

const SLOW_FFT_SIZE = 4096;

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

export function binHz(index: number, sampleRate: number, fftSize: number): number {
  return (index * sampleRate) / fftSize;
}

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

  lowLatency = true;
  private sink: GainNode;
  private bins: Float32Array<ArrayBuffer>;
  private fastBins: Float32Array<ArrayBuffer>;
  private source: MediaStreamAudioSourceNode | null = null;

  private sBass = 0;
  private sMid = 0;
  private sTreble = 0;
  private sEnergy = 0;
  private swell = 0;
  private kickSlow = 0;
  private prevBass = 0;
  private peak = 1e-6;
  private dropEnv = 0;

  private sBassFast = 0;
  private sMidFast = 0;
  private sTrebleFast = 0;
  private sEnergyFast = 0;
  private kickFast = 0;
  private prevBassFast = 0;
  private peakFast = 1e-6;

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

    this.analyser.connect(this.sink);
    this.fastAnalyser.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    this.fastBins = new Float32Array(this.fastAnalyser.frequencyBinCount);
  }

  connect(stream: MediaStream): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {}
    }
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.source.connect(this.fastAnalyser);
  }

  get analyserNode(): AnalyserNode {
    return this.analyser;
  }

  get fastAnalyserNode(): AnalyserNode {
    return this.fastAnalyser;
  }

  update(): DspFrame {
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

    const delta = Math.max(0, nb - this.prevBass);
    this.prevBass = nb;
    this.kickSlow = Math.max(this.kickSlow * 0.86, Math.min(1, delta * 4));

    const lo = this.swell * 0.9;
    const hi = this.swell * 1.4 + 0.05;
    const x = Math.min(Math.max((this.sEnergy - lo) / Math.max(hi - lo, 1e-4), 0), 1);
    const dropTarget = x * x * (3 - 2 * x);
    this.dropEnv += (dropTarget - this.dropEnv) * 0.07;

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

  melFrame(): number[] {
    return computeMelFrame(this.bins, this.ctx.sampleRate, SLOW_FFT_SIZE, this.melFilters);
  }
}
