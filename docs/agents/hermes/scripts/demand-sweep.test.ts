// Unit tests for demand-sweep.ts — the `--no-agent` nightly demand cron.
//
// Two contracts worth pinning. (1) THE SINGLE PASS WITH ONE RETRY: unlike rank (which loops while
// a backlog drains), a demand tick is one `fluncle admin catalogue demand` call — but unlike reach,
// it retries ONCE on a thrown fault (a cold Worker / an SA blip) so a nightly signal doesn't skip a
// whole day on a transient. Never a loop. (2) THE HONEST no-op: an unprovisioned Worker returns
// `configured: false`, which is a successful tick, not a failure. `runDemand` takes injected effects
// so both are provable with a stub — no network, no real spawn.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/demand-sweep.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fluncleJson, type DemandDeps, runDemand } from "./demand-sweep";

/** A no-op sleep — the retry backoff must never actually block a test. */
const noSleep = () => {};
const quietLog = () => {};

/** A configured tick that scored some rows. */
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
  test("a configured tick folds the envelope into a one-line summary, one attempt", () => {
    let calls = 0;
    const summary = runDemand(
      deps(() => {
        calls += 1;
        return CONFIGURED;
      }),
    );

    expect(calls).toBe(1); // one pass, no drain loop
    expect(summary.attempts).toBe(1);
    expect(summary.ok).toBe(true);
    expect(summary.configured).toBe(true);
    expect(summary.demandedArtists).toBe(3);
    expect(summary.demandedLabels).toBe(2);
    expect(summary.tracksScored).toBe(41);
    expect(summary.frontierPromoted).toBe(7);
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

    expect(summary.ok).toBe(true); // a missing SA key is not a fault
    expect(summary.configured).toBe(false);
    expect(summary.tracksScored).toBe(0);
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

    expect(calls).toBe(2); // first threw, retried once
    expect(summary.attempts).toBe(2);
    expect(summary.ok).toBe(true);
    expect(summary.error).toBeNull();
    expect(summary.tracksScored).toBe(41);
  });

  test("a persistent fault fails honestly after the single retry (never a loop)", () => {
    let calls = 0;
    const summary = runDemand(
      deps(() => {
        calls += 1;
        throw new Error("worker down");
      }),
    );

    expect(calls).toBe(2); // exactly two attempts — one retry, then stop
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("worker down");
  });
});

describe("demand-sweep parses the CLI envelope", () => {
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
