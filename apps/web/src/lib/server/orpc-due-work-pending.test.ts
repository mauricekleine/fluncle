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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { contract } from "@fluncle/contracts/orpc";
import { call, implement, ORPCError } from "@orpc/server";
import { DueWorkMaintenancePendingError } from "./due-work";
import { type OrpcContext } from "./orpc-auth";
import { apiFault, toFault, type ApiFaultData } from "./orpc/_shared";
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

  // THE BEHAVIOURAL PROOF. The `list_findings` case above would pass without the middleware, since
  // that handler catches and `apiFault` already maps the class. This one composes a handler with NO
  // catch through the SAME base the router is built on, so the middleware is the only thing that
  // can answer — if it were dropped, the raw error would escape and this fails.
  it("answers 503 for a catch-less op composed through the router's own base", async () => {
    const { dueWorkMaintenancePendingMiddleware } = await import("./orpc-backpressure");
    const base = implement(contract)
      .$context<OrpcContext>()
      .use(dueWorkMaintenancePendingMiddleware);

    const deferred = base.get_health.handler(() => {
      throw new DueWorkMaintenancePendingError("finding.render");
    });

    const fault = await call(deferred, {}, { context: {} as OrpcContext }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(fault).toBeInstanceOf(ORPCError);
    expect((fault as ORPCError<string, unknown>).status).toBe(503);
    expect((fault as ORPCError<string, ApiFaultData>).data).toMatchObject({
      apiCode: "due_work_maintenance_pending",
    });
    expect(captureException).not.toHaveBeenCalled();

    // A real fault is not the middleware's business: it passes through as itself, so the rails
    // still log it and capture it as the 500 it is.
    const boom = new Error("boom");
    await expect(
      call(
        base.get_health.handler(() => {
          throw boom;
        }),
        {},
        { context: {} as OrpcContext },
      ),
    ).rejects.toBe(boom);
  });

  it("carries that middleware on every op of the real router", async () => {
    const { dueWorkMaintenancePendingMiddleware } = await import("./orpc-backpressure");
    const { router } = await import("./orpc");

    // The guarantee is whole-router or it is nothing: one op assembled without this middleware is
    // one op free to surface a deferred read as a 500. Checked by reference over every op, so a
    // domain spread onto a different base — not just a dropped `.use` — fails here.
    const missing = Object.entries(router as Record<string, unknown>)
      .filter(([, op]) => {
        const middlewares = ((op as { "~orpc"?: { middlewares?: unknown[] } })["~orpc"]
          ?.middlewares ?? []) as unknown[];

        return !middlewares.includes(dueWorkMaintenancePendingMiddleware);
      })
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });
});
