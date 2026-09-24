import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimPageContinuation,
  dismissPlayer,
  keepGoing,
  pausePreview,
  playQueue,
  type QueueTrack,
  readPlayer,
  resetPreviewPlayer,
  skipNext,
  skipPrevious,
  startPreview,
  togglePlayback,
} from "./preview-player";

class FakeAudio {
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  playImpl: () => Promise<void> = () => Promise.resolve();
  preload = "";
  src = "";
  readonly #listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.#listeners.get(type) ?? new Set();

    set.add(listener);
    this.#listeners.set(type, set);
  }

  dispatch(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener();
    }
  }

  pause(): void {
    // The singleton pauses before swapping src; tests do not assert paused.
  }

  play(): Promise<void> {
    return this.playImpl();
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
    }
  }
}

function installAudio(playImpl?: () => Promise<void>): FakeAudio {
  const element = new FakeAudio();

  if (playImpl) {
    element.playImpl = playImpl;
  }

  vi.stubGlobal("Audio", function Audio() {
    return element;
  });

  return element;
}

function installSaEvent(): unknown[][] {
  const calls: unknown[][] = [];

  vi.stubGlobal("window", {
    sa_event: (...args: unknown[]) => {
      calls.push(args);
    },
  });

  return calls;
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  resetPreviewPlayer();
  vi.unstubAllGlobals();
});

describe("startPreview — public intent and successful play", () => {
  it("does not emit for an admin start that omits src, even after playback starts", async () => {
    const calls = installSaEvent();
    const element = installAudio();

    startPreview("admin-track");
    await settled();
    element.dispatch("playing");

    expect(element.src).toBe("/api/preview/admin-track");
    expect(calls).toEqual([]);
  });

  it("does not emit for an admin source-audio override after playback starts", async () => {
    const calls = installSaEvent();
    const element = installAudio();

    startPreview("admin-track", { src: "/api/v1/admin/tracks/admin-track/source-audio" });
    await settled();
    element.dispatch("playing");

    expect(calls).toEqual([]);
  });

  it("does not emit a public preview before play succeeds", async () => {
    const calls = installSaEvent();
    let release: (() => void) | undefined;
    const element = installAudio(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    startPreview("public-track", { publicPreview: true });
    expect(calls).toEqual([]);

    release?.();
    await settled();
    expect(calls).toEqual([]);

    element.dispatch("playing");
    expect(calls).toEqual([["discovery_preview"]]);
  });

  it("emits once when a public preview actually starts playing", async () => {
    const calls = installSaEvent();
    const element = installAudio();

    startPreview("public-track", { publicPreview: true });
    await settled();
    expect(calls).toEqual([]);

    element.dispatch("playing");
    element.dispatch("playing");

    expect(calls).toEqual([["discovery_preview"]]);
  });

  it("does not emit when play() rejects", async () => {
    const calls = installSaEvent();
    const element = installAudio(() => Promise.reject(new Error("autoplay blocked")));

    startPreview("public-track", { publicPreview: true });
    await settled();
    element.dispatch("playing");

    expect(calls).toEqual([]);
  });

  it("does not emit when the element errors before playing", async () => {
    const calls = installSaEvent();
    const element = installAudio();

    startPreview("public-track", { publicPreview: true });
    await settled();
    element.dispatch("error");
    element.dispatch("playing");

    expect(calls).toEqual([]);
  });

  it("still starts playback when sa_event throws", async () => {
    vi.stubGlobal("window", {
      sa_event: () => {
        throw new Error("blocked");
      },
    });

    const element = installAudio();

    expect(() => startPreview("public-track", { publicPreview: true })).not.toThrow();
    await settled();
    expect(() => element.dispatch("playing")).not.toThrow();
    expect(element.src).toBe("/api/preview/public-track");
  });
});

function tracks(...ids: string[]): QueueTrack[] {
  return ids.map((id) => ({ artists: [`Artist ${id}`], id, title: `Title ${id}` }));
}

describe("the queue — the list is the queue", () => {
  it("plays the list from the row that was pressed and advances on ended", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b", "c"), 1);
    await settled();
    element.dispatch("playing");

    expect(element.src).toBe("/api/preview/b");
    expect(readPlayer()).toMatchObject({ status: "playing", trackId: "b" });
    expect(readPlayer().queue?.index).toBe(1);

    element.dispatch("ended");
    await settled();

    expect(element.src).toBe("/api/preview/c");
    expect(readPlayer().queue).toMatchObject({ ended: false, index: 2 });
  });

  it("stops at the end of the list and keeps its place for the way on", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b"), 1);
    await settled();
    element.dispatch("playing");
    element.dispatch("ended");

    expect(readPlayer().status).toBe("idle");
    expect(readPlayer().queue).toMatchObject({ ended: true, index: 1 });
  });

  it("skips a missing preview, remembers it, and plays the next track", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b", "c"), 0);
    await settled();
    element.dispatch("error");
    await settled();

    expect(readPlayer().missing.has("a")).toBe(true);
    expect(element.src).toBe("/api/preview/b");
    expect(readPlayer().queue?.index).toBe(1);
  });

  it("gives up after a run of dead previews instead of skipping forever", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b", "c", "d", "e", "f", "g"), 0);

    for (let step = 0; step < 6; step += 1) {
      await settled();
      element.dispatch("error");
    }

    expect(readPlayer().status).toBe("idle");
    expect(readPlayer().queue?.index).toBe(4);
    expect(readPlayer().missing.size).toBe(5);
  });

  it("waits paused, without marking a miss, when autoplay is refused", async () => {
    const refused = new Error("gesture needed");

    refused.name = "NotAllowedError";
    installAudio(() => Promise.reject(refused));

    playQueue(tracks("a", "b"), 0);
    await settled();

    expect(readPlayer()).toMatchObject({ status: "paused", trackId: "a" });
    expect(readPlayer().missing.size).toBe(0);
  });

  it("steps forward and back through the list", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b", "c"), 0);
    skipNext();
    expect(element.src).toBe("/api/preview/b");
    skipNext();
    expect(element.src).toBe("/api/preview/c");
    skipPrevious();
    expect(element.src).toBe("/api/preview/b");

    element.currentTime = 12;
    skipPrevious();
    expect(element.currentTime).toBe(0);
    expect(element.src).toBe("/api/preview/b");
  });

  it("pauses and resumes in place, and restarts the current track from idle", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b"), 0);
    await settled();
    element.dispatch("playing");

    pausePreview();
    expect(readPlayer().status).toBe("paused");

    togglePlayback();
    expect(readPlayer().status).toBe("loading");
    element.dispatch("playing");
    expect(readPlayer().status).toBe("playing");

    element.dispatch("ended");
    element.dispatch("ended");
    expect(readPlayer().status).toBe("idle");

    togglePlayback();
    expect(element.src).toBe("/api/preview/b");
  });

  it("a bare start leaves the queue behind, and dismiss clears it", () => {
    installAudio();

    playQueue(tracks("a", "b"), 0);
    startPreview("admin-audition");
    expect(readPlayer().queue).toBeUndefined();

    playQueue(tracks("a", "b"), 0);
    dismissPlayer();
    expect(readPlayer()).toMatchObject({ queue: undefined, status: "idle" });
  });
});

