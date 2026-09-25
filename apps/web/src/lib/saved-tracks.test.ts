import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSavedTracks, parseSavedTracks, type SavedTrack } from "./saved-tracks";

const KEY = "fluncle-saved-tracks";

type StorageListener = (event: { key: string | null }) => void;

function fakeWindow() {
  const store = new Map<string, string>();
  const listeners = new Set<StorageListener>();

  return {
    addEventListener: (type: string, listener: StorageListener) => {
      if (type === "storage") {
        listeners.add(listener);
      }
    },
    fireStorage: (key: string | null) => {
      for (const listener of listeners) {
        listener({ key });
      }
    },
    localStorage: {
      getItem: (key: string): null | string => store.get(key) ?? null,
      removeItem: (key: string): void => void store.delete(key),
      setItem: (key: string, value: string): void => void store.set(key, value),
    },
    removeEventListener: (type: string, listener: StorageListener) => {
      listeners.delete(listener);
    },
    store,
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
});

function saved(overrides: Partial<SavedTrack> & { trackId: string }): SavedTrack {
  return {
    artists: ["Ashen Relay"],
    savedAt: "2026-09-20T10:00:00.000Z",
    sync: "local",
    title: `Title ${overrides.trackId}`,
    ...overrides,
  };
}

describe("the saved-tracks store", () => {
  it("saves a catalogue track and a finding, newest first, and persists them", async () => {
    const store = await import("./saved-tracks");

    const first = store.saveTrack(
      { artists: ["Ashen Relay"], href: "/track/cat-1", title: "Undertow", trackId: "cat-1" },
      { now: new Date("2026-09-20T10:00:00.000Z") },
    );

    expect(first.outcome).toBe("saved");
    store.saveTrack(
      {
        artists: ["Cinder Vane"],
        href: "/log/241.7.3A",
        logId: "241.7.3A",
        title: "Halide",
        trackId: "find-1",
      },
      { now: new Date("2026-09-21T10:00:00.000Z") },
    );

    expect(store.savedTracks().map((track) => track.trackId)).toEqual(["find-1", "cat-1"]);
    expect(store.isSaved("cat-1")).toBe(true);
    expect(store.isSaved("nope")).toBe(false);
    expect(parseSavedTracks(win.store.get(KEY) ?? null).map((track) => track.trackId)).toEqual([
      "find-1",
      "cat-1",
    ]);
  });

  it("re-saving a track moves it to the top instead of duplicating it", async () => {
    const store = await import("./saved-tracks");

    store.saveTrack(
      { artists: [], title: "A", trackId: "a" },
      { now: new Date("2026-09-20T00:00:00Z") },
    );
    store.saveTrack(
      { artists: [], title: "B", trackId: "b" },
      { now: new Date("2026-09-21T00:00:00Z") },
    );
    store.saveTrack(
      { artists: [], title: "A", trackId: "a" },
      { now: new Date("2026-09-22T00:00:00Z") },
    );

    expect(store.savedTracks().map((track) => track.trackId)).toEqual(["a", "b"]);
  });

  it("unsaves a track and clears the key once nothing is left", async () => {
    const store = await import("./saved-tracks");

    store.saveTrack({ artists: [], title: "A", trackId: "a" });
    store.unsaveTrack("a");

    expect(store.savedTracks()).toEqual([]);
    expect(win.store.has(KEY)).toBe(false);
  });

  it("reads saves another tab wrote when the storage event fires", async () => {
    const store = await import("./saved-tracks");
    const seen: string[][] = [];
    const listener = () => seen.push(store.savedTracks().map((track) => track.trackId));

    const unsubscribe = store.subscribeSavedTracks(listener);

    win.store.set(KEY, JSON.stringify([saved({ trackId: "other-tab" })]));
    win.fireStorage(KEY);
    win.fireStorage("unrelated-key");

    expect(seen).toEqual([["other-tab"]]);
    unsubscribe();
  });

  it("forgets only the saves the account already holds", async () => {
    win.store.set(
      KEY,
      JSON.stringify([
        saved({ sync: "synced", trackId: "on-account" }),
        saved({ sync: "local", trackId: "device-only" }),
      ]),
    );
    const store = await import("./saved-tracks");

    store.forgetSyncedTracks();

    expect(store.savedTracks().map((track) => track.trackId)).toEqual(["device-only"]);
  });

  it("marks a save's sync state", async () => {
    const store = await import("./saved-tracks");

    store.saveTrack({ artists: [], title: "A", trackId: "a" });
    store.markSavedTrack("a", "synced");

    expect(store.savedTracks()[0]?.sync).toBe("synced");
  });
});

