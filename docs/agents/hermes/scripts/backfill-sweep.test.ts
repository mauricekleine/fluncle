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
function stubSource(
  callsFile: string,
  modeFile: string,
  beatportModeFile: string,
  discogsFactsModeFile: string,
): string {
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
      discogs) printf '{"ok":true,"resolvedCount":1,"unresolvedCount":2,"skippedCount":3,"rateLimited":true,"rateLimitedBy":"musicbrainz"}\\n' ;;
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
      beatport)
        mode="ok"
        if [ -f ${JSON.stringify(beatportModeFile)} ]; then mode="$(cat ${JSON.stringify(beatportModeFile)})"; fi
        case "$mode" in
          unconfigured) printf '{"ok":true,"configured":false,"resolvedCount":0,"unresolvedCount":0,"failedCount":0,"skippedCount":0}\\n' ;;
          crash) printf 'beatport boom\\n' >&2; exit 1 ;;
          *) printf '{"ok":true,"configured":true,"resolvedCount":13,"unresolvedCount":14,"failedCount":15,"skippedCount":16}\\n' ;;
        esac
        ;;
      discogs-facts)
        mode="ok"
        if [ -f ${JSON.stringify(discogsFactsModeFile)} ]; then mode="$(cat ${JSON.stringify(discogsFactsModeFile)})"; fi
        case "$mode" in
          unconfigured) printf '{"ok":true,"configured":false,"resolvedCount":0,"noneCount":0,"failedCount":0,"rateLimited":false}\\n' ;;
          crash) printf 'discogs facts boom\\n' >&2; exit 1 ;;
          *) printf '{"ok":true,"configured":true,"resolvedCount":17,"noneCount":18,"failedCount":19,"rateLimited":true}\\n' ;;
        esac
        ;;
    esac
    ;;
esac
`;
}

let fluncleJson: <T>(args: string[]) => T;
let runBackfillSweep: () => Record<string, unknown>;
let backfillSweepExitCode: (summary: { ok: boolean }) => 0 | 1;
let stubDir: string;
let callsFile: string;
let modeFile: string;
let beatportModeFile: string;
let discogsFactsModeFile: string;

beforeAll(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "fluncle-stub-"));
  const stub = join(stubDir, "fluncle");
  callsFile = join(stubDir, "calls.log");
  modeFile = join(stubDir, "catalogue-mode");
  beatportModeFile = join(stubDir, "beatport-mode");
  discogsFactsModeFile = join(stubDir, "discogs-facts-mode");
  writeFileSync(stub, stubSource(callsFile, modeFile, beatportModeFile, discogsFactsModeFile));
  chmodSync(stub, 0o755);
  process.env.FLUNCLE_BIN = stub;
  ({ backfillSweepExitCode, fluncleJson, runBackfillSweep } =
    (await import("./backfill-sweep")) as unknown as {
      backfillSweepExitCode: (summary: { ok: boolean }) => 0 | 1;
      fluncleJson: <T>(args: string[]) => T;
      runBackfillSweep: () => Record<string, unknown>;
    });
});

afterEach(() => {
  rmSync(callsFile, { force: true });
  rmSync(modeFile, { force: true });
  rmSync(beatportModeFile, { force: true });
  rmSync(discogsFactsModeFile, { force: true });
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

    expect(sources).toEqual([
      "discogs",
      "lastfm",
      "apple-music",
      "apple-catalogue",
      "beatport",
      "discogs-facts",
    ]);
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
    expect(summary.musicbrainz).toEqual({ throttled: true });
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

  test("a catalogue leg that crashes records its error and makes the tick report failure", () => {
    writeFileSync(modeFile, "crash");

    const summary = runBackfillSweep();

    expect((summary["apple-catalogue"] as { error: null | string }).error).toContain("apple boom");
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
    expect(summary.ok).toBe(false);
    expect(backfillSweepExitCode(summary as { ok: boolean })).toBe(1);
  });

  test("the Beatport leg asks for the smallest batch in the sweep — one rendered scrape each", () => {
    runBackfillSweep();

    const beatport = recordedCalls().find((call) => call.includes("beatport"));

    expect(beatport).toBe("admin backfills beatport --limit 10 --json");
  });

  test("the Beatport counts land in the summary under their own key", () => {
    const summary = runBackfillSweep();

    expect(summary.beatport).toEqual({
      configured: true,
      error: null,
      failed: 15,
      resolved: 13,
      skipped: 16,
      unresolved: 14,
    });
  });

  test("an unconfigured Beatport leg is a recorded no-op, not a failed tick", () => {
    writeFileSync(beatportModeFile, "unconfigured");

    const summary = runBackfillSweep();

    expect(summary.beatport).toEqual({
      configured: false,
      error: null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      unresolved: 0,
    });
    expect(summary.ok).toBe(true);
  });

  test("a Beatport leg that crashes records its error and leaves every earlier leg intact", () => {
    // The containment that matters: Beatport is the newest and slowest leg, and it reaches a
    // Cloudflare-walled site through a third party. It must never be able to cost the sweep the
    // four legs that ran before it.
    writeFileSync(beatportModeFile, "crash");

    const summary = runBackfillSweep();

    expect((summary.beatport as { error: null | string }).error).toContain("beatport boom");
    expect((summary["apple-music"] as { resolved: number }).resolved).toBe(6);
    expect((summary["apple-catalogue"] as { resolved: number }).resolved).toBe(9);
    expect((summary.discogs as { resolved: number }).resolved).toBe(1);
  });

  test("the Discogs-facts leg runs LAST and asks for its own small batch", () => {
    // The order is the priority: this leg shares leg 1's Discogs rate window, and leg 1's
    // release-ID resolves (which a finding's public `sameAs` depends on) must get first call on it.
    runBackfillSweep();

    const calls = recordedCalls();
    const facts = calls.find((call) => call.includes("discogs-facts"));

    expect(facts).toBe("admin backfills discogs-facts --limit 10 --json");
    expect(calls.at(-1)).toBe(facts);
  });

  test("the Discogs-facts counts land in the summary under their own key", () => {
    const summary = runBackfillSweep();

    expect(summary["discogs-facts"]).toEqual({
      configured: true,
      error: null,
      failed: 19,
      none: 18,
      resolved: 17,
      throttled: true,
    });
  });

  test("an unconfigured Discogs-facts leg is a recorded no-op, not a failed tick", () => {
    writeFileSync(discogsFactsModeFile, "unconfigured");

    const summary = runBackfillSweep();

    expect(summary["discogs-facts"]).toEqual({
      configured: false,
      error: null,
      failed: 0,
      none: 0,
      resolved: 0,
      throttled: false,
    });
    expect(summary.ok).toBe(true);
  });

  test("a Discogs-facts leg that crashes records its error and leaves every earlier leg intact", () => {
    writeFileSync(discogsFactsModeFile, "crash");

    const summary = runBackfillSweep();

    expect((summary["discogs-facts"] as { error: null | string }).error).toContain(
      "discogs facts boom",
    );
    expect((summary.discogs as { resolved: number }).resolved).toBe(1);
    expect((summary.beatport as { resolved: number }).resolved).toBe(13);
  });
});
