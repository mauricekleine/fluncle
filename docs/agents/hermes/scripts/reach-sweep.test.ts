// Unit tests for reach-sweep.ts — the `--no-agent` daily /reach snapshot cron.
//
// The contract worth pinning is the SINGLE COLLECT: unlike rank (which loops while a backlog
// drains), a daily snapshot is one idempotent `fluncle admin reach collect` call. So the sweep
// makes exactly one call, folds the wrapper into a one-line JSON summary (inserted / landed /
// skipped / failed), stays `ok` when individual platforms fault or cleanly skip,
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
  full) printf '{"ok":true,"inserted":4,"collected":[{"platform":"mixcloud","metrics":["followers","listens"]},{"platform":"bluesky","metrics":["followers","posts"]}],"failed":[],"skipped":[{"kind":"unconfigured","platform":"tiktok","reason":"no oauth"}]}\\n' ;;
  # A same-day re-run: everything already snapshotted, nothing new written — a safe no-op.
  noop) printf '{"ok":true,"inserted":0,"collected":[{"platform":"mixcloud","metrics":["followers"]}],"failed":[],"skipped":[]}\\n' ;;
  # Every platform skipped (all keys held back) — still a successful tick, just an empty one.
  all-skipped) printf '{"ok":true,"inserted":0,"collected":[],"failed":[],"skipped":[{"kind":"unconfigured","platform":"tiktok","reason":"no oauth"},{"kind":"unconfigured","platform":"instagram","reason":"no oauth"}]}\\n' ;;
  # A measured empty collect: both outcome arrays exist and contain zero platforms.
  empty) printf '{"ok":true,"inserted":0,"collected":[],"failed":[],"skipped":[]}\\n' ;;
  # The three non-landed outcomes have exact machine-readable buckets.
  unconfigured) printf '{"ok":true,"inserted":0,"collected":[],"failed":[],"skipped":[{"kind":"unconfigured","platform":"tiktok","reason":"no oauth"}]}\\n' ;;
  no-metrics) printf '{"ok":true,"inserted":0,"collected":[],"failed":[],"skipped":[{"kind":"empty","platform":"appstore","reason":"not live"}]}\\n' ;;
  platform-fault) printf '{"ok":true,"inserted":0,"collected":[],"failed":[{"platform":"github","reason":"GitHub responded 500"}],"skipped":[]}\\n' ;;
  # The Worker reported a hard stop before it could return trustworthy outcome arrays.
  worker-fail) printf '{"ok":false,"inserted":0}\\n' ;;
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
    expect(summary.unconfigured).toBe(1);
    expect(summary.empty).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.checked).toBe(3);
    expect(summary.produced).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(true);
  });

  test("a same-day re-run is a safe no-op (inserted 0, still ok)", () => {
    mode("noop");
    const summary = run();

    expect(calls()).toBe(1);
    expect(summary.inserted).toBe(0);
    // Platforms, not inserted metric rows, are the work unit: the idempotent collect still
    // checked and successfully handled Mixcloud.
    expect(summary.checked).toBe(1);
    expect(summary.produced).toBe(1);
    expect(summary.ok).toBe(true);
  });

  test("every platform skipped is an honest, successful empty tick", () => {
    mode("all-skipped");
    const summary = run();

    expect(summary.landed).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.unconfigured).toBe(2);
    expect(summary.empty).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.checked).toBe(2);
    expect(summary.produced).toBe(0);
    // A held-back key is not a fault — the tick succeeded, it just had nothing to write.
    expect(summary.ok).toBe(true);
  });

  test("explicit empty outcome arrays are a measured canonical zero", () => {
    mode("empty");
    const summary = run();

    expect(summary).toMatchObject({
      checked: 0,
      empty: 0,
      errors: 0,
      failed: 0,
      landed: 0,
      produced: 0,
      skipped: 0,
      unconfigured: 0,
    });
  });

  test.each([
    ["unconfigured", { empty: 0, failed: 0, skipped: 1, unconfigured: 1 }],
    ["no-metrics", { empty: 1, failed: 0, skipped: 1, unconfigured: 0 }],
    ["platform-fault", { empty: 0, failed: 1, skipped: 0, unconfigured: 0 }],
  ] as const)("keeps the %s platform outcome distinct", (state, expected) => {
    mode(state);
    const summary = run();

    expect(summary).toMatchObject({
      checked: 1,
      errors: 0,
      landed: 0,
      ok: true,
      produced: 0,
      ...expected,
    });
  });

  test("omits queue depth because a daily snapshot has no remaining backlog", () => {
    mode("full");
    const summary = run();

    // The collect is a periodic whole-platform snapshot, not a capped queue walk. A platform
    // count is work checked, not work remaining, so there is no honest queue_depth to emit.
    expect(summary).not.toHaveProperty("queue_depth");
    expect(summary).not.toHaveProperty("expected_interval_ms");
  });
});

describe("reach-sweep fails honestly", () => {
  test("a Worker ok:false is a failed tick, not a false success", () => {
    mode("worker-fail");
    const summary = run();

    expect(summary.ok).toBe(false);
    // Absent outcome arrays mean every domain counter is unknown, never fabricated zero.
    expect(summary).toMatchObject({
      checked: null,
      empty: null,
      errors: 1,
      failed: null,
      inserted: 0,
      landed: null,
      produced: null,
      skipped: null,
      unconfigured: null,
    });
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
    expect(summary).toMatchObject({ checked: null, errors: 1, produced: null });
    expect(summary.error).toBeTruthy();
  });
});
