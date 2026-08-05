import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");
const workflowDir = join(root, ".github", "workflows");

function workflowInstallCommands(): string[] {
  return readdirSync(workflowDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .flatMap((file) =>
      readFileSync(join(workflowDir, file), "utf8")
        .split("\n")
        .filter((line) => /^\s*(?:run:\s*)?bun install(?:\s|$)/.test(line))
        .map((line) => line.replace(/^\s*run:\s*/, "").trim()),
    );
}

describe("hosted dependency installation", () => {
  test("every workflow install uses the frozen lockfile contract", () => {
    const commands = workflowInstallCommands();

    expect(commands.length).toBeGreaterThan(0);
    expect(commands).toEqual(commands.map(() => "bun install --frozen-lockfile"));
  });

  test("Bun rejects a package manifest that drifts from its lockfile", () => {
    const fixture = mkdtempSync(join(tmpdir(), "fluncle-frozen-lockfile-"));

    try {
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      const devDependencies = { ...packageJson.devDependencies };
      delete devDependencies.oxfmt;
      packageJson.devDependencies = devDependencies;

      writeFileSync(join(fixture, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
      copyFileSync(join(root, "bun.lock"), join(fixture, "bun.lock"));
      for (const directory of ["apps", "packages", "patches"]) {
        symlinkSync(join(root, directory), join(fixture, directory), "dir");
      }

      const frozen = spawnSync(
        "bun",
        ["install", "--frozen-lockfile", "--offline", "--no-progress"],
        {
          cwd: fixture,
          encoding: "utf8",
        },
      );
      const output = `${frozen.stdout}\n${frozen.stderr}`.toLowerCase();

      expect(frozen.status).not.toBe(0);
      expect(output).toContain("lockfile had changes");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });
});
