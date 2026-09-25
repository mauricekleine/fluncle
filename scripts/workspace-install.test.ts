import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { workspaceInstallProblem } from "./quality/workspace-install.mjs";

const REPO = resolve(import.meta.dir, "..");
const GUARD = resolve(REPO, "scripts/quality/workspace-install.mjs");

describe("workspace install guard", () => {
  it("is satisfied by a checkout that resolves a workspace package inside itself", () => {
    expect(workspaceInstallProblem(REPO)).toBeNull();
  });

  it("names the escape when the package resolves outside the checkout it is asked about", () => {
    const problem = workspaceInstallProblem(resolve(REPO, "apps/web"));

    expect(problem).toContain("OUTSIDE");
    expect(problem).toContain("another one's install");
  });

  it("reports a workspace package that does not resolve at all", () => {
    expect(workspaceInstallProblem(REPO, "@fluncle/not-a-real-workspace-package")).toContain(
      "does not resolve at all",
    );
  });

  it("exits clean when RUN in this checkout", () => {
    const result = spawnSync("node", [GUARD], { cwd: REPO, encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  it("does not act on import", () => {
    const probe = `import("${GUARD}").then(() => { process.stdout.write("imported"); });`;
    const result = spawnSync("node", ["--input-type=module", "-e", probe], {
      cwd: REPO,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("imported");
    expect(result.stderr).not.toContain("no install of its own");
  });
});
