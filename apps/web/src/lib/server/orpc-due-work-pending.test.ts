// BACKPRESSURE IS NOT A FAULT — the whole-router guarantee.
//
// `DueWorkMaintenancePendingError` means a bounded maintenance pass converged as far as its budget
// allowed and the read it fronted is deferred. That is a typed "come back", so every op answers a
// 503 `due_work_maintenance_pending` and NOTHING is captured into Sentry: a write burst must never
// page as an error, and a deferred read must never look like a 500 to the box sweeps that poll it.
//
// The guarantee is made in ONE place — the router-level middleware in `./orpc` — so it holds for a
// handler with no catch, for a middleware, and for input validation, not only for the handlers that
// happen to route their catch through `apiFault`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DueWorkMaintenancePendingError } from "./due-work";
import { apiFault, toFault } from "./orpc/_shared";
import { apiUrl, readJson, setAdminTokenEnv, warmOrpcRouter } from "./orpc-test-kit";

const captureException = vi.fn();

vi.mock("@sentry/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/cloudflare")>()),
  captureException: (...args: unknown[]) => captureException(...args),
}));

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    listTracks: (...args: Parameters<typeof actual.listTracks>) =>
      pendingFromListTracks
        ? Promise.reject(new DueWorkMaintenancePendingError("finding.render"))
        : actual.listTracks(...args),
  };
});

let pendingFromListTracks = false;

beforeAll(() => {
  setAdminTokenEnv();
});
warmOrpcRouter();

afterEach(() => {
  pendingFromListTracks = false;
  captureException.mockClear();
});

describe("due-work maintenance pending is a typed 503, never a fault", () => {
  it("answers 503 at the apiFault chokepoint without a Sentry capture", () => {
    for (const convert of [apiFault, toFault]) {
      const fault = convert(new DueWorkMaintenancePendingError("catalogue-rank"));

      expect(fault.status).toBe(503);
      expect(fault.data).toMatchObject({ apiCode: "due_work_maintenance_pending" });
    }

    expect(captureException).not.toHaveBeenCalled();
  });

  it("answers 503 on the op path the production read regressed on", async () => {
    const { handleOrpc } = await import("./orpc");
    pendingFromListTracks = true;

    // `list_findings` → `listTracks` → `listProjectedTracks` → `readPromotedDueWorkPage`: the
    // deferred-read stack, answered as a pause rather than a 500.
    const response = await handleOrpc(new Request(apiUrl("/findings?limit=1")));

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: "due_work_maintenance_pending",
      ok: false,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("converts the throw at the router level, so an op with no catch cannot 500", async () => {
    const { dueWorkMaintenancePendingMiddleware } = await import("./orpc-backpressure");
    const middleware = dueWorkMaintenancePendingMiddleware as unknown as (options: {
      next: () => Promise<unknown>;
    }) => Promise<unknown>;

    await expect(
      middleware({
        next: () => Promise.reject(new DueWorkMaintenancePendingError("finding.render")),
      }),
    ).rejects.toMatchObject({ status: 503 });

    // A real fault still flies untouched — the middleware narrows to the typed answer only.
    const boom = new Error("boom");
    await expect(middleware({ next: () => Promise.reject(boom) })).rejects.toBe(boom);
  });

  it("keeps the router composed through that middleware", async () => {
    const source = await readFile(fileURLToPath(new URL("./orpc.ts", import.meta.url)), "utf8");

    // The guarantee is whole-router or it is nothing: a router assembled without this middleware
    // leaves every catch-less op free to surface a deferred read as a 500.
    expect(source).toContain("os.use(dueWorkMaintenancePendingMiddleware).router({");
  });
});
