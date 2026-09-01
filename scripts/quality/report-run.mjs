#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function parseArguments(argv) {
  const parsed = { cacheHit: "unknown", job: "quality" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") {
      parsed.planPath = argv[++index];
    } else if (argument === "--metrics") {
      parsed.metricsPath = argv[++index];
    } else if (argument === "--job") {
      parsed.job = argv[++index];
    } else if (argument === "--cache-hit") {
      parsed.cacheHit = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!parsed.planPath) {
    throw new Error("--plan is required");
  }
  return parsed;
}

function readMetrics(path) {
  if (!path || !existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function directoryBytes(path) {
  if (!existsSync(path)) {
    return 0;
  }
  const result = spawnSync("du", ["-sb", path], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const bytes = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(bytes) ? bytes : null;
}

function selectedLanes(plan) {
  return Object.entries(plan.lanes)
    .filter(([, selected]) => selected)
    .map(([lane]) => lane);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(options.planPath, "utf8"));
  const metrics = readMetrics(options.metricsPath);
  const totalSeconds = metrics.reduce((total, metric) => total + metric.durationSeconds, 0);
  const failure = metrics.find((metric) => metric.outcome === "failure") ?? null;
  const firstStarted = metrics.length > 0 ? Date.parse(metrics[0].startedAt) : null;
  const firstActionableFailureSeconds =
    failure && firstStarted !== null
      ? Number(
          ((Date.parse(failure.completedAt ?? failure.startedAt) - firstStarted) / 1000).toFixed(3),
        )
      : null;
  const report = {
    billedMinuteProjection: Math.max(1, Math.ceil(totalSeconds / 60)),
    cache: {
      hit: options.cacheHit,
      turboBytes: directoryBytes(".turbo/cache"),
    },
    changedFileCount: plan.changedFiles.length,
    firstActionableFailureSeconds,
    fullBackstop: plan.full,
    fullBackstopEscapes: plan.full && failure ? "unclassified" : 0,
    job: options.job,
    lanes: selectedLanes(plan),
    packages: plan.packages,
    realVersusFlakyFailure: failure ? "unclassified-until-rerun" : "none-observed",
    totalMeasuredSeconds: Number(totalSeconds.toFixed(3)),
    unknownFiles: plan.unknownFiles,
  };

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(
      summary,
      [
        "",
        `Selected closure: ${report.lanes.join(", ") || "none"}`,
        `Affected packages: ${report.packages.join(", ") || "none"}`,
        `Measured lane time: ${report.totalMeasuredSeconds.toFixed(1)}s; projected billed minutes for this job: ${report.billedMinuteProjection}.`,
        `Time to first actionable failure: ${report.firstActionableFailureSeconds ?? "none"}.`,
        `Failure classification: ${report.realVersusFlakyFailure}; full-backstop escapes: ${report.fullBackstopEscapes}.`,
        `Cache: hit=${report.cache.hit}, local snapshot bytes=${report.cache.turboBytes ?? "unavailable"}.`,
        plan.unknownFiles.length > 0
          ? `Unknown paths failed closed to full: ${plan.unknownFiles.join(", ")}.`
          : "Unknown paths: none.",
        "",
      ].join("\n"),
    );
  }
  process.stdout.write(`QUALITY_REPORT ${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(
    `quality report: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
