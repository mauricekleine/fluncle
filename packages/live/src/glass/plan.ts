import { type Scene } from "./scene-extract.ts";
import { extractScene, resolveSceneTextureUrls } from "./scene-extract.ts";

export type PlanEntry = {
  logId: string;
  title: string;
  artists: string[];
  foundAt: string | null;
  palette: unknown;
  scenePalette?: string[];
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
    } catch {}
  }
  return [];
}

async function fetchVehicleMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const r = await fetch("https://www.fluncle.com/api/v1/findings?limit=500");
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
  } catch {}
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
      let artworkUrl: string | null = null;
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
              artworkUrl?: string;
            };
          };
          palette = p.palette ?? null;
          seed = p.seed ?? null;
          title = p.track?.title ?? title;
          artists = p.track?.artists ?? artists;
          foundAt = p.track?.discoveredAt ?? null;
          durationMs = p.track?.durationMs ?? durationMs;
          artworkUrl = p.track?.artworkUrl ?? null;
        }
      } catch {}
      let scenePalette: string[] | undefined;
      try {
        const sr = await fetch(`https://found.fluncle.com/${t.logId}/scene.json`);
        if (sr.ok) {
          const sc = (await sr.json()) as { palette?: string[] };
          if (Array.isArray(sc.palette) && sc.palette.length >= 4) {
            scenePalette = sc.palette;
          }
        }
      } catch {}
      let replay: Scene = {
        customUniforms: [],
        layers: [],
        reason: "composition.tsx unavailable",
        replayable: false,
        textures: [],
        usesDrop: false,
      };
      try {
        const cr = await fetch(`https://found.fluncle.com/${t.logId}/composition.tsx`);
        if (cr.ok) {
          replay = resolveSceneTextureUrls(extractScene(await cr.text()), t.logId, artworkUrl);
        }
      } catch {}
      return {
        artists,
        durationMs,
        foundAt,
        logId: t.logId,
        palette,
        replay,
        scenePalette,
        seed,
        title,
        videoVehicle: vehicleMap[t.logId] ?? null,
      };
    }),
  );
  PLAN_CACHE = out;
  return out;
}

export function logSummary(plan: PlanEntry[]): void {
  const pad = (s: string, n: number): string => (s + " ".repeat(n)).slice(0, n);
  let rep = 0;
  console.log(
    "\n" +
      pad("logId", 10) +
      pad("replay", 8) +
      pad("layers", 8) +
      pad("tex", 5) +
      pad("custom uniforms", 42) +
      "reason",
  );
  console.log("-".repeat(118));
  for (const e of plan) {
    const r = e.replay as Scene | undefined;
    if (r?.replayable) {
      rep++;
    }
    const cu = (r?.customUniforms ?? []).map((c) => `${c.name}:${c.class}`).join(",");
    console.log(
      pad(e.logId, 10) +
        pad(r?.replayable ? "YES" : "no", 8) +
        pad(String(r?.layers.length ?? 0), 8) +
        pad(String(r?.textures?.length ?? 0), 5) +
        pad(cu || "(none)", 42) +
        (r?.replayable ? "" : (r?.reason ?? "")),
    );
  }
  console.log("-".repeat(118));
  console.log(`replayable: ${rep}/${plan.length}\n`);
}

export type PlanSource = "bridge" | "local";

export function choosePlanSource<T>(
  bridgePlan: readonly T[] | null,
  localPlan: readonly T[],
): { plan: T[]; source: PlanSource; log: string } {
  if (bridgePlan && bridgePlan.length > 0) {
    return {
      log: `plan: ${bridgePlan.length} findings via the bridge`,
      plan: [...bridgePlan],
      source: "bridge",
    };
  }
  return {
    log: `plan: ${localPlan.length} findings, local fixture — no bridge`,
    plan: [...localPlan],
    source: "local",
  };
}

export async function resolveBridgePlan(
  bridgePort: number,
  timeoutMs = 1200,
): Promise<PlanEntry[] | null> {
  try {
    const res = await fetch(`http://localhost:${bridgePort}/plan`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    const body: unknown = await res.json();

    return Array.isArray(body) ? (body as PlanEntry[]) : null;
  } catch {
    return null;
  }
}

export async function resolveBridgePlanWithRetry(
  bridgePort: number,
  {
    tries = 8,
    delayMs = 300,
    timeoutMs = 1200,
  }: { tries?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<PlanEntry[] | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const plan = await resolveBridgePlan(bridgePort, timeoutMs);
    if (plan) {
      return plan;
    }
    if (attempt < tries - 1) {
      await Bun.sleep(delayMs);
    }
  }
  return null;
}
