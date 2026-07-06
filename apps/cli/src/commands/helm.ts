// Fluncle's Helm — the launcher (HELM-CONTRACT.md, Unit 1). `fluncle helm`
// starts-or-focuses the local mission-control daemon (apps/helm, :4190) and opens
// its app window; `install`/`uninstall` manage the launchd LaunchAgent so the
// daemon rises at login. Like packages/live's show, this is LOCAL orchestration —
// it spawns processes on this Mac, it never talks to the Fluncle Worker.

import { existsSync, mkdirSync, openSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openExternal } from "../open-external";
import { CliError } from "../output";

const HELM_PORT = 4190;
const HELM_URL = `http://127.0.0.1:${HELM_PORT}`;
const LAUNCH_AGENT_LABEL = "com.fluncle.helm";

function launchAgentPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function helmLogPath(): string {
  return join(homedir(), "Library/Logs/fluncle-helm.log");
}

const HELM_DIR_FILE = join(homedir(), ".config/fluncle/helm-dir");

function walkUpForHelm(start: string): string | null {
  let dir = start;

  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "apps/helm");

    if (existsSync(join(candidate, "src/server.ts"))) {
      return candidate;
    }

    const parent = dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  return null;
}

/** Remember where the helm lives, so the command answers from any directory. */
function persistHelmDir(dir: string): void {
  try {
    mkdirSync(dirname(HELM_DIR_FILE), { recursive: true });
    writeFileSync(HELM_DIR_FILE, `${dir}\n`, { mode: 0o600 });
  } catch {
    // best-effort: a read-only home never blocks the helm itself
  }
}

/**
 * Where apps/helm lives. FLUNCLE_HELM_DIR wins; then a walk up from the cwd and
 * from this file (in-repo runs); then the path remembered from the last
 * successful run (~/.config/fluncle/helm-dir) — so the compiled binary answers
 * from ANY directory once it has found the repo a single time.
 */
export function resolveHelmDir(): string {
  const fromEnv = process.env.FLUNCLE_HELM_DIR;

  if (fromEnv) {
    if (!existsSync(join(fromEnv, "src/server.ts"))) {
      throw new CliError(
        "helm_not_found",
        `FLUNCLE_HELM_DIR points at ${fromEnv}, but there's no helm there (src/server.ts missing).`,
      );
    }

    return resolve(fromEnv);
  }

  const found = walkUpForHelm(process.cwd()) ?? walkUpForHelm(import.meta.dir);

  if (found) {
    persistHelmDir(found);

    return found;
  }

  try {
    const remembered = readFileSync(HELM_DIR_FILE, "utf8").trim();

    if (remembered && existsSync(join(remembered, "src/server.ts"))) {
      return remembered;
    }
  } catch {
    // nothing remembered yet
  }

  throw new CliError(
    "helm_not_found",
    "No helm aboard. Run this once from the fluncle repo (the helm remembers the way after that), or set FLUNCLE_HELM_DIR.",
  );
}

function resolveBun(): string {
  const bun = Bun.which("bun");

  if (!bun) {
    throw new CliError("no_bun", "No bun on the PATH. The helm daemon runs under bun.");
  }

  return bun;
}

async function daemonHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${HELM_URL}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });

    return response.ok;
  } catch {
    return false;
  }
}

/** Build the glass if dist/ is missing — the daemon serves it statically. */
async function ensureBuilt(helmDir: string): Promise<void> {
  if (existsSync(join(helmDir, "dist/index.html"))) {
    return;
  }

  console.log("The glass isn't built yet. Building it once…");
  const proc = Bun.spawn([resolveBun(), "run", "build"], {
    cwd: helmDir,
    stderr: "inherit",
    stdin: "ignore",
    stdout: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new CliError("helm_build_failed", `The glass build failed (exit ${exitCode}).`);
  }
}

function bootDaemon(helmDir: string): void {
  const logPath = helmLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");

  const proc = Bun.spawn([resolveBun(), "src/server.ts"], {
    cwd: helmDir,
    stderr: logFd,
    stdin: "ignore",
    stdout: logFd,
  });
  proc.unref();
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await daemonHealthy()) {
      return true;
    }

    await Bun.sleep(250);
  }

  return false;
}

