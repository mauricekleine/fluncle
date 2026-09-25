export const GLASS_PORT = 4173;
export const BRIDGE_PORT = 4180;

export const BRIDGE_WS_PATH = "/state";

export const BRIDGE_REMOTE_PATH = "/remote";

export const VJ_TRANSITION_PORT = 9000;

export type PlanEntry = {
  logId: string;
  title: string;
  artists: string[];

  bpm?: number | null;
  key?: string | null;
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

  scenePalette?: string[];

  replay?: {
    replayable: boolean;
    reason?: string;

    layers?: Array<{
      body: string;
      customUniforms: PlanCustomUniform[];
      blend: "opaque" | "over";

      textures?: PlanTexture[];
    }>;

    body?: string;
    customUniforms?: PlanCustomUniform[];

    bloom?: { threshold?: number; intensity?: number; radius?: number };

    textures?: PlanTexture[];

    usesDrop?: boolean;

    dropShape?: { riseMs: number; holdMs: number; fallMs: number };
  };
};

type PlanCustomUniform = {
  name: string;
  type: string;
  class: "riseRamp" | "settleDim" | "audioAlias" | "color" | "velocityPos" | "velocity";
  params?: Record<string, unknown>;
};

export type PlanTexture = {
  name: string;
  source: "artwork" | "plate" | "plate-background";
  url: string;
};

export type ShowState = {
  t: number;
  seq: number;
  plan: { pointer: number; total: number; source: "fingerprint" | "manual" | "boot" };

  match?: { logId: string; confidence: number };

  pending?: { logId: string; title: string; artists: string[] };
  channels: { audio: "live" | "stale" | "silent"; matcher: "ready" | "off" };

  prearmed: boolean;

  intensity: number;

  blackout: boolean;

  current?: { logId: string; title: string; artists: string[] };
};

export type ShowCommand =
  | { cmd: "advance" }
  | { cmd: "rewind" }
  | { cmd: "goto"; index: number }
  | { cmd: "blackout"; on: boolean }
  | { cmd: "intensity"; value: number }
  | { cmd: "heartbeat"; renderFrame: number }
  | { cmd: "mel"; t: number; frame: number[] };

export const MEL_BINS = 40;

export const MEL_FMIN = 0;
export const MEL_FMAX = 8000;
