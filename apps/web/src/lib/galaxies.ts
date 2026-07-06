// Single source of truth for the four galaxies — the vibe-map quadrants by which
// findings are grouped. The NAMES are provisional: rename
// them HERE and every surface follows — the /admin board, the newsletter (via the
// `galaxy` field on /api/tracks), and the game.
//
// vibe_x = Light(-1)↔Dark(+1) mood; vibe_y = Floaty(-1)↔Driving(+1) energy. The
// four quadrants map to the four galaxies; the axes are inclusive toward
// dark/driving (x>=0, y>=0) so every coordinate lands in exactly one.

import { type Galaxy } from "@fluncle/contracts";

export type { Galaxy };

export type GalaxyMeta = {
  color: string;
  energy: "driving" | "floaty";
  mood: "dark" | "light";
  name: string;
};

export const GALAXIES: Record<Galaxy, GalaxyMeta> = {
  astral: { color: "oklch(0.64 0.16 295)", energy: "floaty", mood: "dark", name: "Astral" }, // bottom-right (floaty + dark)
  lunar: { color: "oklch(0.72 0.12 230)", energy: "floaty", mood: "light", name: "Lunar" }, // bottom-left (floaty + light)
  nebular: { color: "oklch(0.62 0.21 25)", energy: "driving", mood: "dark", name: "Nebular" }, // top-right (driving + dark)
  solar: { color: "oklch(0.8 0.13 85)", energy: "driving", mood: "light", name: "Solar" }, // top-left (driving + light)
};

export function galaxyForVibe(x: number, y: number): Galaxy {
  if (y >= 0) {
    return x < 0 ? "solar" : "nebular";
  }

  return x < 0 ? "lunar" : "astral";
}
