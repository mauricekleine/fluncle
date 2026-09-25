#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  dueWorkRepairPendingSummary,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_CAP = 6;
const QUEUE_LIMIT = 50;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const RETRY_EMPTY =
  process.env.RETRY_EMPTY === "1" ||
  process.env.RETRY_EMPTY === "true" ||
  process.argv.slice(2).includes("--retry-empty");

const log = (message: string) => console.error(`[context-sweep] ${message}`);

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

type ContextResult = {
  contextNote?: string;
  logId?: string;
  skipped?: boolean;
  trackId?: string;
};

type Outcome = "filled" | "noop" | "skipped";

type ContextCounts = {
  batch: number;
  failed: number;
  filled: number;
  noop: number;
  queueRemaining: number;
};

export function buildContextSummary(
  counts: ContextCounts,
  retryEmpty: boolean,
): {
  batch: number;
  checked: number;
  errors: number;
  failed: number;
  filled: number;
  noop: number;
  ok: true;
  processed: number;
  produced: number;
  queueRemaining: number;
  retryEmpty: boolean;
} {
  return {
    ...counts,
    checked: counts.batch,
    errors: 0,
    ok: true,
    processed: counts.filled + counts.noop,

    produced: counts.filled,
    retryEmpty,
  };
}

export function buildContextFailureSummary(error: unknown): {
  checked: null;
  error: string;
  errors: 1;
  failed: null;
  ok: false;
  produced: null;
  reason: "context_failed";
} {
  return {
    checked: null,
    error: error instanceof Error ? error.message : String(error),
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "context_failed",
  };
}

function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  if (code !== 0) {
    throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

function contextOne(finding: QueueFinding): Outcome {
  const id = finding.trackId ?? finding.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return "skipped";
  }

  const result = fluncleJson<ContextResult>(["admin", "tracks", "context", id]);

  if (result.skipped) {
    log(`${result.logId ?? id}: field notes already on file — no-op`);

    return "noop";
  }

  if (!result.contextNote || !result.contextNote.trim()) {
    log(`${result.logId ?? id}: no field notes turned up — stays queued`);

    return "skipped";
  }

  log(`${result.logId ?? id}: field notes gathered`);

  return "filled";
}

export function main(): void {
  let response: { tracks?: QueueFinding[] };

  try {
    response = fluncleJson<{ tracks?: QueueFinding[] }>([
      "admin",
      "tracks",
      "context",
      "--queue",
      "--limit",
      String(QUEUE_LIMIT),
      ...(RETRY_EMPTY ? ["--retry-empty"] : []),
    ]);
  } catch (error) {
    if (!isDueWorkRepairPending(error)) {
      throw error;
    }

    log(error.message);
    console.log(
      JSON.stringify(
        dueWorkRepairPendingSummary({ checked: 0, failed: 0, retryEmpty: RETRY_EMPTY }),
      ),
    );

    return;
  }

  const queue = response.tracks ?? [];

  const counts: ContextCounts = {
    batch: 0,
    failed: 0,
    filled: 0,
    noop: 0,
    queueRemaining: queue.length,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify(buildContextSummary(counts, RETRY_EMPTY)));

    return;
  }

  for (const finding of queue.slice(0, BATCH_CAP)) {
    counts.batch += 1;

    try {
      const outcome = contextOne(finding);

      if (outcome === "filled") {
        counts.filled += 1;
      } else if (outcome === "noop") {
        counts.noop += 1;
      } else {
        counts.failed += 1;
      }
    } catch (error) {
      counts.failed += 1;
      log(
        `error on ${finding.trackId ?? finding.logId ?? "?"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  counts.queueRemaining = Math.max(0, queue.length - counts.filled - counts.noop);
  console.log(JSON.stringify(buildContextSummary(counts, RETRY_EMPTY)));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const summary = buildContextFailureSummary(error);
    log(`context sweep failed: ${summary.error}`);
    console.log(JSON.stringify(summary));
    process.exit(1);
  }
}
