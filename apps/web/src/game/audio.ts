import { type SimEvent, type SimState, nearestCarrier } from "./sim";

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

  playIntro: () => void;
  resume: () => void;
  setMuted: (value: boolean) => void;

  suspend: () => void;
  update: (state: SimState) => void;
};

const INTRO_GAIN = 0.5;

const INTRO_HOLD = 4;

const INTRO_FADE_TC = 0.9;

export function createAudioManager(): AudioManager {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let sfxBus: GainNode | undefined;
  let musicBus: GainNode | undefined;
  let thrust: { gain: GainNode; osc: OscillatorNode } | undefined;
  let playing: PlayingPreview | undefined;
  let isMuted = false;
  let alarmTimer: number | undefined;
  let introBuffer: AudioBuffer | undefined;
  let introStarted = false;

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
        } catch {}

        ending.source.disconnect();
        ending.gain.disconnect();
        ending.panner.disconnect();
      },
      CROSSFADE_SECONDS * 1000 + 80,
    );
  }

  function audioFocus(state: SimState): { gain: number; pan: number; trackId: string } | undefined {
    if (state.orbitIndex >= 0) {
      const orbited = state.stars[state.orbitIndex];
      if (orbited !== undefined) {
        return { gain: 1, pan: 0, trackId: orbited.trackId };
      }
    }

    const { config, ship } = state;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let currentIndex = -1;
    let currentDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < state.stars.length; index++) {
      const star = state.stars[index];

      if (star === undefined || star.collected) {
        continue;
      }

      const distance = Math.hypot(star.x - ship.x, star.y - ship.y);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }

      if (star.trackId === playing?.trackId) {
        currentDistance = distance;
        currentIndex = index;
      }
    }

    if (
      currentIndex >= 0 &&
      currentIndex !== bestIndex &&
      currentDistance < config.audioRange &&
      bestDistance > currentDistance * 0.8
    ) {
      bestDistance = currentDistance;
      bestIndex = currentIndex;
    }

    if (bestIndex < 0) {
      return undefined;
    }

    const strength = Math.max(0, 1 - bestDistance / config.audioRange);

    if (strength <= 0) {
      return undefined;
    }

    const star = state.stars[bestIndex];

    if (star === undefined) {
      return undefined;
    }

    const bearing = Math.atan2(star.y - ship.y, star.x - ship.x) - ship.heading;

    return {
      gain: Math.pow(strength, 1.6) * 0.9,
      pan: Math.max(-0.85, Math.min(0.85, Math.sin(bearing) * 0.9)),
      trackId: star.trackId,
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

    const carrier = nearestCarrier(state);

    if (carrier && carrier.distance < state.config.audioRange * 1.5) {
      const carrierStar = state.stars[carrier.starIndex];
      if (carrierStar !== undefined) {
        void loadBuffer(carrierStar.trackId);
      }
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
      case "asteroid-hit":
        blip(120, 0, 0.12, 0.2);
        blip(90, 0.1, 0.18, 0.2);
        break;
      case "bolt-fired":
        blip(900, 0, 0.05, 0.08);
        break;
      case "bolt-hit":
        blip(300, 0, 0.04, 0.14);
        blip(160, 0.04, 0.08, 0.14);
        break;
      case "home":
        blip(440, 0, 0.15);
        blip(550, 0.16, 0.15);
        blip(660, 0.32, 0.15);
        blip(880, 0.48, 0.5);
        stopAlarm();
        break;
      case "logged":
        blip(523, 0, 0.09);
        blip(784, 0.1, 0.09);
        blip(1046, 0.2, 0.2);
        {
          const loggedStar = state.stars[event.starIndex];
          if (loggedStar !== undefined) {
            void loadBuffer(loggedStar.trackId);
          }
        }
        break;
      case "low-fuel":
        startAlarm();
        break;
      case "refuelled":
        blip(392, 0, 0.08, 0.15);
        blip(523, 0.09, 0.12, 0.15);
        stopAlarm();
        break;
      case "warped":
        blip(330, 0, 0.12, 0.18);
        blip(180, 0.1, 0.14, 0.18);
        blip(120, 0.22, 0.18, 0.2);
        blip(440, 0.36, 0.1, 0.16);
        blip(700, 0.44, 0.2, 0.16);
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

  async function playIntro(): Promise<void> {
    const ctx = ensureContext();

    if (!ctx || !musicBus || introStarted) {
      return;
    }

    introStarted = true;

    try {
      if (!introBuffer) {
        const response = await fetch("/galaxy/amen.mp3");

        if (!response.ok) {
          return;
        }

        introBuffer = await ctx.decodeAudioData(await response.arrayBuffer());
      }

      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      const now = ctx.currentTime;

      source.buffer = introBuffer;
      source.loop = false;
      gain.gain.setValueAtTime(INTRO_GAIN, now);
      gain.gain.setTargetAtTime(0, now + INTRO_HOLD, INTRO_FADE_TC);
      source.connect(gain);
      gain.connect(musicBus);
      source.start(now);
      source.stop(now + INTRO_HOLD + INTRO_FADE_TC * 4 + 0.5);
      source.onended = () => {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {}
      };
    } catch {}
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
    playIntro: () => {
      void playIntro();
    },
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
