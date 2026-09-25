import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "render-detached.sh");
const FIXTURE_TIMEOUT_MS = 30_000;

type Launch = {
  depsMissing?: boolean;

  claudeOutput?: string;

  claudeHangs?: boolean;

  existingConfig?: string;

  env?: Record<string, string>;
};

type LaunchResult = {
  claudeArgs: () => string;
  config: string;
  home: string;
  marker: string;
  runLog: string;
  stdout: string;
};

function write(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const SETSID_STUB = `#!/usr/bin/env bash\nexec "$@"\n`;

const SLEEP_STUB = `#!/usr/bin/env bash\nexec /bin/sleep 0.2\n`;

async function waitForFile(path: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
    await Bun.sleep(50);
  }
  return existsSync(path);
}

async function withLaunch<T>(
  options: Launch,
  body: (result: LaunchResult) => Promise<T> | T,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "render-detached-"));
  try {
    return await body(runLauncher(options, root));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runLauncher(options: Launch, root: string): LaunchResult {
  const home = join(root, "home");
  const stub = join(root, "stub");
  const workspace = join(home, "fluncle");
  mkdirSync(join(workspace, "packages/skills/fluncle-video/automation"), { recursive: true });
  mkdirSync(stub, { recursive: true });

  mkdirSync(join(workspace, "node_modules/browserslist"), { recursive: true });
  if (options.depsMissing !== true) {
    writeFileSync(join(workspace, "node_modules/browserslist/package.json"), "{}\n");
  }
  writeFileSync(
    join(workspace, "packages/skills/fluncle-video/automation/render-queue.prompt.md"),
    "render exactly one queued finding\n",
  );
  if (options.existingConfig !== undefined) {
    writeFileSync(join(home, ".claude.json"), options.existingConfig);
  }
  write(join(stub, "setsid"), SETSID_STUB);
  write(join(stub, "sleep"), SLEEP_STUB);
  write(join(stub, "bun"), `#!/usr/bin/env bash\nexec ${process.execPath} "$@"\n`);
  write(
    join(stub, "claude"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >"${join(stub, "claude-args")}"`,
      `printf '%s\\n' ${JSON.stringify(options.claudeOutput ?? "rendering")}`,
      options.claudeHangs === true ? "exec /bin/sleep 30" : "exit 0",
      "",
    ].join("\n"),
  );

  const run = spawnSync("bash", [LAUNCHER], {
    encoding: "utf8",
    env: {
      CLAUDE_CONFIG_FILE: join(home, ".claude.json"),
      FLUNCLE_WORKSPACE: workspace,
      HOME: home,
      PATH: `${stub}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TRUST_GUARD_SECONDS: "30",
      ...options.env,
    },
    timeout: FIXTURE_TIMEOUT_MS,
  });

  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    claudeArgs: () => read(join(stub, "claude-args")),
    config: join(home, ".claude.json"),
    home,
    marker: join(home, "conductor-run.done"),
    runLog: join(home, "conductor-run.log"),
    stdout: run.stdout ?? "",
  };
}

describe("the trust setting", () => {
  test("is written for the render workspace's exact path, and disturbs nothing else", async () => {
    await withLaunch(
      {
        claudeOutput: "rendering",
        existingConfig: JSON.stringify({
          installMethod: "native",
          projects: {
            "/home/user/elsewhere": { hasTrustDialogAccepted: false, history: ["a"] },
          },
        }),
      },
      (result) => {
        const config = JSON.parse(readFileSync(result.config, "utf8")) as {
          installMethod?: string;
          projects: Record<string, { hasTrustDialogAccepted?: boolean; history?: string[] }>;
        };
        const workspace = join(result.home, "fluncle");

        expect(config.projects[workspace]?.hasTrustDialogAccepted).toBe(true);

        expect(config.projects["/home/user/elsewhere"]?.hasTrustDialogAccepted).toBe(false);
        expect(config.projects["/home/user/elsewhere"]?.history).toEqual(["a"]);
        expect(config.installMethod).toBe("native");
        expect(result.stdout).toContain("render-detached: launched");
      },
    );
  });

  test("survives a corrupt config rather than refusing the render over it", async () => {
    await withLaunch({ existingConfig: "{not json" }, (result) => {
      const config = JSON.parse(readFileSync(result.config, "utf8")) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };

      expect(config.projects[join(result.home, "fluncle")]?.hasTrustDialogAccepted).toBe(true);
      expect(result.stdout).toContain("render-detached: launched");
    });
  });

  test(
    "an ignored allowlist kills the run early and names it on the marker",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      await withLaunch(
        {
          claudeHangs: true,
          claudeOutput:
            "Ignoring 16 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.",
        },
        async (result) => {
          expect(result.stdout).toContain("render-detached: launched");
          expect(await waitForFile(result.marker, 15_000)).toBe(true);

          expect(readFileSync(result.marker, "utf8")).toContain("EXIT=trust-denied");
        },
      );
    },
  );

  test(
    "a properly permissioned run is left alone and reports its own exit code",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      await withLaunch({ claudeOutput: "rendering" }, async (result) => {
        expect(await waitForFile(result.marker, 15_000)).toBe(true);
        const marker = readFileSync(result.marker, "utf8");

        expect(marker).toContain("EXIT=0");
        expect(marker).toContain("DURATION=");

        expect(result.claudeArgs()).toContain("--model opus");
        expect(result.claudeArgs()).toContain("--effort high");
        expect(result.claudeArgs()).toContain("--max-turns 150");
      });
    },
  );
});

describe("the reasoning effort", () => {
  test(
    "RENDER_CLAUDE_EFFORT overrides the pinned level",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      await withLaunch({ env: { RENDER_CLAUDE_EFFORT: "xhigh" } }, async (result) => {
        expect(await waitForFile(result.marker, 15_000)).toBe(true);
        expect(result.claudeArgs()).toContain("--effort xhigh");
      });
    },
  );

  test(
    "a level the CLI would not accept falls back to high and says so in the run log",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      await withLaunch({ env: { RENDER_CLAUDE_EFFORT: "ludicrous" } }, async (result) => {
        expect(await waitForFile(result.marker, 15_000)).toBe(true);
        expect(result.claudeArgs()).toContain("--effort high");
        expect(readFileSync(result.marker, "utf8")).toContain("EXIT=0");
        expect(readFileSync(result.runLog, "utf8")).toContain(
          "RENDER_CLAUDE_EFFORT=ludicrous is not low|medium|high|xhigh|max; using high",
        );
      });
    },
  );
});

describe("the workspace's modules", () => {
  test("an empty package directory is refused as incomplete, and the agent is never handed the install", async () => {
    await withLaunch({ depsMissing: true }, (result) => {
      expect(result.stdout).toContain("render-detached: refused deps-missing");
      expect(result.stdout).not.toContain("render-detached: launched");

      expect(result.claudeArgs()).toBe("");

      expect(readFileSync(result.marker, "utf8")).toContain("EXIT=deps-missing");
    });
  });
});
