// pulse server routes. Four surfaces, one scheduler:
//
//   GET  /api/pulse/board        — the cheap, fast half: daemon vitals, the render
//                                  queue, the /api/status surface grid, and the
//                                  show's liveness (read-only probes to :4173/:4180).
//   GET  /api/pulse/next         — the single next-to-post card + the nudge status.
//   POST /api/pulse/nudge/check  — run the 18h nudge tick now (dry, or fire; the
//                                  `force` test hook — LOOPBACK-ONLY — pushes the
//                                  clock past the threshold).
//   POST /api/pulse/ping         — the line check (a streamed run) — the run-drawer
//                                  proof kept from the pulse-lite reference.
//
// Every admin/status read is READ-ONLY; the helm never writes. The scheduler is
// started here, so it rises with the daemon and nudges even windowless (launchd).

import { resolve } from "node:path";

import { HELM_PORT, type RunStartedResponse } from "../../contract";
import { adminTokenAboard } from "../../server/admin";
import { json } from "../../server/features";
import { requestIsLocal } from "../../server/locality";
import { type AdminClient, type HelmApp } from "../types";
import {
  type LiveProbe,
  type NudgeCheckResponse,
  type PulseBoard,
  type PulseNext,
  type QueueSummary,
  type SurfacesSummary,
} from "./contract";
import { mapQueue, mapSurfaces, type QueueTrackInput, type StatusProbeInput } from "./logic";
import { createPostingGatherer } from "./posting-state";
import { createNudgeScheduler, fileNudgeStore, readNudgeConfig } from "./scheduler";

const SITE_BASE = "https://www.fluncle.com";
const GLASS_PORT = 4173;
const BRIDGE_PORT = 4180;
const QUEUE_LIMIT = 20;
const PROBE_TIMEOUT_MS = 700;

// The line check (a tiny streamed child), narrated in the pre-flight vocabulary
// ([clear]/[hold]/[dark], packages/live/src/show.ts) so the run drawer renders it
// as status rows. Kept from pulse-lite: it proves the streamed-run path still
// answers from the pulse station. A PURE ARGV spawn — the daemon's own runtime
// (`bun -e`) evaluates this fixed source; no shell ever parses a string.
const LINE_CHECK_LINES = [
  "line check — the helm sounds its own wiring",
  "  [clear] spawn                  a child ran under the daemon",
  "  [clear] stream                 you are reading it live",
  "  [clear] line check             the wiring holds",
] as const;

const LINE_CHECK_SOURCE = `for (const line of ${JSON.stringify(LINE_CHECK_LINES)}) { console.log(line); await Bun.sleep(400); }`;

/** The line check's argv: the runtime, `-e`, the fixed source — never a shell. */
export function lineCheckArgv(execPath: string): string[] {
  return [execPath, "-e", LINE_CHECK_SOURCE];
}

const HELM_PKG = resolve(import.meta.dir, "../../../package.json");
let versionCache: string | undefined;

async function helmVersion(): Promise<string> {
  if (versionCache !== undefined) {
    return versionCache;
  }

  try {
    const pkg = JSON.parse(await Bun.file(HELM_PKG).text()) as { version?: string };
    versionCache = pkg.version ?? "0.0.0";
  } catch {
    versionCache = "0.0.0";
  }

  return versionCache;
}

function resolvePort(): number {
  const raw = process.env.FLUNCLE_HELM_PORT;
  const port = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : HELM_PORT;
}

