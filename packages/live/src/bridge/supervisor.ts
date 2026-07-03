// THE SUPERVISOR — the bridge's out-of-process watchdog over the glass (RFC §3's
// two-tier watchdog: the in-page heartbeat is tier one; this is tier two). The
// glass sends `{ cmd: "heartbeat", renderFrame }` every render tick over the same
// WS. If no heartbeat arrives for `staleMs` (default 5s), the render loop is
// wedged (a lost WebGL context that did not recover, a hung tab): the supervisor
// relaunches the pinned Chromium and logs the trip. Every trip is recorded so the
// dress rehearsal can count on-air gaps.
//
// The launch line (documented, per the brief): a PINNED Chromium in --app kiosk
// mode with the RFC §3 flags (own profile, auto-update disabled, no first-run UI),
// pointed at the glass. On macOS the operator's pinned build is launched by its
// absolute path via `open -na <app> --args ...` (config, not code: the path comes
// from FLUNCLE_CHROMIUM). Relaunch is best-effort — the OBS fallback scene (a
// static brand card, one-key cut) covers the relaunch seconds regardless.

import { spawn } from "node:child_process";

import { GLASS_PORT } from "../contract";

export type SupervisorTrip = {
  at: number;
  heartbeatAgeMs: number;
  relaunched: boolean;
  error?: string;
};

export type SupervisorConfig = {
  /** No heartbeat for this long ⇒ the glass is wedged; relaunch. */
  staleMs: number;
  /** How often the watchdog checks. */
  checkMs: number;
  /** Don't relaunch again within this cool-off (a relaunch takes seconds to boot). */
  cooloffMs: number;
  /** The glass URL the Chromium opens. */
  glassUrl: string;
  /** The pinned Chromium app/binary. Absent ⇒ log-only (no auto-relaunch). */
  chromiumPath: string | undefined;
};

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  checkMs: 1_000,
  chromiumPath: process.env.FLUNCLE_CHROMIUM,
  cooloffMs: 20_000,
  glassUrl: process.env.FLUNCLE_GLASS_URL ?? `http://localhost:${GLASS_PORT}`,
  staleMs: 5_000,
};

/** The Chromium flags the pinned kiosk launches with (RFC §3). */
export function chromiumArgs(glassUrl: string): string[] {
  return [
    `--app=${glassUrl}`,
    "--kiosk",
    "--start-fullscreen",
    "--user-data-dir=/tmp/fluncle-glass-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--disable-background-networking",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=Translate,MediaRouter",
  ];
}

/**
 * Launch (or relaunch) the pinned Chromium at the glass. Best-effort: returns
 * false (with no throw) when no pinned binary is configured or the spawn fails.
 * macOS `open -na <app> --args …` bundles; a bare binary path is spawned directly.
 */
export function launchGlassChromium(cfg: SupervisorConfig): boolean {
  if (!cfg.chromiumPath) {
    return false;
  }
  try {
    const args = chromiumArgs(cfg.glassUrl);
    // A .app bundle goes through `open`; a raw executable is spawned directly.
    const isBundle = cfg.chromiumPath.endsWith(".app");
    const child = isBundle
      ? spawn("open", ["-na", cfg.chromiumPath, "--args", ...args], {
          detached: true,
          stdio: "ignore",
        })
      : spawn(cfg.chromiumPath, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The watchdog. `heartbeatAgeMs(now)` returns ms since the last render heartbeat
 * (or -1 if none yet — a not-yet-connected glass is not a trip). Returns a stop
 * handle. Each trip is passed to `onTrip` (and logged).
 */
export function startSupervisor(
  heartbeatAgeMs: (now: number) => number,
  onTrip: (trip: SupervisorTrip) => void,
  config: Partial<SupervisorConfig> = {},
): { stop: () => void; trips: SupervisorTrip[] } {
  const cfg = { ...DEFAULT_SUPERVISOR_CONFIG, ...config };
  const trips: SupervisorTrip[] = [];
  let lastRelaunchAt = -Infinity;

  const timer = setInterval(() => {
    const now = Date.now();
    const age = heartbeatAgeMs(now);
    if (age < 0 || age <= cfg.staleMs) {
      return;
    }
    if (now - lastRelaunchAt < cfg.cooloffMs) {
      return;
    }
    lastRelaunchAt = now;
    const relaunched = launchGlassChromium(cfg);
    const trip: SupervisorTrip = { at: now, heartbeatAgeMs: age, relaunched };
    if (!relaunched && !cfg.chromiumPath) {
      trip.error = "no FLUNCLE_CHROMIUM configured (log-only)";
    }
    trips.push(trip);
    onTrip(trip);
  }, cfg.checkMs);

  return {
    stop: () => clearInterval(timer),
    trips,
  };
}
