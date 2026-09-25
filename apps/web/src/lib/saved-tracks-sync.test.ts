import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SavedTrack } from "./saved-tracks";

const KEY = "fluncle-saved-tracks";

type Call = { body?: unknown; method: string; path: string };

function fakeWindow() {
  const store = new Map<string, string>();

  return {
    addEventListener: () => {},
    localStorage: {
      getItem: (key: string): null | string => store.get(key) ?? null,
      removeItem: (key: string): void => void store.delete(key),
      setItem: (key: string, value: string): void => void store.set(key, value),
    },
    removeEventListener: () => {},
    store,
  };
}

function fakeServer(options: { refuse?: string[]; remote?: unknown[] } = {}) {
  const calls: Call[] = [];
  const refuse = new Set(options.refuse ?? []);

  const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    calls.push({ body, method, path });

    if (path === "/api/v1/me/csrf") {
      return new Response(JSON.stringify({ csrfToken: "tok", ok: true }));
    }

    if (path === "/api/v1/me/saved-findings" && method === "GET") {
      return new Response(JSON.stringify({ ok: true, savedFindings: options.remote ?? [] }));
    }

    if (path === "/api/v1/me/saved-findings" && method === "POST") {
      const trackId = (body as { trackId: string }).trackId;

      return refuse.has(trackId)
        ? new Response(JSON.stringify({ error: "track_not_found" }), { status: 404 })
        : new Response(JSON.stringify({ ok: true }));
    }

    return new Response(JSON.stringify({ ok: true }));
  });

  return { calls, fetchImpl };
}

function local(trackId: string, sync: SavedTrack["sync"] = "local"): SavedTrack {
  return {
    artists: ["Ashen Relay"],
    savedAt: `2026-09-2${trackId.length % 10}T00:00:00.000Z`,
    sync,
    title: trackId,
    trackId,
  };
}

let win: ReturnType<typeof fakeWindow>;

beforeEach(() => {
  vi.resetModules();
  win = fakeWindow();
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load() {
  const server = await import("./saved-tracks-sync");
  const store = await import("./saved-tracks");

  return { server, store };
}

describe("toggleSavedTrack", () => {
  it("signed out, saves on the device and never touches the network", async () => {
    const { server, store } = await load();
    const { calls, fetchImpl } = fakeServer();
    vi.stubGlobal("fetch", fetchImpl);

    const result = server.toggleSavedTrack({ artists: [], title: "A", trackId: "a" }, fetchImpl);

    expect(result).toEqual({ kept: "device", outcome: "saved" });
    expect(store.isSaved("a")).toBe(true);
    expect(calls).toEqual([]);

    expect(server.toggleSavedTrack({ artists: [], title: "A", trackId: "a" }, fetchImpl)).toEqual({
      kept: "device",
      outcome: "removed",
    });
    expect(store.isSaved("a")).toBe(false);
  });

  it("signed in, saves locally first, then writes the account and marks it synced", async () => {
    const { server, store } = await load();
    const { calls, fetchImpl } = fakeServer();
    vi.stubGlobal("fetch", fetchImpl);
    server.setSavedTracksUser("user-1");

    const result = server.toggleSavedTrack(
      { artists: [], logId: "241.7.3A", title: "A", trackId: "a" },
      fetchImpl,
    );

    expect(result).toEqual({ kept: "account", outcome: "saved" });
    expect(store.savedTracks()[0]?.sync).toBe("local");

    await vi.waitFor(() => expect(store.savedTracks()[0]?.sync).toBe("synced"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      logId: "241.7.3A",
      trackId: "a",
    });

    server.toggleSavedTrack({ artists: [], title: "A", trackId: "a" }, fetchImpl);
    await vi.waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE" && call.path.endsWith("/a"))).toBe(true),
    );
  });
});

describe("mergeOnSignIn", () => {
  it("pulls the account into the device, pushes the device's own saves, and runs once", async () => {
    win.store.set(KEY, JSON.stringify([local("device-only"), local("both")]));
    const { server, store } = await load();
    const { calls, fetchImpl } = fakeServer({
      remote: [
        { artists: ["R"], savedAt: "2026-09-19T00:00:00.000Z", title: "R", trackId: "remote-only" },
        { artists: ["B"], savedAt: "2026-09-19T00:00:00.000Z", title: "B", trackId: "both" },
      ],
    });
    vi.stubGlobal("fetch", fetchImpl);
    server.setSavedTracksUser("user-1");

    const result = await server.mergeOnSignIn("user-1", fetchImpl);

    expect(result).toEqual({ deferred: 0, outcome: "merged", pulled: 1, pushed: 1 });
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { trackId: "device-only" },
    ]);
    expect(
      store
        .savedTracks()
        .map((track) => `${track.trackId}:${track.sync}`)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["both:synced", "device-only:synced", "remote-only:synced"]);

    expect(await server.mergeOnSignIn("user-1", fetchImpl)).toEqual({ outcome: "skipped" });
  });

  it("pushes at most one batch per load and leaves the rest on the device", async () => {
    const many = Array.from({ length: 45 }, (_unused, index) => local(`t${index}`));
    win.store.set(KEY, JSON.stringify(many));
    const { server, store } = await load();
    const { calls, fetchImpl } = fakeServer();
    vi.stubGlobal("fetch", fetchImpl);
    server.setSavedTracksUser("user-1");

    const result = await server.mergeOnSignIn("user-1", fetchImpl);

    expect(result).toEqual({
      deferred: 45 - server.MERGE_PUSH_BATCH,
      outcome: "merged",
      pulled: 0,
      pushed: server.MERGE_PUSH_BATCH,
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(server.MERGE_PUSH_BATCH);
    expect(store.savedTracks().filter((track) => track.sync === "local")).toHaveLength(
      45 - server.MERGE_PUSH_BATCH,
    );
  });

  it("marks a save the archive no longer holds as refused so it is never pushed again", async () => {
    win.store.set(KEY, JSON.stringify([local("ghost")]));
    const { server, store } = await load();
    const { fetchImpl } = fakeServer({ refuse: ["ghost"] });
    vi.stubGlobal("fetch", fetchImpl);
    server.setSavedTracksUser("user-1");

    await server.mergeOnSignIn("user-1", fetchImpl);

    expect(store.savedTracks()[0]?.sync).toBe("refused");
  });

  it("reports an unreachable account and retries on the next attempt", async () => {
    const { server } = await load();
    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    server.setSavedTracksUser("user-1");

    expect(await server.mergeOnSignIn("user-1", failing)).toEqual({ outcome: "unavailable" });

    const { fetchImpl } = fakeServer();
    vi.stubGlobal("fetch", fetchImpl);

    expect((await server.mergeOnSignIn("user-1", fetchImpl)).outcome).toBe("merged");
  });
});

describe("parseRemoteSavedTracks", () => {
  it("keeps catalogue rows (no logId) and rejects a malformed envelope", async () => {
    const { server } = await load();

    expect(
      server.parseRemoteSavedTracks({
        savedFindings: [
          { artists: [], savedAt: "x", title: "Cat", trackId: "cat" },
          { title: "broken" },
        ],
      }),
    ).toEqual([{ artists: [], savedAt: "x", title: "Cat", trackId: "cat" }]);
    expect(server.parseRemoteSavedTracks({ nope: true })).toBeUndefined();
  });
});
