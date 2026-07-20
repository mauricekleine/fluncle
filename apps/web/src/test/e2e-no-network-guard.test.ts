import { type Plugin } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Proof that the SERVER half of the e2e no-network rail is wired — the half
// `tests/e2e/browser.ts` cannot cover.
//
// `blockExternalRequests` stubs what the BROWSER asks for. Behind those requests the e2e
// dev server reaches the real internet on its own: rendering `/podcast.xml` HEADs the
// production R2 CDN once per seeded mixtape, `/api/preview/:id` falls through to
// `itunes.apple.com`, and the search dialog's LLM tier POSTs to `openrouter.ai` with the
// template's fake key (fake is truthy, so the "unprovisioned" guard never trips). Fake
// credentials make those calls FAIL; they do not make them not happen.
//
// The guard is a `apply: "serve"` Vite plugin, added only when the e2e stack sets
// FLUNCLE_E2E_BLOCK_OUTBOUND=1, that prepends a rail-installing module to the Worker
// entry. This file pins all three properties: absent by default, present under the flag,
// and prepending to the right module in the right environment. If it goes red, the e2e
// dev server can talk to production again.

const WORKER_ENTRY = "/repo/apps/web/src/server.ts";

async function loadPlugins(): Promise<(Plugin | null)[]> {
  vi.resetModules();

  const config = (await import("../../vite.config")).default;

  if (typeof config === "function" || !("plugins" in config)) {
    throw new Error("vite.config default export is not a plain config object");
  }

  return (config.plugins ?? []) as (Plugin | null)[];
}

async function findGuard(): Promise<Plugin | undefined> {
  const plugins = await loadPlugins();

  return plugins.find(
    (plugin): plugin is Plugin =>
      plugin !== null && typeof plugin === "object" && plugin.name === "fluncle-e2e-no-network",
  );
}

/** Call a plugin hook with the `this.environment.name` the guard branches on. */
function callTransform(plugin: Plugin, environment: string, code: string, id: string): unknown {
  const { transform } = plugin;

  if (typeof transform !== "function") {
    throw new Error("the guard has no transform hook");
  }

  return transform.call({ environment: { name: environment } } as never, code, id, undefined);
}

describe("the e2e server-side no-network guard", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("is absent when the flag is unset, so an ordinary dev server is untouched", async () => {
    vi.stubEnv("FLUNCLE_E2E_BLOCK_OUTBOUND", undefined);

    expect(await findGuard()).toBeUndefined();
  });

  it("is present when the e2e stack sets the flag", async () => {
    vi.stubEnv("FLUNCLE_E2E_BLOCK_OUTBOUND", "1");

    const guard = await findGuard();

    expect(guard).toBeDefined();
    // `serve` is the second, independent gate: a production build never even sees it.
    expect(guard?.apply).toBe("serve");
  });

  it("prepends the rail to the Worker entry in the ssr environment", async () => {
    vi.stubEnv("FLUNCLE_E2E_BLOCK_OUTBOUND", "1");

    const guard = await findGuard();

    if (!guard) {
      throw new Error("the guard is not registered under the flag");
    }

    const result = callTransform(guard, "ssr", "export default {};", WORKER_ENTRY);

    expect(result).toMatchObject({
      code: expect.stringContaining("virtual:fluncle-e2e-no-network") as unknown as string,
    });
  });

  it("leaves the client environment and every other module alone", async () => {
    vi.stubEnv("FLUNCLE_E2E_BLOCK_OUTBOUND", "1");

    const guard = await findGuard();

    if (!guard) {
      throw new Error("the guard is not registered under the flag");
    }

    expect(callTransform(guard, "client", "export default {};", WORKER_ENTRY)).toBeUndefined();
    expect(
      callTransform(guard, "ssr", "export default {};", "/repo/apps/web/src/router.tsx"),
    ).toBeUndefined();
  });

  it("serves a virtual module that installs the shared rail", async () => {
    vi.stubEnv("FLUNCLE_E2E_BLOCK_OUTBOUND", "1");

    const guard = await findGuard();
    const { load } = guard ?? {};

    if (typeof load !== "function") {
      throw new Error("the guard has no load hook");
    }

    const source: unknown = load.call({} as never, "\0virtual:fluncle-e2e-no-network");

    if (typeof source !== "string") {
      throw new Error("the virtual module did not resolve to source text");
    }

    expect(source).toContain("@fluncle/test-support/no-network");
    expect(source).toContain("installNoNetworkRail()");
  });
});
