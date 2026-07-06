import { describe, expect, test } from "bun:test";

import { type RunSummary } from "../../contract";
import { type RouteHandler } from "../../server/router";
import { type Run, type RunRegistry } from "../../server/runs";
import { type HelmApp, type HelmContext } from "../types";
import { registerRoutes } from "./server";
import { SHOW_FEATURE_ID } from "./wire";

/**
 * A registry double that mirrors the real one's load-bearing property: a run is
 * listed as `running` SYNCHRONOUSLY, the moment runStreamed returns. Nothing is
 * spawned. (standDown is async-shaped to match the hardened shell's contract.)
 */
function fakeRegistry(): { registry: RunRegistry; started: string[] } {
  const started: string[] = [];
  const summaries: RunSummary[] = [];

  const registry: RunRegistry = {
    get: (): Run | undefined => undefined,
    kill: () => false,
    list: () => [...summaries].reverse(),
    runStreamed(argv, opts) {
      const runId = crypto.randomUUID();

      started.push(runId);
      summaries.push({
        argv,
        endedAt: null,
        exitCode: null,
        feature: opts.feature,
        id: runId,
        startedAt: Date.now(),
        status: "running",
        title: opts.title,
      });

      return { runId };
    },
    standDown: async () => {},
    subscribe: () => () => {},
  };

  return { registry, started };
}

function appOver(registry: RunRegistry): { app: HelmApp; handlers: Map<string, RouteHandler> } {
  const handlers = new Map<string, RouteHandler>();
  const context: HelmContext = {
    admin: {
      del: () => Promise.reject(new Error("unused")),
      get: () => Promise.reject(new Error("unused")),
      patch: () => Promise.reject(new Error("unused")),
      post: () => Promise.reject(new Error("unused")),
      postForm: () => Promise.reject(new Error("unused")),
      put: () => Promise.reject(new Error("unused")),
    },
    machine: "m5",
    machineBrand: "",
    notify: async () => {},
    runs: registry,
    startedAt: Date.now(),
  };
  const app: HelmApp = {
    context,
    get(pattern, handler) {
      handlers.set(`GET ${pattern}`, handler);
    },
    post(pattern, handler) {
      handlers.set(`POST ${pattern}`, handler);
    },
  };

  return { app, handlers };
}

function raiseRequest(ref: string): Request {
  return new Request("http://127.0.0.1:4190/api/show-control/raise", {
    body: JSON.stringify({ ref }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("the raise race (M5)", () => {
  test("two simultaneous raises spawn exactly one show", async () => {
    const { registry, started } = fakeRegistry();
    const { app, handlers } = appOver(registry);

    registerRoutes(app);

    const raise = handlers.get("POST /api/show-control/raise");

    if (!raise) {
      throw new Error("raise route not registered");
    }

    // Fire both BEFORE awaiting either — the handlers interleave at their body
    // read, which is exactly the window the old code left open.
    const [first, second] = await Promise.all([
      raise(raiseRequest("plan-one"), {}),
      raise(raiseRequest("plan-two"), {}),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);

    expect(statuses).toEqual([200, 409]);
    expect(started).toHaveLength(1);

    const refused = first.status === 409 ? first : second;
    const body = (await refused.json()) as { code: string };

    expect(body.code).toBe("already_running");
  });

  test("a raise after the winner still answers 409 while the show runs", async () => {
    const { registry, started } = fakeRegistry();
    const { app, handlers } = appOver(registry);

    registerRoutes(app);

    const raise = handlers.get("POST /api/show-control/raise");

    if (!raise) {
      throw new Error("raise route not registered");
    }

    const winner = await raise(raiseRequest("plan-one"), {});

    expect(winner.status).toBe(200);

    const late = await raise(raiseRequest("plan-two"), {});

    expect(late.status).toBe(409);
    expect(started).toHaveLength(1);

    const body = (await late.json()) as { runId?: string };

    expect(body.runId).toBe(started[0]);
  });

  test("a bodyless raise still 400s before any spawn", async () => {
    const { registry, started } = fakeRegistry();
    const { app, handlers } = appOver(registry);

    registerRoutes(app);

    const raise = handlers.get("POST /api/show-control/raise");

    if (!raise) {
      throw new Error("raise route not registered");
    }

    const response = await raise(
      new Request("http://127.0.0.1:4190/api/show-control/raise", { method: "POST" }),
      {},
    );

    expect(response.status).toBe(400);
    expect(started).toHaveLength(0);
  });
});

describe("the show feature id", () => {
  test("the raise runs under the show-control scope", async () => {
    const { registry } = fakeRegistry();
    const { app, handlers } = appOver(registry);

    registerRoutes(app);

    const raise = handlers.get("POST /api/show-control/raise");

    if (!raise) {
      throw new Error("raise route not registered");
    }

    await raise(raiseRequest("plan-one"), {});

    expect(registry.list()[0]?.feature).toBe(SHOW_FEATURE_ID);
  });
});
