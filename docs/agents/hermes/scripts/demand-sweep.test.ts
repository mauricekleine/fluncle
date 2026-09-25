import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fluncleJson, type DemandDeps, runDemand } from "./demand-sweep";

const noSleep = () => {};
const quietLog = () => {};

const CONFIGURED = {
  ok: true,
  summary: {
    configured: true,
    demandedArtists: 3,
    demandedLabels: 2,
    frontierPromoted: 7,
    pagesRead: 120,
    tracksScored: 41,
    unknownSlugs: 1,
  },
};

function deps(demand: DemandDeps["demand"]): DemandDeps {
  return { demand, log: quietLog, sleep: noSleep };
}

describe("demand-sweep runs ONE tick, retrying once", () => {
  test("a configured tick folds the wrapper into a one-line summary, one attempt", () => {
    let calls = 0;
    const summary = runDemand(
      deps(() => {
        calls += 1;
        return CONFIGURED;
      }),
    );

    expect(calls).toBe(1);
    expect(summary.attempts).toBe(1);
    expect(summary.ok).toBe(true);
    expect(summary.configured).toBe(true);
    expect(summary.demandedArtists).toBe(3);
    expect(summary.demandedLabels).toBe(2);
    expect(summary.tracksScored).toBe(41);
    expect(summary.frontierPromoted).toBe(7);
    expect(summary.checked).toBe(120);
    expect(summary.produced).toBe(5);
    expect(summary.errors).toBe(0);
  });

  test("an unprovisioned Worker (configured:false) is an honest, successful no-op", () => {
    const summary = runDemand(
      deps(() => ({
        ok: true,
        summary: {
          configured: false,
          demandedArtists: 0,
          demandedLabels: 0,
          frontierPromoted: 0,
          pagesRead: 0,
          tracksScored: 0,
          unknownSlugs: 0,
        },
      })),
    );

    expect(summary.ok).toBe(true);
    expect(summary.configured).toBe(false);
    expect(summary.tracksScored).toBe(0);

    expect(summary.checked).toBe(0);
    expect(summary.produced).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test("a transient fault is retried ONCE, and the retry's success wins", () => {
    let calls = 0;
    const summary = runDemand(
      deps(() => {
        calls += 1;

        if (calls === 1) {
          throw new Error("cold worker");
        }

        return CONFIGURED;
      }),
    );

    expect(calls).toBe(2);
    expect(summary.attempts).toBe(2);
    expect(summary.ok).toBe(true);
    expect(summary.error).toBeNull();
    expect(summary.tracksScored).toBe(41);
    expect(summary).toMatchObject({ checked: 120, errors: 0, produced: 5 });
  });

  test("a persistent fault fails honestly after the single retry (never a loop)", () => {
    let calls = 0;
    const summary = runDemand(
      deps(() => {
        calls += 1;
        throw new Error("worker down");
      }),
    );

    expect(calls).toBe(2);
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("worker down");
    expect(summary).toMatchObject({ checked: null, errors: 1, produced: null });
  });

  test("omits queue depth because demand is a full nightly rewrite, not a backlog walk", () => {
    const summary = runDemand(deps(() => CONFIGURED));

    expect(summary).not.toHaveProperty("queue_depth");
    expect(summary).not.toHaveProperty("expected_interval_ms");
  });
});

describe("demand-sweep parses the CLI wrapper", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "demand-sweep-"));
  });

  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  test("the CLI's own error payload throws (a failed command)", () => {
    const bin = join(dir, "fluncle");
    writeFileSync(
      bin,
      `#!/bin/bash\nprintf '{"code":"missing_token","message":"Missing required env vars","ok":false}\\n'\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    process.env.FLUNCLE_BIN = bin;

    expect(() => fluncleJson(["admin", "catalogue", "demand"])).toThrow(/missing_token/);
  });
});