/**
 * Open the helm as an app-mode window: Chrome's `--app` chrome-less frame when
 * Chrome is aboard, the default browser otherwise. `open -n` gives the window
 * its own instance, so `fluncle helm` always lands you on a helm window.
 */
async function openAppWindow(): Promise<void> {
  if (process.platform === "darwin" && chromeInstalled()) {
    const proc = Bun.spawn(["open", "-na", "Google Chrome", "--args", `--app=${HELM_URL}`], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });

    if ((await proc.exited) === 0) {
      return;
    }
  }

  await openExternal(HELM_URL);
}

function chromeInstalled(): boolean {
  return (
    existsSync("/Applications/Google Chrome.app") ||
    existsSync(join(homedir(), "Applications/Google Chrome.app"))
  );
}

/** `fluncle helm` — start-or-focus: daemon healthy? open the window. Else raise it first. */
export async function helmOpenCommand(): Promise<void> {
  if (await daemonHealthy()) {
    console.log(`The helm holds on :${HELM_PORT}. Opening the window.`);
    await openAppWindow();
    return;
  }

  const helmDir = resolveHelmDir();
  await ensureBuilt(helmDir);
  bootDaemon(helmDir);

  if (!(await waitForHealth(15_000))) {
    throw new CliError(
      "helm_no_answer",
      `The daemon didn't answer on :${HELM_PORT}. Its log is at ${helmLogPath()}.`,
    );
  }

  console.log(`Helm raised on :${HELM_PORT}. Opening the window.`);
  await openAppWindow();
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The LaunchAgent plist (label com.fluncle.helm): the daemon under launchd —
 * RunAtLoad at login, crash-restart (KeepAlive on non-clean exit only), logs to
 * ~/Library/Logs/fluncle-helm.log, and a PATH launchd's minimal one lacks.
 * Exported pure for the tests.
 */
export function buildLaunchAgentPlist(helmDir: string, bunPath: string, logPath: string): string {
  const path = `${dirname(bunPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>src/server.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(helmDir)}</string>
</dict>
</plist>
`;
}

function currentUid(): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

  if (uid === undefined) {
    throw new CliError("no_uid", "Couldn't read the user id — launchd needs a gui domain.");
  }

  return uid;
}

async function launchctl(args: string[]): Promise<number> {
  const proc = Bun.spawn(["launchctl", ...args], {
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });

  return proc.exited;
}

/** `fluncle helm install` — write the LaunchAgent and load it now. */
export async function helmInstallCommand(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new CliError(
      "unsupported_platform",
      "launchd is a macOS thing. Nothing to install here.",
    );
  }

  const helmDir = resolveHelmDir();
  await ensureBuilt(helmDir);

  const plistPath = launchAgentPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(helmLogPath()), { recursive: true });
  writeFileSync(plistPath, buildLaunchAgentPlist(helmDir, resolveBun(), helmLogPath()));

  const uid = currentUid();
  // Re-installs replace the running agent: boot the old one out first (a first
  // install has nothing to boot out — that failure is fine).
  await launchctl(["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  const exitCode = await launchctl(["bootstrap", `gui/${uid}`, plistPath]);

  if (exitCode !== 0) {
    throw new CliError(
      "launchctl_refused",
      `launchctl bootstrap refused (exit ${exitCode}). The plist is at ${plistPath}.`,
    );
  }

  console.log(`LaunchAgent installed (${LAUNCH_AGENT_LABEL}).`);
  console.log(`The daemon rises at login and holds :${HELM_PORT}. Log: ${helmLogPath()}`);
}

/** `fluncle helm uninstall` — stand the agent down and remove the plist. */
export async function helmUninstallCommand(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new CliError("unsupported_platform", "launchd is a macOS thing. Nothing to remove here.");
  }

  const plistPath = launchAgentPlistPath();
  await launchctl(["bootout", `gui/${currentUid()}/${LAUNCH_AGENT_LABEL}`]);

  if (existsSync(plistPath)) {
    rmSync(plistPath);
    console.log("LaunchAgent removed and the daemon stood down.");
    return;
  }

  console.log("No LaunchAgent on file. Nothing stood down.");
}
