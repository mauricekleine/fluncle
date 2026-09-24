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

    expect(moved).toBe("moved");
    expect(seen).toEqual(["b"]);
    expect(readPlayer().queue?.tracks.map((track) => track.id)).toEqual(["x", "y"]);
    expect(element.src).toBe("/api/preview/x");
  });

  it("reports no way on when the archive has no neighbours", async () => {
    installAudio();

    playQueue(tracks("a"), 0);

    const moved = await keepGoing({ loadSimilar: async () => [], navigate: () => {} });

    expect(moved).toBe("none");
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

    expect(moved).toBe("moved");
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

// ── THE RACES A BROWSER ACTUALLY PRODUCES ─────────────────────────────────────────────────────
// A browser-shaped element: play() stays pending until the clip arrives, and a pause() or a new
// source while it is pending rejects it with an AbortError (the HTML media spec's "pending play
// promises" rejection), exactly the cancellation the player must not mistake for a missing clip.

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

class BrowserLikeAudio {
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  muted = false;
  paused = true;
  preload = "";
  #src = "";
  #pending: { reject: (error: unknown) => void; resolve: () => void } | undefined;
  readonly #listeners = new Map<string, Set<() => void>>();

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    this.#abort("The play() request was interrupted by a new load request.");
    this.paused = true;
    this.#src = value;
  }

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

  play(): Promise<void> {
    this.paused = false;

    return new Promise((resolve, reject) => {
      this.#pending = { reject, resolve };
    });
  }

  pause(): void {
    const wasPlaying = !this.paused;

    this.paused = true;
    this.#abort("The play() request was interrupted by a call to pause().");

    if (wasPlaying) {
      this.dispatch("pause");
    }
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.#src = "";
    }
  }

  /** The clip arrived and started sounding. */
  arrive(): void {
    const pending = this.#pending;

    this.#pending = undefined;
    pending?.resolve();
    this.dispatch("playing");
  }

  /** The relay answered with nothing playable. */
  failToLoad(): void {
    const pending = this.#pending;

    this.#pending = undefined;
    this.dispatch("error");
    pending?.reject(domError("NotSupportedError", "The element has no supported sources."));
  }

  /** The clip played to its end. */
  finish(): void {
    this.paused = true;
    this.ended = true;
    this.dispatch("pause");
    this.dispatch("ended");
    this.ended = false;
  }

  #abort(message: string): void {
    const pending = this.#pending;

    this.#pending = undefined;
    pending?.reject(domError("AbortError", message));
  }
}

function installBrowserAudio(): BrowserLikeAudio {
  const element = new BrowserLikeAudio();

  vi.stubGlobal("Audio", function Audio() {
    return element;
  });

  return element;
}

/** Another sound on the page: Stories' video, the radio's audio. */
class OtherMedia {
  muted = false;
  paused = true;
  pauses = 0;
  volume = 1;

  pause(): void {
    this.paused = true;
    this.pauses += 1;
  }
}

/** A document that hears media events in the capture phase, as the real one does. */
function installPage(others: OtherMedia[]): { start: (media: OtherMedia) => void } {
  const listeners = new Map<string, ((event: Event) => void)[]>();

  vi.stubGlobal("HTMLMediaElement", OtherMedia);
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    querySelectorAll: () => others,
  });

  return {
    start: (media) => {
      media.paused = false;

      for (const listener of listeners.get("play") ?? []) {
        listener({ target: media } as unknown as Event);
      }
    },
  };
}

type FakeSession = {
  handlers: Map<string, (() => void) | null>;
  metadata: unknown;
  playbackState: string;
  setActionHandler: (action: string, handler: (() => void) | null) => void;
};

function installMediaSession(): FakeSession {
  const session: FakeSession = {
    handlers: new Map(),
    metadata: null,
    playbackState: "none",
    setActionHandler: (action, handler) => {
      session.handlers.set(action, handler);
    },
  };

  vi.stubGlobal("navigator", { mediaSession: session });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(readonly init: unknown) {}
    },
  );

  return session;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

