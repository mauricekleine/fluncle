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
