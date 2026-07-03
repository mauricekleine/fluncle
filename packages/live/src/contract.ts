// The glass <-> bridge contract (the RFC's Unit L/B boundary). Both processes
// import ONLY this file from each other's world, so the two units build in
// parallel without collisions. The glass runs standalone when no bridge is
// present (the v0.6 behavior, preserved as the degraded mode: the failure
// matrix's floor is renderer-local DSP + last-known state).

/** Fixed local ports. The glass serves the page; the bridge serves state. */
export const GLASS_PORT = 4173;
export const BRIDGE_PORT = 4180;
/** The bridge's WebSocket state stream (ws://localhost:4180/state). */
export const BRIDGE_WS_PATH = "/state";
/** The phone remote page the bridge serves (http://<lan-ip>:4180/remote). */
export const BRIDGE_REMOTE_PATH = "/remote";

/** One planned track, enriched at show start (the /plan shape the glass already consumes). */
export type PlanEntry = {
  logId: string;
  title: string;
  artists: string[];
  foundAt?: string;
  durationMs?: number;
  videoVehicle?: string;
  videoGrain?: string;
  videoRegister?: string;
  palette?: {
    background?: string;
    accent?: string;
    glow?: string;
    ink?: string;
    swatches?: string[];
  };
  seed?: number;
  replay?: {
    replayable: boolean;
    body?: string;
    customUniforms?: Array<{
      name: string;
      class: "rise" | "settle" | "audio" | "color";
      params?: Record<string, number>;
    }>;
    reason?: string;
  };
};

/** The bridge's fused state stream, emitted at a fixed cadence (30-60Hz). */
export type ShowState = {
  t: number; // bridge wall-clock ms
  seq: number; // monotonic
  plan: { pointer: number; total: number; source: "fingerprint" | "manual" | "boot" };
  /** Fingerprint matcher verdict for the CURRENT audio window. */
  match?: { logId: string; confidence: number };
  /** The next planned finding, pre-armed (prefetch target). */
  pending?: { logId: string };
  channels: { audio: "live" | "stale" | "silent"; matcher: "ready" | "off" };
};

/** Commands the glass (or the phone remote) sends the bridge over the same WS. */
export type ShowCommand =
  | { cmd: "advance" } // manual next (the arrow key / remote tap)
  | { cmd: "rewind" }
  | { cmd: "goto"; index: number }
  | { cmd: "blackout"; on: boolean }
  | { cmd: "intensity"; value: number }
  | { cmd: "heartbeat"; renderFrame: number }; // the watchdog feed
