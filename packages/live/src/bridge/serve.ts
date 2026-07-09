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
import { fingerprintPlan, fingerprintPlanFullSong } from "./fingerprint";
import { type Fingerprint } from "./matcher";
import { type AdminAuth, buildPlan, isAllPlan, loadAdminAuth } from "./plan";
import { REMOTE_HTML } from "./remote";
import { createShowState } from "./state";
import { startSupervisor } from "./supervisor";
import {
  createShuffleBag,
  mulberry32,
  resolveVjTransitionPort,
  startVjTransitionListener,
} from "./vj";

/** State-stream cadence (30Hz — the low end of the RFC's 30-60Hz). */
const BROADCAST_HZ = 30;

type Boot = { plan: PlanEntry[]; fingerprints: Fingerprint[] };

/**
 * Resolve the requested plan ref from the bridge's argv, honouring BOTH `--plan <ref>`
 * (the shape `run show` passes) and a bare positional ref, with `FLUNCLE_PLAN_MIXTAPE`
 * as the fallback. The ref is a mixtape logId OR a plan handle — `buildPlan` decides by
 * shape. Returns undefined when nothing is requested — `buildPlan` then builds the default
 * plan (fixture floor). Pure so the arg contract is unit-testable.
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

/**
 * The Tier-A full-song swap is GATED, default OFF: the bridge fingerprints the full
 * song only when BOTH an admin token is present (the operator machine) AND
 * `FLUNCLE_FULL_SONG_FINGERPRINT` is explicitly enabled ("1"/"true", case-insensitive).
 * Until the operator flips the flag AFTER the M5 accuracy re-tune, the bridge stays on
 * preview references with the preview-calibrated thresholds — so merging Tier-A is a
 * live-path NO-OP (the swap ships only when the flag is on). Additive: a token alone
 * never flips it. Pure, so it is unit-tested.
 */
export function shouldFingerprintFullSong(
  auth: AdminAuth | null,
  flagEnv = process.env.FLUNCLE_FULL_SONG_FINGERPRINT,
): boolean {
  if (!auth) {
    return false;
  }
  const flag = flagEnv?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** Build the plan (mixtape logId or plan handle) and fingerprint each planned finding. */
async function boot(planRef?: string): Promise<Boot> {
  const plan = await buildPlan(planRef);
  // RANDOM-VJ MODE (`--plan all`): the WHOLE archive as an unordered pool, driven by the
  // shuffle-bag director's transition datagrams (`vj.ts`) — there is no identity to match, so
  // skip fingerprinting entirely. Returning `frames: null` for EVERY entry means the matcher
  // never advances (it only ever advances on a fingerprint hit), so the director owns the
  // pointer via `goto`. Every OTHER plan ref stays exactly as before (still fingerprints).
  if (isAllPlan(planRef)) {
    console.error(
      `bridge: RANDOM-VJ pool — ${plan.length} findings, no fingerprinting (director shuffles)`,
    );
    return { fingerprints: plan.map((p) => ({ frames: null, logId: p.logId })), plan };
  }
  const logIds = plan.map((p) => p.logId);
  const suffix = planRef ? ` (${planRef})` : "";
  // Tier-A full-song references are GATED (default OFF): fingerprint the full song from
  // the private R2 via the operator-token `get_source_audio` endpoint ONLY when a token
  // is present AND FLUNCLE_FULL_SONG_FINGERPRINT is on — the operator flips it AFTER the
  // M5 accuracy re-tune. Otherwise stay on the 30s preview relay (today's behavior, even
  // when a token exists), so merging Tier-A is a live-path no-op. Either path pulls the
  // fingerprints ONCE at boot (bounded concurrency) and holds them for the whole show —
  // the matcher never touches the network again (the never-crash rail).
  const auth = await loadAdminAuth();
  const fullSong = shouldFingerprintFullSong(auth);
  const source = fullSong
    ? "full songs (private R2)"
    : auth
      ? "30s previews — full-song fingerprinting OFF (set FLUNCLE_FULL_SONG_FINGERPRINT=1 after the M5 accuracy re-tune)"
      : "30s previews (no admin token)";
  console.error(`bridge: plan built — ${plan.length} findings${suffix}; fingerprinting ${source}…`);
  const fingerprints =
    fullSong && auth ? await fingerprintPlanFullSong(logIds, auth) : await fingerprintPlan(logIds);
  const withFp = fingerprints.filter((f) => f.frames !== null).length;
  console.error(`bridge: fingerprinted ${withFp}/${fingerprints.length} — ${source}`);
  return { fingerprints, plan };
}

async function main(): Promise<void> {
  const planRef = parsePlanArg(process.argv.slice(2));
  const { plan, fingerprints } = await boot(planRef);
  const state = createShowState(plan, fingerprints);

  // RANDOM-VJ MODE (`--plan all`): bind the UDP transition channel and let the shuffle-bag
  // director drive the pointer. Bound ONLY in VJ mode — every other plan ref never opens the
  // socket. Each valid `{"type":"transition","deck":1|2}` datagram pulls the next unique
  // finding from the bag and drives the show through the SAME `goto` command path the phone
  // remote uses. LAN-local by design (bound on all interfaces so the DJ-mixer sender on the
  // other machine can reach it). The port is injectable via `FLUNCLE_VJ_TRANSITION_PORT`.
  let vjListener: Awaited<ReturnType<typeof startVjTransitionListener>> | null = null;
  if (isAllPlan(planRef) && plan.length > 0) {
    const bag = createShuffleBag(plan.length, mulberry32(Date.now()));
    vjListener = await startVjTransitionListener({
      onError: (err) => console.error("bridge: VJ transition socket —", err),
      onTransition: () => state.ingest({ cmd: "goto", index: bag.next() }, Date.now()),
      port: resolveVjTransitionPort(),
    });
    console.error(
      `bridge: RANDOM-VJ transition channel on udp/${vjListener.port} (LAN-local) — ` +
        `shuffle-bag over ${plan.length} findings`,
    );
  }

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
    void vjListener?.close();
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
