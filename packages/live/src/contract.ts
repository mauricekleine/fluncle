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
  /**
   * The composition's RENDERED palette stops (scene.json `palette`, emitted from the
   * composition source since #307) — dark->bright hex ramp. When a composition
   * overrode the artwork palette, THIS is the truth the replay must re-tint with;
   * `palette` above stays the artwork-derived morph target for the abstract vehicles.
   */
  scenePalette?: string[];
  /**
   * The dream-replay scene — the glass's scene-extract `Scene` shape, mirrored here
   * so both worlds keep importing only this file. Layers carry resolved GLSL bodies;
   * custom uniforms are classified for live re-drive (rise ramps -> dwell, tail
   * dimmers -> pinned, audio aliases -> the live DSP, colour vec3s -> palette stops,
   * velocity pairs -> JS-integrated position motion).
   */
  replay?: {
    replayable: boolean;
    reason?: string;
    /** One layer for a single-ShaderLayer comp; N for a composited one. */
    layers?: Array<{
      body: string;
      customUniforms: PlanCustomUniform[];
      blend: "opaque" | "over";
      /** Image samplers this layer reads, with their resolved crossOrigin URLs. */
      textures?: PlanTexture[];
    }>;
    /** Convenience mirror of layers[0] (the single-layer path). */
    body?: string;
    customUniforms?: PlanCustomUniform[];
    /** Bloom config read from the composition's ShaderLayer `bloom` prop. */
    bloom?: { threshold?: number; intensity?: number; radius?: number };
    /** Every image sampler the scene declares (unioned across layers) with resolved URLs. */
    textures?: PlanTexture[];
  };
};

/** A classified custom (non-header) uniform in a replay scene. */
export type PlanCustomUniform = {
  name: string;
  type: string;
  class: "riseRamp" | "settleDim" | "audioAlias" | "color" | "velocityPos" | "velocity";
  params?: Record<string, unknown>;
};

/**
 * A plate/artwork image sampler in a replay scene: the sampler uniform `name`, its resolved
 * `source` (the plate lane or the finding's artwork), and the concrete https `url` the glass
 * loads (crossOrigin anonymous) and binds. The glass reconstructs the offline ShaderLayer's
 * `sampler2D <name>;` + `float <name>AspectRatio;` header pair around the archived body.
 */
export type PlanTexture = {
  name: string;
  source: "artwork" | "plate" | "plate-background";
  url: string;
};

/** The bridge's fused state stream, emitted at a fixed cadence (30-60Hz). */
export type ShowState = {
  t: number; // bridge wall-clock ms
  seq: number; // monotonic
  plan: { pointer: number; total: number; source: "fingerprint" | "manual" | "boot" };
  /** Fingerprint matcher verdict for the CURRENT audio window. */
  match?: { logId: string; confidence: number };
  /** The next planned finding, pre-armed (prefetch target + the remote's "up next"). */
  pending?: { logId: string; title: string; artists: string[] };
  channels: { audio: "live" | "stale" | "silent"; matcher: "ready" | "off" };
  /** The energy dip->surge PRE-ARM hint is active (heightened match sensitivity; never advances alone). */
  prearmed: boolean;
  /** Global reactivity multiplier the operator dials (mirrors the glass's intensity key). */
  intensity: number;
  /** The held-breath rail: the glass is easing to the holding scene. */
  blackout: boolean;
  /** The current planned finding at the pointer (the plate identity), if any. */
  current?: { logId: string; title: string; artists: string[] };
};

/**
 * Commands the glass (or the phone remote) sends the bridge over the same WS.
 * The `mel` frame is the glass's live audio fingerprint feed (Unit L -> Unit B):
 * 40 log-mel bins spanning 0-8kHz, emitted at 10Hz. It is the ONLY channel the
 * plan-scoped fingerprint matcher consumes; everything else is control. Manual
 * advance/rewind/goto ALWAYS win over the matcher, instantly.
 */
export type ShowCommand =
  | { cmd: "advance" } // manual next (the arrow key / remote tap)
  | { cmd: "rewind" }
  | { cmd: "goto"; index: number }
  | { cmd: "blackout"; on: boolean }
  | { cmd: "intensity"; value: number }
  | { cmd: "heartbeat"; renderFrame: number } // the watchdog feed
  // 40 log-mel bins (log1p power, 0-8kHz) @ 10Hz. RAW (un-normalized): the bridge
  // L2-normalizes for the cosine match AND reads the frame's magnitude as the
  // pre-arm energy proxy (an already-normalized frame still matches, but its energy
  // hint goes flat — the hint is advisory only, so either is safe).
  | { cmd: "mel"; t: number; frame: number[] };

/** The number of log-mel bins in a `mel` frame (the glass <-> matcher contract). */
export const MEL_BINS = 40;
/** The mel frame cadence the glass emits at (Hz). */
export const MEL_RATE_HZ = 10;
/** The mel band span (Hz). Both the glass and the server-side preview fingerprints use it. */
export const MEL_FMIN = 0;
export const MEL_FMAX = 8000;
