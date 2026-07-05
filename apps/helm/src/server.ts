// THE HELM DAEMON (`bun run --cwd apps/helm start`, :4190). Fluncle's Helm — the
// operator's mission control, one per machine. A LAN-local Bun process that:
//   * serves the built glass (the React SPA in dist/) statically,
//   * answers the /api core: /api/machine (which Mac), /api/health, /api/features
//     (the machine-gated station manifests), /api/runs (the drawer's list),
//   * hosts the action-streaming core — runStreamed children with per-run SSE
//     stream + kill routes, stood down when the daemon itself exits,
//   * holds the admin bridge (apps/cli's credentials, in-process, server-side —
//     the token never reaches the UI) and notify() via osascript.
//
// Binds 127.0.0.1 by default; FLUNCLE_HELM_LAN=1 opens it to the LAN/tailnet
// (the packages/live LAN-local precedent — the phone companion path).
// FLUNCLE_HELM_PORT overrides 4190. Ports 4173/4180 are the live glass + bridge:
// the helm SPAWNS the show, it never serves those.
//
// Voice: a recovered terminal (VOICE.md, CLI register) — deadpan machine states.

import { resolve } from "node:path";

import {
  HELM_PORT,
  type HealthResponse,
  type MachineResponse,
  type RunsResponse,
} from "./contract";
import { visibleFeatures } from "./features/gating";
import { type HelmApp, type HelmContext } from "./features/types";
import { adminTokenAboard, createAdminClient } from "./server/admin";
import { json, registerFeatures, registerRunRoutes } from "./server/features";
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
  const hostname = process.env.FLUNCLE_HELM_LAN === "1" ? "0.0.0.0" : "127.0.0.1";
  const { brand, machine } = await detectMachine();

  const runs = createRunRegistry();
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
    async fetch(req) {
      const url = new URL(req.url);

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

  const standDown = (): void => {
    runs.standDown();
    void server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", standDown);
  process.on("SIGTERM", standDown);

  const stations = visibleFeatures(manifests, machine).length;
  console.error(
    `helm: holding on ${hostname}:${port} — machine ${machine}` +
      `${brand ? ` (${brand})` : ""} · ${stations} station${stations === 1 ? "" : "s"} wired`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("helm: fatal —", error);
    process.exit(1);
  });
}
