// Unit tests for the `fluncleJson` shell helper in artist-sweep.ts — the same
// parse-first contract as backfill-sweep.ts (the box scripts are deliberately
// self-contained, so the helper is duplicated and pinned in both): a partial-failure
// batch (`ok: false`, exit 1) is RETURNED with its counts intact; only a true crash
// (no parseable JSON) or the CLI's own error payload throws. Run directly:
//
//   bun test docs/agents/hermes/scripts/artist-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no network).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stub fluncle: the first arg selects the response shape; fluncleJson always
// appends --json as the last arg.
const STUB = `#!/bin/bash
case "$1" in
  ok-json) printf '{"ok":true,"filledCount":3,"skippedCount":1}\\n' ;;
  partial) printf '{"ok":false,"filledCount":3,"failedCount":2,"skippedCount":1,"dryRun":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  not-json) printf 'plain text\\n' ;;
  admin)
    if [[ "$2" == "artists" && "$3" == "resolve" && "$4" == "--queue" ]]; then
      if [[ "\${ARTIST_STUB_FATAL:-0}" == "1" ]]; then
        printf 'queue unavailable\\n' >&2
        exit 1
      fi
      printf '{"artists":[{"artistId":"social-1","name":"One"},{"artistId":"social-2","name":"Two"}]}\\n'
    elif [[ "$2" == "artists" && "$3" == "resolve" && "$4" == "social-1" ]]; then
      if [[ "\${ARTIST_STUB_RATE_LIMITED:-0}" == "1" ]]; then
        printf '{"artistId":"social-1","mbid":null,"ok":true,"rateLimited":true,"socialsCount":0}\\n'
      else
        printf '{"artistId":"social-1","mbid":"mbid-1","ok":true,"rateLimited":false,"socialsCount":2}\\n'
      fi
    elif [[ "$2" == "artists" && "$3" == "resolve" && "$4" == "social-2" ]]; then
      printf '{"artistId":"social-2","mbid":"mbid-2","ok":true,"rateLimited":false,"socialsCount":0}\\n'
    elif [[ "$2" == "backfills" && "$3" == "artist-images" ]]; then
      if [[ "\${ARTIST_STUB_RATE_LIMITED:-0}" == "1" ]]; then
        printf '{"budgetLimited":false,"checkedCount":0,"dryRun":false,"failed":[],"failedCount":0,"filled":[],"filledCount":0,"nextCursor":null,"ok":true,"queueDepth":0,"rateLimited":false,"skipped":[],"skippedCount":0}\\n'
      else
        printf '{"budgetLimited":true,"checkedCount":9,"dryRun":false,"failed":[{"artistId":"image-fail-1","error":"spotify 500"},{"artistId":"image-fail-2","error":"spotify 502"}],"failedCount":2,"filled":["image-1","image-2","image-3"],"filledCount":3,"nextCursor":"image-9","ok":false,"queueDepth":12,"rateLimited":true,"skipped":["skip-1","skip-2","skip-3","skip-4"],"skippedCount":4}\\n'
        exit 1
      fi
    fi
    ;;
esac
`;

let fluncleJson: <T>(args: string[]) => T;
let stubDir: string;
const sweepPath = new URL("./artist-sweep.ts", import.meta.url).pathname;

beforeAll(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "fluncle-stub-"));
  const stub = join(stubDir, "fluncle");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  process.env.FLUNCLE_BIN = stub;
  ({ fluncleJson } = await import("./artist-sweep"));
});

afterAll(() => {
  rmSync(stubDir, { force: true, recursive: true });
});

describe("fluncleJson parse-first contract (artist-sweep copy)", () => {
  test("exit 0 with JSON returns the parsed payload", () => {
    expect(fluncleJson<{ filledCount: number; ok: boolean }>(["ok-json"])).toEqual({
      filledCount: 3,
      ok: true,
      skippedCount: 1,
    });
  });

  test("exit 1 with a partial-failure summary RETURNS it — the counts survive", () => {
    const summary = fluncleJson<{ failedCount: number; filledCount: number; ok: boolean }>([
      "partial",
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.filledCount).toBe(3);
    expect(summary.failedCount).toBe(2);
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

test("main preserves image failures, skips, throttle state, and canonical run counters", async () => {
  const proc = Bun.spawn([process.execPath, sweepPath], {
    env: {
      ...process.env,
      FLUNCLE_BIN: join(stubDir, "fluncle"),
      NODE_ENV: "test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).toBe(0);

  const summary = JSON.parse(stdout) as Record<string, unknown>;
  expect(summary).toMatchObject({
    batch: 2,
    checked: 11,
    errors: 0,
    expected_interval_ms: 3_600_000,
    failed: 2,
    imagesBudgetLimited: true,
    imagesChecked: 9,
    imagesFailed: 2,
    imagesFilled: 3,
    imagesRateLimited: true,
    imagesSkipped: 4,
    noop: 1,
    ok: true,
    processed: 2,
    produced: 9,
    queueRemaining: 0,
    queue_depth: 12,
    resolved: 1,
    throttled: true,
  });
});

test("a genuine artist run failure reports errors:1 and exits non-zero", async () => {
  const proc = Bun.spawn([process.execPath, sweepPath], {
    env: {
      ...process.env,
      ARTIST_STUB_FATAL: "1",
      FLUNCLE_BIN: join(stubDir, "fluncle"),
      NODE_ENV: "test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    errors: 1,
    ok: false,
    reason: "artist_failed",
  });
});

test("a MusicBrainz circuit-breaker yield is not a failed artist", async () => {
  const proc = Bun.spawn([process.execPath, sweepPath], {
    env: {
      ...process.env,
      ARTIST_STUB_RATE_LIMITED: "1",
      FLUNCLE_BIN: join(stubDir, "fluncle"),
      NODE_ENV: "test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    batch: 1,
    checked: 1,
    failed: 0,
    ok: true,
    queueRemaining: 2,
    resolved: 0,
    throttled: true,
  });
});
