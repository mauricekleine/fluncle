// The overworld's sound — the ground before flight, so it stays under the music.
// Mirrors the galaxy game's WebAudio lifecycle (apps/web/src/game/audio.ts): a
// lazily-created AudioContext unlocked on the first user gesture, a master
// GainNode for the mute ramp, and a visibilitychange suspend/resume so a hidden
// tab goes quiet. Everything here is all-synth — square/triangle oscillators,
// no asset files — and deliberately quiet: a slow, warm arpeggio bed under a
// soft footstep tick and a gentle door chime. This is pre-flight, not the
// dancefloor, so the bed loops low and the SFX barely lift over it.

// The bed: a gentle minor-pentatonic arpeggio that reads as the canon cosmos —
// a low root, its fifth, octave, minor third above, and the fourth — cycled
// slowly so it never asks for attention. Frequencies in Hz (A1-rooted).
const BED_NOTES = [55, 82.41, 110, 130.81, 146.83, 110, 82.41, 65.41] as const;
/** Seconds between bed notes — slow enough to feel like breathing, not a riff. */
const BED_STEP = 1.1;
/** The bed sits well below the SFX; the ground hums, it does not play. */
const BED_GAIN = 0.05;
/** A low pad drone under the arpeggio, for warmth. */
const PAD_GAIN = 0.018;

export type EarthAudio = {
  /** Toggle the looping bed (default on once resumed). */
  ambient: (on: boolean) => void;
  /** A gentle chime when a door opens. */
  doorOpen: () => void;
  /** Tear down: stop the bed, close the context, drop listeners. */
  destroy: () => void;
  muted: () => boolean;
  /** Create/resume the AudioContext — call on the first user gesture. */
  resume: () => void;
  /** Ramp the master gain to mute or unmute. */
  setMuted: (value: boolean) => void;
  /** A soft, short footstep tick. */
  step: () => void;
};

export function createEarthAudio(): EarthAudio {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  let bedBus: GainNode | undefined;
  let pad: { filter: BiquadFilterNode; gain: GainNode; osc: OscillatorNode } | undefined;
  let bedTimer: number | undefined;
  let bedIndex = 0;
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

    bedBus = context.createGain();
    bedBus.gain.value = 1;
    bedBus.connect(master);

    // A barely-there low triangle pad under the arpeggio — the warmth of the
    // soil. Lowpassed so it never gets edgy.
    const osc = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();

    osc.type = "triangle";
    osc.frequency.value = 55;
    filter.type = "lowpass";
    filter.frequency.value = 220;
    gain.gain.value = 0;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(bedBus);
    osc.start();
    pad = { filter, gain, osc };

    return context;
  }

  /** One soft note — a triangle so it stays warm, with a gentle attack/decay. */
  function tone(
    bus: GainNode,
    frequency: number,
    at: number,
    duration: number,
    volume: number,
    type: OscillatorType = "triangle",
  ): void {
    if (!context) {
      return;
    }

    const osc = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + at;

    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(start);
    osc.stop(start + duration + 0.05);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // Already torn down.
      }
    };
  }

  function bedTick(): void {
    if (!context || !bedBus) {
      return;
    }

    const note = BED_NOTES[bedIndex % BED_NOTES.length];
    if (note !== undefined) {
      tone(bedBus, note, 0, BED_STEP * 0.9, BED_GAIN);
    }

    bedIndex++;
  }

  function startBed(): void {
    if (bedTimer !== undefined || !context) {
      return;
    }

    if (pad) {
      pad.gain.gain.setTargetAtTime(PAD_GAIN, context.currentTime, 0.6);
    }

    bedTick();
    bedTimer = window.setInterval(bedTick, BED_STEP * 1000);
  }

  function stopBed(): void {
    if (bedTimer !== undefined) {
      window.clearInterval(bedTimer);
      bedTimer = undefined;
    }

    if (pad && context) {
      pad.gain.gain.setTargetAtTime(0, context.currentTime, 0.4);
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
    destroy: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopBed();

      try {
        pad?.osc.stop();
      } catch {
        // Already stopped.
      }

      void context?.close();
      context = undefined;
      master = undefined;
      bedBus = undefined;
      pad = undefined;
    },
    doorOpen: () => {
      if (!ensureContext() || !master) {
        return;
      }

      // A gentle three-note rise into the surface — soft, never a fanfare.
      tone(master, 392, 0, 0.16, 0.08);
      tone(master, 523.25, 0.1, 0.18, 0.08);
      tone(master, 659.25, 0.22, 0.4, 0.07);
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
    step: () => {
      if (!ensureContext() || !master) {
        return;
      }

      // A soft, low square tick — the foot meeting soil, quick and quiet.
      tone(master, 196, 0, 0.05, 0.035, "square");
    },
  };
}
