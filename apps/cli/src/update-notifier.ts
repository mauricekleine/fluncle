import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, currentVersion, normalizeVersion } from "./version";

const registryUrl = "https://registry.npmjs.org/fluncle";
const releasesUrl = "https://github.com/mauricekleine/fluncle/releases/latest";

const cacheTtlMs = 24 * 60 * 60 * 1000;
const fetchTimeoutMs = 1500;

type UpdateState = {
  checkedAt: number;

  latestVersion: string;
};

type InstallMethod = "npm" | "homebrew" | "binary";

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
  } catch {}
}

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
    if (arg === undefined) {
      continue;
    }

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
  } catch {}
}

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

export function detectInstallMethod(launch: { entry: string; execPath: string }): InstallMethod {
  const { entry, execPath } = launch;
  const haystack = `${execPath}\n${entry}`.toLowerCase();

  if (isHomebrewPath(haystack)) {
    return "homebrew";
  }

  if (isCompiledBinary(execPath, entry)) {
    return "binary";
  }

  if (
    entry.endsWith(".mjs") ||
    entry.endsWith(".js") ||
    entry.endsWith(".cjs") ||
    haystack.includes(`${sep}node_modules${sep}`) ||
    haystack.includes("/node_modules/")
  ) {
    return "npm";
  }

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

  const base = exec.split(/[\\/]/).pop() ?? "";

  if (!base.startsWith("fluncle")) {
    return false;
  }

  return entry === "" || entry === execPath;
}

function entryPath(): string {
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
