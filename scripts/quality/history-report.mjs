#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { classifyPaths, repositoryRoot } from "./classifier.mjs";

const MODEL = JSON.parse(readFileSync(join(import.meta.dirname, "timing-model.json"), "utf8"));

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: repositoryRoot(),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${program} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function git(...args) {
  return command("git", args);
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function billedMinutes(seconds) {
  return Math.max(1, Math.ceil(seconds / 60));
}

function estimate(plan, percentileName = "p50") {
  const model = MODEL.new;
  const packageFraction = plan.packages.length / 15;
  const packageSeconds =
    plan.packages.length === 0 ? 0 : Math.max(15, model.fullPackageSeconds * packageFraction);
  const coreSeconds =
    model.coreBaseSeconds +
    packageSeconds +
    (plan.lanes.scripts ? model.scriptsSeconds : 0) +
    (plan.lanes.skills ? model.skillsSeconds : 0) +
    (plan.lanes.goSsh ? model.goSshSeconds : 0) +
    (plan.lanes.goDns ? model.goDnsSeconds : 0) +
    (plan.lanes.sonar ? model.sonarSeconds : 0) +
    (plan.lanes.workflows ? model.workflowSeconds : 0);
  const e2eSeconds = plan.lanes.e2e
    ? percentileName === "p90"
      ? model.e2eP90Seconds
      : model.e2eP50Seconds
    : 5;
  return {
    billedMinutes:
      billedMinutes(coreSeconds) + billedMinutes(e2eSeconds) + billedMinutes(model.gateSeconds),
    feedbackSeconds: Math.max(coreSeconds, e2eSeconds) + model.gateSeconds,
    jobs: 3,
  };
}

function replay(count) {
  const commits = git("rev-list", "--first-parent", `--max-count=${count + 1}`, "HEAD")
    .split("\n")
    .filter(Boolean);
  const rows = [];
  for (const commit of commits.slice(0, count)) {
    const parent = git("rev-parse", `${commit}^`);
    const output = git("diff", "--name-only", "--diff-filter=ACDMRTUXB", parent, commit, "--");
    const paths = output ? output.split("\n") : [];
    const plan = classifyPaths(paths, { base: parent, head: commit });
    rows.push({ commit, p50: estimate(plan, "p50"), p90: estimate(plan, "p90"), plan });
  }
  return rows;
}

function liveRuns() {
  return JSON.parse(
    command("gh", ["api", "repos/mauricekleine/fluncle/actions/runs?branch=main&per_page=100"]),
  ).workflow_runs;
}

function liveWorkflowStats(rows, name) {
  const durations = rows
    .filter((row) => row.name === name && row.conclusion === "success")
    .map((row) => (Date.parse(row.updated_at) - Date.parse(row.run_started_at)) / 1000);
  return {
    p50Seconds: percentile(durations, 0.5),
    p90Seconds: percentile(durations, 0.9),
    sample: durations.length,
  };
}

function liveStepSample(rows) {
  const selected = rows
    .filter(
      (row) =>
        ["E2E", "Post-deploy Probe", "Quality Checks", "Skills Sync"].includes(row.name) &&
        row.conclusion === "success",
    )
    .reduce((sample, row) => {
      const workflowCount = sample.filter((candidate) => candidate.name === row.name).length;
      if (workflowCount < 8) {
        sample.push(row);
      }
      return sample;
    }, []);
  const restoreSeconds = [];
  const installSeconds = [];
  const snapshotRestoreSeconds = [];
  const snapshotSaveSeconds = [];

  for (const run of selected) {
    const jobs = JSON.parse(
      command("gh", [
        "api",
        `repos/mauricekleine/fluncle/actions/runs/${run.id}/jobs?per_page=100`,
      ]),
    ).jobs;
    for (const step of jobs.flatMap((job) => job.steps ?? [])) {
      const duration = (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000;
      if (!Number.isFinite(duration) || duration < 0) {
        continue;
      }
      if (step.name === "Cache Bun packages") {
        restoreSeconds.push(duration);
      }
      if (step.name === "Install dependencies") {
        installSeconds.push(duration);
      }
      if (step.name.startsWith("Restore bounded ") && step.name.endsWith(" snapshot")) {
        snapshotRestoreSeconds.push(duration);
      }
      if (step.name.startsWith("Save bounded ") && step.name.includes(" snapshot")) {
        snapshotSaveSeconds.push(duration);
      }
    }
  }

  const stats = (values) => ({
    meanSeconds:
      values.length === 0
        ? null
        : Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(1)),
    p50Seconds: percentile(values, 0.5),
    p90Seconds: percentile(values, 0.9),
    sample: values.length,
  });
  return {
    install: stats(installSeconds),
    restore: stats(restoreSeconds),
    snapshotRestore: stats(snapshotRestoreSeconds),
    snapshotSave: stats(snapshotSaveSeconds),
  };
}

function liveCacheInventory() {
  const caches = [];
  for (let page = 1; ; page += 1) {
    const response = JSON.parse(
      command("gh", [
        "api",
        `repos/mauricekleine/fluncle/actions/caches?per_page=100&page=${page}`,
      ]),
    );
    caches.push(...(response.actions_caches ?? []));
    if ((response.actions_caches ?? []).length < 100) {
      break;
    }
  }
  const turbo = caches.filter((cache) => cache.key.startsWith("turbo-"));
  return {
    allBytes: caches.reduce((total, cache) => total + cache.size_in_bytes, 0),
    allCount: caches.length,
    turboBytes: turbo.reduce((total, cache) => total + cache.size_in_bytes, 0),
    turboCount: turbo.length,
  };
}

function liveArtifactInventory() {
  const artifacts = [];
  for (let page = 1; ; page += 1) {
    const response = JSON.parse(
      command("gh", [
        "api",
        `repos/mauricekleine/fluncle/actions/artifacts?per_page=100&page=${page}`,
      ]),
    );
    artifacts.push(...(response.artifacts ?? []));
    if ((response.artifacts ?? []).length < 100) {
      break;
    }
  }

  const summarize = (rows) => ({
    bytes: rows.reduce((total, artifact) => total + artifact.size_in_bytes, 0),
    count: rows.length,
  });
  const byName = Object.fromEntries(
    [...new Set(artifacts.map((artifact) => artifact.name))]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, summarize(artifacts.filter((artifact) => artifact.name === name))]),
  );
  return {
    ...summarize(artifacts),
    active: summarize(artifacts.filter((artifact) => !artifact.expired)),
    byName,
    expired: summarize(artifacts.filter((artifact) => artifact.expired)),
  };
}

