// Update-available notice for the `fluncle` CLI.
//
// Doctrine: a command's behaviour is sacred. This check is fire-and-forget,
// swallows every error, no-ops offline, and only ever prints a hint to STDERR
// AFTER the command's own output — it can never change exit code, stdout, or
// timing in a way a scripted consumer would notice. The latest version is cached
// ~24h in a local state file so a normal invocation rarely touches the network.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, currentVersion, normalizeVersion } from "./version";

// npm registry abbreviated metadata for the published `fluncle` package. The
// abbreviated `Accept` header keeps the payload to a few KB (dist-tags only).
const registryUrl = "https://registry.npmjs.org/fluncle";
const releasesUrl = "https://github.com/mauricekleine/fluncle/releases/latest";

const cacheTtlMs = 24 * 60 * 60 * 1000; // 24h
const fetchTimeoutMs = 1500;

type UpdateState = {
  // Wall-clock ms of the last successful registry check.
  checkedAt: number;
  // The latest published version at that check (normalized, no leading v).
  latestVersion: string;
};

type InstallMethod = "npm" | "homebrew" | "binary";

/**
 * Maybe print an "update available" hint to stderr, AFTER the command ran.
 *
 * Every failure path is swallowed: a thrown error, a network blip, a malformed
 * cache file, or a missing latest version all resolve to a silent no-op. The
 * caller awaits this only so the process doesn't exit mid-write; it is never
 * allowed to reject.
 */
export async function notifyIfUpdateAvailable(args: string[]): Promise<void> {
  try {
    if (!shouldNotify(args)) {
      return;
    }

    const latestVersion = await resolveLatestVersion();

    if (!latestVersion) {
      return;
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return;
    }

    process.stderr.write(`\n${buildNotice(currentVersion, latestVersion)}\n`);
  } catch {
    // Never let the notifier affect the command. Swallow everything.
  }
}

// Gate the notice on the environment, not just the version. We skip it for
// machine-readable output (--json), for any non-TTY stderr (piped/redirected),
// and for the explicit opt-out. Help/version/about already speak about updates,
// so we don't double up there.
export function shouldNotify(args: string[]): boolean {
  if (process.env.FLUNCLE_NO_UPDATE_NOTIFIER === "1") {
    return false;
  }

  if (process.env.CI) {
    return false;
  }

  if (process.stderr.isTTY !== true) {
    return false;
  }

  if (args.includes("--json")) {
    return false;
  }

  const command = firstPositional(args);

  if (command === "version" || command === "about" || command === "help") {
    return false;
  }

  if (args.includes("--help") || args.includes("-h") || args.includes("--version")) {
    return false;
  }

  return true;
}

function firstPositional(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--env") {
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    return arg;
  }

  return undefined;
}

// Read the cache; on a miss/stale/parse-failure, hit the registry once, persist,
// and return the latest. Any network/IO failure returns the cached value if we
// have one, else undefined (silent no-op upstream).
async function resolveLatestVersion(): Promise<string | undefined> {
  const cached = await readCache();

  if (cached && Date.now() - cached.checkedAt < cacheTtlMs) {
    return cached.latestVersion;
  }

  const fetched = await fetchLatestVersion();

  if (!fetched) {
    return cached?.latestVersion;
  }

  await writeCache({ checkedAt: Date.now(), latestVersion: fetched });

  return fetched;
}

