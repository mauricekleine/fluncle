// Unit tests for rank-sweep.ts — The Ear's `--no-agent` ranking cron.
//
// The contract worth pinning is the DRAIN: unlike the crawl (one pass per tick, because
// its pace is a vendor's rate limit), ranking is local SQL with a natural finish line, so
// the sweep loops while `remaining > 0` up to a hard tick budget. A crawl that just landed
// 700 rows must be ranked by the next tick, not seventy minutes later — and the budget
// must still bound the tick when the backlog is bigger than the budget.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live
// outside any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/rank-sweep.test.ts
//
// The fluncle CLI is stubbed with a tiny executable selected via FLUNCLE_BIN. A mode FILE
// beside it selects the response shape (Bun's spawnSync snapshots the environment, so the
// mode cannot ride on an env var), and a COUNTER file lets the stub answer differently on
// each successive call — which is the only way to exercise a drain.
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
  # Three ticks of real work, then drained — in the REAL CLI shape: the counts nest under
  # "summary" ({"ok":true,"summary":{…}}). The original stubs printed the counts FLAT, which
  # is exactly how the 2026-07-14 regression shipped green: the sweep read top-level keys,
  # prod nested them, and every tick parsed as zeros. The stubs now mirror prod.
  drain)
    case "$N" in
      1) printf '{"ok":true,"summary":{"scored":250,"prioritized":10,"remaining":400,"corpus":"60:60"}}\\n' ;;
      2) printf '{"ok":true,"summary":{"scored":250,"prioritized":5,"remaining":150,"corpus":"60:60"}}\\n' ;;
      *) printf '{"ok":true,"summary":{"scored":150,"prioritized":0,"remaining":0,"corpus":"60:60"}}\\n' ;;
    esac ;;
  # Never drains — the tick budget must stop it, and say so honestly.
  endless) printf '{"ok":true,"summary":{"scored":250,"prioritized":0,"remaining":9999,"corpus":"60:60"}}\\n' ;;
  # An unchanged archive: one cheap scoped COUNT, nothing to do.
  idle) printf '{"ok":true,"summary":{"scored":0,"prioritized":0,"remaining":0,"corpus":"60:60"}}\\n' ;;
  # The pre-envelope flat shape — the unwrap keeps it parseable as a fallback.
  flat) printf '{"ok":true,"scored":42,"prioritized":7,"remaining":0,"corpus":"60:60"}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
esac
`;

let dir: string;
let main: typeof import("./rank-sweep").main;
let fluncleJson: typeof import("./rank-sweep").fluncleJson;

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
  dir = mkdtempSync(join(tmpdir(), "rank-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  process.env.FLUNCLE_RANK_MAX_CALLS = "8";
  mode("idle");

  ({ fluncleJson, main } = await import("./rank-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("rank-sweep drains the stale set", () => {
  test("keeps calling while `remaining > 0`, and stops the moment it hits 0", () => {
    mode("drain");
    const summary = run();

    expect(calls()).toBe(3); // it did NOT take one bite and leave 400 rows stale
    expect(summary.calls).toBe(3);
    expect(summary.scored).toBe(650); // 250 + 250 + 150, summed across the drain
    expect(summary.prioritized).toBe(15);
    expect(summary.remaining).toBe(0);
    expect(summary.ok).toBe(true);
  });

  test("the tick BUDGET bounds it when the backlog is bigger — and it says so", () => {
    mode("endless");
    const summary = run();

    expect(calls()).toBe(8); // FLUNCLE_RANK_MAX_CALLS, not forever
    expect(summary.remaining).toBe(9999);
    // Still `ok`: a leftover backlog is not a failure, it is the next tick's work.
    expect(summary.ok).toBe(true);
  });

  test("an unchanged archive is ONE call and a no-op", () => {
    mode("idle");
    const summary = run();

    expect(calls()).toBe(1);
    expect(summary.scored).toBe(0);
    expect(summary.remaining).toBe(0);
  });

  test("the pre-envelope FLAT payload still parses (the unwrap fallback)", () => {
    mode("flat");
    const summary = run();

    expect(calls()).toBe(1);
    expect(summary.scored).toBe(42);
    expect(summary.prioritized).toBe(7);
    expect(summary.remaining).toBe(0);
  });
});

describe("rank-sweep's fluncleJson", () => {
  test("throws on the CLI's own error payload (a failed command, not a partial batch)", () => {
    mode("cli-error");

    expect(() => fluncleJson(["admin", "catalogue", "rank"])).toThrow(/missing_token/);
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson(["admin", "catalogue", "rank"])).toThrow(/exited 1/);
  });

  test("a failing tick reports ok:false rather than pretending it drained", () => {
    mode("crash");
    const summary = run();

    expect(summary.ok).toBe(false);
    expect(summary.error).toBeTruthy();
  });
});
