import { type DoorDef, type RegionModule } from "./regions/_shared";
import { makeSprite } from "./sprites";

// Auto-registration: every region module under ./regions/*.ts (except _shared)
// is discovered at build time via Vite's import.meta.glob. Adding a region is
// adding a file — no edit here — which is what lets parallel region builds fan
// out without touching a shared file. Browser/Vite-only (the glob is a Vite
// transform); never imported by unit tests.

const modules = import.meta.glob<{ default: RegionModule }>("./regions/*.ts", {
  eager: true,
});

export const REGIONS: RegionModule[] = Object.entries(modules)
  .filter(([path]) => !path.includes("/_"))
  .map(([, mod]) => mod.default)
  .filter((region): region is RegionModule => Boolean(region));

export type PlacedDoor = DoorDef & { region: string };

/** Every door across every region, flattened, with its region id attached. */
export const DOORS: PlacedDoor[] = REGIONS.flatMap((region) =>
  region.doors.map((door) => ({ ...door, region: region.id })),
);

// propId -> char grid, merged across regions (prop ids are globally unique).
const PROP_MAPS: Record<string, string[]> = {};
for (const region of REGIONS) {
  for (const propId of Object.keys(region.props)) {
    const map = region.props[propId];
    if (map) {
      PROP_MAPS[propId] = map;
    }
  }
}

/** Build the procedural prop sprites once at boot (PNG overrides them on load). */
export function buildPropSprites(): Record<string, HTMLCanvasElement> {
  const out: Record<string, HTMLCanvasElement> = {};
  for (const propId of Object.keys(PROP_MAPS)) {
    const map = PROP_MAPS[propId];
    if (map) {
      out[propId] = makeSprite(map);
    }
  }
  return out;
}
