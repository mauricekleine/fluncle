import { expect, it, vi } from "vitest";

const execute = vi.hoisted(() =>
  vi.fn<() => Promise<{ rows: unknown[] }>>(async () => {
    throw new Error("database unavailable");
  }),
);
const getDb = vi.hoisted(() => vi.fn(async () => ({ execute })));

vi.mock("@/lib/server/db", async (original) => ({
  ...(await original<typeof import("@/lib/server/db")>()),
  getDb,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      handler: (handler: (context: unknown) => unknown) => (context: unknown) => handler(context),
      validator: () => builder,
    };
    return builder;
  },
}));

const { Route } = await import("./__root");
const { isGalaxyMapFullyNamed } = await import("@/lib/server/galaxies-map");

async function loadRoot() {
  const loader = Route.options.loader;
  if (typeof loader !== "function") {
    throw new Error("root loader is missing");
  }
  return loader({} as never);
}

it("loads the shared layout without SQL, using the last-known galaxy availability or showing the link on uncertainty", async () => {
  expect(await loadRoot()).toEqual({ galaxiesLive: true });
  expect(getDb).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();

  for (const [total, unnamed, expected] of [
    [0, 0, false],
    [2, 1, false],
    [2, 0, true],
  ] as const) {
    execute.mockResolvedValue({ rows: [{ total, unnamed }] });
    expect(await isGalaxyMapFullyNamed()).toBe(expected);
    getDb.mockClear();
    execute.mockClear();
    execute.mockImplementation(() => new Promise(() => undefined));
    expect(await loadRoot()).toEqual({ galaxiesLive: expected });
    expect(getDb).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }
});
