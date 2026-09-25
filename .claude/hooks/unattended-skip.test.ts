import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORMAT_HOOK = join(import.meta.dir, "format-on-edit.sh");
const PREFLIGHT_HOOK = join(import.meta.dir, "preflight-on-edit.sh");

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PRE_COMMIT_HOOK = join(REPO_ROOT, ".husky", "pre-commit");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

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

function run(hook: string, env: Record<string, string>, input?: string, cwd?: string): number {
  const result = spawnSync("bash", [hook], {
    cwd,
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

describe(".husky/pre-commit", () => {
  test("attended, the preflight join is invoked", () => {
    const { dir, log } = stubCommands(["node", "bunx", "git", "bun"]);
    run(PRE_COMMIT_HOOK, { PATH: `${dir}:${process.env.PATH ?? ""}` }, undefined, REPO_ROOT);
    expect(calls(log)).toContain("preflight.mjs join");
  });

  test("unattended, the join is skipped and the scoped checks are not", () => {
    const { dir, log } = stubCommands(["node", "bunx", "git", "bun"]);
    run(
      PRE_COMMIT_HOOK,
      { FLUNCLE_UNATTENDED: "1", PATH: `${dir}:${process.env.PATH ?? ""}` },
      undefined,
      REPO_ROOT,
    );
    const invoked = calls(log);
    expect(invoked).not.toContain("preflight.mjs join");
    expect(invoked).toContain("lint-staged");
  });
});