/** A read-only liveness GET to a localhost port — any HTTP answer means it's up. */
async function probePort(port: number): Promise<"down" | "up"> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    return "up";
  } catch {
    return "down";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRoutes(app: HelmApp): void {
  const { admin, machine, machineBrand, runs, startedAt } = app.context;
  const port = resolvePort();

  const gather = createPostingGatherer(admin);
  const scheduler = createNudgeScheduler({
    config: readNudgeConfig(),
    notify: (title, body) => app.context.notify(title, body),
    store: fileNudgeStore(),
  });

  // The nudge rises with the daemon — hourly, windowless under launchd.
  scheduler.start(() => gather());

  app.get("/api/pulse/board", async () => {
    const [version, queue, surfaces, glass, bridge] = await Promise.all([
      helmVersion(),
      readQueue(admin),
      readSurfaces(),
      probePort(GLASS_PORT),
      probePort(BRIDGE_PORT),
    ]);

    const live: LiveProbe = { bridge, glass };
    const body: PulseBoard = {
      live,
      queue,
      surfaces,
      vitals: {
        adminTokenAboard: adminTokenAboard(),
        machine,
        machineBrand,
        pid: process.pid,
        port,
        uptimeMs: Date.now() - startedAt,
        version,
      },
    };

    return json(body);
  });

  app.get("/api/pulse/next", async () => {
    try {
      const state = await gather();
      const body: PulseNext = {
        nextToPost: state.nextToPost,
        nudge: scheduler.status(state, Date.now()),
      };

      return json(body);
    } catch (error) {
      // A failed gather (no admin token, network) still needs a nudge shape so the
      // panel reads "admin not aboard" rather than going blank.
      const body: PulseNext = {
        error: errorText(error),
        nudge: {
          ageMs: null,
          hasUnposted: false,
          lastNudgeDay: null,
          newestPostedAt: null,
          reason: "no-unposted",
          thresholdHours: scheduler.config.thresholdHours,
          timeZone: scheduler.config.timeZone,
          wouldFire: false,
        },
      };

      return json(body);
    }
  });

  app.post("/api/pulse/nudge/check", async (req) => {
    const options = await readCheckBody(req);

    // The forced clock is a test hook — loopback only, even though LAN peers
    // are already key-authed (the daemon's fetch gate stamps locality by remote
    // address, so a header can never forge this).
    if (options.force && !requestIsLocal(req)) {
      return json(
        { code: "local_only", message: "The forced clock answers only from this Mac." },
        403,
      );
    }

    try {
      const state = await gather({ force: options.force });
      const result: NudgeCheckResponse = await scheduler.check(state, {
        fire: options.fire,
        force: options.force,
      });

      return json(result);
    } catch (error) {
      return json({ code: "gather_failed", message: errorText(error) }, 502);
    }
  });

  app.post("/api/pulse/ping", () => {
    const { runId } = runs.runStreamed(lineCheckArgv(process.execPath), {
      feature: "pulse",
      title: "line check",
    });
    const body: RunStartedResponse = { runId };

    return json(body);
  });
}

/** The render queue: findings with context but no video yet, oldest first. */
async function readQueue(admin: AdminClient): Promise<QueueSummary> {
  try {
    const response = await admin.get<{ tracks: (QueueTrackInput & { type?: string })[] }>(
      `/api/admin/tracks?hasContext=true&hasVideo=false&order=asc&limit=${QUEUE_LIMIT}`,
    );
    const findings = (response.tracks ?? []).filter((track) => track.type !== "mixtape");

    return { rows: mapQueue(findings, Date.now()) };
  } catch (error) {
    return { error: errorText(error), rows: [] };
  }
}

/** The public /api/status probe — read-only, unauthenticated. */
async function readSurfaces(): Promise<SurfacesSummary> {
  try {
    const response = await fetch(`${SITE_BASE}/api/status`, { signal: AbortSignal.timeout(6000) });

    if (!response.ok) {
      return { error: `status ${response.status}`, freshestReportAt: null, rows: [] };
    }

    const payload = (await response.json()) as StatusProbeInput;

    return { freshestReportAt: payload.freshestReportAt ?? null, rows: mapSurfaces(payload) };
  } catch (error) {
    return { error: errorText(error), freshestReportAt: null, rows: [] };
  }
}

type CheckBody = { fire: boolean; force: boolean };

async function readCheckBody(req: Request): Promise<CheckBody> {
  try {
    const body = (await req.json()) as { fire?: unknown; force?: unknown } | null;

    return { fire: body?.fire === true, force: body?.force === true };
  } catch {
    return { fire: false, force: false };
  }
}
