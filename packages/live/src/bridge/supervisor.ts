import { spawn } from "node:child_process";

import { GLASS_PORT } from "../contract";

export type SupervisorTrip = {
  at: number;
  heartbeatAgeMs: number;
  relaunched: boolean;
  error?: string;
};

export type SupervisorConfig = {
  staleMs: number;

  checkMs: number;

  cooloffMs: number;

  glassUrl: string;

  chromiumPath: string | undefined;
};

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  checkMs: 1_000,
  chromiumPath: process.env.FLUNCLE_CHROMIUM,
  cooloffMs: 20_000,
  glassUrl: process.env.FLUNCLE_GLASS_URL ?? `http://localhost:${GLASS_PORT}`,
  staleMs: 5_000,
};

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

export function launchGlassChromium(cfg: SupervisorConfig): boolean {
  if (!cfg.chromiumPath) {
    return false;
  }
  try {
    const args = chromiumArgs(cfg.glassUrl);

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