describe("the saved-tracks store when the browser refuses storage", () => {
  it("starts empty and keeps saving in memory when reading storage throws", async () => {
    win.localStorage.getItem = () => {
      throw new Error("SecurityError");
    };
    const store = await import("./saved-tracks");

    expect(store.savedTracks()).toEqual([]);

    const result = store.saveTrack({ artists: [], title: "A", trackId: "a" });

    expect(result.outcome).toBe("saved");
    expect(store.isSaved("a")).toBe(true);
  });

  it("keeps a save it could not write for this page and says the device did not keep it", async () => {
    win.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const store = await import("./saved-tracks");

    const result = store.saveTrack({ artists: [], title: "A", trackId: "a" });

    expect(result.outcome).toBe("unpersisted");
    expect(store.isSaved("a")).toBe(true);
    expect(win.store.has(KEY)).toBe(false);
  });

  it("ignores a storage event whose read throws instead of dropping the page's saves", async () => {
    const store = await import("./saved-tracks");
    const unsubscribe = store.subscribeSavedTracks(() => {});

    store.saveTrack({ artists: [], title: "A", trackId: "a" });
    win.localStorage.getItem = () => {
      throw new Error("SecurityError");
    };
    win.fireStorage(KEY);

    expect(store.isSaved("a")).toBe(true);
    unsubscribe();
  });
});

describe("the saved-tracks store bound", () => {
  it("refuses a new save once the device holds the maximum, and never evicts an old one", async () => {
    const store = await import("./saved-tracks");
    const full = Array.from({ length: store.MAX_SAVED_TRACKS }, (_unused, index) =>
      saved({
        savedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        trackId: `t${index}`,
      }),
    );
    store.replaceSavedTracks(full);

    const result = store.saveTrack({ artists: [], title: "New", trackId: "new" });

    expect(result.outcome).toBe("full");
    expect(store.isSaved("new")).toBe(false);
    expect(store.savedTracks()).toHaveLength(store.MAX_SAVED_TRACKS);
    expect(store.isSaved("t0")).toBe(true);
  });

  it("still lets a full device re-save a track it already holds, and lets an unbounded caller past the bound", async () => {
    const store = await import("./saved-tracks");
    store.replaceSavedTracks(
      Array.from({ length: store.MAX_SAVED_TRACKS }, (_unused, index) =>
        saved({ trackId: `t${index}` }),
      ),
    );

    expect(store.saveTrack({ artists: [], title: "Again", trackId: "t3" }).outcome).toBe("saved");
    expect(store.savedTracks()[0]?.trackId).toBe("t3");
    expect(
      store.saveTrack({ artists: [], title: "Account", trackId: "acct" }, { limit: Infinity })
        .outcome,
    ).toBe("saved");
  });
});