function parseArguments(argv) {
  const parsed = { commits: 120, live: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--commits") {
      parsed.commits = Number(argv[++index]);
    } else if (argv[index] === "--live") {
      parsed.live = true;
    } else if (argv[index] === "--json") {
      parsed.json = true;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!Number.isInteger(parsed.commits) || parsed.commits < 1) {
    throw new Error("--commits must be positive");
  }
  return parsed;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const rows = replay(options.commits);
  const actionsRuns = options.live ? liveRuns() : null;
  const currentP50Minutes =
    billedMinutes(MODEL.current.qualityP50Seconds) + billedMinutes(MODEL.current.e2eP50Seconds);
  const currentP90Minutes =
    billedMinutes(MODEL.current.qualityP90Seconds) + billedMinutes(MODEL.current.e2eP90Seconds);
  const newP50Minutes = rows.reduce((total, row) => total + row.p50.billedMinutes, 0);
  const newP90Minutes = rows.reduce((total, row) => total + row.p90.billedMinutes, 0);
  const report = {
    artifacts: options.live ? liveArtifactInventory() : null,
    cache: options.live ? liveCacheInventory() : null,
    cacheTrajectory: {
      former: "approximately one immutable Turbo archive per commit",
      new: "at most one trusted-main snapshot per UTC week and dependency lineage",
      pullRequestWrites: 0,
    },
    classification: {
      e2eCommits: rows.filter((row) => row.plan.lanes.e2e).length,
      fullBackstops: rows.filter((row) => row.plan.full).length,
      sample: rows.length,
      unknownCommits: rows.filter((row) => row.plan.unknownFiles.length > 0).length,
    },
    current: {
      feedbackP50Seconds: Math.max(MODEL.current.qualityP50Seconds, MODEL.current.e2eP50Seconds),
      feedbackP90Seconds: Math.max(MODEL.current.qualityP90Seconds, MODEL.current.e2eP90Seconds),
      jobs: rows.length * 2,
      runnerMinutesP50: rows.length * currentP50Minutes,
      runnerMinutesP90: rows.length * currentP90Minutes,
    },
    liveWorkflows: options.live
      ? {
          e2e: liveWorkflowStats(actionsRuns, "E2E"),
          postDeploy: liveWorkflowStats(actionsRuns, "Post-deploy Probe"),
          quality: liveWorkflowStats(actionsRuns, "Quality Checks"),
          steps: liveStepSample(actionsRuns),
        }
      : null,
    projected: {
      feedbackP50Seconds: percentile(
        rows.map((row) => row.p50.feedbackSeconds),
        0.5,
      ),
      feedbackP90Seconds: percentile(
        rows.map((row) => row.p90.feedbackSeconds),
        0.9,
      ),
      jobs: rows.reduce((total, row) => total + row.p50.jobs, 0),
      runnerMinutesP50: newP50Minutes,
      runnerMinutesP90: newP90Minutes,
      runnerReductionP50Percent: Number(
        ((1 - newP50Minutes / (rows.length * currentP50Minutes)) * 100).toFixed(1),
      ),
      runnerReductionP90Percent: Number(
        ((1 - newP90Minutes / (rows.length * currentP90Minutes)) * 100).toFixed(1),
      ),
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "# Quality history replay",
        "",
        `Commits: ${report.classification.sample}; full backstops: ${report.classification.fullBackstops}; E2E-selected: ${report.classification.e2eCommits}; unknown-path commits: ${report.classification.unknownCommits}.`,
        `Current p50 projection: ${report.current.runnerMinutesP50} billed runner-minutes across ${report.current.jobs} jobs; feedback ${report.current.feedbackP50Seconds}s.`,
        `New p50 projection: ${report.projected.runnerMinutesP50} billed runner-minutes across ${report.projected.jobs} jobs; feedback p50 ${report.projected.feedbackP50Seconds}s (${report.projected.runnerReductionP50Percent}% runner-minute reduction).`,
        `Current p90 projection: ${report.current.runnerMinutesP90} billed runner-minutes; new p90: ${report.projected.runnerMinutesP90} (${report.projected.runnerReductionP90Percent}% reduction), feedback p90 ${report.projected.feedbackP90Seconds}s.`,
        report.cache
          ? `Live caches: ${report.cache.allCount} archives / ${report.cache.allBytes} bytes; Turbo ${report.cache.turboCount} / ${report.cache.turboBytes} bytes.`
          : "Live cache inventory not queried (pass --live).",
        report.artifacts
          ? `Live artifacts: ${report.artifacts.active.count} active / ${report.artifacts.active.bytes} bytes; ${report.artifacts.expired.count} expired records / ${report.artifacts.expired.bytes} bytes.`
          : "Live artifact inventory not queried (pass --live).",
        `Cache trajectory: ${report.cacheTrajectory.former}; ${report.cacheTrajectory.new}; PR writes ${report.cacheTrajectory.pullRequestWrites}.`,
        "",
      ].join("\n"),
    );
  }
} catch (error) {
  process.stderr.write(
    `quality history: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
