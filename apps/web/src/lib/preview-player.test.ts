import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPreviewPlayer, startPreview } from "./preview-player";

class FakeAudio {
  currentTime = 0;
  duration = Number.NaN;
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
