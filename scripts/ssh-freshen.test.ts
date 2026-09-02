import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "apps/ssh/deploy/fluncle-ssh-freshen.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(
  options: {
    archiveSha?: string;
    minifiedRef?: boolean;
    objectType?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "fluncle-ssh-freshen-"));
  roots.push(root);
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const archiveSha = options.archiveSha ?? sha;
  const fakeBin = join(root, "bin");
  const repoDir = join(root, "checkout");
  const stateDir = join(root, "state");
  const archiveDir = join(root, "archives");
  const tree = join(root, `fluncle-${archiveSha}`);
  const gitLog = join(root, "git.log");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(join(tree, "apps/ssh"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(tree, "apps/ssh/go.mod"), "module example.invalid/ssh\n");
  writeFileSync(join(tree, "apps/ssh/main.go"), "package main\nfunc main() {}\n");
  const ref = {
    object: { sha, type: options.objectType ?? "commit" },
    ref: "refs/heads/main",
  };
  writeFileSync(join(root, "ref.json"), JSON.stringify(ref, null, options.minifiedRef ? 0 : 2));
  const archive = join(archiveDir, sha);
  const tar = spawnSync("tar", ["-czf", archive, "-C", root, `fluncle-${archiveSha}`], {
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`fixture tar failed: ${tar.stderr}`);
  }
  writeFileSync(
    join(fakeBin, "git"),
    `#!/usr/bin/env bash\nprintf 'prompt=%s askpass=%s args=%s\\n' "\${GIT_TERMINAL_PROMPT:-}" "\${GIT_ASKPASS:-}" "$*" >>${JSON.stringify(gitLog)}\nprintf 'fatal: could not read Username for public repository\\nfatal: expected flush after ref listing\\n' >&2\nexit 1\n`,
  );
  chmodSync(join(fakeBin, "git"), 0o755);
  writeFileSync(join(fakeBin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(fakeBin, "flock"), 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    SSHFRESHEN_LOCK: join(root, "freshen.lock"),
    SSHFRESHEN_PUBLIC_ARCHIVE_BASE: pathToFileURL(archiveDir).href.replace(/\/$/, ""),
    SSHFRESHEN_PUBLIC_REF_URL: pathToFileURL(join(root, "ref.json")).href,
    SSHFRESHEN_REPO_DIR: repoDir,
    SSHFRESHEN_SHA_FILE: join(stateDir, "deployed-sha"),
    SSHFRESHEN_STATE_DIR: stateDir,
  };
  return { env, gitLog, repoDir, root, sha, stateDir, tree };
}

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env, timeout: 15_000 });
}

function manifest(tree: string) {
  const paths = ["apps/ssh/go.mod", "apps/ssh/main.go"];
  return paths
    .map(
      (path) =>
        `${createHash("sha256")
          .update(readFileSync(join(tree, path)))
          .digest("hex")}  ${path}`,
    )
    .join("\n");
}

describe("SSH freshen public-source fallback", () => {
  it("falls back without credentials when anonymous git prompts and verifies the exact archive commit", async () => {
    const box = fixture();
    writeFileSync(join(box.stateDir, "deployed-sha"), `${box.sha}\n`);

    const result = run(box.env);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("anonymous git sync failed; falling back");
    expect(result.stderr).toContain(`already at ${box.sha}`);
    expect(await Bun.file(box.gitLog).text()).toContain("prompt=0 askpass=/bin/false");
    expect(await Bun.file(box.gitLog).text()).toContain("credential.helper=");
    expect(await Bun.file(join(box.stateDir, "source/apps/ssh/main.go")).text()).toContain(
      "package main",
    );
  });

  it("accepts a minified GitHub commit-ref response", async () => {
    const box = fixture({ minifiedRef: true });
    writeFileSync(join(box.stateDir, "deployed-sha"), `${box.sha}\n`);

    const result = run(box.env);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`already at ${box.sha}`);
    expect(await Bun.file(join(box.stateDir, "source/apps/ssh/main.go")).exists()).toBe(true);
  });

  it("rejects a ref whose object is not a commit", async () => {
    const box = fixture({ minifiedRef: true, objectType: "tag" });

    const result = run(box.env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public main ref did not resolve to a commit SHA");
    expect(await Bun.file(join(box.stateDir, "source/apps/ssh/main.go")).exists()).toBe(false);
  });

  it("keeps docs-only archive advances as a no-op using the successful-deploy manifest", () => {
    const box = fixture();
    writeFileSync(join(box.stateDir, "deployed-sha"), `${"0".repeat(40)}\n`);
    writeFileSync(join(box.stateDir, "deployed-source-manifest.sha256"), `${manifest(box.tree)}\n`);

    const result = run(box.env);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("no compiled-source change");
    expect(result.stderr).toContain("no rebuild needed");
  });

  it("advances the source manifest only inside the successful post-swap branch", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const success = script.indexOf("if service_healthy; then");
    const manifestWrite = script.indexOf('>"$SOURCE_MANIFEST_FILE"');
    const rollback = script.indexOf("# ── 7. ROLLBACK");

    expect(success).toBeGreaterThan(-1);
    expect(manifestWrite).toBeGreaterThan(success);
    expect(manifestWrite).toBeLessThan(rollback);
    expect(script.match(/>"\$SOURCE_MANIFEST_FILE"/g)).toHaveLength(1);
  });

  it("refuses an archive whose root does not carry the resolved commit", async () => {
    const box = fixture({ archiveSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    const result = run(box.env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public source archive identity did not match");
    expect(await Bun.file(join(box.stateDir, "source/apps/ssh/main.go")).exists()).toBe(false);
  });
});
