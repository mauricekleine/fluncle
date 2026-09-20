// The two PostToolUse hooks that spawn heavy tooling — the type-aware `oxlint --fix` in
// format-on-edit.sh and the affected quality lanes in preflight-on-edit.sh — must NOT run inside
// an unattended box sweep: a headless `claude -p` in the checkout inherits them on every edit, and
// tsgolint's 2.5–3 GB peak is what the Hermes container's memory cap kills. The marker is the same
// FLUNCLE_UNATTENDED=1 the sweeps already export for the PreToolUse guard.
//
// Both halves are asserted, as with the guard: attended, the tooling IS invoked (so a hook that
// silently stopped working would fail here too); unattended, nothing is spawned.
//
//   bun test .claude/hooks/unattended-skip.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORMAT_HOOK = join(import.meta.dir, "format-on-edit.sh");
const PREFLIGHT_HOOK = join(import.meta.dir, "preflight-on-edit.sh");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A PATH directory whose named commands only append their argv to a log file. */
function stubCommands(names: readonly string[]): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "hook-stub-"));
  temporaryDirectories.push(dir);
  const log = join(dir, "calls.log");
  for (const name of names) {
    const stub = join(dir, name);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >>"${log}"\nexit 0\n`,
    );
    chmodSync(stub, 0o755);
  }
  return { dir, log };
}

function calls(log: string): string {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

function run(hook: string, env: Record<string, string>, input?: string): number {
  const result = spawnSync("bash", [hook], {
    encoding: "utf8",
    env: { HOME: process.env.HOME ?? "", ...env },
    input,
  });
  return result.status ?? -1;
}

describe("format-on-edit.sh", () => {
  test("attended, a TypeScript edit is formatted and linted through bunx", () => {
    const { dir, log } = stubCommands(["bunx"]);
    const file = join(dir, "edited.ts");
    writeFileSync(file, "export const a = 1;\n");
    const payload = JSON.stringify({ tool_input: { file_path: file }, tool_name: "Edit" });
    // The payload reader needs the real bun, so the stub dir goes FIRST on the real PATH.
    expect(run(FORMAT_HOOK, { PATH: `${dir}:${process.env.PATH ?? ""}` }, payload)).toBe(0);
    expect(calls(log)).toContain("bunx oxfmt --write");
    expect(calls(log)).toContain("bunx oxlint --fix");
  });

  test("unattended, nothing is spawned for the same edit", () => {
    const { dir, log } = stubCommands(["bunx"]);
    const file = join(dir, "edited.ts");
    writeFileSync(file, "export const a = 1;\n");
    const payload = JSON.stringify({ tool_input: { file_path: file }, tool_name: "Edit" });
    const env = { FLUNCLE_UNATTENDED: "1", PATH: `${dir}:${process.env.PATH ?? ""}` };
    expect(run(FORMAT_HOOK, env, payload)).toBe(0);
    expect(calls(log)).toBe("");
  });
});

describe("preflight-on-edit.sh", () => {
  test("attended, the affected quality lanes are started", () => {
    const { dir, log } = stubCommands(["bun"]);
    expect(run(PREFLIGHT_HOOK, { PATH: `${dir}:${process.env.PATH ?? ""}` })).toBe(0);
    expect(calls(log)).toContain("bun run quality:preflight -- start --quiet");
  });

  test("unattended, the lanes are not started", () => {
    const { dir, log } = stubCommands(["bun"]);
    expect(
      run(PREFLIGHT_HOOK, { FLUNCLE_UNATTENDED: "1", PATH: `${dir}:${process.env.PATH ?? ""}` }),
    ).toBe(0);
    expect(calls(log)).toBe("");
  });

  test("the settings file routes the preflight hook through this script", () => {
    const settings = readFileSync(join(import.meta.dir, "..", "settings.json"), "utf8");
    expect(settings).toContain("/.claude/hooks/preflight-on-edit.sh");
    expect(settings).not.toContain('"command": "bun run quality:preflight');
  });
});
