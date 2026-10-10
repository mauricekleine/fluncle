import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test.each([
  { checked: true, config: "tsconfig.json", cwd: ".", script: "bun --check" },
  {
    checked: true,
    config: "tsconfig.json",
    cwd: "tooling project",
    script: 'bun --cwd "tooling project" --check',
  },
  {
    checked: true,
    config: "tsconfig.tooling.json",
    cwd: ".",
    script: "bun --check --tsconfig-override tsconfig.tooling.json",
  },
  {
    checked: true,
    config: "tsconfig.tooling.json",
    cwd: "tooling project",
    script: 'bun --cwd "tooling project" --check --tsconfig-override tsconfig.tooling.json',
  },
  { checked: false, config: "tsconfig.json", cwd: ".", script: "bun check" },
  { checked: false, config: "tsconfig.json", cwd: ".", script: null },
])(
  "only files in executed compiler programs count as covered: $script",
  ({ script, cwd, config, checked }) => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-typecheck-coverage-"));
    roots.push(root);
    const quality = join(root, "scripts/quality");
    const workspace = join(root, "packages/example");
    mkdirSync(quality, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../../node_modules"), join(root, "node_modules"), "dir");
    for (const file of ["classifier.mjs", "typecheck-coverage.mjs", "deploy-watch-paths.json"]) {
      copyFileSync(join(import.meta.dir, file), join(quality, file));
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "example",
        scripts: script ? { typecheck: script } : {},
      }),
    );
    writeFileSync(
      join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, types: [] },
        include: [cwd === "." && config === "tsconfig.json" ? "included.ts" : "unchecked.ts"],
      }),
    );
    const programDirectory = join(workspace, cwd);
    mkdirSync(programDirectory, { recursive: true });
    writeFileSync(
      join(programDirectory, config),
      JSON.stringify({
        compilerOptions: { noEmit: true, types: [] },
        include: [cwd === "." ? "included.ts" : "../included.ts"],
      }),
    );
    writeFileSync(join(workspace, "included.ts"), "export const included = 1;\n");
    writeFileSync(join(workspace, "unchecked.ts"), "export const unchecked = 1;\n");
    for (const args of [
      ["init", "--quiet"],
      ["add", "packages/example"],
    ]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }

    const result = spawnSync(process.execPath, [join(quality, "typecheck-coverage.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/example/unchecked.ts");
    if (checked) {
      expect(result.stdout).toContain("1/2 covered");
      expect(result.stderr).not.toContain("packages/example/included.ts");
    } else {
      expect(result.stdout).toContain("0/2 covered");
      expect(result.stderr).toContain("packages/example/included.ts");
    }
  },
);
