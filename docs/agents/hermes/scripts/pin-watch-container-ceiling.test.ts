import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIN_WATCH = join(import.meta.dir, "..", "pin-watch", "rebuild-hermes.sh");
const HERMES_DOC = join(import.meta.dir, "..", "..", "hermes-agent.md");

const GIB = 1073741824;

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

/**
 * Drive the checked-in ceiling resolution + the checked-in `run_container` against a fake
 * docker, and return the `docker run` argv the swap (or the rollback) would issue.
 */
function runCeilingScenario(options: {
  readonly env?: Readonly<Record<string, string>>;
  readonly liveMemory?: string;
  readonly liveNanoCpus?: string;
  readonly path?: "rollback" | "swap";
}) {
  const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-ceiling-"));
  const calls = join(root, "calls");
  const runner = join(root, "runner.sh");
  const source = readFileSync(PIN_WATCH, "utf8");
  const config = source.slice(
    source.indexOf('HERMES_CPUS="${PINWATCH_CPUS'),
    source.indexOf("\n", source.indexOf('HERMES_MEMORY_GIB="${PINWATCH_MEMORY_GIB')),
  );
  writeFileSync(calls, "", "utf8");

  writeFileSync(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
CONTAINER=hermes
CONTAINER_SECURITY_ARGS=(--security-opt pin-watch-test)
ENVTMP=/tmp/pin-watch-test-env
MOUNT_SRC=/pin-watch-test/data
RESTART=unless-stopped
log() { printf '[pin-watch] %s\\n' "$*" >&2; }
die() { printf 'FATAL:%s\\n' "$*"; exit 1; }
docker() {
  case "$*" in
    *NanoCpus*) printf '%s\\n' "$PINWATCH_LIVE_NANOCPUS"; return 0 ;;
    *HostConfig.Memory*) printf '%s\\n' "$PINWATCH_LIVE_MEMORY"; return 0 ;;
  esac
  printf '%s\\n' "$*" >>"$PINWATCH_CALLS"
  return 0
}
${config}
${extractFunction(source, "to_nanocpus")}
${extractFunction(source, "from_nanocpus")}
${extractFunction(source, "validate_ceiling")}
${extractFunction(source, "preserve_live_ceiling")}
${extractFunction(source, "run_container")}
validate_ceiling
preserve_live_ceiling
run_container "fluncle-hermes:${options.path === "rollback" ? "old" : "new"}"
`,
    "utf8",
  );

  try {
    const result = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PINWATCH_CALLS: calls,
        PINWATCH_LIVE_MEMORY: options.liveMemory ?? "0",
        PINWATCH_LIVE_NANOCPUS: options.liveNanoCpus ?? "0",
        ...options.env,
      },
    });
    return {
      calls: readFileSync(calls, "utf8"),
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runScriptWithEnv(env: Readonly<Record<string, string>>) {
  return spawnSync("bash", [PIN_WATCH, "--fingerprint"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("pin-watch container resource ceiling", () => {
  test("the swap creates the container at the ruled ceiling with swap pinned to memory", () => {
    const result = runCeilingScenario({ path: "swap" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("--cpus=3.000");
    expect(result.calls).toContain(`--memory=${6 * GIB}b`);
    expect(result.calls).toContain(`--memory-swap=${6 * GIB}b`);
  });

  test("the rollback re-creates the container at the same ceiling", () => {
    const swap = runCeilingScenario({ path: "swap" });
    const rollback = runCeilingScenario({ path: "rollback" });

    expect(rollback.status, rollback.stderr).toBe(0);
    expect(rollback.calls.replace("fluncle-hermes:old", "fluncle-hermes:new")).toBe(swap.calls);
  });

  test("a higher live ceiling set by hand survives the rebake", () => {
    const result = runCeilingScenario({
      liveMemory: String(8 * GIB),
      liveNanoCpus: "4000000000",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("--cpus=4.000");
    expect(result.calls).toContain(`--memory=${8 * GIB}b`);
    expect(result.calls).toContain(`--memory-swap=${8 * GIB}b`);
  });

  test("a lower live ceiling never drags the container back down", () => {
    const result = runCeilingScenario({
      liveMemory: String(4 * GIB),
      liveNanoCpus: "2000000000",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("--cpus=3.000");
    expect(result.calls).toContain(`--memory=${6 * GIB}b`);
  });

  test("an unreadable live ceiling falls back to the default rather than to zero", () => {
    const result = runCeilingScenario({ liveMemory: "", liveNanoCpus: "<no value>" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("--cpus=3.000");
    expect(result.calls).toContain(`--memory=${6 * GIB}b`);
  });

  test("the env override sets the ceiling, fractional CPUs included", () => {
    const result = runCeilingScenario({
      env: { PINWATCH_CPUS: "2.5", PINWATCH_MEMORY_GIB: "12" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("--cpus=2.500");
    expect(result.calls).toContain(`--memory=${12 * GIB}b`);
  });

  test("an invalid override refuses loudly before anything is built", () => {
    for (const env of [
      { PINWATCH_CPUS: "lots" },
      { PINWATCH_CPUS: "0.5" },
      { PINWATCH_CPUS: "3." },
      { PINWATCH_MEMORY_GIB: "6g" },
      { PINWATCH_MEMORY_GIB: "0" },
    ]) {
      const result = runScriptWithEnv(env);

      expect(result.status, JSON.stringify(env)).toBe(1);
      expect(result.stderr).toContain("FATAL");
      expect(result.stderr).toContain(Object.keys(env)[0] ?? "");
      expect(result.stderr).not.toContain("baked paths");
    }
  });

  test("the container creation path carries no hardcoded ceiling", () => {
    const source = readFileSync(PIN_WATCH, "utf8");
    const runContainer = extractFunction(source, "run_container");

    expect(runContainer).toContain('--cpus="$(from_nanocpus "$CEILING_NANOCPUS")"');
    expect(runContainer).toContain('--memory="${CEILING_MEMORY_BYTES}b"');
    expect(runContainer).toContain('--memory-swap="${CEILING_MEMORY_BYTES}b"');
    expect(runContainer).not.toMatch(/--(?:cpus|memory)=[0-9]/);
    // The live ceiling is read while the old container still exists — before the swap.
    expect(source.indexOf("\npreserve_live_ceiling\n")).toBeGreaterThan(0);
    expect(source.indexOf("\npreserve_live_ceiling\n")).toBeLessThan(
      source.indexOf('log "swapping $CONTAINER'),
    );
  });

  test("the canonical operator recipe states the same ceiling as the script default", () => {
    const script = readFileSync(PIN_WATCH, "utf8");
    const doc = readFileSync(HERMES_DOC, "utf8");
    const cpus = /HERMES_CPUS="\$\{PINWATCH_CPUS:-([0-9.]+)\}"/.exec(script)?.[1];
    const memory = /HERMES_MEMORY_GIB="\$\{PINWATCH_MEMORY_GIB:-([0-9]+)\}"/.exec(script)?.[1];

    expect(cpus).toBe("3");
    expect(memory).toBe("6");
    expect(doc).toContain(`--cpus=${cpus} --memory=${memory}g --memory-swap=${memory}g`);
  });
});
