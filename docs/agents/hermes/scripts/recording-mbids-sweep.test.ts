import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  throttled) printf '{"ok":true,"dryRun":false,"prefixStripped":3,"resolved":["4aBcD"],"resolvedCount":1,"missed":[],"missedCount":0,"failed":[],"failedCount":0,"rateLimited":true}\\n' ;;
  partial) printf '{"ok":true,"dryRun":false,"prefixStripped":0,"resolved":["4aBcD"],"resolvedCount":1,"missed":["7xYz"],"missedCount":1,"failed":[{"error":"boom","trackId":"1qWe"}],"failedCount":1,"rateLimited":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"prefixStripped":5,"resolved":["4aBcD","9pQr"],"resolvedCount":2,"missed":["7xYz"],"missedCount":1,"failed":[],"failedCount":0,"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./recording-mbids-sweep").fluncleJson;
let runRecordingMbidsSweep: typeof import("./recording-mbids-sweep").runRecordingMbidsSweep;

function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "recording-mbids-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson, runRecordingMbidsSweep } = await import("./recording-mbids-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  failedCount?: number;
  missedCount?: number;
  ok?: boolean;
  prefixStripped?: number;
  rateLimited?: boolean;
  resolvedCount?: number;
};

describe("recording-mbids-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "recording-mbids", "--limit", "25"]);

    expect(pass.ok).toBe(true);
    expect(pass.prefixStripped).toBe(5);
    expect(pass.resolvedCount).toBe(2);
    expect(pass.missedCount).toBe(1);
    expect(pass.rateLimited).toBe(false);
  });

  test("RECORDS a pass that stopped on a vendor circuit breaker", () => {
    mode("throttled");
    const pass = fluncleJson<Pass>(["admin", "backfills", "recording-mbids"]);

    expect(pass.rateLimited).toBe(true);
    expect(pass.resolvedCount).toBe(1);
    expect(pass.prefixStripped).toBe(3);
  });

  test("RECORDS a partial batch (per-row failure, exit 1) rather than discarding it", () => {
    mode("partial");
    const pass = fluncleJson<Pass>(["admin", "backfills", "recording-mbids"]);

    expect(pass.resolvedCount).toBe(1);
    expect(pass.missedCount).toBe(1);
    expect(pass.failedCount).toBe(1);
  });

  test("keeps item failures separate from canonical run errors", () => {
    mode("partial");

    const summary = runRecordingMbidsSweep();

    expect(summary).toMatchObject({
      checked: 3,
      errors: 0,
      failed: 1,
      missed: 1,
      produced: 2,
      resolved: 1,
    });
  });

  test("emits canonical counters and omits queue depth because the bounded pass has no backlog count", () => {
    mode("ok");

    const summary = runRecordingMbidsSweep();

    expect(summary).toMatchObject({ checked: 8, errors: 0, produced: 8 });

    expect(summary).not.toHaveProperty("queue_depth");
    expect(summary).not.toHaveProperty("expected_interval_ms");
  });

  test("a command failure reports one run error without guessing work counters", () => {
    mode("cli-error");

    const summary = runRecordingMbidsSweep();

    expect(summary).toMatchObject({
      checked: null,
      errors: 1,
      failed: 0,
      ok: false,
      produced: null,
    });
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "recording-mbids"])).toThrow(
      /missing_token/,
    );
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "recording-mbids"])).toThrow(/exited 1/);
  });
});
