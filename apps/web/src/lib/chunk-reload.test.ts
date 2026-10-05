import { describe, expect, it, vi } from "vitest";
import { createChunkReloadGuard } from "./chunk-reload";

function setup() {
  const store = new Map<string, string>();
  const clock = { at: 1_000_000 };
  const location = { href: "https://www.fluncle.com/tracks", reload: vi.fn() };
  const storage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
  };
  const deps = { location, now: () => clock.at, storage };

  return { clock, deps, guard: createChunkReloadGuard(deps), location, store };
}

function preloadError() {
  return new Event("vite:preloadError", { cancelable: true });
}

describe("createChunkReloadGuard", () => {
  it("records and cancels the first failure before reloading", () => {
    const { clock, guard, location, store } = setup();
    const event = preloadError();

    expect(guard.isReloading()).toBe(false);
    location.reload.mockImplementation(() => {
      expect(guard.isReloading()).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(JSON.parse(store.get("fluncle-chunk-reload") ?? "null")).toEqual({
        at: clock.at,
        href: location.href,
      });
    });

    guard.handlePreloadError(event);

    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(guard.isReloading()).toBe(true);
  });

  it("lets a repeated failure on the same URL propagate after a fresh reload", () => {
    const { clock, deps, guard, location } = setup();

    guard.handlePreloadError(preloadError());
    clock.at += 59_999;
    const afterReload = createChunkReloadGuard(deps);
    const event = preloadError();

    afterReload.handlePreloadError(event);

    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(afterReload.isReloading()).toBe(false);
  });

  it("allows the same URL to reload again once the window expires", () => {
    const { clock, deps, guard, location } = setup();

    guard.handlePreloadError(preloadError());
    clock.at += 60_000;
    const afterReload = createChunkReloadGuard(deps);
    const event = preloadError();

    afterReload.handlePreloadError(event);

    expect(location.reload).toHaveBeenCalledTimes(2);
    expect(event.defaultPrevented).toBe(true);
    expect(afterReload.isReloading()).toBe(true);
  });

  it("reloads a different URL within the window", () => {
    const { deps, guard, location } = setup();

    guard.handlePreloadError(preloadError());
    location.href = "https://www.fluncle.com/artists";
    const afterReload = createChunkReloadGuard(deps);
    const event = preloadError();

    afterReload.handlePreloadError(event);

    expect(location.reload).toHaveBeenCalledTimes(2);
    expect(event.defaultPrevented).toBe(true);
    expect(afterReload.isReloading()).toBe(true);
  });

  it.each(["getItem", "setItem"] as const)(
    "lets the error propagate when storage %s throws",
    (method) => {
      const { deps, guard, location } = setup();
      vi.spyOn(deps.storage, method).mockImplementation(() => {
        throw new Error("storage blocked");
      });
      const event = preloadError();

      expect(() => guard.handlePreloadError(event)).not.toThrow();

      expect(location.reload).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(guard.isReloading()).toBe(false);
    },
  );

  it("lets the error propagate when sessionStorage itself is unavailable", () => {
    const { deps, location } = setup();
    const guard = createChunkReloadGuard({
      ...deps,
      get storage(): never {
        throw new Error("storage blocked");
      },
    });
    const event = preloadError();

    expect(() => guard.handlePreloadError(event)).not.toThrow();

    expect(location.reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(guard.isReloading()).toBe(false);
  });

  it.each([
    "not json",
    "https://www.fluncle.com/tracks",
    "null",
    "{}",
    '{"href":"https://www.fluncle.com/tracks","at":"recent"}',
  ])("treats a corrupt record as absent: %s", (value) => {
    const { guard, location, store } = setup();
    store.set("fluncle-chunk-reload", value);
    const event = preloadError();

    guard.handlePreloadError(event);

    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(guard.isReloading()).toBe(true);
  });
});
