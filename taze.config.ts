import { readFileSync } from "node:fs";
import { defineConfig } from "taze";

type RenovateRule = {
  allowedVersions?: string;
  dependencyDashboardApproval?: boolean;
  enabled?: boolean;
  matchPackageNames?: string[];
  matchUpdateTypes?: string[];
};

const secondsPerDay = 86_400;

function bunfigMinimumReleaseAgeDays(): number {
  const bunfig = readFileSync(new URL("./bunfig.toml", import.meta.url), "utf8");
  const seconds = /^minimumReleaseAge\s*=\s*(\d+)/m.exec(bunfig)?.[1];

  if (!seconds) {
    throw new Error("bunfig.toml must set [install] minimumReleaseAge for taze to mirror");
  }

  return Number(seconds) / secondsPerDay;
}

function excludedVersions(rule: RenovateRule): string {
  const ceiling = /^<\s*(\S+)$/.exec(rule.allowedVersions ?? "")?.[1];

  if (!ceiling) {
    throw new Error(
      `taze.config.ts maps only "<version" allowedVersions holds; got "${rule.allowedVersions}"`,
    );
  }

  return `@>=${ceiling}`;
}

function renovateHolds(): string[] {
  const renovate = JSON.parse(
    readFileSync(new URL("./renovate.json", import.meta.url), "utf8"),
  ) as { packageRules: RenovateRule[] };

  return renovate.packageRules.flatMap((rule) => {
    const names = rule.matchPackageNames ?? [];

    if (rule.matchUpdateTypes) {
      return [];
    }

    if (rule.allowedVersions) {
      return names.map((name) => `${name}${excludedVersions(rule)}`);
    }

    return rule.enabled === false || rule.dependencyDashboardApproval === true ? names : [];
  });
}

export default defineConfig({
  exclude: renovateHolds(),
  includeLocked: true,
  maturityPeriod: bunfigMinimumReleaseAgeDays(),
  recursive: true,
  requestTimeout: 30_000,
});
