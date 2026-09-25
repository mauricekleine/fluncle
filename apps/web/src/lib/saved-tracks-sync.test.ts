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

function fakeServer(
  options: {
    deleteFails?: "network" | number;
    limitAfter?: number;
    refuse?: string[];
    remote?: unknown[];
  } = {},
) {
  const calls: Call[] = [];
  const refuse = new Set(options.refuse ?? []);
  const state = { limitAfter: options.limitAfter ?? Number.POSITIVE_INFINITY, saved: 0 };

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

      if (refuse.has(trackId)) {
        return new Response(JSON.stringify({ error: "track_not_found" }), { status: 404 });
      }

      if (state.saved >= state.limitAfter) {
        return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
      }

      state.saved += 1;

      return new Response(JSON.stringify({ ok: true }));
    }

    if (method === "DELETE" && options.deleteFails === "network") {
      throw new TypeError("Failed to fetch");
    }

    if (method === "DELETE" && typeof options.deleteFails === "number") {
      return new Response(JSON.stringify({ error: "nope" }), { status: options.deleteFails });
    }

    return new Response(JSON.stringify({ ok: true }));
  });

  return {
    calls,
    fetchImpl,
    posts: () => calls.filter((call) => call.method === "POST").length,
    reopen: () => {
      state.limitAfter = Number.POSITIVE_INFINITY;
    },
    state,
  };
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
  vi.useRealTimers();
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

describe("toggleSavedTrack when the account refuses an unsave", () => {
  async function savedAndSynced(deleteFails: "network" | number) {
    win.store.set(
      KEY,
      JSON.stringify([
        { ...local("first", "synced"), savedAt: "2026-09-24T00:00:00.000Z" },
        { ...local("middle", "synced"), savedAt: "2026-09-23T00:00:00.000Z" },
        { ...local("last", "synced"), savedAt: "2026-09-22T00:00:00.000Z" },
      ]),
    );
    const loaded = await load();
    const fake = fakeServer({ deleteFails });
    vi.stubGlobal("fetch", fake.fetchImpl);
    loaded.server.setSavedTracksUser("user-1");

    return { ...loaded, fake };
  }

  it.each([500, 429, "network"] as const)(
    "puts the save back where it was and says so once when the delete fails (%s)",
    async (deleteFails) => {
      const { fake, server, store } = await savedAndSynced(deleteFails);
      const before = store.savedTracks();
      const onUnsaveFailed = vi.fn();

      const result = server.toggleSavedTrack(
        { artists: [], title: "middle", trackId: "middle" },
        fake.fetchImpl,
        { onUnsaveFailed },
      );

      expect(result).toEqual({ kept: "account", outcome: "removed" });
      expect(store.isSaved("middle")).toBe(false);

      await vi.waitFor(() => expect(onUnsaveFailed).toHaveBeenCalledTimes(1));
      expect(store.savedTracks()).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onUnsaveFailed).toHaveBeenCalledTimes(1);
    },
  );

  it("treats a 404 as already gone and keeps the save removed", async () => {
    const { fake, server, store } = await savedAndSynced(404);
    const onUnsaveFailed = vi.fn();

    server.toggleSavedTrack({ artists: [], title: "middle", trackId: "middle" }, fake.fetchImpl, {
      onUnsaveFailed,
    });

    await vi.waitFor(() => expect(fake.calls.some((call) => call.method === "DELETE")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onUnsaveFailed).not.toHaveBeenCalled();
    expect(store.isSaved("middle")).toBe(false);
  });
});

