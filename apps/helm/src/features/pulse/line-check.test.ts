import { describe, expect, test } from "bun:test";

import { markRequestLocal, requestIsLocal } from "../../server/locality";
import { type RouteHandler } from "../../server/router";
import { createRunRegistry } from "../../server/runs";
import { type HelmApp, type HelmContext } from "../types";
import { lineCheckArgv, registerRoutes } from "./server";

describe("the line check argv (L9)", () => {
  test("a pure argv — the runtime evaluates a fixed source, no shell parses a string", () => {
    const argv = lineCheckArgv("/opt/homebrew/bin/bun");

    expect(argv[0]).toBe("/opt/homebrew/bin/bun");
    expect(argv[1]).toBe("-e");
    expect(argv).toHaveLength(3);
    expect(argv).not.toContain("/bin/sh");
    expect(argv).not.toContain("-c");
  });

  test("the check round-trips through the run registry with its narration", async () => {
    const registry = createRunRegistry();
    const { runId } = registry.runStreamed(lineCheckArgv(process.execPath), {
      feature: "pulse",
      title: "line check",
    });

    const finished = await new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("line check never finished")), 8000);

      registry.subscribe("pulse", runId, (event) => {
        if (event.kind === "status" && event.run.status !== "running") {
          clearTimeout(timer);
          resolvePromise(event.run.status);
        }
      });
    });

    expect(finished).toBe("ok");

    const texts = registry.get("pulse", runId)?.lines.map((line) => line.text) ?? [];

    expect(texts).toContain("line check — the helm sounds its own wiring");
    expect(texts).toContain("  [clear] line check             the wiring holds");
  });
});

describe("the forced clock is loopback-scoped (L10)", () => {
  test("locality is a daemon-side mark, never a header", () => {
    const marked = new Request("http://127.0.0.1:4190/api/pulse/nudge/check", { method: "POST" });
    const unmarked = new Request("http://127.0.0.1:4190/api/pulse/nudge/check", {
      headers: { "x-helm-local": "1" },
      method: "POST",
    });

    markRequestLocal(marked);

    expect(requestIsLocal(marked)).toBe(true);
    expect(requestIsLocal(unmarked)).toBe(false);
  });

  test("a forced check from off-loopback answers 403; the loopback proof path holds", async () => {
    const handlers = new Map<string, RouteHandler>();
    const context: HelmContext = {
      admin: {
        del: () => Promise.reject(new Error("unused")),
        get: <T>() => Promise.resolve({ tracks: [] } as T),
        patch: () => Promise.reject(new Error("unused")),
        post: () => Promise.reject(new Error("unused")),
        postForm: () => Promise.reject(new Error("unused")),
        put: () => Promise.reject(new Error("unused")),
      },
      machine: "m5",
      machineBrand: "",
      notify: async () => {},
      runs: createRunRegistry(),
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

    registerRoutes(app);

    const check = handlers.get("POST /api/pulse/nudge/check");

    if (!check) {
      throw new Error("nudge check route not registered");
    }

    const forced = (): Request =>
      new Request("http://127.0.0.1:4190/api/pulse/nudge/check", {
        body: JSON.stringify({ fire: false, force: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    const remote = await check(forced(), {});

    expect(remote.status).toBe(403);

    const body = (await remote.json()) as { code: string };

    expect(body.code).toBe("local_only");

    const local = forced();

    markRequestLocal(local);

    const answered = await check(local, {});

    expect(answered.status).toBe(200);
  });
});
