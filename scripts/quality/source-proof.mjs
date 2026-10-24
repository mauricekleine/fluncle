import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const artifactName = "quality-source-proof";
const workflowPath = ".github/workflows/quality-checks.yml";
const freshnessMs = 6 * 60 * 60 * 1000;
const shaPattern = /^[0-9a-f]{40}$/;
const qualityOwners = [
  "Selected quality lanes",
  ...[1, 2, 3, 4].map((shard) => `Public flows when selected (${shard}/4)`),
];

function ownersSucceeded(jobs) {
  return qualityOwners.every((name) => {
    const matches = jobs.filter((job) => job.name === name);
    return (
      matches.length === 1 &&
      matches[0].status === "completed" &&
      matches[0].conclusion === "success"
    );
  });
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function createProof(context) {
  const { root, sha, base, head, repository, runId, attempt, pr } = context;
  if (
    ![sha, base, head].every((value) => shaPattern.test(value)) ||
    attempt !== 1 ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(pr) ||
    pr <= 0
  ) {
    return null;
  }
  const parents = git(root, "show", "-s", "--format=%P", sha).split(" ");
  if (
    git(root, "rev-parse", "HEAD") !== sha ||
    parents.length !== 2 ||
    parents[0] !== base ||
    parents[1] !== head
  ) {
    return null;
  }
  return {
    attempt,
    base,
    head,
    pr,
    repository,
    runId,
    sha,
    tree: git(root, "rev-parse", `${sha}^{tree}`),
    version: 1,
  };
}

function successfulRun(run, workflow, pr, repository, now) {
  const finished = Date.parse(run.updated_at);
  return (
    run.workflow_id === workflow.id &&
    run.path === workflowPath &&
    run.event === "pull_request" &&
    run.head_repository?.full_name === repository &&
    run.head_sha === pr.head.sha &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.run_attempt === 1 &&
    finished >= Date.parse(run.created_at) &&
    finished <= Date.parse(pr.merged_at) &&
    finished <= now &&
    now - finished <= freshnessMs
  );
}

export async function assessReuse(context, source) {
  const fallback = (reason) => ({ reason, reused: false });
  const { root, sha, base, repository, now } = context;
  if (context.event !== "push" || context.ref !== "refs/heads/main") {
    return fallback("not-main-push");
  }
  if (
    ![sha, base].every((value) => shaPattern.test(value)) ||
    git(root, "rev-parse", "HEAD") !== sha
  ) {
    throw new Error("Main checkout identity does not match the push");
  }
  if (git(root, "show", "-s", "--format=%P", sha).split(" ")[0] !== base) {
    return fallback("push-is-not-one-merge");
  }
  const changed = git(root, "diff", "--name-only", base, sha).split("\n");
  if (
    changed.some((path) =>
      /^(\.github\/|scripts\/quality\/|bun\.lock$|bunfig\.toml$|package\.json$|turbo\.json$|\.ox|(?:.*\/)?(?:package\.json|bunfig\.toml|tsconfig[^/]*\.json)$)/.test(
        path,
      ),
    )
  ) {
    return fallback("validation-controls-changed");
  }
  try {
    const prs = (await source.json(`/commits/${sha}/pulls`)).filter(
      (pr) =>
        pr.merged_at &&
        pr.merge_commit_sha === sha &&
        pr.base?.ref === "main" &&
        pr.base?.repo?.full_name === repository &&
        pr.head?.repo?.full_name === repository,
    );
    if (prs.length !== 1) {
      return fallback("missing-or-ambiguous-merged-pr");
    }
    const pr = prs[0];
    const workflow = await source.json("/actions/workflows/quality-checks.yml");
    const { workflow_runs: runs } = await source.json(
      `/actions/workflows/quality-checks.yml/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=100`,
    );
    const tree = git(root, "rev-parse", `${sha}^{tree}`);
    for (const run of runs) {
      if (!successfulRun(run, workflow, pr, repository, now)) {
        continue;
      }
      const { jobs } = await source.json(`/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
      if (
        !ownersSucceeded(jobs) ||
        jobs.filter(
          (job) =>
            job.name === "Lint, Format, and Typecheck" &&
            job.status === "completed" &&
            job.conclusion === "success",
        ).length !== 1
      ) {
        continue;
      }
      const { artifacts } = await source.json(`/actions/runs/${run.id}/artifacts?per_page=100`);
      const matches = artifacts.filter(
        (artifact) =>
          artifact.name === artifactName &&
          !artifact.expired &&
          artifact.size_in_bytes > 0 &&
          artifact.size_in_bytes < 65536,
      );
      if (matches.length !== 1) {
        continue;
      }
      const proof = await source.proof(matches[0].id);
      if (
        proof.version !== 1 ||
        proof.repository !== repository ||
        proof.runId !== run.id ||
        proof.attempt !== 1 ||
        proof.pr !== pr.number ||
        proof.head !== pr.head.sha ||
        proof.base !== base ||
        proof.tree !== tree ||
        !shaPattern.test(proof.sha)
      ) {
        continue;
      }
      const commit = await source.json(`/git/commits/${proof.sha}`);
      if (
        commit.sha !== proof.sha ||
        commit.tree?.sha !== tree ||
        commit.parents?.length !== 2 ||
        commit.parents[0].sha !== base ||
        commit.parents[1].sha !== pr.head.sha
      ) {
        continue;
      }
      return {
        base,
        pr: pr.number,
        proofSha: proof.sha,
        reason: "matching-pr-tree-and-base",
        reused: true,
        runId: run.id,
        sha,
        tree,
      };
    }
    return fallback("no-matching-successful-pr-proof");
  } catch {
    return fallback("proof-unavailable-run-fresh-validation");
  }
}

function githubSource(repository) {
  const api = (path) =>
    execFileSync("gh", ["api", "--allow-escape-sequences", `repos/${repository}${path}`], {
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
  return {
    json: async (path) => JSON.parse(api(path).toString()),
    proof: async (id) => {
      const archive = api(`/actions/artifacts/${id}/zip`);
      const result = execFileSync(
        "python3",
        [
          "-c",
          "import sys,io,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.namelist()==['quality-source-proof.json']; i=z.infolist()[0]; assert i.file_size<65536; print(z.read(i).decode())",
        ],
        { input: archive, maxBuffer: 65536, timeout: 5000 },
      );
      return JSON.parse(result.toString());
    },
  };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const context = {
    base: event.before,
    event: process.env.GITHUB_EVENT_NAME,
    now: Date.now(),
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    root: process.cwd(),
    sha: process.env.GITHUB_SHA,
  };
  if (process.argv[2] === "create") {
    const proof = createProof({
      ...context,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      base: event.pull_request?.base.sha,
      head: event.pull_request?.head.sha,
      pr: event.pull_request?.number,
      runId: Number(process.env.GITHUB_RUN_ID),
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `created=${proof !== null}\n`);
    if (proof) {
      writeFileSync(process.argv[3], `${JSON.stringify(proof)}\n`);
    }
    return;
  }
  const decision = await assessReuse(context, githubSource(context.repository));
  appendFileSync(process.env.GITHUB_OUTPUT, `reused=${decision.reused}\n`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n## PR source proof\n\n${JSON.stringify(decision)}\n`,
  );
  console.log(JSON.stringify(decision));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
