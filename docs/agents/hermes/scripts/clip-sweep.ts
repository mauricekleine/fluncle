#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";

const BATCH_CAP = Number(process.env.CLIP_BATCH_CAP ?? "1") || 1;
const QUEUE_LIMIT = 50;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[clip-sweep] ${message}`);

type PendingClip = {
  id?: string;
  mixtapeId?: string;
};

export type ClipOutcome = "cut" | "deferred" | "failed";

type CutResult = { cost: BoxCostEvent | null; outcome: ClipOutcome };

export type ClipSweepSummary = {
  batch: number;
  checked: number;
  cut: number;
  errors: number;
  failed: number;
  pending: number;
  produced: number;
  queue_depth: number;
  skipped: number;
};

export function createClipSummary(pending: number): ClipSweepSummary {
  return {
    batch: 0,
    checked: 0,
    cut: 0,
    errors: 0,
    failed: 0,
    pending,
    produced: 0,
    queue_depth: pending,
    skipped: 0,
  };
}

export function classifyClipFailure(detail: string): Exclude<ClipOutcome, "cut"> {
  return detail.toLowerCase().includes("set_not_staged") ? "deferred" : "failed";
}

export function recordClipOutcome(summary: ClipSweepSummary, outcome: ClipOutcome): void {
  summary.batch += 1;
  summary.checked += 1;

  if (outcome === "cut") {
    summary.cut += 1;
    summary.produced += 1;
    summary.queue_depth = Math.max(0, summary.queue_depth - 1);

    return;
  }

  summary.skipped += 1;

  if (outcome === "failed") {
    summary.failed += 1;
  }
}

export function buildClipFatalSummary(): Record<string, unknown> {
  return {
    checked: null,
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "sweep_error",
  };
}

function run(bin: string, args: string[]): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function fluncleJson<T>(args: string[]): T {
  const { code, stderr, stdout } = run(FLUNCLE_BIN, [...args, "--json"]);

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

function cutOne(clip: PendingClip): CutResult {
  const id = clip.id;

  if (!id) {
    log("queue item without a clip id — skipping");

    return { cost: null, outcome: "failed" };
  }

  const cutStart = Date.now();
  const { code, stderr, stdout } = run(FLUNCLE_BIN, ["admin", "clips", "cut", id, "--json"]);
  const cutSeconds = (Date.now() - cutStart) / 1000;

  if (code !== 0) {
    const detail = `${stdout}\n${stderr}`.toLowerCase();
    const outcome = classifyClipFailure(detail);

    if (outcome === "deferred") {
      log(
        `${id}: set video not staged yet — skipping (stays pending until distribute --set-video)`,
      );
    } else {
      log(`${id}: cut exited ${code}: ${stderr.trim().slice(-200)}`);
    }

    return { cost: null, outcome };
  }

  log(`${id}: cut`);

  return {
    cost: selfSecondsCost({
      occurredAt: new Date().toISOString(),
      seconds: cutSeconds,
      step: "studio-clip",
    }),
    outcome: "cut",
  };
}

async function main(): Promise<void> {
  const response = fluncleJson<{ clips?: PendingClip[] }>([
    "admin",
    "clips",
    "list",
    "--status",
    "pending",
  ]);
  const queue = response.clips ?? [];
  const work = queue.slice(0, QUEUE_LIMIT);

  const summary = createClipSummary(queue.length);

  if (queue.length === 0) {
    console.log(JSON.stringify({ ok: true, ...summary }));

    return;
  }

  const costs: BoxCostEvent[] = [];

  for (const clip of work.slice(0, BATCH_CAP)) {
    try {
      const { cost, outcome } = cutOne(clip);

      if (cost) {
        costs.push(cost);
      }

      recordClipOutcome(summary, outcome);
    } catch (error) {
      recordClipOutcome(summary, "failed");
      log(`error on ${clip.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const costWriteFailures = (await emitCost(costs)).failed;
  console.log(JSON.stringify({ costWriteFailures, ok: true, ...summary }));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify(buildClipFatalSummary()));
    process.exit(1);
  });
}
