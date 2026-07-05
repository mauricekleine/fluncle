import { describe, expect, test } from "bun:test";

import { type FeatureManifest, type HelmApp, type HelmContext } from "../features/types";
import { createRouter, type RouteHandler } from "./router";
import { machineGatedApp } from "./features";
import { createRunRegistry } from "./runs";

function appOn(machine: HelmContext["machine"]): {
  app: HelmApp;
  router: ReturnType<typeof createRouter>;
} {
  const router = createRouter();
  const context: HelmContext = {
    admin: {
      del: () => Promise.reject(new Error("unused")),
      get: () => Promise.reject(new Error("unused")),
      patch: () => Promise.reject(new Error("unused")),
      post: () => Promise.reject(new Error("unused")),
      postForm: () => Promise.reject(new Error("unused")),
      put: () => Promise.reject(new Error("unused")),
    },
    machine,
    machineBrand: "",
    notify: async () => {},
    runs: createRunRegistry(),
    startedAt: Date.now(),
  };
  const app: HelmApp = {
    context,
    get(pattern, handler) {
      router.add("GET", pattern, handler);
    },
    post(pattern, handler) {
      router.add("POST", pattern, handler);
    },
  };

  return { app, router };
}

const m2Manifest: FeatureManifest = { id: "cues", machines: ["m2"], order: 1, title: "Cues" };

async function invoke(router: ReturnType<typeof createRouter>, method: string, path: string) {
  const match = router.match(method, path);

  if (!match) {
    throw new Error(`no route for ${method} ${path}`);
  }

  const handler: RouteHandler = match.handler;

  return handler(new Request(`http://127.0.0.1:4190${path}`, { method }), match.params);
}

describe("machineGatedApp (wrong-machine action POSTs 403 server-side)", () => {
  test("a wrong-machine POST answers 403; reads stay open", async () => {
    const { app, router } = appOn("m5");
    const gated = machineGatedApp(app, m2Manifest);

    gated.get("/api/cues/list", () => Response.json({ ok: true }));
    gated.post("/api/cues/derive", () => Response.json({ started: true }));

    const read = await invoke(router, "GET", "/api/cues/list");

    expect(read.status).toBe(200);

    const action = await invoke(router, "POST", "/api/cues/derive");

    expect(action.status).toBe(403);

    const body = (await action.json()) as { code: string };

    expect(body.code).toBe("wrong_machine");
  });

  test("the right machine and an unknown machine act freely", async () => {
    for (const machine of ["m2", "unknown"] as const) {
      const { app, router } = appOn(machine);
      const gated = machineGatedApp(app, m2Manifest);

      gated.post("/api/cues/derive", () => Response.json({ started: true }));

      const action = await invoke(router, "POST", "/api/cues/derive");

      expect(action.status).toBe(200);
    }
  });
});
