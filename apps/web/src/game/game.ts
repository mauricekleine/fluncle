import { fetchTracks } from "../lib/tracks";
import { createAudioManager } from "./audio";
import { createInput } from "./input";
import { placeStars } from "./placement";
import {
  BOOT_DURATION,
  TOWED_DURATION,
  createRenderer,
  type LogCardView,
  type MasterPhase,
  type RenderView,
} from "./render";
import {
  createSim,
  drainEvents,
  nearestCarrier,
  radarBlips,
  resetSim,
  type SimEvent,
  type SimState,
  stepSim,
} from "./sim";
import { type GameTrack } from "./types";

// The conductor: loads the catalogue (N is fixed at boot — a banger logged
// mid-session is a new star on the NEXT run), owns the master phase
// (gate → boot → play → end), runs the fixed-step sim loop, and fans sim
// events out to audio and the telemetry feed.

const SIM_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
/** How long the log card lingers after you fly on. */
const LOG_CARD_LINGER = 4;
const TELEMETRY_SECONDS = 5;

export type Game = {
  destroy: () => void;
};

type TelemetryLine = {
  line: string;
  until: number;
};

export function createGame(container: HTMLElement): Game {
  const renderer = createRenderer(container);
  const input = createInput(container);
  const audio = createAudioManager();

  let destroyed = false;
  let sim: SimState | undefined;
  let phase: MasterPhase = "gate";
  let bootT = 0;
  let endT = 0;
  let towedT = 0;
  let accumulator = 0;
  let lastFrame: number | undefined;
  let rafId = 0;
  let emptyGalaxy = false;
  let card: { shownAt: number; starIndex: number } | undefined;
  let nowS = 0;

  const telemetry: TelemetryLine[] = [];

  function pushTelemetry(line: string): void {
    telemetry.push({ line, until: nowS + TELEMETRY_SECONDS });

    if (telemetry.length > 3) {
      telemetry.shift();
    }
  }

  async function loadCatalogue(): Promise<void> {
    const tracks: GameTrack[] = [];
    let cursor: string | undefined;

    do {
      const page = await fetchTracks({ cursor, limit: 48 });

      for (const track of page.tracks) {
        tracks.push({
          addedAt: track.addedAt,
          artists: track.artists,
          logId: track.logId,
          title: track.title,
          trackId: track.trackId,
        });
      }

      cursor = page.nextCursor;
    } while (cursor);

    if (destroyed) {
      return;
    }

    if (tracks.length === 0) {
      emptyGalaxy = true;

      return;
    }

    sim = createSim(placeStars(tracks));
  }

  void loadCatalogue().catch(() => {
    emptyGalaxy = true;
  });

  function handleEvent(event: SimEvent, state: SimState): void {
    audio.handleEvent(event, state);

    switch (event.kind) {
      case "adrift":
        pushTelemetry("Tank dry. Adrift.");
        break;
      case "all-found":
        pushTelemetry("No carriers left in the sector. Home, junglist.");
        break;
      case "home":
        endT = 0;
        phase = "end";
        break;
      case "logged":
        card = { shownAt: nowS, starIndex: event.starIndex };
        pushTelemetry(`Logged fluncle://${state.stars[event.starIndex].logId}.`);
        break;
      case "low-fuel":
        pushTelemetry("Tank low.");
        break;
      case "refuelled":
        pushTelemetry("Tank full.");
        break;
      case "towed":
        towedT = TOWED_DURATION;
        card = undefined;
        break;
      default:
        break;
    }
  }

  function logCardView(state: SimState): LogCardView | undefined {
    if (!card) {
      return undefined;
    }

    // Revisiting a logged star brings its card back: the listening moment is
    // repeatable, only the refuelling isn't.
    if (state.orbitIndex >= 0 && state.collected[state.orbitIndex]) {
      if (card.starIndex !== state.orbitIndex) {
        card = { shownAt: nowS, starIndex: state.orbitIndex };
      }
    } else if (nowS - card.shownAt > LOG_CARD_LINGER) {
      card = undefined;

      return undefined;
    }

    const star = state.stars[card.starIndex];
    const inOrbit = state.orbitIndex === card.starIndex;

    return {
      age: nowS - card.shownAt,
      artistLine: star.artistLine,
      logId: star.logId,
      refuelling: inOrbit && state.orbitFresh && state.ship.fuel < state.config.tankCapacity - 0.5,
      title: star.title,
    };
  }

  function onAction(): void {
    if (phase === "gate") {
      if (!sim) {
        return;
      }

      audio.resume();
      bootT = 0;
      phase = "boot";

      return;
    }

    if (phase === "boot") {
      phase = "play";

      return;
    }

    if (phase === "end" && sim && endT > 0.6) {
      resetSim(sim, false);
      card = undefined;
      phase = "play";
    }
  }

  function frame(timestampMs: number): void {
    if (destroyed) {
      return;
    }

    const dt = lastFrame === undefined ? 0 : Math.min(0.25, (timestampMs - lastFrame) / 1000);

    lastFrame = timestampMs;
    nowS += dt;

    if (input.consumeMuteToggle()) {
      audio.setMuted(!audio.muted());
    }

    const acted = input.consumeAction();

    if (acted && (phase !== "play" || towedT <= 0)) {
      onAction();
    }

    if (phase === "boot") {
      bootT += dt / BOOT_DURATION;

      if (bootT >= 1) {
        phase = "play";
      }
    }

    if (phase === "end") {
      endT += dt;
    }

    if (towedT > 0) {
      towedT = Math.max(0, towedT - dt);
    }

    if (phase === "play" && sim) {
      accumulator += dt;

      let steps = 0;

      while (accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
        stepSim(sim, input.state(), SIM_STEP);
        steps += 1;
        accumulator -= SIM_STEP;
      }

      if (steps === MAX_STEPS_PER_FRAME) {
        accumulator = 0;
      }

      for (const event of drainEvents(sim)) {
        handleEvent(event, sim);
      }

      audio.update(sim);
    }

    while (telemetry.length > 0 && telemetry[0].until < nowS) {
      telemetry.shift();
    }

    if (sim) {
      const view: RenderView = {
        bootT: Math.min(1, bootT),
        carrier: nearestCarrier(sim),
        endT,
        logCard: phase === "play" ? logCardView(sim) : undefined,
        muted: audio.muted(),
        nowS,
        phase,
        radar: phase === "play" ? radarBlips(sim) : [],
        sim,
        steer: input.state().steer,
        telemetry: telemetry.map((entry) => entry.line),
        touch: input.touchSeen() || isCoarsePointer(),
        towedT,
      };

      renderer.draw(view);
    } else {
      drawHolding();
    }

    rafId = window.requestAnimationFrame(frame);
  }

  // The gate before the catalogue lands (or when there is nothing out there
  // yet): keep the plate up with an honest line under it.
  function drawHolding(): void {
    const view: RenderView = {
      bootT: 0,
      endT: 0,
      muted: audio.muted(),
      nowS,
      phase: "gate",
      radar: [],
      sim: holdingSim(),
      steer: 0,
      telemetry: [
        emptyGalaxy ? "No findings logged yet. Quiet sector tonight." : "Charting the galaxy…",
      ],
      touch: input.touchSeen() || isCoarsePointer(),
      towedT: 0,
    };

    renderer.draw(view);
  }

  let cachedHoldingSim: SimState | undefined;

  function holdingSim(): SimState {
    cachedHoldingSim ??= createSim([]);

    return cachedHoldingSim;
  }

  function isCoarsePointer(): boolean {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  function onResize(): void {
    renderer.resize(container.clientWidth, container.clientHeight);
  }

  function onVisibility(): void {
    if (document.hidden) {
      audio.suspend();
    } else if (phase !== "gate") {
      audio.resume();
    }
  }

  const resizeObserver = new ResizeObserver(onResize);

  resizeObserver.observe(container);
  document.addEventListener("visibilitychange", onVisibility);
  rafId = window.requestAnimationFrame(frame);

  // Read-only instrument tap for development and harness tests (?debug).
  if (new URLSearchParams(window.location.search).has("debug")) {
    (window as { __galaxy?: { sim: () => SimState | undefined } }).__galaxy = {
      sim: () => sim,
    };
  }

  return {
    destroy: () => {
      destroyed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      input.destroy();
      audio.destroy();
      renderer.destroy();
    },
  };
}
