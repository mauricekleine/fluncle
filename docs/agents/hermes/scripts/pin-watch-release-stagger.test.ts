import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERMES = join(import.meta.dir, "..");
const PIN_WATCH = join(HERMES, "pin-watch", "rebuild-hermes.sh");
const PIN_WATCH_SERVICE = join(HERMES, "pin-watch", "pin-watch.service");
const PIN_WATCH_README = join(HERMES, "pin-watch", "README.md");

function extractFunction(source: string, functionName: string): string {
  const start = source.indexOf(`${functionName}() {`);
  if (start < 0) {
    throw new Error(`missing ${functionName}`);
  }

  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      opened = true;
    } else if (character === "}") {
      depth -= 1;
      if (opened && depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`unterminated ${functionName}`);
}

function releaseConfig(source: string): string {
  const start = source.indexOf('RELEASE_STAGGER_SECS="${PINWATCH_RELEASE_STAGGER_SECS');
  const end = source.indexOf("\n)\n", source.indexOf("RELEASE_HEAVY_TIMERS=("));

  if (start < 0 || end < 0) {
    throw new Error("missing the RELEASE_* configuration block");
  }

  return source.slice(start, end + 3);
}

function repoSweepTimers(): readonly string[] {
  const timers: string[] = [];

  for (const directory of readdirSync(HERMES, { withFileTypes: true })) {
    if (!directory.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(join(HERMES, directory.name))) {
      if (
        entry.startsWith("fluncle-") &&
        entry.endsWith(".timer") &&
        entry !== "fluncle-healthcheck.timer"
      ) {
        timers.push(entry);
      }
    }
  }

  return timers.sort();
}

type ReleaseRun = {
  readonly order: readonly string[];
  readonly sleeps: readonly number[];
  readonly status: number | null;
  readonly stderr: string;
};

