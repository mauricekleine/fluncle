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
  departOrbit,
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
/** Grace after parking on a star, so a held key doesn't instantly eject you. */
const DEPART_GRACE = 1.2;

export type Game = {
  destroy: () => void;
};

type TelemetryLine = {
  line: string;
  until: number;
};

/** The console easter egg (and the harness tests' steering tap). */
type FluncleConsole = {
  help: () => string;
  log: () => string;
  mute: () => string;
  refuel: () => string;
  sim: () => SimState | undefined;
  trigger: (what: "death" | "win") => string;
  warp: (logId: string) => string;
};

type GalaxyWindow = Window & { fluncle?: FluncleConsole };

export function createGame(container: HTMLElement): Game {
  const renderer = createRenderer(container);
  const input = createInput(container, handleUiTap);
  const audio = createAudioManager();

  // Per-run session seed: the galaxy's POSITIONS stay deterministic, but a few
  // frontier choices (which black-hole slot is live) vary run to run off this.
  const sessionSeed = Math.floor(Math.random() * 0xffffffff) >>> 0;

  // The card's Spotify link is canvas-drawn, so presses hit-test against the
  // renderer's reported rect. Opening the tab auto-pauses via visibility.
  let cardSpotifyUrl: string | undefined;

  function handleUiTap(clientX: number, clientY: number): boolean {
    const bounds = renderer.canvas.getBoundingClientRect();

    if (bounds.width === 0 || bounds.height === 0) {
      return false;
    }

    const ix = ((clientX - bounds.left) / bounds.width) * renderer.canvas.width;
    const iy = ((clientY - bounds.top) / bounds.height) * renderer.canvas.height;
    const hit = (rect: { h: number; w: number; x: number; y: number } | undefined): boolean =>
      !!rect && ix >= rect.x && ix <= rect.x + rect.w && iy >= rect.y && iy <= rect.y + rect.h;

    // The top-right volume toggle: a tap flips the master mute (the M key does
    // the same). Eats the press so it never steers or launches.
    if (hit(renderer.volumeRect())) {
      audio.setMuted(!audio.muted());

      return true;
    }

    const rect = renderer.spotifyLinkRect();

    if (rect && cardSpotifyUrl && hit(rect)) {
      window.open(cardSpotifyUrl, "_blank", "noopener");

      return true;
    }

    return false;
  }

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
  let wasOrbiting = false;
  let orbitEnteredAt = 0;
  let paused = false;

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
        if (track.type === "mixtape") {
          continue;
        }

        tracks.push({
          addedAt: track.addedAt,
          artists: track.artists,
          logId: track.logId,
          spotifyUrl: track.spotifyUrl,
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

    sim = createSim(placeStars(tracks), {
      frontier: { asteroids: true, blackHoles: true, setDressing: true },
      seed: sessionSeed,
    });
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
      case "asteroid-hit":
        pushTelemetry("Hull hit. Fuel knocked loose.");
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
      case "warped":
        pushTelemetry("Pulled under. Flung across the galaxy.");
        break;
      default:
        break;
    }
  }

  function logCardView(state: SimState): LogCardView | undefined {
    // Parked on any logged star, the card is pinned to it — fresh logs and
    // revisits alike, including revisits long after an old card expired.
    if (state.orbitIndex >= 0 && state.stars[state.orbitIndex]?.collected) {
      if (card?.starIndex !== state.orbitIndex) {
        card = { shownAt: nowS, starIndex: state.orbitIndex };
      }
    } else if (card && nowS - card.shownAt > LOG_CARD_LINGER) {
      card = undefined;
    }

    if (!card) {
      return undefined;
    }

    const star = state.stars[card.starIndex];
    const inOrbit = state.orbitIndex === card.starIndex;

    return {
      age: nowS - card.shownAt,
      artistLine: star.artistLine,
      logId: star.logId,
      refuelling: inOrbit && state.orbitFresh && state.ship.fuel < state.config.tankCapacity - 0.5,
      spotifyUrl: star.spotifyUrl,
      title: star.title,
    };
  }

  function onAction(): void {
    if (phase === "gate") {
      if (!sim) {
        return;
      }

      audio.resume();
      // The amen break rides this same gesture unlock (autoplay-with-sound is
      // blocked, so it can only start on the launch tap, never on load).
      audio.playIntro();
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

    if (input.consumePauseToggle() && phase === "play") {
      setPaused(!paused);
    }

    const acted = input.consumeAction();

    if (acted) {
      if (paused) {
        // Any key or tap also resumes; Esc isn't the only way back.
        setPaused(false);
      } else if (phase === "play") {
        // In flight, keys are controls; parked on a banger, any key flies on
        // (after a beat of grace so a held boost key doesn't eject you).
        if (sim?.phase === "orbiting" && towedT <= 0 && nowS - orbitEnteredAt > DEPART_GRACE) {
          departOrbit(sim);
        }
      } else {
        onAction();
      }
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

    if (phase === "play" && sim && !paused) {
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

      const orbiting = sim.phase === "orbiting";

      if (orbiting && !wasOrbiting) {
        orbitEnteredAt = nowS;
      }

      // Departing resets the card's clock so it lingers a beat after a long
      // listen instead of vanishing the moment you fly on.
      if (!orbiting && wasOrbiting && card) {
        card.shownAt = nowS;
      }

      wasOrbiting = orbiting;
    }

    while (telemetry.length > 0 && telemetry[0].until < nowS) {
      telemetry.shift();
    }

    if (sim) {
      const cardView = phase === "play" ? logCardView(sim) : undefined;

      cardSpotifyUrl = cardView?.spotifyUrl;

      const view: RenderView = {
        bootT: Math.min(1, bootT),
        carrier: nearestCarrier(sim),
        endT,
        logCard: cardView,
        muted: audio.muted(),
        nowS,
        paused: paused && phase === "play",
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
      paused: false,
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

  function setPaused(value: boolean): void {
    if (paused === value) {
      return;
    }

    paused = value;

    if (paused) {
      audio.suspend();
    } else if (phase !== "gate") {
      audio.resume();
    }
  }

  function onVisibility(): void {
    if (document.hidden) {
      // Leaving the tab parks the run; you come back to a pause screen,
      // not a ship that kept burning fuel.
      if (phase === "play") {
        setPaused(true);
      } else {
        audio.suspend();
      }
    } else if (phase !== "gate" && !paused) {
      audio.resume();
    }
  }

  const resizeObserver = new ResizeObserver(onResize);

  resizeObserver.observe(container);
  document.addEventListener("visibilitychange", onVisibility);
  rafId = window.requestAnimationFrame(frame);

  installFlightComputer();

  // The flight computer: a console easter egg for the crew and the harness
  // tests' steering tap in one. Methods return their reply so the console
  // prints it.
  function installFlightComputer(): void {
    const fluncle: FluncleConsole = {
      // The list goes through console.log: a RETURNED string renders as one
      // escaped line in devtools; logged text keeps its line breaks.
      help: () => {
        console.log(
          [
            "%cfluncle.refuel()           %ctank full, no questions",
            "%cfluncle.log()              %clog the nearest carrier from the couch",
            '%cfluncle.warp("004.0.1C")   %cjump to a coordinate',
            '%cfluncle.trigger("win")     %cskip to the end of the story',
            '%cfluncle.trigger("death")   %cfind out what a dry tank feels like',
            "%cfluncle.mute()             %csound on / off",
          ].join("\n"),
          ...Array.from({ length: 6 }, () => ["color:#f5b800", "color:#b7ab95"]).flat(),
        );

        return "Safe travels, junglist.";
      },
      log: () => {
        if (!sim) {
          return "Still charting the galaxy.";
        }

        const carrier = nearestCarrier(sim);

        if (!carrier) {
          return "Nothing left to log out here.";
        }

        sim.stars[carrier.starIndex].collected = true;
        sim.collectedCount += 1;
        sim.events.push({ kind: "logged", starIndex: carrier.starIndex });

        if (sim.collectedCount === sim.stars.length) {
          sim.events.push({ kind: "all-found" });
        }

        return `Logged fluncle://${sim.stars[carrier.starIndex].logId}. No flying required.`;
      },
      mute: () => {
        audio.setMuted(!audio.muted());

        return audio.muted() ? "Muted." : "Sound on.";
      },
      refuel: () => {
        if (!sim) {
          return "Still charting the galaxy.";
        }

        sim.ship.fuel = sim.config.tankCapacity;
        sim.events.push({ kind: "refuelled" });

        return "Tank full. Courtesy of the uncle.";
      },
      sim: () => sim,
      trigger: (what: "death" | "win") => {
        if (!sim) {
          return "Still charting the galaxy.";
        }

        if (phase !== "play") {
          return "Launch first.";
        }

        if (what === "death") {
          if (sim.phase === "orbiting") {
            return "Not while parked on a banger.";
          }

          if (sim.phase !== "flying") {
            return "Already mid-drama.";
          }

          sim.ship.fuel = Math.min(sim.ship.fuel, 0.4);

          return "Mind the gauge.";
        }

        if (what === "win") {
          for (const star of sim.stars) {
            star.collected = true;
          }

          sim.collectedCount = sim.stars.length;
          sim.events.push({ kind: "all-found" });
          sim.phase = "flying";
          sim.orbitFresh = false;
          sim.orbitIndex = -1;
          sim.ship.x = 0;
          sim.ship.y = -380;
          sim.ship.heading = Math.PI / 2;
          sim.ship.fuel = sim.config.tankCapacity;

          return "Course laid in for home.";
        }

        return "Unknown trigger. fluncle.help() lists the commands.";
      },
      warp: (logId: string) => {
        if (!sim) {
          return "Still charting the galaxy.";
        }

        if (phase !== "play") {
          return "Launch first.";
        }

        const target = sim.stars.find(
          (star) => star.logId.toLowerCase() === String(logId).toLowerCase(),
        );

        if (!target) {
          return "No finding at that coordinate.";
        }

        const { ship } = sim;
        const approach = Math.atan2(target.y - ship.y, target.x - ship.x);

        sim.phase = "flying";
        sim.orbitFresh = false;
        sim.orbitIndex = -1;
        ship.heading = approach;
        ship.x = target.x - Math.cos(approach) * (sim.config.starOrbitRadius + 60);
        ship.y = target.y - Math.sin(approach) * (sim.config.starOrbitRadius + 60);

        return `On approach to fluncle://${target.logId}.`;
      },
    };

    (window as GalaxyWindow).fluncle = fluncle;

    const gold = "color:#f5b800";

    console.log(
      [
        "%c      ▄█▄",
        "    ▄█████▄",
        "  ▄█████████▄",
        "    ▀█████▀",
        "      ▀█▀",
        "",
        "%cFLUNCLE'S GALAXY",
        "%cEvery banger out there is a star.",
        "You found the flight computer, junglist. fluncle.help() lists the commands.",
      ].join("\n"),
      gold,
      `${gold};font-weight:bold;font-size:14px`,
      "color:#b7ab95",
    );
  }

  return {
    destroy: () => {
      destroyed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      delete (window as GalaxyWindow).fluncle;
      input.destroy();
      audio.destroy();
      renderer.destroy();
    },
  };
}
