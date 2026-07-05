import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type NextToPostCard } from "./contract";
import { type GatheredPosting } from "./posting-state";
import {
  createNudgeScheduler,
  fileNudgeStore,
  type NudgeConfig,
  type NudgeStore,
  parseNudgeState,
  readNudgeConfig,
} from "./scheduler";

const HOUR = 3_600_000;

function card(): NextToPostCard {
  return {
    addedAt: "2026-07-06T00:00:00Z",
    adminUrl: "https://www.fluncle.com/admin",
    ageMinutes: 120,
    artistTitle: "Artist — Title",
    caption: "a caption",
    coverUrl: undefined,
    logId: "001.1.1A",
    logUrl: "https://www.fluncle.com/log/001.1.1A",
    postAssetUrl: "https://found.fluncle.com/001.1.1A/footage.social.mp4",
    title: "Title",
  };
}

function state(opts: { hasNext: boolean; newestPostedAt: number | null }): GatheredPosting {
  return {
    candidates: [],
    gatheredAt: Date.now(),
    newestPostedAt: opts.newestPostedAt,
    nextToPost: opts.hasNext ? card() : undefined,
  };
}

function fakeNotify() {
  const calls: Array<{ body: string; title: string }> = [];

  return {
    calls,
    notify: (title: string, body: string): Promise<void> => {
      calls.push({ body, title });

      return Promise.resolve();
    },
  };
}

const CONFIG: NudgeConfig = {
  disabled: false,
  intervalMs: HOUR,
  thresholdHours: 18,
  timeZone: "UTC",
};

describe("readNudgeConfig", () => {
  test("defaults: 18h threshold, hourly, enabled, a real zone", () => {
    const config = readNudgeConfig({});

    expect(config.thresholdHours).toBe(18);
    expect(config.intervalMs).toBe(HOUR);
    expect(config.disabled).toBe(false);
    expect(config.timeZone.length).toBeGreaterThan(0);
  });

  test("reads overrides off the environment", () => {
    const config = readNudgeConfig({
      FLUNCLE_HELM_NUDGE_DISABLED: "1",
      FLUNCLE_HELM_NUDGE_HOURS: "6",
      FLUNCLE_HELM_NUDGE_INTERVAL_MS: "1000",
      FLUNCLE_HELM_NUDGE_TZ: "America/Los_Angeles",
    });

    expect(config).toEqual({
      disabled: true,
      intervalMs: 1000,
      thresholdHours: 6,
      timeZone: "America/Los_Angeles",
    });
  });

  test("a garbage threshold falls back to the default", () => {
    expect(readNudgeConfig({ FLUNCLE_HELM_NUDGE_HOURS: "nope" }).thresholdHours).toBe(18);
    expect(readNudgeConfig({ FLUNCLE_HELM_NUDGE_HOURS: "-4" }).thresholdHours).toBe(18);
  });
});

