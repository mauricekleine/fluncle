import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  throttled) printf '{"ok":true,"dryRun":false,"resolved":["hospital-records"],"resolvedCount":1,"none":[],"noneCount":0,"failed":[],"failedCount":0,"unmatchedParents":2,"rateLimited":true}\\n' ;;
  partial) printf '{"ok":true,"dryRun":false,"resolved":["med-school"],"resolvedCount":1,"none":["tiny-imprint"],"noneCount":1,"failed":[{"error":"boom","slug":"broke"}],"failedCount":1,"unmatchedParents":0,"rateLimited":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"resolved":["med-school","hospital-records"],"resolvedCount":2,"none":["tiny-imprint"],"noneCount":1,"failed":[],"failedCount":0,"unmatchedParents":1,"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./label-lineage-sweep").fluncleJson;
let runLabelLineageSweep: typeof import("./label-lineage-sweep").runLabelLineageSweep;

function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "label-lineage-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson, runLabelLineageSweep } = await import("./label-lineage-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
  unmatchedParents?: number;
};

describe("label-lineage-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-lineage", "--limit", "25"]);

    expect(pass.ok).toBe(true);
    expect(pass.resolvedCount).toBe(2);
    expect(pass.noneCount).toBe(1);
    expect(pass.unmatchedParents).toBe(1);
    expect(pass.rateLimited).toBe(false);
  });

  test("RECORDS a pass that stopped on a vendor circuit breaker", () => {
    mode("throttled");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-lineage"]);

    expect(pass.rateLimited).toBe(true);
    expect(pass.resolvedCount).toBe(1);
    expect(pass.unmatchedParents).toBe(2);
  });

  test("RECORDS a partial batch (per-row failure, exit 1) rather than discarding it", () => {
    mode("partial");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-lineage"]);

    expect(pass.resolvedCount).toBe(1);
    expect(pass.noneCount).toBe(1);
    expect(pass.failedCount).toBe(1);
  });

  test("keeps item failures separate from canonical run errors", () => {
    mode("partial");

    const summary = runLabelLineageSweep();

    expect(summary).toMatchObject({
      checked: 3,
      errors: 0,
      failed: 1,
      none: 1,
      produced: 2,
      resolved: 1,
    });
  });

  test("emits canonical counters and omits queue depth because the bounded pass has no backlog count", () => {
    mode("ok");

    const summary = runLabelLineageSweep();

    expect(summary).toMatchObject({ checked: 3, errors: 0, produced: 3 });

    expect(summary).not.toHaveProperty("queue_depth");
    expect(summary).not.toHaveProperty("expected_interval_ms");
  });

  test("a command failure reports one run error without guessing work counters", () => {
    mode("cli-error");

    const summary = runLabelLineageSweep();

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

    expect(() => fluncleJson<Pass>(["admin", "backfills", "label-lineage"])).toThrow(
      /missing_token/,
    );
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "label-lineage"])).toThrow(/exited 1/);
  });
});
