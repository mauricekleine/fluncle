import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "pin-watch", "rebuild-hermes.sh");
const SOURCE = readFileSync(SCRIPT, "utf8");

function extractFunction(name: string): string {
  const start = SOURCE.indexOf(`${name}() {`);
  if (start < 0) {
    throw new Error(`missing ${name}`);
  }
  let depth = 0;
  for (let index = SOURCE.indexOf("{", start); index < SOURCE.length; index += 1) {
    if (SOURCE[index] === "{") {
      depth += 1;
    }
    if (SOURCE[index] === "}") {
      depth -= 1;
    }
    if (depth === 0) {
      return SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function replay(at: number, stamp: string, mode = "--if-stale") {
  const runner = `#!/usr/bin/env bash
set -euo pipefail
LAST_BUILD_FILE="$PINWATCH_STAMP"
REBUILD_INTERVAL_SECS=7200
MODE="$PINWATCH_MODE"
date() { printf '%s\\n' "$PINWATCH_NOW"; }
log() { printf '%s\\n' "$*" >&2; }
die() { printf 'FATAL: %s\\n' "$*" >&2; exit 1; }
${extractFunction("rebuild_window_open")}
${extractFunction("record_build_start")}
if rebuild_window_open; then
  record_build_start
  printf 'build\\n'
else
  printf 'deferred\\n'
fi
`;
  return spawnSync("bash", ["-c", runner], {
    encoding: "utf8",
    env: { ...process.env, PINWATCH_MODE: mode, PINWATCH_NOW: String(at), PINWATCH_STAMP: stamp },
  });
}

describe("pin-watch rebuild coalescing", () => {
  test("two drifts three minutes apart build once; drift at two hours and one minute builds latest main", () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-coalesce-"));
    const stamp = join(root, "last-build-at");
    try {
      const first = replay(1_800_000_000, stamp);
      const second = replay(1_800_000_180, stamp);
      const third = replay(1_800_007_260, stamp);
      expect([first.status, second.status, third.status]).toEqual([0, 0, 0]);
      expect([first.stdout.trim(), second.stdout.trim(), third.stdout.trim()]).toEqual([
        "build",
        "deferred",
        "build",
      ]);
      expect(second.stderr).toContain("drift deferred");
      expect(readFileSync(stamp, "utf8").trim()).toBe("1800007260");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an operator force rebuilds immediately and starts a new window", () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-force-"));
    const stamp = join(root, "last-build-at");
    try {
      writeFileSync(stamp, "1800000000\n");
      const forced = replay(1_800_000_180, stamp, "--force");
      const deferred = replay(1_800_000_240, stamp);
      expect(forced.status).toBe(0);
      expect(forced.stdout.trim()).toBe("build");
      expect(deferred.stdout.trim()).toBe("deferred");
      expect(readFileSync(stamp, "utf8").trim()).toBe("1800000180");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a corrupt timestamp refuses to build without losing drift", () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-invalid-"));
    const stamp = join(root, "last-build-at");
    try {
      writeFileSync(stamp, "invalid\n");
      const result = replay(1_800_000_180, stamp);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("build");
      expect(result.stderr).toContain("invalid last-build timestamp");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("the cooldown gates build before quiesce and leaves rollback restoration in place", () => {
    expect(SOURCE.indexOf("if ! rebuild_window_open; then")).toBeLessThan(
      SOURCE.indexOf("\nquiesce_sweeps\n"),
    );
    expect(SOURCE.indexOf("\nrecord_build_start\n")).toBeLessThan(
      SOURCE.indexOf("\ndocker build --build-arg"),
    );
    expect(SOURCE).toContain("trap 'pinwatch_on_exit' EXIT");
    expect(SOURCE).toContain('if run_container "$OLD_IMAGE" && container_healthy; then');
  });
});
