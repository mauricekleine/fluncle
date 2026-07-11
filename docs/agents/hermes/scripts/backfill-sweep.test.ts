// Unit tests for the `fluncleJson` shell helper in backfill-sweep.ts — the parse-first
// contract that keeps a partial-failure batch RECORDED instead of discarded: a sweep
// command with per-item failures exits 1 but still prints its full JSON summary
// (`ok: false` + the counts), and the helper must return that summary rather than
// throw. The box-script sweep is self-contained (it can't import the workspace) and
// lives outside any package's test runner, so this file uses `bun:test` and is run
// directly:
//
//   bun test docs/agents/hermes/scripts/backfill-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no network). The fluncle CLI itself is stubbed
// with a tiny executable selected via FLUNCLE_BIN (read at module load, hence the
// dynamic import in beforeAll).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stub fluncle: the first arg selects the response shape; fluncleJson always
// appends --json as the last arg.
const STUB = `#!/bin/bash
case "$1" in
  ok-json) printf '{"ok":true,"lovedCount":2,"failedCount":0}\\n' ;;
  partial) printf '{"ok":false,"lovedCount":2,"failedCount":1,"skippedCount":0,"rateLimited":false,"dryRun":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  not-json) printf 'plain text\\n' ;;
esac
`;

let fluncleJson: <T>(args: string[]) => T;
let stubDir: string;

beforeAll(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "fluncle-stub-"));
  const stub = join(stubDir, "fluncle");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  process.env.FLUNCLE_BIN = stub;
  ({ fluncleJson } = await import("./backfill-sweep"));
});

afterAll(() => {
  rmSync(stubDir, { force: true, recursive: true });
});

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
