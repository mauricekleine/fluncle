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
import {
  apiUrl,
  OPERATOR_TOKEN,
  readJson,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

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

vi.mock("./track-work", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./track-work")>();

  return {
    ...actual,
    countTrackWork: (...args: Parameters<typeof actual.countTrackWork>) =>
      trackWorkPage === "real" ? actual.countTrackWork(...args) : Promise.resolve(4_812),
    listTrackWork: (...args: Parameters<typeof actual.listTrackWork>) =>
      trackWorkPage === "pending"
        ? Promise.reject(new DueWorkMaintenancePendingError("embed-catalogue"))
        : trackWorkPage === "served"
          ? Promise.resolve([])
          : actual.listTrackWork(...args),
  };
});

let pendingFromListTracks = false;
let trackWorkPage: "pending" | "real" | "served" = "real";

beforeAll(() => {
  setAdminTokenEnv();
});
warmOrpcRouter();

afterEach(() => {
  pendingFromListTracks = false;
  trackWorkPage = "real";
  captureException.mockClear();
});

// A COUNT IS A GAUGE, NOT A WORK HANDOUT. The deferral protects a metered ORDER, so it withholds
// the page — but refusing the SIZE of the backlog blinds the operator and the gauge-publishing
// sweeps exactly when debt is the thing they need to see.
describe("the worklist count answers under debt while the page stays withheld", () => {
  const read = (query: string) =>
    import("./orpc").then(({ handleOrpc }) =>
      handleOrpc(
        new Request(apiUrl(`/admin/tracks/work?kind=embed&limit=5&${query}`), {
          headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
        }),
      ),
    );

  it("answers the backlog, an empty page, and debtPending to a caller that opted in", async () => {
    trackWorkPage = "pending";

    const response = await read("count=true&debtAware=true");

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      debtPending: true,
      ok: true,
      queued: 4_812,
      tracks: [],
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  // THE OLD-SWEEP WINDOW. The box CLI is a pinned release; a sweep baked before this flag existed
  // does not send it, and several of them size PAID capture and GPU rental off this read. Handed a
  // 200 with an empty page it would report "no work" against a real backlog until its next rebake.
  // It must keep getting the refusal it already pauses on, which is what makes the Worker safe to
  // deploy ahead of the box.
  it("keeps the typed 503 for a counting caller that did NOT opt in", async () => {
    trackWorkPage = "pending";

    const response = await read("count=true");

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: "due_work_maintenance_pending",
      ok: false,
    });
  });

  it("treats any value other than the exact string as not opted in", async () => {
    trackWorkPage = "pending";

    for (const flag of ["1", "yes", "TRUE", ""]) {
      const response = await read(`count=true&debtAware=${flag}`);

      expect(response?.status).toBe(503);
    }
  });

  it("still refuses a page-only read, where the page IS the answer", async () => {
    trackWorkPage = "pending";

    // Even opted in: without `count` there is no gauge to answer, only a page that was withheld.
    for (const query of ["", "debtAware=true"]) {
      const response = await read(query);

      expect(response?.status).toBe(503);
      expect(await readJson(response)).toMatchObject({
        code: "due_work_maintenance_pending",
        ok: false,
      });
    }
  });

  // An opted-in read answers the flag either way, so its presence is also the caller's proof that
  // this Worker understood the flag. An OLD Worker omits the field entirely, which is how a NEW
  // caller tells "the page is genuinely complete" from "my flag was ignored".
  it("answers debtPending false, not absent, when an opted-in read was served", async () => {
    trackWorkPage = "served";

    expect(await readJson(await read("count=true&debtAware=true"))).toMatchObject({
      debtPending: false,
      ok: true,
    });
  });

  it("omits debtPending entirely for a caller that did not opt in", async () => {
    trackWorkPage = "served";

    const body = await readJson(await read("count=true"));

    expect(body).toMatchObject({ ok: true });
    expect((body as { debtPending?: unknown }).debtPending).toBeUndefined();
  });
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