describe("restoreSavedTrack", () => {
  it("puts a removed save back at its old position with its old savedAt", async () => {
    const store = await import("./saved-tracks");
    store.replaceSavedTracks([
      saved({ trackId: "a" }),
      saved({ trackId: "b" }),
      saved({ trackId: "c" }),
    ]);
    const removed = store.savedTracks()[1];

    store.unsaveTrack("b");
    if (removed) {
      store.restoreSavedTrack(removed, 1);
    }

    expect(store.savedTracks().map((track) => track.trackId)).toEqual(["a", "b", "c"]);
    expect(store.savedTracks()[1]).toEqual(removed);
  });

  it("leaves a track alone when it was saved again before the restore", async () => {
    const store = await import("./saved-tracks");
    store.replaceSavedTracks([saved({ trackId: "a" })]);
    const removed = store.savedTracks()[0];

    store.unsaveTrack("a");
    store.saveTrack({ artists: [], title: "A again", trackId: "a" });
    if (removed) {
      store.restoreSavedTrack(removed, 0);
    }

    expect(store.savedTracks().map((track) => track.title)).toEqual(["A again"]);
  });
});

describe("parseSavedTracks", () => {
  it("drops malformed rows and duplicates, and defaults an unknown sync state to local", () => {
    const rows = parseSavedTracks(
      JSON.stringify([
        saved({ trackId: "a" }),
        { title: "no id" },
        saved({ title: "duplicate", trackId: "a" }),
        { ...saved({ trackId: "b" }), sync: "weird" },
        "garbage",
      ]),
    );

    expect(rows.map((row) => [row.trackId, row.sync])).toEqual([
      ["a", "local"],
      ["b", "local"],
    ]);
  });

  it("reads corrupt storage as nothing saved", () => {
    expect(parseSavedTracks("{not json")).toEqual([]);
    expect(parseSavedTracks(JSON.stringify({ trackId: "a" }))).toEqual([]);
    expect(parseSavedTracks(null)).toEqual([]);
  });
});

describe("mergeSavedTracks", () => {
  const since = "2026-09-25T12:00:00.000Z";

  it("unions by trackId and queues only the device's own saves for the account", () => {
    const { next, pending } = mergeSavedTracks(
      [
        saved({ savedAt: "2026-09-24T00:00:00.000Z", trackId: "device-only" }),
        saved({ savedAt: "2026-09-23T00:00:00.000Z", trackId: "both" }),
      ],
      [
        {
          artists: ["Remote"],
          href: "/track/remote-only",
          imageUrl: "https://example.invalid/cover.jpg",
          savedAt: "2026-09-22T00:00:00.000Z",
          title: "Remote",
          trackId: "remote-only",
        },
        {
          artists: ["Ashen Relay"],
          logId: "241.7.3A",
          savedAt: "2026-09-20T00:00:00.000Z",
          title: "Both",
          trackId: "both",
        },
      ],
      since,
    );

    expect(next.map((row) => [row.trackId, row.sync])).toEqual([
      ["device-only", "local"],
      ["both", "synced"],
      ["remote-only", "synced"],
    ]);
    expect(next.find((row) => row.trackId === "both")?.logId).toBe("241.7.3A");
    expect(next.find((row) => row.trackId === "remote-only")?.coverUrl).toBe(
      "https://example.invalid/cover.jpg",
    );
    expect(pending.map((row) => row.trackId)).toEqual(["device-only"]);
  });

  it("drops a synced save the account no longer holds, but keeps one saved during the merge", () => {
    const { next } = mergeSavedTracks(
      [
        saved({
          savedAt: "2026-09-20T00:00:00.000Z",
          sync: "synced",
          trackId: "removed-elsewhere",
        }),
        saved({ savedAt: "2026-09-25T12:00:01.000Z", sync: "synced", trackId: "saved-just-now" }),
        saved({ sync: "refused", trackId: "gone-from-archive" }),
      ],
      [],
      since,
    );

    expect(next.map((row) => row.trackId)).toEqual(["saved-just-now", "gone-from-archive"]);
  });

  it("links a remote finding by its coordinate when the row carries no href", () => {
    const { next } = mergeSavedTracks(
      [],
      [{ artists: [], logId: "241.7.3A", savedAt: since, title: "T", trackId: "t" }],
      since,
    );

    expect(next[0]?.href).toBe("/log/241.7.3A");
  });
});