describe("createNudgeScheduler", () => {
  test("a dry check never notifies", async () => {
    const { calls, notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: CONFIG, notify });

    const result = await scheduler.check(state({ hasNext: true, newestPostedAt: 0 }), {
      fire: false,
    });

    expect(result.decision.fire).toBe(true); // stale: it WOULD fire…
    expect(result.notified).toBe(false); // …but a dry check holds.
    expect(calls).toHaveLength(0);
  });

  test("a natural fire notifies once, then dedupes for the day", async () => {
    const { calls, notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: CONFIG, notify });
    const ancient = state({ hasNext: true, newestPostedAt: 0 });

    const first = await scheduler.check(ancient, { fire: true });
    const second = await scheduler.check(ancient, { fire: true });

    expect(first.notified).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.title).toBe("Artist — Title");
    expect(second.notified).toBe(false);
    expect(second.decision.fire).toBe(false);
    expect(second.decision.reason).toBe("already-nudged-today");
  });

  test("nothing unposted → never notifies", async () => {
    const { calls, notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: CONFIG, notify });

    const result = await scheduler.check(state({ hasNext: false, newestPostedAt: 0 }), {
      fire: true,
    });

    expect(result.notified).toBe(false);
    expect(result.decision.reason).toBe("no-unposted");
    expect(calls).toHaveLength(0);
  });

  test("a forced fire bypasses freshness AND dedupe (the test hook)", async () => {
    const { calls, notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: CONFIG, notify });
    // Freshly posted — a natural tick would hold. Forced, it fires anyway…
    const fresh = state({ hasNext: true, newestPostedAt: Date.now() });

    const first = await scheduler.check(fresh, { fire: true, force: true });
    const second = await scheduler.check(fresh, { fire: true, force: true });

    expect(first.notified).toBe(true);
    // …and never arms the per-day dedupe, so it can fire again.
    expect(second.notified).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("osascript refusing leaves the dedupe unarmed so a retry can fire", async () => {
    let attempts = 0;
    const scheduler = createNudgeScheduler({
      config: CONFIG,
      notify: () => {
        attempts += 1;

        return Promise.reject(new Error("not authorised"));
      },
    });
    const ancient = state({ hasNext: true, newestPostedAt: 0 });

    const first = await scheduler.check(ancient, { fire: true });
    const second = await scheduler.check(ancient, { fire: true });

    expect(first.notified).toBe(false);
    expect(second.notified).toBe(false);
    expect(attempts).toBe(2); // it retried rather than marking the day done
  });

  test("status reports the decision without firing", async () => {
    const { calls, notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: CONFIG, notify });

    const status = scheduler.status(state({ hasNext: true, newestPostedAt: 0 }), Date.now());

    expect(status.wouldFire).toBe(true);
    expect(status.reason).toBe("stale");
    expect(status.thresholdHours).toBe(18);
    expect(calls).toHaveLength(0);
  });

  test("a disabled scheduler never starts the interval", () => {
    const { notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: { ...CONFIG, disabled: true }, notify });

    let gathered = false;
    scheduler.start(() => {
      gathered = true;

      return Promise.resolve(state({ hasNext: true, newestPostedAt: 0 }));
    });
    scheduler.stop();

    expect(gathered).toBe(false);
  });
});

function memoryStore(initial: string | null = null): NudgeStore & { saved: string[] } {
  let day = initial;
  const saved: string[] = [];

  return {
    load: () => day,
    save(value) {
      day = value;
      saved.push(value);
    },
    saved,
  };
}

describe("the persisted dedupe (L10)", () => {
  test("a natural fire persists the day, and a fresh scheduler on the same store stays deduped — the restart case", async () => {
    const store = memoryStore();
    const first = fakeNotify();
    const before = createNudgeScheduler({ config: CONFIG, notify: first.notify, store });
    const ancient = state({ hasNext: true, newestPostedAt: 0 });

    const fired = await before.check(ancient, { fire: true });

    expect(fired.notified).toBe(true);
    expect(store.saved).toHaveLength(1);

    // The daemon restarts: a new scheduler over the SAME store must not re-nudge.
    const second = fakeNotify();
    const after = createNudgeScheduler({ config: CONFIG, notify: second.notify, store });
    const again = await after.check(ancient, { fire: true });

    expect(again.notified).toBe(false);
    expect(again.decision.reason).toBe("already-nudged-today");
    expect(second.calls).toHaveLength(0);
  });

  test("a forced fire never touches the store (a synthetic clock persists nothing)", async () => {
    const store = memoryStore();
    const { notify } = fakeNotify();
    const scheduler = createNudgeScheduler({ config: CONFIG, notify, store });

    await scheduler.check(state({ hasNext: true, newestPostedAt: Date.now() }), {
      fire: true,
      force: true,
    });

    expect(store.saved).toHaveLength(0);
  });

  test("parseNudgeState: the happy shape, and every malformation reads as never-nudged", () => {
    expect(parseNudgeState('{"lastNudgeDay":"2026-07-06"}')).toBe("2026-07-06");
    expect(parseNudgeState('{"lastNudgeDay":""}')).toBeNull();
    expect(parseNudgeState('{"lastNudgeDay":7}')).toBeNull();
    expect(parseNudgeState("{}")).toBeNull();
    expect(parseNudgeState("null")).toBeNull();
    expect(parseNudgeState("not json")).toBeNull();
  });

  test("fileNudgeStore round-trips through the disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "helm-nudge-")), "nested", "helm-nudge.json");
    const store = fileNudgeStore(path);

    expect(store.load()).toBeNull();

    store.save("2026-07-06");

    expect(store.load()).toBe("2026-07-06");
    expect(fileNudgeStore(path).load()).toBe("2026-07-06");
  });
});
