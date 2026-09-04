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
/**
 * RANDOM-VJ MODE's transition input channel (`--plan all`): the default UDP port the
 * bridge binds a `node:dgram` listener on, accepting `{"type":"transition","deck":1|2}`
 * datagrams from the DJ-mixer sender on the other machine. LAN-local by design (bound on
 * all interfaces so a LAN/VPN peer can reach it). Overridable via `FLUNCLE_VJ_TRANSITION_PORT`.
 */
export const VJ_TRANSITION_PORT = 9000;

/**
 * THE CREW WALL — the room's own logos on the show screen. The bridge serves three LAN
 * surfaces for it on :4180, beside /remote:
 *   * `/crew` — the upload page anyone on the room's WiFi opens (QR-reachable from the wall),
 *   * `/crew/moderate` — the operator's approve/reject queue, phone-sized,
 *   * `/crew/wall` — the rotating overlay OBS reads as a Browser Source.
 * LAN-local by design, exactly like /remote: no auth, never on the open internet. The
 * operator gate is ON by default — an upload lands `pending` and reaches the wall only
 * once he approves it (`FLUNCLE_CREW_AUTO_APPROVE=1` for a room he trusts).
 */
export const BRIDGE_CREW_PATH = "/crew";
export const BRIDGE_CREW_WALL_PATH = "/crew/wall";
export const BRIDGE_CREW_MODERATE_PATH = "/crew/moderate";

/** Per-upload byte cap: a logo, not a photo album. */
export const CREW_MAX_BYTES = 2_000_000;
/** How many logos the wall holds before it stops taking more (bounded by design). */
export const CREW_MAX_LOGOS = 60;
/** Uploads one address may land inside `CREW_RATE_WINDOW_MS`. */
export const CREW_RATE_LIMIT = 5;
export const CREW_RATE_WINDOW_MS = 60_000;
/** How long one logo holds the wall before the crossfade to the next. */
export const CREW_DWELL_MS = 18_000;

/** The raster formats the wall accepts. SVG is refused — it executes script in a browser source. */
export type CrewImageExt = "png" | "jpeg" | "webp" | "gif";

/** One uploaded logo. `state` IS the operator gate: pending until he approves it. */
export type CrewLogo = {
  id: string;
  ext: CrewImageExt;
  state: "pending" | "approved";
  addedAt: number;
  /** The uploader's own label, trimmed + capped. Shown in the moderation queue only. */
  label?: string;
};

/**
 * The wall's roll: the approved logos plus the ORDER the wall walks them in. The order is
 * drawn bridge-side by the SAME `createShuffleBag` the RANDOM-VJ director uses, so the
 * package holds exactly one shuffle implementation — no browser mirror to drift out of step.
 */
export type CrewRoll = {
  /** Bumps whenever the approved set changes, so the wall knows to re-fetch. */
  version: number;
  dwellMs: number;
  /** A full permutation of the approved ids — every logo shows once before any repeats. */
  order: string[];
  logos: Array<{ id: string; url: string; label?: string }>;
};

/** One planned track, enriched at show start (the /plan shape the glass already consumes). */
export type PlanEntry = {
  logId: string;
  title: string;
  artists: string[];
  /**
   * Fluncle's stored DSP bpm + scale-text key (`"A minor"`), threaded through from the
   * public feed row so a `PlanEntry[]` is structurally a `Finding[]` — the deck-identity
   * resolver (`identity.ts`) reads them as COARSE GUARDS when matching an on-flip OCR read
   * to this plan. Only the RANDOM-VJ pool (`--plan all`, sourced from `/api/v1/findings`) carries
   * them; the mixtape/handle path leaves them undefined (the resolver's guards are optional).
   */
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
    /**
     * True when the scene builds toward a drop reveal (a layer reads `u_audioDrop` / drives a
     * drop alias) — the live host runs the scripted arrival arc only on these.
     */
    usesDrop?: boolean;
    /** The archived drop-envelope timing (rise/hold/fall), when the composition declared one. */
    dropShape?: { riseMs: number; holdMs: number; fallMs: number };
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
/** The mel band span (Hz). Both the glass and the server-side preview fingerprints use it. */
export const MEL_FMIN = 0;
export const MEL_FMAX = 8000;
