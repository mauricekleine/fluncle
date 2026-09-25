import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "fluncle.admin.key-notation";

function mockStorage() {
  const store = new Map<string, string>();

  return {
    _store: store,
    getItem: (key: string): null | string => store.get(key) ?? null,
    removeItem: (key: string): void => void store.delete(key),
    setItem: (key: string, value: string): void => void store.set(key, value),
  };
}

let storage: ReturnType<typeof mockStorage>;

beforeEach(() => {
  vi.resetModules();
  storage = mockStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(routes: {
  me?: { user: unknown };
  preferencesGet?: unknown;
  onPatch?: (body: unknown) => void;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/me") {
      return new Response(JSON.stringify({ ok: true, user: routes.me?.user ?? null }));
    }

    if (url === "/api/v1/me/preferences" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ ok: true, preferences: routes.preferencesGet ?? {} }));
    }

    if (url === "/api/v1/me/csrf") {
      return new Response(JSON.stringify({ csrfToken: "tok", ok: true }));
    }

    if (url === "/api/v1/me/preferences" && init?.method === "PATCH") {
      routes.onPatch?.(JSON.parse(typeof init.body === "string" ? init.body : "{}"));

      return new Response(JSON.stringify({ ok: true, preferences: {} }));
    }

    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("key-notation account sync (adopt on sign-in)", () => {
  it("adopts the profile notation — the synced truth wins over the device value", async () => {
    storage.setItem(STORAGE_KEY, "scales");
    stubFetch({ me: { user: { id: "u1" } }, preferencesGet: { keyNotation: "camelot" } });

    const mod = await import("./key-notation");
    await mod.syncKeyNotationFromAccount();

    expect(mod.getKeyNotation()).toBe("camelot");
    expect(storage.getItem(STORAGE_KEY)).toBe("camelot");
  });

  it("leaves the store on default when the profile has no stored notation", async () => {
    stubFetch({ me: { user: { id: "u1" } }, preferencesGet: {} });

    const mod = await import("./key-notation");
    await mod.syncKeyNotationFromAccount();

    expect(mod.getKeyNotation()).toBe("scales");
  });

  it("is a no-op for an anonymous visitor (never fetches preferences)", async () => {
    const fetchMock = stubFetch({ me: { user: null } });

    const mod = await import("./key-notation");
    await mod.syncKeyNotationFromAccount();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mod.getKeyNotation()).toBe("scales");
  });

  it("runs its network probe once per load unless forced", async () => {
    const fetchMock = stubFetch({ me: { user: { id: "u1" } }, preferencesGet: {} });

    const mod = await import("./key-notation");
    await mod.syncKeyNotationFromAccount();
    await mod.syncKeyNotationFromAccount();
    const afterGuarded = fetchMock.mock.calls.length;
    await mod.syncKeyNotationFromAccount({ force: true });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterGuarded);
  });
});

describe("key-notation account sync (toggle write-through)", () => {
  it("optimistically writes the device AND mirrors the toggle to the profile when signed in", async () => {
    const patched: unknown[] = [];
    const fetchMock = stubFetch({
      me: { user: { id: "u1" } },
      onPatch: (body) => patched.push(body),
      preferencesGet: {},
    });

    const mod = await import("./key-notation");
    await mod.syncKeyNotationFromAccount();
    mod.setKeyNotation("camelot");

    expect(storage.getItem(STORAGE_KEY)).toBe("camelot");
    expect(mod.getKeyNotation()).toBe("camelot");

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/me/csrf")).toBe(true);
      expect(patched).toEqual([{ keyNotation: "camelot" }]);
    });
  });

  it("NEVER touches the account for an anonymous toggle (the device-only path is unchanged)", async () => {
    const fetchMock = stubFetch({ me: { user: null } });

    const mod = await import("./key-notation");
    await mod.syncKeyNotationFromAccount();
    fetchMock.mockClear();
    mod.setKeyNotation("camelot");

    expect(storage.getItem(STORAGE_KEY)).toBe("camelot");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
