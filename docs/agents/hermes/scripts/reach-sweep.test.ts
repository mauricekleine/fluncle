// Unit tests for reach-sweep.ts — the `--no-agent` daily /reach snapshot cron.
//
// The contract worth pinning is the SINGLE COLLECT: unlike rank (which loops while a backlog
// drains), a daily snapshot is one idempotent `fluncle admin reach collect` call. So the sweep
// makes exactly one call, folds the envelope into a one-line JSON summary (inserted / landed /
// skipped), stays `ok` when platforms are merely skipped (a held-back key is not a failure),
// and reports `ok:false` when the collect genuinely fails.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside
// any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/reach-sweep.test.ts
//
// The fluncle CLI is stubbed with a tiny executable selected via FLUNCLE_BIN. A mode FILE beside
// it selects the response shape (Bun's spawnSync snapshots the environment, so the mode cannot
// ride on an env var), and a COUNTER file proves the sweep makes exactly one call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
DIR="$(dirname "$0")"
N=$(cat "$DIR/count" 2>/dev/null || echo 0)
N=$((N + 1))
echo "$N" > "$DIR/count"
case "$(cat "$DIR/mode")" in
  # A full snapshot: two platforms landed, one skipped, four rows written.
  full) printf '{"ok":true,"inserted":4,"collected":[{"platform":"mixcloud","metrics":["followers","listens"]},{"platform":"bluesky","metrics":["followers","posts"]}],"skipped":[{"platform":"tiktok","reason":"no oauth"}]}\\n' ;;
  # A same-day re-run: everything already snapshotted, nothing new written — a safe no-op.
  noop) printf '{"ok":true,"inserted":0,"collected":[{"platform":"mixcloud","metrics":["followers"]}],"skipped":[]}\\n' ;;
  # Every platform skipped (all keys held back) — still a successful tick, just an empty one.
  all-skipped) printf '{"ok":true,"inserted":0,"collected":[],"skipped":[{"platform":"tiktok","reason":"no oauth"},{"platform":"instagram","reason":"no oauth"}]}\\n' ;;
  # The Worker reported a hard stop.
  worker-fail) printf '{"ok":false,"inserted":0,"collected":[],"skipped":[]}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
esac
`;

let dir: string;
let main: typeof import("./reach-sweep").main;
let fluncleJson: typeof import("./reach-sweep").fluncleJson;

function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
  writeFileSync(join(dir, "count"), "0");
}

function calls(): number {
  return Number(readFileSync(join(dir, "count"), "utf8").trim());
}

/** Capture the sweep's one JSON summary line. */
function run(): Record<string, unknown> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);

  try {
    main();
  } finally {
    console.log = log;
  }

  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reach-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("full");

  ({ fluncleJson, main } = await import("./reach-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("reach-sweep takes ONE daily snapshot", () => {
  test("one collect → a folded summary (inserted / landed / skipped)", () => {
    mode("full");
    const summary = run();

    expect(calls()).toBe(1); // a snapshot is a single call, never a drain loop
    expect(summary.inserted).toBe(4);
    expect(summary.landed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.ok).toBe(true);
  });

  test("a same-day re-run is a safe no-op (inserted 0, still ok)", () => {
    mode("noop");
    const summary = run();

    expect(calls()).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(summary.ok).toBe(true);
  });

  test("every platform skipped is an honest, successful empty tick", () => {
    mode("all-skipped");
    const summary = run();

    expect(summary.landed).toBe(0);
    expect(summary.skipped).toBe(2);
    // A held-back key is not a fault — the tick succeeded, it just had nothing to write.
    expect(summary.ok).toBe(true);
  });
});

describe("reach-sweep fails honestly", () => {
  test("a Worker ok:false is a failed tick, not a false success", () => {
    mode("worker-fail");
    const summary = run();

    expect(summary.ok).toBe(false);
    expect(summary.error).toBeTruthy();
  });

  test("the CLI's own error payload throws (a failed command)", () => {
    mode("cli-error");

    expect(() => fluncleJson(["admin", "reach", "collect"])).toThrow(/missing_token/);
  });

  test("a crash with no parseable JSON reports ok:false rather than pretending it snapshotted", () => {
    mode("crash");
    const summary = run();

    expect(summary.ok).toBe(false);
    expect(summary.error).toBeTruthy();
  });
});
