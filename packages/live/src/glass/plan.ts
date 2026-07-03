// The /plan bridge — assemble the ordered tracklist enriched with each finding's
// palette + seed + duration + videoVehicle tag + the extracted, replay-ready shader
// scene (now multi-layer + velocity-aware). Same-origin so the page has no CORS.
//
// Source of the tracklist, in order: $FLUNCLE_SHOW_PLAN (a path a `fluncle run show
// --plan` bridge writes), else the committed demo fixture, else empty (uncharted-
// space standalone — the failure floor). Everything the arrival needs is already on
// R2 (props.json + composition.tsx), CORS-clear — no backfill artifact.
import { type Scene } from "./scene-extract.ts";
import { extractScene } from "./scene-extract.ts";

export type PlanEntry = {
  logId: string;
  title: string;
  artists: string[];
  foundAt: string | null;
  palette: unknown;
  seed: number | null;
  durationMs: number | null;
  videoVehicle: string | null;
  replay: Scene;
};

type TracklistItem = { logId: string; title?: string; artists?: string[]; durationMs?: number };

let PLAN_CACHE: PlanEntry[] | null = null;

async function loadTracklist(): Promise<TracklistItem[]> {
  const envPath = process.env.FLUNCLE_SHOW_PLAN;
  const candidates = [
    ...(envPath ? [envPath] : []),
    new URL("../plan-pointer/tracklist.json", import.meta.url).pathname,
  ];
  for (const path of candidates) {
    try {
      const f = Bun.file(path);
      if (await f.exists()) {
        return (await f.json()) as TracklistItem[];
      }
    } catch {
      // try the next candidate
    }
  }
  return [];
}

async function fetchVehicleMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const r = await fetch("https://www.fluncle.com/api/tracks?limit=500");
    if (r.ok) {
      const d = (await r.json()) as unknown;
      const items = Array.isArray(d)
        ? d
        : ((d as { tracks?: unknown[]; items?: unknown[] }).tracks ??
          (d as { items?: unknown[] }).items ??
          []);
      for (const t of items as Array<{ logId?: string; videoVehicle?: string }>) {
        if (t.logId && t.videoVehicle) {
          map[t.logId] = t.videoVehicle;
        }
      }
    }
  } catch {
    // feed unavailable -> tag-map falls back to hash for every track
  }
  return map;
}

export async function buildPlan(): Promise<PlanEntry[]> {
  if (PLAN_CACHE) {
    return PLAN_CACHE;
  }
  const tracklist = await loadTracklist();
  const vehicleMap = await fetchVehicleMap();
  const out = await Promise.all(
    tracklist.map(async (t): Promise<PlanEntry> => {
      let palette: unknown = null;
      let seed: number | null = null;
      let title = t.title ?? "";
      let artists = t.artists ?? [];
      let foundAt: string | null = null;
      let durationMs: number | null = t.durationMs ?? null;
      try {
        const r = await fetch(`https://found.fluncle.com/${t.logId}/props.json`);
        if (r.ok) {
          const p = (await r.json()) as {
            palette?: unknown;
            seed?: number;
            track?: {
              title?: string;
              artists?: string[];
              discoveredAt?: string;
              durationMs?: number;
            };
          };
          palette = p.palette ?? null;
          seed = p.seed ?? null;
          title = p.track?.title ?? title;
          artists = p.track?.artists ?? artists;
          foundAt = p.track?.discoveredAt ?? null;
          durationMs = p.track?.durationMs ?? durationMs;
        }
      } catch {
        // props.json missing -> canon palette for this arrival
      }
      let replay: Scene = {
        customUniforms: [],
        layers: [],
        reason: "composition.tsx unavailable",
        replayable: false,
      };
      try {
        const cr = await fetch(`https://found.fluncle.com/${t.logId}/composition.tsx`);
        if (cr.ok) {
          replay = extractScene(await cr.text());
        }
      } catch {
        // fetch failed -> non-replayable (tag-map fallback)
      }
      return {
        artists,
        durationMs,
        foundAt,
        logId: t.logId,
        palette,
        replay,
        seed,
        title,
        videoVehicle: vehicleMap[t.logId] ?? null,
      };
    }),
  );
  PLAN_CACHE = out;
  return out;
}

/** Pre-extract all scenes at boot and print the replayability table. */
export function logSummary(plan: PlanEntry[]): void {
  const pad = (s: string, n: number): string => (s + " ".repeat(n)).slice(0, n);
  let rep = 0;
  console.log(
    "\n" +
      pad("logId", 10) +
      pad("replay", 8) +
      pad("layers", 8) +
      pad("custom uniforms", 46) +
      "reason",
  );
  console.log("-".repeat(118));
  for (const e of plan) {
    if (e.replay.replayable) {
      rep++;
    }
    const cu = e.replay.customUniforms.map((c) => `${c.name}:${c.class}`).join(",");
    console.log(
      pad(e.logId, 10) +
        pad(e.replay.replayable ? "YES" : "no", 8) +
        pad(String(e.replay.layers.length), 8) +
        pad(cu || "(none)", 46) +
        (e.replay.replayable ? "" : (e.replay.reason ?? "")),
    );
  }
  console.log("-".repeat(118));
  console.log(`replayable: ${rep}/${plan.length}\n`);
}
