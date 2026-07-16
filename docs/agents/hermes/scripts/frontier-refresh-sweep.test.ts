// Unit tests for frontier-refresh-sweep.ts — the weekly Frontier-refresh `--no-agent`
// cron (E2, the public recommendation machine).
//
// The contract worth pinning is that the sweep is a PURE TRIGGER: it fires ONE
// `fluncle admin frontier refresh`, surfaces the op's counts on its own summary line, and
// (1) reports `switchOff` honestly when the kill switch is closed, (2) stays `ok` when the
// op reports per-user failures (best-effort; retried next week), and (3) reports
// `ok: false` on a CLI error without throwing.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live
// outside any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/frontier-refresh-sweep.test.ts
//
// The fluncle CLI is stubbed with a tiny executable selected via FLUNCLE_BIN; a mode FILE
// beside it selects the response shape (Bun's spawnSync snapshots the environment, so the
// mode cannot ride on an env var).
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
  ok)       printf '{"ok":true,"total":3,"refreshed":2,"unchanged":1,"minted":0,"skipped":0,"failed":0,"switchOff":false}\\n' ;;
  # The kill switch is closed — nothing walked.
  switched) printf '{"ok":true,"total":0,"refreshed":0,"unchanged":0,"minted":0,"skipped":0,"failed":0,"switchOff":true}\\n' ;;
  # A best-effort per-user Spotify fault — still a successful tick.
  partial)  printf '{"ok":true,"total":4,"refreshed":2,"unchanged":1,"minted":0,"skipped":0,"failed":1,"switchOff":false}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars","ok":false}\\n'; exit 1 ;;
  crash)    printf 'boom\\n' >&2; exit 1 ;;
esac
`;

let dir: string;
let main: typeof import("./frontier-refresh-sweep").main;

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
  dir = mkdtempSync(join(tmpdir(), "frontier-refresh-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ main } = await import("./frontier-refresh-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("frontier-refresh-sweep is a pure weekly trigger", () => {
  test("fires ONE refresh and surfaces the op's counts", () => {
    mode("ok");
    const summary = run();

    expect(calls()).toBe(1);
    expect(summary).toMatchObject({
      failed: 0,
      ok: true,
      refreshed: 2,
      switchOff: false,
      total: 3,
      unchanged: 1,
    });
  });

  test("reports switchOff honestly when the kill switch is closed", () => {
    mode("switched");
    const summary = run();

    expect(calls()).toBe(1);
    expect(summary.switchOff).toBe(true);
    expect(summary.ok).toBe(true);
  });

  test("a per-user failure is still a successful tick (best-effort, retried next week)", () => {
    mode("partial");
    const summary = run();

    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(true);
  });

  test("a CLI error is reported as ok:false, never thrown", () => {
    mode("cli-error");
    const summary = run();

    expect(summary.ok).toBe(false);
    expect(typeof summary.error).toBe("string");
  });
});
