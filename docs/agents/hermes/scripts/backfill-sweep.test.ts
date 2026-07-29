// Unit tests for backfill-sweep.ts — two contracts.
//
// 1. The `fluncleJson` parse-first contract that keeps a partial-failure batch RECORDED
//    instead of discarded: a sweep command with per-item failures exits 1 but still prints
//    its full JSON summary (`ok: false` + the counts), and the helper must return that
//    summary rather than throw.
// 2. The TICK's leg ORDER + tally: the catalogue Apple leg runs LAST (leg 3's certified
//    rows get first call on the shared Apple meter), its counts land in the summary, and an
//    unconfigured leg is a recorded no-op rather than a failed tick.
//
// The box-script sweep is self-contained (it can't import the workspace) and lives outside
// any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/backfill-sweep.test.ts
//
// The entrypoint is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no network). The fluncle CLI itself is stubbed with a
// tiny executable selected via FLUNCLE_BIN (read at module load, hence the dynamic import in
// beforeAll).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stub fluncle. For the helper tests the FIRST arg selects the response shape; for the
// tick tests the real invocation shape (`admin backfills <source> --limit N --json`) is matched
// on the THIRD arg, and every call is appended to a log file so the test can assert the leg
// ORDER and the exact flags. A second file switches the catalogue leg's response.
//
// Both control channels are FILES with absolute paths baked into the script, not env vars: the
// sweep's own `spawnSync` passes no `env`, and under Bun a `process.env` mutation made after
// startup does not reach the child — an env-var switch silently reads as unset.
//
// fluncleJson always appends --json as the last arg.
function stubSource(callsFile: string, modeFile: string): string {
  return `#!/bin/bash
case "$1" in
  ok-json) printf '{"ok":true,"lovedCount":2,"failedCount":0}\\n' ;;
  partial) printf '{"ok":false,"lovedCount":2,"failedCount":1,"skippedCount":0,"rateLimited":false,"dryRun":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  not-json) printf 'plain text\\n' ;;
  admin)
    printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}
    case "$3" in
      discogs) printf '{"ok":true,"resolvedCount":1,"unresolvedCount":2,"skippedCount":3,"rateLimited":false}\\n' ;;
      lastfm) printf '{"ok":true,"lovedCount":4,"failedCount":0,"skippedCount":5,"rateLimited":false}\\n' ;;
      apple-music) printf '{"ok":true,"configured":true,"resolvedCount":6,"unresolvedCount":7,"failedCount":0,"skippedCount":8,"rateLimited":false}\\n' ;;
      apple-catalogue)
        mode="ok"
        if [ -f ${JSON.stringify(modeFile)} ]; then mode="$(cat ${JSON.stringify(modeFile)})"; fi
        case "$mode" in
          unconfigured) printf '{"ok":true,"configured":false,"resolvedCount":0,"unresolvedCount":0,"failedCount":0,"albumFactsWritten":0,"rateLimited":false,"breakerTripped":false}\\n' ;;
          crash) printf 'apple boom\\n' >&2; exit 1 ;;
          *) printf '{"ok":true,"configured":true,"resolvedCount":9,"unresolvedCount":10,"failedCount":11,"albumFactsWritten":12,"rateLimited":true,"breakerTripped":true}\\n' ;;
        esac
        ;;
    esac
    ;;
esac
`;
}

let fluncleJson: <T>(args: string[]) => T;
let runBackfillSweep: () => Record<string, unknown>;
let stubDir: string;
let callsFile: string;
let modeFile: string;

beforeAll(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "fluncle-stub-"));
  const stub = join(stubDir, "fluncle");
  callsFile = join(stubDir, "calls.log");
  modeFile = join(stubDir, "catalogue-mode");
  writeFileSync(stub, stubSource(callsFile, modeFile));
  chmodSync(stub, 0o755);
  process.env.FLUNCLE_BIN = stub;
  ({ fluncleJson, runBackfillSweep } = (await import("./backfill-sweep")) as unknown as {
    fluncleJson: <T>(args: string[]) => T;
    runBackfillSweep: () => Record<string, unknown>;
  });
});

