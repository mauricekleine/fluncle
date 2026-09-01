#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const metricsPath = process.argv[2] ?? ".post-deploy-metrics.jsonl";
const metrics = existsSync(metricsPath)
  ? readFileSync(metricsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const wait = metrics.find((metric) => metric.lane === "deploy-wait");
const probe = metrics.find((metric) => metric.lane === "surface-probe");
const report = {
  probeSeconds: probe?.durationSeconds ?? null,
  waitSeconds: wait?.durationSeconds ?? null,
};
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\nDeploy wait: ${report.waitSeconds ?? "not run"}s; public-surface sweep: ${report.probeSeconds ?? "not run"}s.\n`,
  );
}
process.stdout.write(`POST_DEPLOY_REPORT ${JSON.stringify(report)}\n`);
