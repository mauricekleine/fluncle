import { beforeEach, describe, expect, it, vi } from "vitest";
import { takeWaitUntilPromises } from "../../test/cloudflare-workers-stub";
import { get, readJson, warmOrpcRouter } from "./orpc-test-kit";

type Statement = { args?: unknown[]; sql: string };
type SearchOptions = { beforeModel?: () => Promise<void>; limit?: number; q: string };

const execute = vi.hoisted(() => vi.fn<(statement: Statement) => Promise<{ rows: unknown[] }>>());
const searchArchive = vi.hoisted(() => vi.fn<(options: SearchOptions) => Promise<unknown>>());

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => ({ execute }),
}));

vi.mock("./search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./search")>()),
  searchArchive,
}));

warmOrpcRouter();

const SONIC = {
  anchor: {
    artists: ["Nu:Tone"],
    certified: true,
    logId: "004.7.2I",
    title: "Better Places",
    trackId: "anchor",
  },
  degraded: false,
  entities: [],
  kind: "sonic",
  results: [{ artists: ["Someone"], certified: false, title: "A Neighbour", trackId: "t1" }],
};
const SONIC_URL =
  "https://www.fluncle.com/api/v1/search/archive?q=sounds%20like%20Better%20Places&limit=12";

type Verdict = "allowed" | "limited";

function isSearchCharge(statement: Statement): boolean {
  return (
    statement.sql.includes("insert into rate_limit_counters") &&
    statement.args?.[0] === "search_archive"
  );
}

function holdCharge(): { isSettled: () => boolean; release: (verdict: Verdict) => void } {
  let release: (verdict: Verdict) => void = () => undefined;
  const landed = new Promise<Verdict>((resolve) => {
    release = resolve;
  });
  let settled = false;

  execute.mockImplementation(async (statement) => {
    if (!isSearchCharge(statement)) {
      return { rows: [] };
    }

    const verdict = await landed;

    settled = true;

    return { rows: verdict === "allowed" ? [{ count: 1 }] : [] };
  });

  return { isSettled: () => settled, release: (verdict) => release(verdict) };
}

beforeEach(() => {
  execute.mockReset();
  searchArchive.mockReset();
  void takeWaitUntilPromises();
});

describe("oRPC public read — GET /search/archive (search_archive) and its limiter's bounded wait", () => {
  it("answers a sonic search while its charge is still stalled on the primary", async () => {
    const charge = holdCharge();

    searchArchive.mockResolvedValue(SONIC);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(SONIC_URL));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, ...SONIC });

    expect(charge.isSettled()).toBe(false);

    const settling = takeWaitUntilPromises();

    expect(settling.length).toBeGreaterThan(0);

    charge.release("allowed");
    await Promise.all(settling);

    expect(charge.isSettled()).toBe(true);

    expect(execute.mock.calls.filter(([statement]) => isSearchCharge(statement))).toHaveLength(1);
  });

  it("refuses before any search work when the verdict is prompt and over the limit", async () => {
    holdCharge().release("limited");

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(SONIC_URL));

    expect(response?.status).toBe(429);
    expect(await readJson(response)).toMatchObject({ code: "rate_limited", ok: false });
    expect(searchArchive).not.toHaveBeenCalled();
  });

  it("refuses the answer when a stalled verdict lands over the limit before the answer is ready", async () => {
    const charge = holdCharge();

    searchArchive.mockImplementation(async () => {
      charge.release("limited");
      await new Promise((resolve) => setTimeout(resolve, 0));

      return SONIC;
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(SONIC_URL));

    expect(response?.status).toBe(429);
    expect(await readJson(response)).toMatchObject({ code: "rate_limited", ok: false });
  });

  it("holds the model tier for a stalled verdict and refuses it when the verdict is over the limit", async () => {
    const charge = holdCharge();
    let modelRan = false;

    searchArchive.mockImplementation(async ({ beforeModel }) => {
      setTimeout(() => charge.release("limited"), 20);
      await beforeModel?.();
      modelRan = true;

      return SONIC;
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(SONIC_URL));

    expect(response?.status).toBe(429);
    expect(charge.isSettled()).toBe(true);
    expect(modelRan).toBe(false);
  });
});
