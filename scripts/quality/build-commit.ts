import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const BUILT_REPOSITORY_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export function buildCommitSha(): string {
  const workersBuildsCommitOrBranchName = process.env.WORKERS_CI_COMMIT_SHA ?? "";
  if (FULL_COMMIT_SHA.test(workersBuildsCommitOrBranchName)) {
    return workersBuildsCommitOrBranchName;
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: BUILT_REPOSITORY_DIRECTORY,
    encoding: "utf8",
  });
  return head.status === 0 ? head.stdout.trim() : "";
}

if (import.meta.main) {
  process.stdout.write(buildCommitSha());
}
