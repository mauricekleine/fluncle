// show-control server routes. Three actions:
//   GET  /api/show-control/choices — the pickable tracklists (plans + mixtapes),
//        read from the Fluncle admin API in-process (the token stays server-side).
//   GET  /api/show-control/active  — the show run to re-attach to on reload + the
//        live-glass links (the phone remote needs the daemon's LAN address).
//   POST /api/show-control/raise   — spawn `bun run --cwd packages/live show
//        --plan <ref>` from the repo root, streamed over the shared run routes.
// Standing a show down is the shared kill route (/api/show-control/runs/<id>/kill).

import { type MixtapesResponse, type RecordingsResponse } from "@fluncle/contracts";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";

import { type RunStartedResponse } from "../../contract";
import { json } from "../../server/features";
import { buildChoices } from "./choices";
import { type HelmApp } from "../types";
import {
  type ActiveResponse,
  type ChoicesResponse,
  type ShowLinks,
  SHOW_FEATURE_ID,
  findRunningShow,
  pickActiveShow,
} from "./wire";

// The live-glass surfaces the helm links to but NEVER serves (HELM-CONTRACT.md's
// ports registry; packages/live/src/contract.ts is their source of truth). Kept as
// local constants so this station stays decoupled from the live package's build.
const GLASS_PORT = 4173;
const BRIDGE_PORT = 4180;
const BRIDGE_REMOTE_PATH = "/remote";

/**
 * The repo root, found by walking up from this module until the packages/live show
 * entry is in reach — robust to wherever the daemon's cwd is (a worktree, a launchd
 * job, an installed checkout), where a fixed `../../../../..` would be brittle.
 */
function resolveRepoRoot(): string {
  let dir = import.meta.dir;

  for (;;) {
    if (existsSync(resolve(dir, "packages/live/src/show.ts"))) {
      return dir;
    }

    const parent = dirname(dir);

    if (parent === dir) {
      // Never found it (an unexpected layout) — fall back to the old fixed hop so a
      // raise still spawns something rather than silently doing nothing.
      return resolve(import.meta.dir, "../../../../..");
    }

    dir = parent;
  }
}

/** The daemon's first non-internal IPv4 — the address a phone on the LAN reaches the bridge at. */
function lanIp(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function showLinks(): ShowLinks {
  const ip = lanIp();

  return {
    glass: `http://localhost:${GLASS_PORT}`,
    remote: ip ? `http://${ip}:${BRIDGE_PORT}${BRIDGE_REMOTE_PATH}` : null,
  };
}

/**
 * The base command a raise spawns, before `--plan <ref>` (+ `--force`). The default is
 * the live show; `FLUNCLE_HELM_SHOW_CMD` (whitespace-split) overrides it so an operator
 * can dry-run the whole Helm show path against a rehearsal script without lighting the
 * real glass on 4173/4180 (the seam the show-control acceptance proof drives).
 */
function showBaseArgv(): string[] {
  const override = process.env.FLUNCLE_HELM_SHOW_CMD?.trim();

  if (override) {
    return override.split(/\s+/);
  }

  return ["bun", "run", "--cwd", "packages/live", "show"];
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function readRef(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const ref = (body as Record<string, unknown>).ref;

  return typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : undefined;
}

export function registerRoutes(app: HelmApp): void {
  const repoRoot = resolveRepoRoot();

  app.get("/api/show-control/choices", async () => {
    try {
      const [recordings, mixtapes] = await Promise.all([
        app.context.admin.get<RecordingsResponse>("/api/admin/recordings"),
        app.context.admin.get<MixtapesResponse>("/api/admin/mixtapes"),
      ]);

      const body: ChoicesResponse = {
        choices: buildChoices(recordings.recordings, mixtapes.mixtapes),
        ok: true,
        reachable: true,
      };

      return json(body);
    } catch {
      // No admin token aboard, or the API is unreachable — the picker shows the quiet
      // "no answer" state rather than the daemon 500-ing an operator's console.
      const body: ChoicesResponse = { choices: [], ok: true, reachable: false };

      return json(body);
    }
  });

  app.get("/api/show-control/active", () => {
    const run = pickActiveShow(app.context.runs.list());
    const body: ActiveResponse = { links: showLinks(), ok: true, run: run ?? null };

    return json(body);
  });

  app.post("/api/show-control/raise", async (req) => {
    const running = findRunningShow(app.context.runs.list());

    if (running) {
      return json(
        {
          code: "already_running",
          message: "A show already holds the glass. Stand it down before raising another.",
          runId: running.id,
        },
        409,
      );
    }

    const body = await readJsonBody(req);
    const ref = readRef(body);

    if (ref === undefined) {
      return json(
        { code: "invalid_request", message: "Pick a tracklist first — raise wants a plan ref." },
        400,
      );
    }

    const force =
      typeof body === "object" && body !== null && (body as Record<string, unknown>).force === true;
    const argv = [...showBaseArgv(), "--plan", ref];

    if (force) {
      argv.push("--force");
    }

    const { runId } = app.context.runs.runStreamed(argv, {
      cwd: repoRoot,
      feature: SHOW_FEATURE_ID,
      title: `raise the glass — ${ref}${force ? " (forced)" : ""}`,
    });
    const started: RunStartedResponse = { runId };

    return json(started);
  });
}
