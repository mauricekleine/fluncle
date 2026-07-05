// THE HELM DAEMON (`bun run --cwd apps/helm start`, :4190). Fluncle's Helm — the
// operator's mission control, one per machine. A LAN-local Bun process that:
//   * serves the built glass (the React SPA in dist/) statically,
//   * answers the /api core: /api/machine (which Mac), /api/health, /api/features
//     (the machine-gated station manifests), /api/runs (the drawer's list),
//   * hosts the action-streaming core — runStreamed children with per-run SSE
//     stream + kill routes, stood down (escalating, awaited) when the daemon exits,
//   * holds the admin bridge (apps/cli's credentials, in-process, server-side —
//     the token never reaches the UI) and notify() via osascript.
//
// Binds 127.0.0.1 by default; FLUNCLE_HELM_LAN=1 opens it to the LAN/tailnet
// (the packages/live LAN-local precedent — the phone companion path). LAN mode is
// AUTHENTICATED: loopback requests (verified by remote address) pass free, any
// other peer must present the helm key (auth.ts) — and every request's Host (and
// Origin, when a browser sends one) must sit on the daemon's own allowlist, which
// kills DNS-rebinding and cross-origin POSTs.
// FLUNCLE_HELM_PORT overrides 4190. Ports 4173/4180 are the live glass + bridge:
// the helm SPAWNS the show, it never serves those.
//
// Voice: a recovered terminal (VOICE.md, CLI register) — deadpan machine states.

import { resolve } from "node:path";

import {
  HELM_DEV_PORT,
  HELM_PORT,
  type HealthResponse,
  type MachineResponse,
  type RunsResponse,
} from "./contract";
import { visibleFeatures } from "./features/gating";
import { type HelmApp, type HelmContext } from "./features/types";
import { adminChildEnv, adminTokenAboard, createAdminClient } from "./server/admin";
import {
  authorizeRequest,
  buildHostAllowlist,
  hostAllowed,
  isLoopbackAddress,
  lanAddresses,
  loadHelmKey,
  originAllowed,
  presentedKey,
} from "./server/auth";
import { json, registerFeatures, registerRunRoutes } from "./server/features";
import { markRequestLocal } from "./server/locality";
import { detectMachine } from "./server/machine";
import { notify } from "./server/notify";
import { createRouter } from "./server/router";
import { createRunRegistry } from "./server/runs";
import { createStaticHandler } from "./server/static";

const HELM_ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = resolve(HELM_ROOT, "dist");

function resolvePort(): number {
  const raw = process.env.FLUNCLE_HELM_PORT;

  if (raw === undefined) {
    return HELM_PORT;
  }

  const port = Number.parseInt(raw, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`FLUNCLE_HELM_PORT wants a port number, got ${raw}`);
  }

  return port;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const port = resolvePort();
  const lanMode = process.env.FLUNCLE_HELM_LAN === "1";
  const hostname = lanMode ? "0.0.0.0" : "127.0.0.1";
  const { brand, machine } = await detectMachine();

  // The helm key: loopback never needs it; a LAN peer always presents it.
  const helmKey = loadHelmKey();
  const lanIps = lanMode ? lanAddresses() : [];
  const allowedHosts = buildHostAllowlist({ devPort: HELM_DEV_PORT, lanIps, port });

  const runs = createRunRegistry({ adminEnv: adminChildEnv });
  const context: HelmContext = {
    admin: createAdminClient(),
    machine,
    machineBrand: brand,
    notify,
    runs,
    startedAt,
  };

  const router = createRouter();
  const app: HelmApp = {
    context,
    get(pattern, handler) {
      router.add("GET", pattern, handler);
    },
    post(pattern, handler) {
      router.add("POST", pattern, handler);
    },
  };

  // The /api core.
  app.get("/api/machine", () => {
    const body: MachineResponse = { brand, machine };

    return json(body);
  });

  app.get("/api/health", () => {
    const body: HealthResponse = {
      adminTokenAboard: adminTokenAboard(),
      machine,
      ok: true,
      pid: process.pid,
      port,
      startedAt,
      uptimeMs: Date.now() - startedAt,
    };

    return json(body);
  });

  app.get("/api/runs", () => {
    const body: RunsResponse = { runs: runs.list() };

    return json(body);
  });

  // Features: manifests + their own routes, then the shared per-run routes.
  const manifests = await registerFeatures(app);

  app.get("/api/features", () => json({ features: visibleFeatures(manifests, machine) }));

  registerRunRoutes(router, app);

  const serveStatic = createStaticHandler(DIST_DIR);

  const server = Bun.serve({
    async fetch(req, srv) {
      const url = new URL(req.url);

      // The gate, on EVERY request — static and /api alike. Host first (kills
      // DNS-rebinding), then Origin when a browser sent one (kills cross-origin
      // POSTs), then the key for any peer that is not the loopback itself.
      if (!hostAllowed(req.headers.get("host"), allowedHosts)) {
        return json({ code: "wrong_host", message: "That Host is not this helm." }, 403);
      }

      if (!originAllowed(req.headers.get("origin"), allowedHosts)) {
        return json({ code: "wrong_origin", message: "That origin has no seat here." }, 403);
      }

      const remote = srv.requestIP(req);
      const isLocal = remote !== null && isLoopbackAddress(remote.address);

      if (
        !authorizeRequest({
          isLocal,
          key: helmKey.key,
          presented: presentedKey(req.headers.get("authorization"), url),
        })
      ) {
        return json(
          { code: "unauthorized", message: "The helm wants its key — Bearer, or ?key=." },
          401,
        );
      }

      if (isLocal) {
        markRequestLocal(req);
      }

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const match = router.match(req.method, url.pathname);

        if (!match) {
          return json(
            {
              code: "not_found",
              message: "Nothing wired at this path. The helm answers under /api.",
            },
            404,
          );
        }

        return match.handler(req, match.params);
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return json({ code: "method_not_allowed", message: "The glass takes GET." }, 405);
      }

      return serveStatic(url.pathname);
    },
    hostname,
    idleTimeout: 0,
    port,
  });

  // Daemon exit: SIGINT the run groups, await the bounded escalation (SIGKILL
  // the stragglers), only then stop the server and go.
  let standingDown = false;
  const standDown = (): void => {
    if (standingDown) {
      return;
    }

    standingDown = true;
    void (async () => {
      await runs.standDown();
      void server.stop(true);
      process.exit(0);
    })();
  };
  process.on("SIGINT", standDown);
  process.on("SIGTERM", standDown);

  const stations = visibleFeatures(manifests, machine).length;
  console.error(
    `helm: holding on ${hostname}:${port} — machine ${machine}` +
      `${brand ? ` (${brand})` : ""} · ${stations} station${stations === 1 ? "" : "s"} wired`,
  );

  if (lanMode) {
    // The phone path: LAN peers must present the key, so hand the operator the
    // ready-to-open URL (the key stays out of logs when LAN mode is off).
    const ip = lanIps[0];
    console.error(
      ip
        ? `helm: LAN mode — phone url http://${ip}:${port}/?key=${helmKey.key}`
        : `helm: LAN mode — no LAN address found; key (${helmKey.source}) required off-loopback`,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("helm: fatal —", error);
    process.exit(1);
  });
}