describe("keep going — the one way on", () => {
  it("plays the last track's sonic neighbours, minus what was already heard", async () => {
    const element = installAudio();

    playQueue(tracks("a", "b"), 1);
    element.dispatch("ended");

    const seen: string[] = [];
    const moved = await keepGoing({
      loadSimilar: async (last) => {
        seen.push(last.id);

        return tracks("a", "x", "y");
      },
      navigate: () => {},
    });

    expect(moved).toBe(true);
    expect(seen).toEqual(["b"]);
    expect(readPlayer().queue?.tracks.map((track) => track.id)).toEqual(["x", "y"]);
    expect(element.src).toBe("/api/preview/x");
  });

  it("reports no way on when the archive has no neighbours", async () => {
    installAudio();

    playQueue(tracks("a"), 0);

    const moved = await keepGoing({ loadSimilar: async () => [], navigate: () => {} });

    expect(moved).toBe(false);
    expect(readPlayer().queue?.tracks.map((track) => track.id)).toEqual(["a"]);
  });

  it("walks to the next page and hands the new list a one-shot start", async () => {
    installAudio();

    playQueue(tracks("a"), 0, { continuation: { href: "/tracks?page=2", kind: "page" } });

    const visited: string[] = [];
    const moved = await keepGoing({
      loadSimilar: async () => [],
      navigate: (href) => visited.push(href),
    });

    expect(moved).toBe(true);
    expect(visited).toEqual(["/tracks?page=2"]);
    expect(claimPageContinuation("/tracks?page=3")).toBe(false);
    expect(claimPageContinuation("/tracks?page=2")).toBe(false);
  });

  it("the next page claims its hand-off exactly once", async () => {
    installAudio();

    playQueue(tracks("a"), 0, { continuation: { href: "/tracks?page=2", kind: "page" } });
    await keepGoing({ loadSimilar: async () => [], navigate: () => {} });

    expect(claimPageContinuation("/tracks?page=2")).toBe(true);
    expect(claimPageContinuation("/tracks?page=2")).toBe(false);
  });
});
