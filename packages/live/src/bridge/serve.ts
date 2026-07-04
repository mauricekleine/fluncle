// THE BRIDGE PROCESS (`bun run --cwd packages/live bridge`, :4180). One
// stateless-restartable Bun process that:
//   * serves the enriched /plan (the glass loads it on boot; same shape the glass
//     seed served, now bridge-owned — the glass's standalone /plan on :4173 stays
//     for bridge-less mode, so :4180 takes precedence when the bridge is up),
//   * serves the phone remote at /remote (canon surface, LAN),
//   * streams ShowState over ws://:4180/state at 30Hz with seq/t + per-channel
//     staleness, and ingests ShowCommands (mel frames, nudges, blackout, intensity,
//     heartbeats) on the same socket,
//   * runs the fingerprint matcher (fed by the glass's 10Hz mel frames) and the
//     out-of-process supervisor (relaunches a wedged glass).
//
// Boot: build the plan, fingerprint every planned preview, then open the socket.
// The matcher never touches the network again — the never-crash rail.

import {
  BRIDGE_PORT,
  BRIDGE_REMOTE_PATH,
  BRIDGE_WS_PATH,
  type PlanEntry,
  type ShowCommand,
} from "../contract";
import { fingerprintPlan } from "./fingerprint";
import { type Fingerprint } from "./matcher";
import { buildPlan } from "./plan";
import { REMOTE_HTML } from "./remote";
import { createShowState } from "./state";
import { startSupervisor } from "./supervisor";

/** State-stream cadence (30Hz — the low end of the RFC's 30-60Hz). */
const BROADCAST_HZ = 30;

type Boot = { plan: PlanEntry[]; fingerprints: Fingerprint[] };

/**
 * Resolve the requested plan id from the bridge's argv, honouring BOTH `--plan <id>`
 * (the shape `run show` passes) and a bare positional id, with `FLUNCLE_PLAN_MIXTAPE`
 * as the fallback. Returns undefined when nothing is requested — `buildPlan` then
 * builds the default plan (fixture floor). Pure so the arg contract is unit-testable.
 */
export function parsePlanArg(
  argv: string[],
  env = process.env.FLUNCLE_PLAN_MIXTAPE,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plan") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        return next;
      }
      continue; // a dangling `--plan` with no value falls through to the env/default
    }
    if (!arg.startsWith("--")) {
      return arg; // a bare positional id
    }
  }
  return env;
}

/** Build the plan and fingerprint its previews. */
async function boot(mixtapeLogId?: string): Promise<Boot> {
  const plan = await buildPlan(mixtapeLogId);
  console.error(`bridge: plan built — ${plan.length} findings; fingerprinting previews…`);
  const fingerprints = await fingerprintPlan(plan.map((p) => p.logId));
  const withFp = fingerprints.filter((f) => f.frames !== null).length;
  console.error(`bridge: fingerprinted ${withFp}/${fingerprints.length} previews`);
  return { fingerprints, plan };
}

async function main(): Promise<void> {
  const mixtape = parsePlanArg(process.argv.slice(2));
  const { plan, fingerprints } = await boot(mixtape);
  const state = createShowState(plan, fingerprints);

  // The set of connected sockets (glass + any phone remotes).
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();

  const supervisor = startSupervisor(
    (now) => state.heartbeatAgeMs(now),
    (trip) => {
      console.error(
        `bridge: SUPERVISOR trip — no heartbeat for ${trip.heartbeatAgeMs}ms; ` +
          (trip.relaunched ? "relaunched the glass" : `no relaunch (${trip.error ?? "cooloff"})`),
      );
    },
  );

  const server = Bun.serve({
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === BRIDGE_WS_PATH) {
        if (srv.upgrade(req)) {
          return undefined;
        }
        return new Response("expected a websocket upgrade", { status: 426 });
      }
      if (url.pathname === "/plan") {
        return Response.json(plan);
      }
      if (url.pathname === "/scene") {
        const logId = url.searchParams.get("logId") ?? "";
        const entry = plan.find((p) => p.logId === logId);
        return Response.json(
          entry?.replay ?? {
            customUniforms: [],
            layers: [],
            reason: "unknown logId",
            replayable: false,
          },
        );
      }
      if (url.pathname === BRIDGE_REMOTE_PATH || url.pathname === `${BRIDGE_REMOTE_PATH}/`) {
        return new Response(REMOTE_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/health") {
        return Response.json({ findings: plan.length, ok: true });
      }
      return new Response("the glass bridge — /plan /remote /state /health", { status: 404 });
    },
    port: BRIDGE_PORT,
    websocket: {
      close(ws) {
        sockets.delete(ws);
      },
      message(_ws, raw) {
        let cmd: ShowCommand;
        try {
          cmd = JSON.parse(String(raw)) as ShowCommand;
        } catch {
          return;
        }
        state.ingest(cmd, Date.now());
      },
      open(ws) {
        sockets.add(ws);
      },
    },
  });

  // 30Hz broadcast loop — one ShowState snapshot to every connected socket.
  const interval = setInterval(
    () => {
      if (sockets.size === 0) {
        return;
      }
      const payload = JSON.stringify(state.snapshot(Date.now()));
      for (const ws of sockets) {
        ws.send(payload);
      }
    },
    Math.round(1000 / BROADCAST_HZ),
  );

  const shutdown = (): void => {
    clearInterval(interval);
    supervisor.stop();
    void server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(
    `bridge: live on :${BRIDGE_PORT} — ws${BRIDGE_WS_PATH} · /plan · ${BRIDGE_REMOTE_PATH} · ` +
      `matcher ${state.matcherReady ? "ready" : "off"}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("bridge: fatal —", err);
    process.exit(1);
  });
}