function runRelease(options: {
  readonly env?: Readonly<Record<string, string>>;
  readonly mode: "immediate" | "staggered";
  readonly timers: readonly string[];
}): ReleaseRun {
  const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-release-"));
  const calls = join(root, "calls");
  const sleeps = join(root, "sleeps");
  const runner = join(root, "runner.sh");
  const source = readFileSync(PIN_WATCH, "utf8");
  writeFileSync(calls, "", "utf8");
  writeFileSync(sleeps, "", "utf8");

  writeFileSync(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
log() { printf '[pin-watch] %s\\n' "$*" >&2; }
die() { printf 'FATAL:%s\\n' "$*" >&2; exit 1; }
REBAKE_LOCK=""
STOPPED_TIMERS=(${options.timers.map((timer) => `'${timer}'`).join(" ")})
# The stagger is what is under test, so time is faked: a spacing is RECORDED, never slept.
sleep() { printf '%s\\n' "$1" >>"$PINWATCH_SLEEPS"; }
systemctl() {
  if [ "\${1:-}" = "start" ]; then printf '%s\\n' "$2" >>"$PINWATCH_CALLS"; fi
  return 0
}
# Not under test here; the common "this timer is fine" answer.
rearm_stalled_timer() { return 1; }
${releaseConfig(source)}
${extractFunction(source, "validate_release_stagger")}
${extractFunction(source, "resolve_release_window")}
${extractFunction(source, "release_is_heavy")}
${extractFunction(source, "release_order")}
${extractFunction(source, "restore_sweep_timers")}
validate_release_stagger
restore_sweep_timers ${options.mode === "staggered" ? "staggered" : ""}
`,
    "utf8",
  );

  try {
    const result = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PINWATCH_CALLS: calls,
        PINWATCH_SLEEPS: sleeps,
        ...options.env,
      },
    });

    return {
      order: readFileSync(calls, "utf8").split("\n").filter(Boolean),
      sleeps: readFileSync(sleeps, "utf8").split("\n").filter(Boolean).map(Number),
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function heavyTimers(): readonly string[] {
  const source = readFileSync(PIN_WATCH, "utf8");
  const block = source.slice(
    source.indexOf("RELEASE_HEAVY_TIMERS=("),
    source.indexOf("\n)\n", source.indexOf("RELEASE_HEAVY_TIMERS=(")),
  );

  return block
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("pin-watch releases the sweep roster over a window", () => {
  const roster = repoSweepTimers();
  const heavy = heavyTimers();

  test("every measured long holder names a timer this repo actually installs", () => {
    expect(heavy.length).toBeGreaterThan(0);
    for (const unit of heavy) {
      expect(roster).toContain(unit);
    }
  });

  test("the release spaces the whole roster instead of starting it in one instant", () => {
    const result = runRelease({ mode: "staggered", timers: roster });

    expect(result.status, result.stderr).toBe(0);
    expect(result.order.length).toBe(roster.length);
    expect([...result.order].sort()).toEqual([...roster].sort());

    expect(result.sleeps.length).toBe(roster.length - 1);
    for (const spacing of result.sleeps) {
      expect(spacing).toBeGreaterThanOrEqual(8);
      expect(spacing).toBeLessThanOrEqual(10);
    }
    const window = result.sleeps.reduce((total, spacing) => total + spacing, 0);
    expect(window).toBeGreaterThanOrEqual(5 * 60);
    expect(window).toBeLessThanOrEqual(8 * 60);
  });

  test("two long write-lane holders are never released back to back", () => {
    const result = runRelease({ mode: "staggered", timers: roster });
    const positions = heavy.map((unit) => result.order.indexOf(unit));

    expect(result.status, result.stderr).toBe(0);
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    const spread = [...positions].sort((left, right) => left - right);
    for (let index = 1; index < spread.length; index += 1) {
      expect((spread[index] ?? 0) - (spread[index - 1] ?? 0)).toBeGreaterThan(1);
    }
  });

  test("the order is deterministic — the same roster releases the same way twice", () => {
    const first = runRelease({ mode: "staggered", timers: roster });
    const second = runRelease({ mode: "staggered", timers: [...roster].reverse() });

    expect(first.order).toEqual(second.order);
  });

  test("the operator window wins and sets the spacing", () => {
    const result = runRelease({
      env: { PINWATCH_RELEASE_STAGGER_SECS: "120" },
      mode: "staggered",
      timers: ["fluncle-note.timer", "fluncle-crawl.timer", "fluncle-triage.timer"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.sleeps).toEqual([40, 40]);
    expect(result.stderr).toContain("120s window");
  });

  test("a tiny roster still gets the floor window rather than a hair-thin one", () => {
    const result = runRelease({
      mode: "staggered",
      timers: ["fluncle-note.timer", "fluncle-triage.timer"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.sleeps).toEqual([30]);
  });

  test("an explicit zero restores the one-instant release and says so", () => {
    const result = runRelease({
      env: { PINWATCH_RELEASE_STAGGER_SECS: "0" },
      mode: "staggered",
      timers: roster,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.order.length).toBe(roster.length);
    expect(result.sleeps).toEqual([]);
    expect(result.stderr).toContain("release stagger disabled");
  });

  test("the rollback and abort path restores the roster with no stagger delay at all", () => {
    const result = runRelease({ mode: "immediate", timers: roster });

    expect(result.status, result.stderr).toBe(0);
    expect(result.order.length).toBe(roster.length);
    expect(result.sleeps).toEqual([]);
    expect(result.stderr).toContain(`restored ${roster.length} sweep timer(s)`);
    expect(result.stderr).not.toContain("releasing");
  });

  test("an invalid window refuses loudly before anything is built", () => {
    for (const env of [
      { PINWATCH_RELEASE_STAGGER_SECS: "soon" },
      { PINWATCH_RELEASE_STAGGER_SECS: "-30" },
      { PINWATCH_RELEASE_STAGGER_SECS: "8m" },
      { PINWATCH_RELEASE_STAGGER_SECS: "3601" },
    ]) {
      const result = spawnSync("bash", [PIN_WATCH, "--fingerprint"], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });

      expect(result.status, JSON.stringify(env)).toBe(1);
      expect(result.stderr).toContain("FATAL");
      expect(result.stderr).toContain("PINWATCH_RELEASE_STAGGER_SECS");
      expect(result.stderr).not.toContain("baked paths");
    }
  });
});

describe("pin-watch stagger wiring", () => {
  const source = readFileSync(PIN_WATCH, "utf8");

  test("only a run that reached a clean end releases over the window", () => {
    const staggered = [...source.matchAll(/\n +restore_sweep_timers staggered\n/g)];
    const dryRun = source.indexOf('log "dry-run: $NEW_IMAGE built and pre-smoke passed');
    const deployed = source.indexOf('log "post-swap smoke passed — deployed $NEW_IMAGE"');
    const rollback = source.indexOf('log "new image did not come up healthy');

    expect(staggered.length).toBe(2);
    expect(staggered[0]?.index ?? -1).toBeGreaterThan(dryRun);
    expect(staggered[0]?.index ?? -1).toBeLessThan(deployed);
    expect(staggered[1]?.index ?? -1).toBeGreaterThan(deployed);
    expect(staggered[1]?.index ?? -1).toBeLessThan(rollback);
  });

  test("the guaranteed exit path stays the immediate restore", () => {
    const onExit = extractFunction(source, "pinwatch_on_exit");

    expect(onExit).toContain("restore_sweep_timers\n");
    expect(onExit).not.toContain("restore_sweep_timers staggered");
  });

  test("a signalled run still restores the roster instead of stranding it", () => {
    expect(source).toContain("trap 'pinwatch_on_exit' EXIT");
    expect(source).toContain("trap 'exit 143' INT TERM");
  });

  test("the stagger spaces the STARTS rather than touching any timer's Persistent state", () => {
    const restore = extractFunction(source, "restore_sweep_timers");

    expect(restore).toContain('systemctl start "$t"');
    expect(source).not.toContain("Persistent=false");
    expect(source).not.toContain("stamp-");
  });

  test("the unit's start timeout can hold a slow rebuild plus the widest window", () => {
    const service = readFileSync(PIN_WATCH_SERVICE, "utf8");
    const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)?.[1]);
    const ceiling = Number(/^RELEASE_STAGGER_CEILING_SECS=(\d+)/m.exec(source)?.[1]);

    expect(Number.isFinite(timeout)).toBe(true);
    expect(Number.isFinite(ceiling)).toBe(true);
    expect(timeout).toBeGreaterThan(ceiling);
  });

  test("the README documents the knob operators would otherwise have to read the script for", () => {
    const readme = readFileSync(PIN_WATCH_README, "utf8");

    expect(readme).toContain("PINWATCH_RELEASE_STAGGER_SECS");
  });
});
