import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { contract } from "@fluncle/contracts/orpc";
import { call, implement, ORPCError } from "@orpc/server";
import { DueWorkMaintenancePendingError } from "./due-work";
import { type OrpcContext } from "./orpc-context";
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

    for (const query of ["", "debtAware=true"]) {
      const response = await read(query);

      expect(response?.status).toBe(503);
      expect(await readJson(response)).toMatchObject({
        code: "due_work_maintenance_pending",
        ok: false,
      });
    }
  });

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

    const response = await handleOrpc(new Request(apiUrl("/findings?limit=1")));

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      code: "due_work_maintenance_pending",
      ok: false,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

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
