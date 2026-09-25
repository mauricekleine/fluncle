import {
  BRIDGE_PORT,
  BRIDGE_REMOTE_PATH,
  BRIDGE_WS_PATH,
  type PlanEntry,
  type ShowCommand,
} from "../contract";
import { fingerprintPlan, fingerprintPlanFullSong } from "./fingerprint";
import { type Finding, resolveDeck } from "./identity";
import { type Fingerprint } from "./matcher";
import { type AdminAuth, buildPlan, isAllPlan, loadAdminAuth } from "./plan";
import { REMOTE_HTML } from "./remote";
import { createShowState } from "./state";
import { startSupervisor } from "./supervisor";
import {
  createShuffleBag,
  mulberry32,
  resolveVjTransitionPort,
  type ShuffleBag,
  startVjTransitionListener,
  type VjTransition,
} from "./vj";

const BROADCAST_HZ = 30;

type Boot = { plan: PlanEntry[]; fingerprints: Fingerprint[] };

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
      continue;
    }
    if (!arg.startsWith("--")) {
      return arg;
    }
  }
  return env;
}

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

export type VjSelection =
  | { index: number; via: "match"; logId: string; score: number; reason: string }
  | { index: number; via: "fallback"; reason: string };

export function selectVjIndex(
  transition: VjTransition,
  plan: readonly Finding[],
  bag: ShuffleBag,
): VjSelection {
  const identity = transition.identity;
  if (!identity) {
    return { index: bag.next(), reason: "no identity in datagram", via: "fallback" };
  }
  const match = resolveDeck(identity, plan as Finding[]);
  if (!match) {
    return {
      index: bag.next(),
      reason: `no archive match for "${identity.title}" / "${identity.artist}"`,
      via: "fallback",
    };
  }
  bag.take(match.index);
  return {
    index: match.index,
    logId: plan[match.index]?.logId ?? "?",
    reason: match.reason,
    score: match.score,
    via: "match",
  };
}

export function parseCommand(raw: unknown): ShowCommand | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const msg = raw as {
    cmd?: unknown;
    frame?: unknown;
    index?: unknown;
    on?: unknown;
    renderFrame?: unknown;
    t?: unknown;
    value?: unknown;
  };
  switch (msg.cmd) {
    case "advance":
      return { cmd: "advance" };
    case "rewind":
      return { cmd: "rewind" };
    case "goto":
      return typeof msg.index === "number" && Number.isFinite(msg.index)
        ? { cmd: "goto", index: msg.index }
        : null;
    case "blackout":
      return typeof msg.on === "boolean" ? { cmd: "blackout", on: msg.on } : null;
    case "intensity":
      return typeof msg.value === "number" && Number.isFinite(msg.value)
        ? { cmd: "intensity", value: msg.value }
        : null;
    case "heartbeat":
      return typeof msg.renderFrame === "number" && Number.isFinite(msg.renderFrame)
        ? { cmd: "heartbeat", renderFrame: msg.renderFrame }
        : null;
    case "mel":
      return typeof msg.t === "number" && Number.isFinite(msg.t) && Array.isArray(msg.frame)
        ? { cmd: "mel", frame: msg.frame as number[], t: msg.t }
        : null;
    default:
      return null;
  }
}

async function boot(planRef?: string): Promise<Boot> {
  const plan = await buildPlan(planRef);

  if (isAllPlan(planRef)) {
    console.error(
      `bridge: RANDOM-VJ pool — ${plan.length} findings, no fingerprinting (director shuffles)`,
    );
    return { fingerprints: plan.map((p) => ({ frames: null, logId: p.logId })), plan };
  }
  const logIds = plan.map((p) => p.logId);
  const suffix = planRef ? ` (${planRef})` : "";

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

  let vjListener: Awaited<ReturnType<typeof startVjTransitionListener>> | null = null;
  if (isAllPlan(planRef)) {
    const bag = createShuffleBag(plan.length, mulberry32(Date.now()));
    vjListener = await startVjTransitionListener({
      onError: (err) => console.error("bridge: VJ transition socket —", err),
      onTransition: (msg) => {
        const sel = selectVjIndex(msg, plan, bag);
        if (sel.via === "match") {
          console.error(
            `bridge: VJ deck ${msg.deck} → MATCH ${sel.logId} (idx ${sel.index}, ` +
              `score ${sel.score.toFixed(2)}: ${sel.reason})`,
          );
        } else {
          console.error(
            `bridge: VJ deck ${msg.deck} → shuffle idx ${sel.index} (fallback: ${sel.reason})`,
          );
        }
        state.ingest({ cmd: "goto", index: sel.index }, Date.now());
      },
      port: resolveVjTransitionPort(),
    });
    console.error(
      `bridge: RANDOM-VJ transition channel on udp/${vjListener.port} (LAN-local) — ` +
        `shuffle-bag over ${plan.length} findings`,
    );
  }

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
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const cmd = parseCommand(parsed);
        if (cmd === null) {
          return;
        }
        try {
          state.ingest(cmd, Date.now());
        } catch (err) {
          console.error("bridge: WS ingest —", err);
        }
      },
      open(ws) {
        sockets.add(ws);
      },
    },
  });

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
