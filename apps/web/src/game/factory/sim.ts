// The factory simulation — the live finding list turned into motion. DOM-free
// and deterministic so it unit-tests: it owns where each finding sits, how it
// slides along the belt, how findings PILE in front of a slow machine, and how a
// finished finding boards a ship and lifts off. The renderer (game.ts) reads this
// state and draws it; cover-image loading and audio live there, not here.
//
// Position is TRUE, motion is animated: a finding's station comes straight from
// stationOf() (its real pipeline state); the sim only eases it toward the slot
// that station implies, so when its data advances it visibly rides the belt on.

import { ENTRY_X, FIRST_STATION_X, slotX, stationX } from "./layout";
import { LAUNCH_INDEX, type StationInput, stationOf } from "./stations";

/** Everything the factory needs about one finding — the gates plus what the card shows. */
export type FactoryFinding = StationInput & {
  albumImageUrl?: string;
  artistLine: string;
  galaxyName?: string;
  logId: string;
  logPageUrl?: string;
  spotifyUrl?: string;
  title: string;
};

export type TokenPhase = "belt" | "boarding" | "launching";

export type Token = {
  /** 0..1 — fades out on launch. */
  alpha: number;
  bornSeq: number;
  finding: FactoryFinding;
  launchVy: number;
  /** Upward offset (px) while launching. */
  launchY: number;
  phase: TokenPhase;
  /** True once it has eased into its slot (drives the per-machine working light). */
  settled: boolean;
  /** Queue position at its machine: 0 = at the machine, 1.. = piling behind. */
  slot: number;
  station: number;
  targetX: number;
  x: number;
};

/** Per-frame ease toward the slot — low and calm, so the belt glides, never snaps. */
const BELT_EASE = 0.06;
const SETTLE_EPS = 1.5;
/** Launch kinematics (px, px/s, px/s²). */
const LAUNCH_V0 = 10;
const LAUNCH_ACCEL = 150;
const LAUNCH_OFF = 130;

export type SimEvents = { clunks: number; launches: number };

export type FactorySim = {
  /** Tokens still sliding in from the left edge — the "N incoming" count. */
  incoming: () => number;
  /** Read and reset the audio cues since the last call. */
  consumeEvents: () => SimEvents;
  sync: (findings: FactoryFinding[]) => void;
  tokens: () => Token[];
  update: (dt: number) => void;
};

export function createFactorySim(): FactorySim {
  const tokens = new Map<string, Token>();
  const orbited = new Set<string>();
  let seq = 0;
  let events: SimEvents = { clunks: 0, launches: 0 };

  function sync(findings: FactoryFinding[]): void {
    const present = new Set<string>();

    for (const finding of findings) {
      if (orbited.has(finding.logId)) {
        continue; // already launched away this session
      }
      present.add(finding.logId);
      const station = stationOf(finding);
      const existing = tokens.get(finding.logId);
      if (existing) {
        existing.finding = finding;
        if (existing.station !== station && existing.phase === "belt") {
          existing.station = station;
          existing.settled = false; // advanced a step → ride the belt on
        }
      } else {
        tokens.set(finding.logId, {
          alpha: 1,
          bornSeq: seq++,
          finding,
          launchVy: 0,
          launchY: 0,
          phase: "belt",
          settled: false,
          slot: 0,
          station,
          targetX: ENTRY_X,
          x: ENTRY_X,
        });
      }
    }

    // Drop tokens that fell out of the live window (older than the polled set),
    // unless they're mid-liftoff — let those finish their animation.
    for (const [logId, token] of tokens) {
      if (!present.has(logId) && token.phase !== "launching") {
        tokens.delete(logId);
      }
    }

    assignSlots();
  }

  // Group the belt/boarding tokens by machine and lay them out: queued findings
  // stack in arrival order in front of their machine (the pile). Launch-pad
  // findings board instead of queueing.
  function assignSlots(): void {
    const byStation = new Map<number, Token[]>();
    for (const token of tokens.values()) {
      if (token.phase === "launching") {
        continue;
      }
      const group = byStation.get(token.station);
      if (group) {
        group.push(token);
      } else {
        byStation.set(token.station, [token]);
      }
    }

    for (const [station, group] of byStation) {
      group.sort((a, b) => a.bornSeq - b.bornSeq);
      if (station >= LAUNCH_INDEX) {
        for (const token of group) {
          token.slot = 0;
          token.targetX = stationX(LAUNCH_INDEX);
          if (token.phase === "belt") {
            token.phase = "boarding";
            token.settled = false;
          }
        }
      } else {
        group.forEach((token, i) => {
          token.slot = i;
          token.targetX = slotX(station, i);
        });
      }
    }
  }

  function update(dt: number): void {
    for (const [logId, token] of tokens) {
      if (token.phase === "launching") {
        token.launchVy += LAUNCH_ACCEL * dt;
        token.launchY += token.launchVy * dt;
        token.alpha = Math.max(0, 1 - token.launchY / 90);
        if (token.launchY > LAUNCH_OFF) {
          orbited.add(logId);
          tokens.delete(logId);
        }
        continue;
      }

      const dx = token.targetX - token.x;
      token.x += dx * BELT_EASE;

      if (Math.abs(dx) < SETTLE_EPS) {
        token.x = token.targetX;
        if (token.phase === "boarding") {
          token.phase = "launching";
          token.launchVy = LAUNCH_V0;
          events.launches++;
        } else if (!token.settled) {
          token.settled = true;
          events.clunks++;
        }
      }
    }
  }

  return {
    consumeEvents() {
      const out = events;
      events = { clunks: 0, launches: 0 };
      return out;
    },
    incoming() {
      let n = 0;
      for (const token of tokens.values()) {
        if (token.phase === "belt" && token.x < FIRST_STATION_X - 8) {
          n++;
        }
      }
      return n;
    },
    sync,
    tokens() {
      return [...tokens.values()];
    },
    update,
  };
}
