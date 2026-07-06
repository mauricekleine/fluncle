// The /plan bridge — assemble the ordered tracklist enriched with each finding's
// palette + seed + duration + videoVehicle tag + the extracted, replay-ready shader
// scene (now multi-layer + velocity-aware). Same-origin so the page has no CORS.
//
// Source of the tracklist, in order: $FLUNCLE_SHOW_PLAN (a path a `fluncle run show
// --plan` bridge writes), else the committed demo fixture, else empty (uncharted-
// space standalone — the failure floor). Everything the arrival needs is already on
// R2 (props.json + composition.tsx), CORS-clear — no backfill artifact.
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
      } catch {
        // props.json missing -> canon palette for this arrival
      }
      let scenePalette: string[] | undefined;
      try {
        const sr = await fetch(`https://found.fluncle.com/${t.logId}/scene.json`);
        if (sr.ok) {
          const sc = (await sr.json()) as { palette?: string[] };
          if (Array.isArray(sc.palette) && sc.palette.length >= 4) {
            scenePalette = sc.palette;
          }
        }
      } catch {
        // scene.json missing -> the artwork palette carries the replay tint.
      }
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
          // Resolve plate/artwork samplers to concrete R2 URLs the glass loads + binds.
          replay = resolveSceneTextureUrls(extractScene(await cr.text()), t.logId, artworkUrl);
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

/** Pre-extract all scenes at boot and print the replayability table. */
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
    // `replay` is present on both the glass's own entries and the bridge's (it always
    // sets it), but a lagging bridge could omit it — narrate that rather than throw.
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

// ── Bridge-first plan precedence (RFC §4 · the first-set debrief fix) ─────────
// The glass keeps a standalone /plan (the fixture floor) for bridge-less mode, but when
// the bridge is up its /plan WINS: the operator's real, full plan must drive the glass —
// not the committed demo tracklist. The first live set exposed the gap (the glass cycled
// its own 5-entry fixture while the bridge held the real 17-finding plan). `choosePlanSource`
// is the pure precedence rule the glass server + client both narrate; `resolveBridgePlan`
// reaches the bridge over the loopback. Both worlds index the SAME list, so the bridge
// pointer (arrow keys / phone remote → matcher) and the glass plan stay in lock-step.

/** Which /plan the glass ended up serving. */
export type PlanSource = "bridge" | "local";

/**
 * The pure precedence rule: the bridge's plan wins whenever it answered with a non-empty
 * tracklist; otherwise the local fixture floor. Returns the winning list, its source, and
 * the operator-facing log line ("plan: N findings via the bridge" vs "plan: N findings,
 * local fixture — no bridge"). Generic + side-effect-free, so it unit-tests directly.
 */
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

/**
 * Ask the bridge for its /plan over the loopback. Returns the enriched tracklist, or null
 * when no bridge answers (down, wrong port, timeout, or a non-OK / non-array body) — the
 * signal to fall to the local fixture floor. One attempt; the caller owns any retry window.
 */
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
    // The bridge's PlanEntry[] is the contract shape; the glass consumes it structurally
    // (every field it reads is null/undefined-tolerant), so this is the one boundary cast.
    return Array.isArray(body) ? (body as PlanEntry[]) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the bridge plan with a brief retry window. `run show` raises the bridge first
 * and waits for it healthy, so at glass boot it is normally already answering; this only
 * covers the small startup race (and a rehearsal where the bridge is still coming up).
 */
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
