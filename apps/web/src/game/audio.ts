import { type SimEvent, type SimState, nearestCarrier } from "./sim";

// The audio thesis (docs/galaxy-game.md): the only music in the galaxy is the
// findings. The nearest uncollected banger fades in by distance and pans by
// bearing; in orbit it plays full and centered (the listening moment), and a
// collected star still sings on revisit. Everything else is diegetic 8-bit
// SFX synthesized on the fly — no assets, square waves only.
//
// Previews stream through the same-origin proxy (/api/preview/:trackId) so
// the gain/pan graph stays CORS-clean regardless of where the bytes live.

/** Decoded 30s stereo previews are ~10MB each; keep a small LRU. */
const BUFFER_CACHE_LIMIT = 6;
const CROSSFADE_SECONDS = 0.3;

type PlayingPreview = {
  gain: GainNode;
  panner: StereoPannerNode;
  source: AudioBufferSourceNode;
  trackId: string;
};

export type AudioManager = {
  destroy: () => void;
  handleEvent: (event: SimEvent, state: SimState) => void;
  muted: () => boolean;
  resume: () => void;
  setMuted: (value: boolean) => void;
  /** Park the context while the tab is hidden; resume() brings it back. */
  suspend: () => void;
  update: (state: SimState) => void;
};

export function createAudioManager(): AudioManager {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let sfxBus: GainNode | undefined;
  let musicBus: GainNode | undefined;
  let thrust: { gain: GainNode; osc: OscillatorNode } | undefined;
  let playing: PlayingPreview | undefined;
  let isMuted = false;
  let alarmTimer: number | undefined;

  const buffers = new Map<string, AudioBuffer>();
  const loading = new Set<string>();

  function ensureContext(): AudioContext | undefined {
    if (context) {
      return context;
    }

    try {
      context = new AudioContext();
    } catch {
      return undefined;
    }

    master = context.createGain();
    master.gain.value = isMuted ? 0 : 1;
    master.connect(context.destination);

    musicBus = context.createGain();
    musicBus.gain.value = 0.9;
    musicBus.connect(master);

    sfxBus = context.createGain();
    sfxBus.gain.value = 0.5;
    sfxBus.connect(master);

    // The engine: a barely-there low square, louder under boost.
    const osc = context.createOscillator();
    const thrustGain = context.createGain();
    const filter = context.createBiquadFilter();

    osc.type = "square";
    osc.frequency.value = 38;
    filter.type = "lowpass";
    filter.frequency.value = 120;
    thrustGain.gain.value = 0.03;
    osc.connect(filter);
    filter.connect(thrustGain);
    thrustGain.connect(sfxBus);
    osc.start();
    thrust = { gain: thrustGain, osc };

    return context;
  }

  async function loadBuffer(trackId: string): Promise<void> {
    if (!context || buffers.has(trackId) || loading.has(trackId)) {
      return;
    }

    loading.add(trackId);

    try {
      const response = await fetch(`/api/preview/${trackId}`);

      if (!response.ok) {
        return;
      }

      const decoded = await context.decodeAudioData(await response.arrayBuffer());

      if (buffers.size >= BUFFER_CACHE_LIMIT) {
        const oldest = buffers.keys().next().value;

        if (oldest && oldest !== playing?.trackId) {
          buffers.delete(oldest);
        }
      }

      buffers.set(trackId, decoded);
    } catch {
      // A finding whose preview didn't survive the trip stays silent; the
      // radar still finds it.
    } finally {
      loading.delete(trackId);
    }
  }

  function startPreview(trackId: string): void {
    if (!context || !musicBus) {
      return;
    }

    const buffer = buffers.get(trackId);

    if (!buffer) {
      void loadBuffer(trackId);

      return;
    }

    stopPreview();

    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = context.createStereoPanner();

    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(panner);
    panner.connect(musicBus);
    source.start();
    playing = { gain, panner, source, trackId };
  }

  function stopPreview(): void {
    if (!playing || !context) {
      return;
    }

    const ending = playing;

    playing = undefined;
    ending.gain.gain.setTargetAtTime(0, context.currentTime, CROSSFADE_SECONDS / 3);
    window.setTimeout(
      () => {
        try {
          ending.source.stop();
        } catch {
          // Already stopped.
        }

        ending.source.disconnect();
        ending.gain.disconnect();
        ending.panner.disconnect();
      },
      CROSSFADE_SECONDS * 1000 + 80,
    );
  }

  /** Which star should be singing right now, and how loud. */
  function audioFocus(state: SimState): { gain: number; pan: number; trackId: string } | undefined {
    // In orbit: the listening moment. Full volume, dead center, fresh log or
    // a revisit alike.
    if (state.orbitIndex >= 0) {
      return { gain: 1, pan: 0, trackId: state.stars[state.orbitIndex].trackId };
    }

    const carrier = nearestCarrier(state);

    if (!carrier || carrier.strength <= 0) {
      return undefined;
    }

    return {
      gain: Math.pow(carrier.strength, 1.6) * 0.9,
      pan: Math.max(-0.85, Math.min(0.85, Math.sin(carrier.bearing) * 0.9)),
      trackId: state.stars[carrier.starIndex].trackId,
    };
  }

  function update(state: SimState): void {
    if (!context || !master) {
      return;
    }

    const focus = audioFocus(state);

    if (!focus) {
      if (playing) {
        stopPreview();
      }
    } else if (playing?.trackId !== focus.trackId) {
      startPreview(focus.trackId);
    }

    if (playing && focus) {
      playing.gain.gain.setTargetAtTime(focus.gain, context.currentTime, CROSSFADE_SECONDS);
      playing.panner.pan.setTargetAtTime(focus.pan, context.currentTime, 0.15);
    }

    // Pre-warm the next carrier's preview while it's still faint.
    const carrier = nearestCarrier(state);

    if (carrier && carrier.distance < state.config.audioRange * 1.5) {
      void loadBuffer(state.stars[carrier.starIndex].trackId);
    }

    if (thrust) {
      const target = state.phase !== "flying" ? 0 : state.ship.boosting ? 0.09 : 0.03;

      thrust.gain.gain.setTargetAtTime(target, context.currentTime, 0.1);
      thrust.osc.frequency.setTargetAtTime(
        state.ship.boosting ? 56 : 38,
        context.currentTime,
        0.15,
      );
    }
  }

  /** One square-wave blip. The whole SFX kit is built from these. */
  function blip(frequency: number, at: number, duration: number, volume = 0.25): void {
    if (!context || !sfxBus) {
      return;
    }

    const osc = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + at;

    osc.type = "square";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain);
    gain.connect(sfxBus);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function handleEvent(event: SimEvent, state: SimState): void {
    if (!context) {
      return;
    }

    switch (event.kind) {
      case "adrift":
        // Power-down: a falling sweep.
        blip(220, 0, 0.3, 0.2);
        blip(140, 0.25, 0.35, 0.2);
        blip(80, 0.55, 0.6, 0.2);
        stopAlarm();
        break;
      case "all-found":
        blip(660, 0, 0.12);
        blip(880, 0.13, 0.12);
        blip(1100, 0.26, 0.3);
        break;
      case "home":
        blip(440, 0, 0.15);
        blip(550, 0.16, 0.15);
        blip(660, 0.32, 0.15);
        blip(880, 0.48, 0.5);
        stopAlarm();
        break;
      case "logged":
        // The lock chime: three rising notes for a banger in the log.
        blip(523, 0, 0.09);
        blip(784, 0.1, 0.09);
        blip(1046, 0.2, 0.2);
        void loadBuffer(state.stars[event.starIndex].trackId);
        break;
      case "low-fuel":
        startAlarm();
        break;
      case "refuelled":
        blip(392, 0, 0.08, 0.15);
        blip(523, 0.09, 0.12, 0.15);
        stopAlarm();
        break;
      case "towed":
        blip(196, 0, 0.25, 0.18);
        blip(147, 0.3, 0.4, 0.18);
        break;
      default:
        break;
    }
  }

  function startAlarm(): void {
    if (alarmTimer !== undefined) {
      return;
    }

    const sound = (): void => {
      blip(880, 0, 0.07, 0.12);
      blip(880, 0.12, 0.07, 0.12);
    };

    sound();
    alarmTimer = window.setInterval(sound, 1900);
  }

  function stopAlarm(): void {
    if (alarmTimer !== undefined) {
      window.clearInterval(alarmTimer);
      alarmTimer = undefined;
    }
  }

  return {
    destroy: () => {
      stopAlarm();
      stopPreview();
      thrust?.osc.stop();
      void context?.close();
      context = undefined;
    },
    handleEvent,
    muted: () => isMuted,
    resume: () => {
      const resumed = ensureContext();

      if (resumed?.state === "suspended") {
        void resumed.resume();
      }
    },
    setMuted: (value: boolean) => {
      isMuted = value;

      if (master && context) {
        master.gain.setTargetAtTime(value ? 0 : 1, context.currentTime, 0.05);
      }
    },
    suspend: () => {
      if (context?.state === "running") {
        void context.suspend();
      }
    },
    update,
  };
}
