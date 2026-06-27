// The factory's sound — the works humming under the music, so it stays quiet and
// mechanical. Same WebAudio lifecycle as earth/audio.ts: an AudioContext unlocked
// on the first gesture, a master GainNode for the mute ramp, a visibilitychange
// suspend so a hidden tab goes silent. All-synth — a low motor drone under a slow
// machine clank, a soft clunk when a finding settles into a station, and the
// launch roar when a finished finding rides up. Deliberately under the ear: the
// line hums, it does not perform.

/** The motor drone — a low warm root, lowpassed so it never gets edgy. */
const DRONE_HZ = 49;
const DRONE_GAIN = 0.02;
/** Seconds between the line's clank — slow, like a belt cycling, not a beat. */
const CLANK_STEP = 1.4;
const CLANK_GAIN = 0.025;

export type FactoryAudio = {
  ambient: (on: boolean) => void;
  /** A soft clunk when a finding settles into a station. */
  clunk: () => void;
  destroy: () => void;
  muted: () => boolean;
  resume: () => void;
  /** The launch roar — an ignition thud and a rising whoosh as a find lifts off. */
  launch: () => void;
  setMuted: (value: boolean) => void;
};

export function createFactoryAudio(): FactoryAudio {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let drone: { filter: BiquadFilterNode; gain: GainNode; osc: OscillatorNode } | undefined;
  let clankTimer: number | undefined;
  let bedOn = true;
  let isMuted = false;

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

    const osc = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    osc.type = "sawtooth";
    osc.frequency.value = DRONE_HZ;
    filter.type = "lowpass";
    filter.frequency.value = 160;
    gain.gain.value = 0;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start();
    drone = { filter, gain, osc };

    return context;
  }

  function tone(
    frequency: number,
    at: number,
    duration: number,
    volume: number,
    type: OscillatorType = "triangle",
  ): void {
    if (!context || !master) {
      return;
    }
    const osc = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + at;
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // already torn down
      }
    };
  }

  function clankTick(): void {
    // A dry low square thunk — the belt cycling one notch.
    tone(82, 0, 0.08, CLANK_GAIN, "square");
  }

  function startBed(): void {
    if (!context || clankTimer !== undefined) {
      return;
    }
    if (drone) {
      drone.gain.gain.setTargetAtTime(DRONE_GAIN, context.currentTime, 0.8);
    }
    clankTick();
    clankTimer = window.setInterval(clankTick, CLANK_STEP * 1000);
  }

  function stopBed(): void {
    if (clankTimer !== undefined) {
      window.clearInterval(clankTimer);
      clankTimer = undefined;
    }
    if (drone && context) {
      drone.gain.gain.setTargetAtTime(0, context.currentTime, 0.5);
    }
  }

  function onVisibility(): void {
    if (!context) {
      return;
    }
    if (document.visibilityState === "hidden") {
      if (context.state === "running") {
        void context.suspend();
      }
    } else if (context.state === "suspended") {
      void context.resume();
    }
  }

  document.addEventListener("visibilitychange", onVisibility);

  return {
    ambient: (on: boolean) => {
      bedOn = on;
      if (on) {
        if (ensureContext()) {
          startBed();
        }
      } else {
        stopBed();
      }
    },
    clunk: () => {
      if (!ensureContext()) {
        return;
      }
      // a short two-part mechanical settle
      tone(160, 0, 0.05, 0.03, "square");
      tone(110, 0.04, 0.07, 0.025, "triangle");
    },
    destroy: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopBed();
      try {
        drone?.osc.stop();
      } catch {
        // already stopped
      }
      void context?.close();
      context = undefined;
      master = undefined;
      drone = undefined;
    },
    launch: () => {
      if (!ensureContext() || !context || !master) {
        return;
      }
      const now = context.currentTime;
      tone(64, 0, 0.4, 0.14, "sine"); // ignition thud
      // a rising whoosh as it climbs
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(70, now + 0.1);
      osc.frequency.exponentialRampToValueAtTime(240, now + 1.1);
      gain.gain.setValueAtTime(0.0001, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.05, now + 0.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + 0.1);
      osc.stop(now + 1.4);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // already torn down
        }
      };
    },
    muted: () => isMuted,
    resume: () => {
      const resumed = ensureContext();
      if (resumed?.state === "suspended") {
        void resumed.resume();
      }
      if (bedOn) {
        startBed();
      }
    },
    setMuted: (value: boolean) => {
      isMuted = value;
      if (master && context) {
        master.gain.setTargetAtTime(value ? 0 : 1, context.currentTime, 0.05);
      }
    },
  };
}