describe("cancellation — a pause is never a missing preview", () => {
  it("pausing a clip that is still arriving cancels it without marking it missing or advancing", async () => {
    const element = installBrowserAudio();

    playQueue(tracks("a", "b", "c"), 0);
    pausePreview();
    await settled();

    expect(readPlayer()).toMatchObject({ status: "paused", trackId: "a" });
    expect(readPlayer().queue?.index).toBe(0);
    expect(readPlayer().missing.size).toBe(0);
    expect(element.src).toBe("/api/preview/a");
  });

  it("the player's Pause while loading cancels too, and Play resumes the same clip", async () => {
    const element = installBrowserAudio();

    playQueue(tracks("a", "b"), 0);
    expect(readPlayer().status).toBe("loading");

    togglePlayback();
    await settled();
    expect(readPlayer()).toMatchObject({ status: "paused", trackId: "a" });
    expect(element.paused).toBe(true);

    togglePlayback();
    expect(readPlayer().status).toBe("loading");
    element.arrive();
    await settled();

    expect(readPlayer()).toMatchObject({ status: "playing", trackId: "a" });
    expect(readPlayer().queue?.index).toBe(0);
    expect(readPlayer().missing.size).toBe(0);
  });

  it("other audible media starting while a clip loads pauses it without advancing", async () => {
    installBrowserAudio();

    const story = new OtherMedia();
    const page = installPage([story]);

    playQueue(tracks("a", "b"), 0);
    page.start(story);
    await settled();

    expect(readPlayer()).toMatchObject({ status: "paused", trackId: "a" });
    expect(readPlayer().queue?.index).toBe(0);
    expect(readPlayer().missing.size).toBe(0);
  });

  it("a clip that fails after the listener paused it is remembered, but the queue stays put", async () => {
    const element = installBrowserAudio();

    playQueue(tracks("a", "b"), 0);
    pausePreview();
    element.failToLoad();
    await settled();

    expect(readPlayer().missing.has("a")).toBe(true);
    expect(readPlayer()).toMatchObject({ status: "paused", trackId: "a" });
    expect(readPlayer().queue?.index).toBe(0);
  });

  it("a clip that fails while it is still wanted is still skipped", async () => {
    const element = installBrowserAudio();

    playQueue(tracks("a", "b"), 0);
    element.failToLoad();
    await settled();

    expect(readPlayer().missing.has("a")).toBe(true);
    expect(readPlayer()).toMatchObject({ status: "loading", trackId: "b" });
  });
});

describe("keep going — a late answer never overrides the listener", () => {
  async function endedQueue(element: BrowserLikeAudio): Promise<void> {
    playQueue(tracks("a"), 0);
    element.arrive();
    element.finish();
    await settled();
    expect(readPlayer().queue?.ended).toBe(true);
  }

  it("an answer that arrives after the player closed does not bring it back", async () => {
    const element = installBrowserAudio();

    await endedQueue(element);

    const answer = deferred<QueueTrack[]>();
    const outcome = keepGoing({ loadSimilar: () => answer.promise, navigate: () => {} });

    dismissPlayer();
    answer.resolve(tracks("x", "y"));

    expect(await outcome).toBe("stale");
    expect(readPlayer()).toMatchObject({ queue: undefined, status: "idle" });
  });

  it("an answer that arrives after a newer choice does not replace it", async () => {
    const element = installBrowserAudio();

    await endedQueue(element);

    const answer = deferred<QueueTrack[]>();
    const outcome = keepGoing({ loadSimilar: () => answer.promise, navigate: () => {} });

    playQueue(tracks("n"), 0);
    answer.resolve(tracks("x", "y"));

    expect(await outcome).toBe("stale");
    expect(readPlayer().queue?.tracks.map((track) => track.id)).toEqual(["n"]);
    expect(element.src).toBe("/api/preview/n");
  });

  it("an answer that arrives while the listener is still waiting plays", async () => {
    const element = installBrowserAudio();

    await endedQueue(element);

    const answer = deferred<QueueTrack[]>();
    const outcome = keepGoing({ loadSimilar: () => answer.promise, navigate: () => {} });

    answer.resolve(tracks("x", "y"));

    expect(await outcome).toBe("moved");
    expect(element.src).toBe("/api/preview/x");
  });
});

describe("media session — the lock screen belongs to the live sound", () => {
  it("hands the lock screen to other audio, and takes it back only when the listener resumes", async () => {
    const element = installBrowserAudio();
    const session = installMediaSession();
    const radio = new OtherMedia();
    const page = installPage([radio]);

    playQueue(tracks("a", "b"), 0);
    element.arrive();
    await settled();
    expect(typeof session.handlers.get("play")).toBe("function");
    expect(session.playbackState).toBe("playing");

    // The radio starts: the preview pauses and gives the lock screen up.
    page.start(radio);
    await settled();
    expect(readPlayer().status).toBe("paused");
    expect(session.handlers.get("play")).toBeNull();
    expect(session.handlers.get("nexttrack")).toBeNull();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");

    // The listener resumes the preview from the bar: the radio stops first, the session returns.
    togglePlayback();
    expect(radio.paused).toBe(true);
    expect(radio.pauses).toBe(1);
    expect(typeof session.handlers.get("play")).toBe("function");
    expect(session.metadata).not.toBeNull();
  });

  it("closing the player releases the lock screen", async () => {
    const element = installBrowserAudio();
    const session = installMediaSession();

    playQueue(tracks("a"), 0);
    element.arrive();
    await settled();
    dismissPlayer();

    expect(session.handlers.get("play")).toBeNull();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });
});
