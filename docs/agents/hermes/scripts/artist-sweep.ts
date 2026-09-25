#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_CAP = 5;
const QUEUE_LIMIT = 50;

const IMAGE_BACKFILL_LIMIT = 50;
const EXPECTED_INTERVAL_MS = 60 * 60_000;

const CLI_CALL_TIMEOUT_MS = 120_000;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-sweep] ${message}`);

type QueueArtist = {
  artistId?: string;
  id?: string;
  name?: string;
};

type ResolveResult = {
  artistId?: string;
  mbid?: string | null;
  ok?: boolean;
  rateLimited?: boolean;
  socialsCount?: number;
};

type Outcome = "resolved" | "noop" | "failed" | "rateLimited";

type ArtistImagesOutcome = {
  budgetLimited: boolean;
  checked: number;
  failed: number;
  filled: number;
  queueDepth: number | null;
  rateLimited: boolean;

  repairPending: boolean;
  skipped: number;
};

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLI_CALL_TIMEOUT_MS,
  });

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const detail = timedOut ? `timed out after ${CLI_CALL_TIMEOUT_MS}ms` : result.error.message;
    throw new Error(`fluncle ${args.join(" ")} ${detail}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
    }

    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);

  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }

  return parsed as T;
}

function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function resolveOne(artist: QueueArtist): Outcome {
  const id = artist.artistId ?? artist.id;

  if (!id) {
    log("queue item without an id — skipping");
    return "failed";
  }

  const label = artist.name ? `${artist.name} (${id})` : id;

  const result = fluncleJson<ResolveResult>(["admin", "artists", "resolve", id]);

  if (result.rateLimited) {
    log(`${label}: MB rate-limited — stopping batch, will retry next tick`);
    return "rateLimited";
  }

  if (!result.ok) {
    log(`${label}: Worker returned not-ok`);
    return "failed";
  }

  const count = result.socialsCount ?? 0;
  const mbid = result.mbid ?? "(no mbid)";
  log(`${label}: resolved — mbid=${mbid}, ${count} social(s)`);

  return count > 0 ? "resolved" : "noop";
}

function drainArtistImages(): ArtistImagesOutcome {
  try {
    const result = fluncleJson<{
      budgetLimited?: boolean;
      checkedCount?: number;
      failedCount?: number;
      filledCount?: number;
      ok?: boolean;
      queueDepth?: number;
      rateLimited?: boolean;
      skippedCount?: number;
    }>(["admin", "backfills", "artist-images", "--limit", String(IMAGE_BACKFILL_LIMIT)]);

    const budgetLimited = result.budgetLimited ?? false;
    const checked = result.checkedCount ?? 0;
    const failed = result.failedCount ?? 0;
    const filled = result.filledCount ?? 0;
    const queueDepth = result.queueDepth ?? null;
    const rateLimited = result.rateLimited ?? false;
    const skipped = result.skippedCount ?? 0;

    if (result.ok === false) {
      log(
        `artist-images: partial — checked ${checked}, filled ${filled}, ${failed} failed, ${skipped} without an image`,
      );
    } else {
      log(`artist-images: checked ${checked}, filled ${filled}, ${skipped} without an image`);
    }

    return {
      budgetLimited,
      checked,
      failed,
      filled,
      queueDepth,
      rateLimited,
      repairPending: false,
      skipped,
    };
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      log(error.message);

      return {
        budgetLimited: false,
        checked: 0,
        failed: 0,
        filled: 0,
        queueDepth: null,
        rateLimited: false,
        repairPending: true,
        skipped: 0,
      };
    }

    log(`artist-images drain skipped: ${error instanceof Error ? error.message : String(error)}`);

    return {
      budgetLimited: false,
      checked: 0,
      failed: 1,
      filled: 0,
      queueDepth: null,
      rateLimited: false,
      repairPending: false,
      skipped: 0,
    };
  }
}

function main(): void {
  const response = fluncleJson<{ artists?: QueueArtist[] }>([
    "admin",
    "artists",
    "resolve",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
  ]);
  const queue = response.artists ?? [];

  const summary = {
    batch: 0,
    errors: 0,
    failed: 0,
    imagesBudgetLimited: false,
    imagesChecked: 0,
    imagesFailed: 0,
    imagesFilled: 0,
    imagesRateLimited: false,
    imagesSkipped: 0,
    noop: 0,
    queueRemaining: queue.length,
    resolved: 0,
    throttled: false,
  };

  if (queue.length > 0) {
    for (const artist of queue.slice(0, BATCH_CAP)) {
      summary.batch += 1;

      try {
        const outcome = resolveOne(artist);

        if (outcome === "resolved") {
          summary.resolved += 1;
        } else if (outcome === "noop") {
          summary.noop += 1;
        } else if (outcome === "rateLimited") {
          summary.throttled = true;
          break;
        } else {
          summary.failed += 1;
        }
      } catch (error) {
        summary.failed += 1;
        log(
          `error on ${artist.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  summary.queueRemaining = Math.max(0, queue.length - summary.resolved - summary.noop);
  const images = drainArtistImages();
  summary.imagesBudgetLimited = images.budgetLimited;
  summary.imagesChecked = images.checked;
  summary.imagesFailed = images.failed;
  summary.imagesFilled = images.filled;
  summary.imagesRateLimited = images.rateLimited;
  summary.imagesSkipped = images.skipped;
  summary.throttled ||= images.rateLimited;
  summary.failed += images.failed;

  const processed = summary.resolved + summary.noop;
  const checked = summary.batch + summary.imagesChecked;
  const produced = processed + summary.imagesFilled + summary.imagesSkipped;
  const queueDepth =
    queue.length < QUEUE_LIMIT && images.queueDepth !== null
      ? summary.queueRemaining + images.queueDepth
      : null;

  const line = {
    ...summary,
    checked,
    expected_interval_ms: EXPECTED_INTERVAL_MS,
    ok: true,
    processed,
    produced,
    queue_depth: queueDepth,
  };

  console.log(
    JSON.stringify(images.repairPending ? { ...line, ...dueWorkRepairPendingGate(line) } : line),
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`fatal: ${message}`);
    console.log(JSON.stringify({ error: message, errors: 1, ok: false, reason: "artist_failed" }));
    process.exit(1);
  }
}
