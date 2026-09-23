// THE LAUNCHER'S PRECONDITIONS — driven through the REAL script against a stubbed `claude`.
//
// render-detached.sh is the last thing that runs before a render window is spent, and two of
// its checks exist because each of them costs a whole window when it is discovered from the
// inside instead:
//
//   1. THE TRUST SETTING. Claude Code ignores a workspace's `permissions.allow` entries until
//      the workspace is trusted, and a headless `claude -p` with its allowlist ignored has its
//      tool calls denied — it burns the window doing nothing and dies without shipping. The
//      launcher sets the per-project `hasTrustDialogAccepted` key for the render workspace's
//      EXACT path, and refuses to launch if it cannot. If the warning shows up anyway, the
//      guard kills the run early rather than paying out the window.
//   2. THE WORKSPACE'S MODULES. A checkout without its install dies at the first build step,
//      and the agent — the only thing awake — improvises a full-workspace install beside its
//      own session. The launcher refuses instead, and the agent never installs.
//
// A gate like that is unproven until a synthetic failure makes it fire, so every case runs the
// real script in a temp HOME with a stubbed `claude` and asserts on what it DID.
//
//   bun test docs/agents/hermes/scripts/render-detached.test.ts

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
  /** Omit the workspace's node_modules, the incomplete-tree case. */
  depsMissing?: boolean;
  /** What the stubbed `claude` writes to the run log before it hangs or exits. */
  claudeOutput?: string;
  /** The stub hangs instead of exiting, so the trust guard has something to kill. */
  claudeHangs?: boolean;
  /** Pre-existing ~/.claude.json content, to prove nothing else is disturbed. */
  existingConfig?: string;
  /** Extra environment for the launcher, e.g. an effort override. */
  env?: Record<string, string>;
};

type LaunchResult = {
  /** Read lazily: the render is detached, so its argv lands after the launcher returns. */
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

/** `setsid` is Linux-only; the box has it, this host does not. The detach is not under test. */
const SETSID_STUB = `#!/usr/bin/env bash\nexec "$@"\n`;
// The guard's wait is real-but-brief here, so a case that should detect the warning has time to
// see it written without the fixture spending the production interval.
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

/**
 * Run the real launcher in a throwaway HOME and hand the result to `body`. The temp root is
 * torn down in a `finally`, so a failing assertion never leaves a tree behind.
 */
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
  // `depsMissing: true` leaves the package directory in place but EMPTY — the shape a killed
  // install leaves behind — so the launcher is judged on the manifest, not the directory.
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
        // The key is PER PROJECT: another entry's own answer is its own business.
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
          // A permission-starved run is ended in seconds, with a reason, instead of spending
          // the window and dying markerless.
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
        // The render stays pinned to Opus, at a fixed effort, and bounded, whatever the CLI's
        // defaults become.
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
      // No render was spawned at all.
      expect(result.claudeArgs()).toBe("");
      // The marker carries the same reason, for the tick that reads the marker rather than
      // the trigger's output.
      expect(readFileSync(result.marker, "utf8")).toContain("EXIT=deps-missing");
    });
  });
});