afterEach(() => {
  rmSync(callsFile, { force: true });
  rmSync(modeFile, { force: true });
});

afterAll(() => {
  rmSync(stubDir, { force: true, recursive: true });
});

/** The stub's recorded invocations, one arg-string per leg, in the order they were spawned. */
function recordedCalls(): string[] {
  if (!existsSync(callsFile)) {
    return [];
  }

  return readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean);
}

describe("fluncleJson parse-first contract", () => {
  test("exit 0 with JSON returns the parsed payload", () => {
    expect(fluncleJson<{ lovedCount: number; ok: boolean }>(["ok-json"])).toEqual({
      failedCount: 0,
      lovedCount: 2,
      ok: true,
    });
  });

  test("exit 1 with a partial-failure summary RETURNS it — the counts survive", () => {
    const summary = fluncleJson<{ failedCount: number; lovedCount: number; ok: boolean }>([
      "partial",
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.lovedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
  });

  test("exit 1 with the CLI's own error payload throws with its message", () => {
    expect(() => fluncleJson(["cli-error"])).toThrow(
      "fluncle cli-error failed (missing_token): Missing required env vars: FLUNCLE_API_TOKEN",
    );
  });

  test("exit 1 with unparseable stdout throws the exit-code error (stderr attached)", () => {
    expect(() => fluncleJson(["crash"])).toThrow("fluncle crash exited 1: boom");
  });

  test("exit 0 with unparseable stdout throws the not-JSON error", () => {
    expect(() => fluncleJson(["not-json"])).toThrow("fluncle not-json did not return JSON");
  });
});

describe("the tick's legs", () => {
  test("the catalogue Apple leg runs LAST, after the certified apple-music leg", () => {
    runBackfillSweep();

    const sources = recordedCalls().map((call) => call.split(" ")[2]);

    expect(sources).toEqual(["discogs", "lastfm", "apple-music", "apple-catalogue"]);
  });

  test("the catalogue leg asks for one server pass — --limit 100, the server's own ceiling", () => {
    runBackfillSweep();

    const catalogue = recordedCalls().find((call) => call.includes("apple-catalogue"));

    expect(catalogue).toBe("admin backfills apple-catalogue --limit 100 --json");
  });

  test("the catalogue counts land in the summary under their own key", () => {
    const summary = runBackfillSweep();

    expect(summary["apple-catalogue"]).toEqual({
      albumFacts: 12,
      breakerTripped: true,
      configured: true,
      error: null,
      failed: 11,
      resolved: 9,
      throttled: true,
      unresolved: 10,
    });
  });

  test("the new leg does not disturb the three that were already there", () => {
    const summary = runBackfillSweep();

    expect(summary.discogs).toEqual({
      error: null,
      resolved: 1,
      skipped: 3,
      throttled: false,
      unresolved: 2,
    });
    expect(summary.lastfm).toEqual({
      error: null,
      failed: 0,
      loved: 4,
      skipped: 5,
      throttled: false,
    });
    expect(summary["apple-music"]).toEqual({
      configured: true,
      error: null,
      failed: 0,
      resolved: 6,
      skipped: 8,
      throttled: false,
      unresolved: 7,
    });
  });

  test("an unconfigured catalogue leg is a recorded no-op, not a failed tick", () => {
    writeFileSync(modeFile, "unconfigured");

    const summary = runBackfillSweep();

    expect(summary["apple-catalogue"]).toEqual({
      albumFacts: 0,
      breakerTripped: false,
      configured: false,
      error: null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
    });
    // The tick as a whole stays honest — the earlier legs still reported.
    expect(summary.ok).toBe(true);
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
  });

  test("a catalogue leg that crashes records its error and leaves the tick intact", () => {
    writeFileSync(modeFile, "crash");

    const summary = runBackfillSweep();

    expect((summary["apple-catalogue"] as { error: null | string }).error).toContain("apple boom");
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
  });
});
