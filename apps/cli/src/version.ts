import { printJson } from "./output";

declare const FLUNCLE_CLI_VERSION: string | undefined;

export const currentVersion =
  typeof FLUNCLE_CLI_VERSION === "string" && FLUNCLE_CLI_VERSION.trim()
    ? FLUNCLE_CLI_VERSION.trim()
    : "0.1.0";
const latestReleaseUrl = "https://api.github.com/repos/mauricekleine/fluncle/releases/latest";

type VersionOptions = {
  check?: boolean;
  json?: boolean;
};

type GitHubLatestRelease = {
  tag_name?: string;
};

type VersionResult = {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  message: string;
};

export async function versionCommand(options: VersionOptions): Promise<void> {
  const result = options.check ? await buildVersionCheck() : buildCurrentVersion();

  if (options.json) {
    printJson({
      ok: true,
      ...result,
    });
    return;
  }

  console.log(result.message);
}

function buildCurrentVersion(): VersionResult {
  return {
    currentVersion,
    message: `fluncle ${currentVersion}`,
  };
}

async function buildVersionCheck(): Promise<VersionResult> {
  const response = await fetch(latestReleaseUrl, {
    headers: {
      "User-Agent": `fluncle/${currentVersion}`,
    },
  });

  if (response.status === 404) {
    return {
      currentVersion,
      message: `fluncle ${currentVersion}. No GitHub release found yet.`,
    };
  }

  if (!response.ok) {
    throw new Error(`Update check failed: ${response.status} ${response.statusText}`);
  }

  const release = (await response.json()) as GitHubLatestRelease;
  const latestVersion = normalizeVersion(release.tag_name);

  if (!latestVersion) {
    throw new Error("Update check failed: latest release did not include a tag");
  }

  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  const releaseUrl = `https://github.com/mauricekleine/fluncle/releases/latest`;

  return {
    currentVersion,
    latestVersion,
    message: updateAvailable
      ? `fluncle ${currentVersion}. Update available: ${latestVersion}. Run: curl -fsSL https://www.fluncle.com/cli/latest.sh | sh`
      : `fluncle ${currentVersion}. You are up to date.`,
    releaseUrl,
    updateAvailable,
  };
}

export function normalizeVersion(version: string | undefined): string | undefined {
  return version?.trim().replace(/^v/i, "");
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseVersion(version: string): [number, number, number] {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));

  return [
    Number.isInteger(parts[0]) ? parts[0] : 0,
    Number.isInteger(parts[1]) ? parts[1] : 0,
    Number.isInteger(parts[2]) ? parts[2] : 0,
  ];
}
