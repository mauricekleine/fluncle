import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  partial) printf '{"ok":true,"kind":"album","dryRun":false,"resolved":["some-album"],"resolvedCount":1,"none":["bare-album"],"noneCount":1,"failed":[{"error":"boom","slug":"flaky-album"}],"failedCount":1,"rateLimited":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  artist-pending) case " $* " in *" --kind artist "*) printf '{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\\n'; exit 1 ;; *) printf '{"ok":true,"kind":"album","dryRun":false,"resolved":["some-album","other-album"],"resolvedCount":2,"none":["bare-album"],"noneCount":1,"failed":[],"failedCount":0,"rateLimited":false}\\n' ;; esac ;;
  generic-fault) printf '{"code":"error","message":"Internal error","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"kind":"album","dryRun":false,"resolved":["some-album","other-album"],"resolvedCount":2,"none":["bare-album"],"noneCount":1,"failed":[],"failedCount":0,"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./cover-masters-sweep").fluncleJson;
let main: typeof import("./cover-masters-sweep").main;

function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cover-masters-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson, main } = await import("./cover-masters-sweep"));
});

function run(): Record<string, unknown> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);

  try {
    main();
  } finally {
    console.log = original;
  }

  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

describe("cover-masters-sweep's canonical counters", () => {
  test("resolved + terminal-none are produced; per-entity failures remain failed", () => {
    mode("partial");

    expect(run()).toMatchObject({
      checked: 6,
      errors: 0,
      failed: 2,
      none: 2,
      produced: 4,
      resolved: 2,
    });
  });

  test("a run failure is errors:1 and never invents queue depth", () => {
    mode("crash");
    const summary = run();

    expect(summary).toMatchObject({ checked: 0, errors: 1, failed: 0, ok: false, produced: 0 });

    expect(summary).not.toHaveProperty("queue_depth");
  });

  test("a kind the Worker defers mid-pass keeps the drained kind's counts and pauses as partial", () => {
    mode("artist-pending");

    expect(run()).toMatchObject({
      checked: 3,
      errors: 0,
      failed: 0,
      gateState: "paused",
      none: 1,
      ok: true,
      partial: true,
      produced: 3,
      reason: "due_work_repair_pending",
      resolved: 2,
      throttled: true,
    });
  });

  test("a generic Worker fault stays a run error, never a pause", () => {
    mode("generic-fault");
    const summary = run();

    expect(summary).toMatchObject({ errors: 1, ok: false });
    expect(summary).not.toHaveProperty("gateState");
  });
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  resolvedCount?: number;
};

describe("cover-masters-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>([
      "admin",
      "backfills",
      "cover-masters",
      "--kind",
      "album",
      "--limit",
      "24",
    ]);

    expect(pass.ok).toBe(true);
    expect(pass.resolvedCount).toBe(2);
    expect(pass.noneCount).toBe(1);
  });

  test("RECORDS a partial batch (per-entity failure, exit 1) rather than discarding it", () => {
    mode("partial");
    const pass = fluncleJson<Pass>(["admin", "backfills", "cover-masters", "--kind", "artist"]);

    expect(pass.resolvedCount).toBe(1);
    expect(pass.noneCount).toBe(1);
    expect(pass.failedCount).toBe(1);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() =>
      fluncleJson<Pass>(["admin", "backfills", "cover-masters", "--kind", "album"]),
    ).toThrow(/missing_token/);
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() =>
      fluncleJson<Pass>(["admin", "backfills", "cover-masters", "--kind", "album"]),
    ).toThrow(/exited 1/);
  });
});
