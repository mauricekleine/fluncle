import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../../../apps/cli/src/cli";

const PIN_WATCH = join(import.meta.dir, "..", "pin-watch", "rebuild-hermes.sh");
const ADMIN_TRACKS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "web",
  "src",
  "lib",
  "server",
  "orpc",
  "admin-tracks.ts",
);

function cliRouteExists(route: readonly string[]): boolean {
  let commands = createProgram().commands;

  for (const token of route) {
    const command = commands.find((candidate) => candidate.name() === token);
    if (!command) {
      return false;
    }
    commands = command.commands;
  }

  return true;
}

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

function runBoundaryScenario(scenario: "forbidden" | "success" | "unauthorized") {
  const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-boundary-"));
  const calls = join(root, "calls");
  const runner = join(root, "runner.sh");
  const source = readFileSync(PIN_WATCH, "utf8");
  const implementation = extractFunction(source, "verify_agent_role_boundary");
  writeFileSync(calls, "", "utf8");

  writeFileSync(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
CONTAINER_SECURITY_ARGS=(--security-opt pin-watch-test)
ENVTMP=/tmp/pin-watch-test-env
NEW_IMAGE=fluncle-hermes:test
presmoke_fail() { printf 'pre-smoke-failed:%s\n' "$1"; exit 70; }
docker() {
  printf '%s\n' "$*" >>"$PINWATCH_CALLS"
  case "$*" in
    *"admin tracks enrich"*)
      printf '{"ok":false,"code":"database_unavailable"}'
      return 1
      ;;
    *"admin tracks publish"*)
      case "$PINWATCH_SCENARIO" in
        forbidden) printf '{"ok":false,"code":"forbidden"}'; return 1 ;;
        unauthorized) printf '{"ok":false,"code":"unauthorized"}'; return 1 ;;
        success) printf '{"ok":true}'; return 0 ;;
      esac
      ;;
  esac
  return 71
}
${implementation}
verify_agent_role_boundary
printf 'gateway-pre-smoke-reached\n'
printf 'swap-reached\n'
`,
    "utf8",
  );

  try {
    const result = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PINWATCH_CALLS: calls,
        PINWATCH_SCENARIO: scenario,
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

describe("pin-watch control-plane pre-smoke", () => {
  test("a primary-database outage cannot suppress gateway pre-smoke or swap", () => {
    const result = runBoundaryScenario("forbidden");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("gateway-pre-smoke-reached");
    expect(result.stdout).toContain("swap-reached");
    expect(result.calls).toContain("admin tracks publish");
    expect(result.calls).not.toContain("admin tracks enrich");
  });

  test("an invalid agent token still fails pre-smoke definitively", () => {
    const result = runBoundaryScenario("unauthorized");

    expect(result.status).toBe(70);
    expect(result.stdout).toContain("exact forbidden role-boundary response");
    expect(result.stdout).not.toContain("gateway-pre-smoke-reached");
    expect(result.stdout).not.toContain("swap-reached");
  });

  test("accidental publish authority still fails the role boundary", () => {
    const result = runBoundaryScenario("success");

    expect(result.status).toBe(70);
    expect(result.stdout).toContain("publish-class command was NOT refused");
    expect(result.stdout).not.toContain("gateway-pre-smoke-reached");
    expect(result.stdout).not.toContain("swap-reached");
  });

  test("the checked-in pre-smoke reaches gateway validation and swap without a database probe", () => {
    const source = readFileSync(PIN_WATCH, "utf8");
    const boundaryCall = source.lastIndexOf("\nverify_agent_role_boundary\n");
    const gatewayPreSmoke = source.indexOf('GATEWAY_SMOKE_CONTAINER="pinwatch-gateway-smoke-$$"');
    const preSmokePassed = source.indexOf('log "pre-smoke passed"');
    const swap = source.indexOf('log "swapping $CONTAINER: $OLD_IMAGE -> $NEW_IMAGE"');

    expect(source).not.toContain("admin tracks enrich --queue");
    expect(source).not.toContain(" admin add ");
    expect(source).toContain(" admin tracks publish ");
    expect(boundaryCall).toBeGreaterThanOrEqual(0);
    expect(gatewayPreSmoke).toBeGreaterThan(boundaryCall);
    expect(preSmokePassed).toBeGreaterThan(gatewayPreSmoke);
    expect(swap).toBeGreaterThan(preSmokePassed);
  });

  test("the role-boundary probe names a real operator-only CLI command", () => {
    expect(cliRouteExists(["admin", "tracks", "publish"])).toBe(true);
    expect(cliRouteExists(["admin", "add"])).toBe(false);
  });

  test("the exact forbidden response is produced before the publish database handler", () => {
    const source = readFileSync(ADMIN_TRACKS, "utf8");
    const handlerStart = source.indexOf("const publishTrackHandler = os.publish_track");
    const adminAuth = source.indexOf(".use(adminAuth)", handlerStart);
    const operatorGuard = source.indexOf(".use(operatorGuard)", handlerStart);
    const handler = source.indexOf(".handler(async", handlerStart);
    const databaseHandler = source.indexOf("await publishTrack(", handlerStart);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(adminAuth).toBeGreaterThan(handlerStart);
    expect(operatorGuard).toBeGreaterThan(adminAuth);
    expect(handler).toBeGreaterThan(operatorGuard);
    expect(databaseHandler).toBeGreaterThan(handler);
  });
});
