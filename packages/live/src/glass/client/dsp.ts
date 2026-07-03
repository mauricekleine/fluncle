// Live DSP — the audio texture the whole glass rides on. Mirrors the pipeline's
// band conventions (<150 / 150-2k / >2k) with fast-attack/slow-release followers,
// a rolling-peak normalizer, and a kick transient. Plus the 40-bin log-mel frame
// the bridge streams to Unit B's fingerprint matcher (the agreed {number[40]} shape).
//
// The getUserMedia constraints are MANDATED off (RFC §3): Chrome's AGC / noise
// suppression / echo cancellation would pump the energy envelope and gate the
// transients while OBS's copy sounds fine — invisible corruption. The AudioContext
// is forced to 48kHz to match the transport chain.

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: false,
  echoCancellation: false,
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
  /** Live u_audioDrop analog: how far energy sits above the swell baseline. */
  drop: number;
};

const MEL_BINS = 40;
const MEL_MAX_HZ = 8000;

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

export class Dsp {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private sink: GainNode;
  private bins: Float32Array<ArrayBuffer>;
  private source: MediaStreamAudioSourceNode | null = null;

  // followers
  private sBass = 0;
  private sMid = 0;
  private sTreble = 0;
  private sEnergy = 0;
  private swell = 0;
  private kick = 0;
  private prevBass = 0;
  private peak = 1e-6;
  private dropEnv = 0;

  // mel filterbank (built once for the analyser geometry)
  private melFilters: Array<{ lo: number; hi: number; peak: number }> = [];

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ sampleRate: 48000 });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.analyser.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    this.buildMelBank();
  }

  private binHz(i: number): number {
    return (i * this.ctx.sampleRate) / this.analyser.fftSize;
  }

  private buildMelBank(): void {
    const melLo = hzToMel(0);
    const melHi = hzToMel(MEL_MAX_HZ);
    const points: number[] = [];
    for (let i = 0; i < MEL_BINS + 2; i++) {
      points.push(melToHz(melLo + ((melHi - melLo) * i) / (MEL_BINS + 1)));
    }
    this.melFilters = [];
    for (let m = 1; m <= MEL_BINS; m++) {
      this.melFilters.push({ hi: points[m + 1], lo: points[m - 1], peak: points[m] });
    }
  }

  /** Attach a live input stream (replaces any previous source). */
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
  }

  /** A node for the demo synth to feed the SAME analyser. */
  get analyserNode(): AnalyserNode {
    return this.analyser;
  }

  update(): DspFrame {
    this.analyser.getFloatFrequencyData(this.bins);
    let b = 0,
      bn = 0,
      m = 0,
      mn = 0,
      t = 0,
      tn = 0;
    for (let i = 1; i < this.bins.length; i++) {
      const f = this.binHz(i);
      const mag = Math.pow(10, this.bins[i] / 20);
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
    b /= bn || 1;
    m /= mn || 1;
    t /= tn || 1;
    this.peak = Math.max(b, m, this.peak * 0.9995, 1e-6);
    const nb = Math.min(1, b / this.peak);
    const nm = Math.min(1, m / this.peak);
    const nt = Math.min(1, t / (this.peak * 0.35));
    const ema = (s: number, v: number, a: number, d: number): number =>
      v > s ? s + (v - s) * a : s + (v - s) * d;
    this.sBass = ema(this.sBass, nb, 0.5, 0.12);
    this.sMid = ema(this.sMid, nm, 0.4, 0.1);
    this.sTreble = ema(this.sTreble, nt, 0.5, 0.15);
    this.sEnergy = ema(this.sEnergy, nb * 0.5 + nm * 0.35 + nt * 0.15, 0.3, 0.06);
    this.swell = ema(this.swell, this.sEnergy, 0.02, 0.01);
    const delta = Math.max(0, nb - this.prevBass);
    this.prevBass = nb;
    this.kick = Math.max(this.kick * 0.86, Math.min(1, delta * 4));
    // drop: smoothstep of energy across the swell baseline
    const lo = this.swell * 0.9;
    const hi = this.swell * 1.4 + 0.05;
    const x = Math.min(Math.max((this.sEnergy - lo) / Math.max(hi - lo, 1e-4), 0), 1);
    const dropTarget = x * x * (3 - 2 * x);
    this.dropEnv += (dropTarget - this.dropEnv) * 0.07;

    return {
      bass: this.sBass,
      drop: this.dropEnv,
      energy: this.sEnergy,
      kick: this.kick,
      mid: this.sMid,
      swell: this.swell,
      treble: this.sTreble,
    };
  }

  /** The 40-bin log-mel frame (0-8kHz) the bridge streams to the matcher. */
  melFrame(): number[] {
    // bins already filled by update() this frame.
    const out: number[] = Array.from({ length: MEL_BINS }, () => 0);
    for (let m = 0; m < MEL_BINS; m++) {
      const f = this.melFilters[m];
      let acc = 0;
      for (let i = 1; i < this.bins.length; i++) {
        const hz = this.binHz(i);
        if (hz < f.lo || hz > f.hi) {
          continue;
        }
        const mag = Math.pow(10, this.bins[i] / 20);
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
}