describe("toggleSavedTrack when the device cannot hold the save", () => {
  it("says the save lives only on this page when the browser refuses the write", async () => {
    win.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const { server, store } = await load();
    const { fetchImpl } = fakeServer();

    expect(server.toggleSavedTrack({ artists: [], title: "A", trackId: "a" }, fetchImpl)).toEqual({
      kept: "page",
      outcome: "saved",
    });
    expect(store.isSaved("a")).toBe(true);
  });

  it("says a signed-out removal lives only on this page when the browser refuses the write", async () => {
    const { server, store } = await load();
    const { fetchImpl } = fakeServer();
    store.replaceSavedTracks([local("a"), local("b")]);
    win.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    expect(server.toggleSavedTrack({ artists: [], title: "a", trackId: "a" }, fetchImpl)).toEqual({
      kept: "page",
      outcome: "removed",
    });
    expect(store.isSaved("a")).toBe(false);
  });

  it("confirms a signed-out removal for a track the browser never stored", async () => {
    win.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const { server, store } = await load();
    const { fetchImpl } = fakeServer();

    server.toggleSavedTrack({ artists: [], title: "A", trackId: "a" }, fetchImpl);
    server.toggleSavedTrack({ artists: [], title: "B", trackId: "b" }, fetchImpl);

    expect(server.toggleSavedTrack({ artists: [], title: "A", trackId: "a" }, fetchImpl)).toEqual({
      kept: "device",
      outcome: "removed",
    });
    expect(store.isSaved("a")).toBe(false);
  });

  it("refuses a signed-out save once the device is full", async () => {
    const { server, store } = await load();
    const { calls, fetchImpl } = fakeServer();
    store.replaceSavedTracks(
      Array.from({ length: store.MAX_SAVED_TRACKS }, (_unused, index) => local(`t${index}`)),
    );

    expect(
      server.toggleSavedTrack({ artists: [], title: "New", trackId: "new" }, fetchImpl),
    ).toEqual({ kept: "device", outcome: "full" });
    expect(store.isSaved("new")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("lets a signed-in save past the device bound because the account holds it", async () => {
    const { server, store } = await load();
    const { fetchImpl } = fakeServer();
    vi.stubGlobal("fetch", fetchImpl);
    server.setSavedTracksUser("user-1");
    store.replaceSavedTracks(
      Array.from({ length: store.MAX_SAVED_TRACKS }, (_unused, index) =>
        local(`t${index}`, "synced"),
      ),
    );

    expect(
      server.toggleSavedTrack({ artists: [], title: "New", trackId: "new" }, fetchImpl),
    ).toEqual({ kept: "account", outcome: "saved" });
    await vi.waitFor(() => expect(store.savedTracks()[0]?.sync).toBe("synced"));
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

    expect(result).toEqual({ outcome: "merged", pulled: 1, pushed: 1 });
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

  it("keeps pushing the device's saves in paced batches until all 45 reach the account, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const many = Array.from({ length: 45 }, (_unused, index) => local(`t${index}`));
    win.store.set(KEY, JSON.stringify(many));
    const { server, store } = await load();
    const fake = fakeServer();
    vi.stubGlobal("fetch", fake.fetchImpl);
    server.setSavedTracksUser("user-1");
    const onBatch = vi.fn();

    const merging = server.mergeOnSignIn("user-1", fake.fetchImpl, { onBatch });

    await vi.waitFor(() => expect(fake.posts()).toBe(server.MERGE_PUSH_BATCH));
    await vi.advanceTimersByTimeAsync(server.MERGE_BATCH_PAUSE_MS / 2);
    expect(fake.posts()).toBe(server.MERGE_PUSH_BATCH);

    await vi.advanceTimersByTimeAsync(server.MERGE_BATCH_PAUSE_MS);

    expect(await merging).toEqual({ outcome: "merged", pulled: 0, pushed: 45 });
    expect(fake.posts()).toBe(45);
    expect(store.savedTracks().filter((track) => track.sync === "local")).toHaveLength(0);
    expect(onBatch).toHaveBeenCalledTimes(2);
  });

  it("backs off when the account says too many saves, then resumes and finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    win.store.set(
      KEY,
      JSON.stringify(Array.from({ length: 45 }, (_unused, index) => local(`t${index}`))),
    );
    const { server, store } = await load();
    const fake = fakeServer({ limitAfter: 35 });
    vi.stubGlobal("fetch", fake.fetchImpl);
    server.setSavedTracksUser("user-1");

    const merging = server.mergeOnSignIn("user-1", fake.fetchImpl);

    await vi.waitFor(() => expect(fake.posts()).toBe(server.MERGE_PUSH_BATCH));
    await vi.advanceTimersByTimeAsync(server.MERGE_BATCH_PAUSE_MS);
    await vi.waitFor(() => expect(fake.state.saved).toBe(35));
    const afterLimit = fake.posts();

    await vi.advanceTimersByTimeAsync(server.MERGE_LIMITED_BACKOFF_MS / 2);
    expect(fake.posts()).toBe(afterLimit);

    fake.reopen();
    await vi.advanceTimersByTimeAsync(server.MERGE_LIMITED_BACKOFF_MS);

    expect(await merging).toEqual({ outcome: "merged", pulled: 0, pushed: 45 });
    expect(fake.state.saved).toBe(45);
    expect(store.savedTracks().every((track) => track.sync === "synced")).toBe(true);
  });

  it("stops pushing the moment the signed-in user changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    win.store.set(
      KEY,
      JSON.stringify(Array.from({ length: 45 }, (_unused, index) => local(`t${index}`))),
    );
    const { server } = await load();
    const fake = fakeServer();
    vi.stubGlobal("fetch", fake.fetchImpl);
    server.setSavedTracksUser("user-1");

    const merging = server.mergeOnSignIn("user-1", fake.fetchImpl);

    await vi.waitFor(() => expect(fake.posts()).toBe(server.MERGE_PUSH_BATCH));
    server.setSavedTracksUser("user-2");
    await vi.advanceTimersByTimeAsync(server.MERGE_BATCH_PAUSE_MS * 3);

    expect(await merging).toEqual({
      outcome: "stopped",
      pulled: 0,
      pushed: server.MERGE_PUSH_BATCH,
      remaining: 45 - server.MERGE_PUSH_BATCH,
    });
    expect(fake.posts()).toBe(server.MERGE_PUSH_BATCH);
  });

  it("merges again when the same user signs back in after signing out", async () => {
    const { server } = await load();
    const { fetchImpl } = fakeServer();
    vi.stubGlobal("fetch", fetchImpl);
    server.setSavedTracksUser("user-1");

    expect((await server.mergeOnSignIn("user-1", fetchImpl)).outcome).toBe("merged");

    server.setSavedTracksUser(undefined);
    server.setSavedTracksUser("user-1");

    expect((await server.mergeOnSignIn("user-1", fetchImpl)).outcome).toBe("merged");
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