async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await fetch(registryUrl, {
      headers: {
        // Abbreviated metadata: small payload, dist-tags included.
        Accept: "application/vnd.npm.install-v1+json",
        "User-Agent": `fluncle/${currentVersion}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as { "dist-tags"?: { latest?: string } };

    return normalizeVersion(body["dist-tags"]?.latest);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function readCache(): Promise<UpdateState | undefined> {
  try {
    const raw = await readFile(cacheFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateState>;

    if (typeof parsed.checkedAt !== "number" || typeof parsed.latestVersion !== "string") {
      return undefined;
    }

    return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion };
  } catch {
    return undefined;
  }
}

async function writeCache(state: UpdateState): Promise<void> {
  try {
    const file = cacheFilePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state), "utf8");
  } catch {
    // A read-only HOME (or any IO failure) just means we re-check next time.
  }
}

// State lives next to the existing CLI config (~/.config/fluncle on every OS we
// ship to; the env loader already reads ~/.config/fluncle/.env.*), honoring
// XDG_CACHE_HOME when set so we land in the user's cache dir.
function cacheFilePath(): string {
  const base =
    process.env.XDG_CACHE_HOME?.trim() ||
    (platform() === "win32" && process.env.LOCALAPPDATA?.trim()) ||
    join(homedir(), ".config");

  return join(base, "fluncle", "update-check.json");
}

function buildNotice(current: string, latest: string): string {
  const method = detectInstallMethod({ entry: entryPath(), execPath: process.execPath || "" });
  const command = updateCommand(method);

  return [`Update available: fluncle ${current} → ${latest}`, `Run: ${command}`].join("\n");
}

export function updateCommand(method: InstallMethod): string {
  if (method === "homebrew") {
    return "brew upgrade fluncle";
  }

  if (method === "binary") {
    return `curl -fsSL https://www.fluncle.com/cli/latest.sh | sh  (or ${releasesUrl})`;
  }

  return "npm i -g fluncle@latest";
}

/**
 * Best-effort install-method detection from how this process was launched and
 * where the executable resolves on disk.
 *
 * - homebrew: the running path lives under a Homebrew prefix (Cellar / opt /
 *   /usr/local|/opt/homebrew/bin) — set explicitly by `brew` or by the symlink.
 * - npm: launched under node with a JS bundle entry (the published `fluncle`
 *   npm package is a `.mjs` run by node), or resolved under a node_modules tree.
 * - binary: the Bun `--compile` standalone (process.execPath IS the fluncle
 *   binary, no separate script entry) — the curl-installer / GitHub-release path.
 */
export function detectInstallMethod(launch: { entry: string; execPath: string }): InstallMethod {
  const { entry, execPath } = launch;
  const haystack = `${execPath}\n${entry}`.toLowerCase();

  if (isHomebrewPath(haystack)) {
    return "homebrew";
  }

  // The Bun standalone binary runs itself: execPath ends in `fluncle...` and the
  // entry module is that same compiled binary (no separate .js/.mjs/.ts script).
  if (isCompiledBinary(execPath, entry)) {
    return "binary";
  }

  // node + a JS bundle (or anything under node_modules) is the npm install.
  if (
    entry.endsWith(".mjs") ||
    entry.endsWith(".js") ||
    entry.endsWith(".cjs") ||
    haystack.includes(`${sep}node_modules${sep}`) ||
    haystack.includes("/node_modules/")
  ) {
    return "npm";
  }

  // Default to npm: it's the broadest channel and `npm i -g fluncle@latest` is
  // a safe, conventional instruction even if detection was inconclusive.
  return "npm";
}

function isHomebrewPath(haystack: string): boolean {
  return (
    haystack.includes("/cellar/") ||
    haystack.includes("/homebrew/") ||
    haystack.includes("/.linuxbrew/") ||
    haystack.includes("/usr/local/cellar/") ||
    haystack.includes("homebrew")
  );
}

function isCompiledBinary(execPath: string, entry: string): boolean {
  const exec = execPath.toLowerCase();
  // A Bun-compiled binary is named `fluncle` (or `fluncle-<os>-<arch>`); the
  // running executable is not the generic `node`/`bun` runtime, and the entry
  // module resolves back to that same executable.
  const base = exec.split(/[\\/]/).pop() ?? "";

  if (!base.startsWith("fluncle")) {
    return false;
  }

  return entry === "" || entry === execPath;
}

function entryPath(): string {
  // process.argv[1] is the script path under node; for a Bun --compile binary
  // it is absent or equal to execPath. import.meta.url backs it up when present.
  const fromArgv = process.argv[1] ?? "";

  if (fromArgv) {
    return fromArgv;
  }

  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}
