#!/usr/bin/env bun

export const FOLLOW_DIGEST_RUN_CAP = 1000;
export const FOLLOW_DIGEST_BATCH_LIMIT = 50;

type SendResult = {
  capped: boolean;
  considered: number;
  dryRun: boolean;
  empty: number;
  failed: number;
  nextCursor?: string;
  ok: boolean;
  paused: boolean;
  sent: number;
  skipped: number;
  unknown: number;
  weekKey: string;
};

export type FollowDigestSweepSummary = {
  capped: boolean;
  checked: number;
  empty: number;
  error: null | string;
  errors: number;
  failed: number;
  gateState: "active" | "paused";
  nextCursor: null | string;
  ok: boolean;
  passes: number;
  produced: number;
  sent: number;
  skipped: number;
  unknown: number;
  weekKey: null | string;
};

export async function runFollowDigestSweep(
  send: (cursor: string | undefined, limit: number) => Promise<SendResult>,
): Promise<FollowDigestSweepSummary> {
  const summary: FollowDigestSweepSummary = {
    capped: false,
    checked: 0,
    empty: 0,
    error: null,
    errors: 0,
    failed: 0,
    gateState: "active",
    nextCursor: null,
    ok: true,
    passes: 0,
    produced: 0,
    sent: 0,
    skipped: 0,
    unknown: 0,
    weekKey: null,
  };
  let cursor: string | undefined;
  try {
    while (summary.sent < FOLLOW_DIGEST_RUN_CAP) {
      const limit = Math.min(FOLLOW_DIGEST_BATCH_LIMIT, FOLLOW_DIGEST_RUN_CAP - summary.sent);
      const result = await send(cursor, limit);
      if (result.ok !== true || result.considered < 0 || result.sent < 0) {
        throw new Error("send_follow_digests returned an invalid response");
      }
      summary.passes += 1;
      summary.checked += result.considered;
      summary.empty += result.empty;
      summary.failed += result.failed;
      summary.sent += result.sent;
      summary.produced += result.sent;
      summary.skipped += result.skipped;
      summary.unknown += result.unknown;
      summary.weekKey = result.weekKey;
      summary.nextCursor = result.nextCursor ?? null;
      if (result.paused) {
        summary.gateState = "paused";
        break;
      }
      if (!result.nextCursor) {
        break;
      }
      if (result.nextCursor <= (cursor ?? "")) {
        throw new Error("send_follow_digests cursor did not advance");
      }
      cursor = result.nextCursor;
    }
    summary.capped = summary.sent >= FOLLOW_DIGEST_RUN_CAP && summary.nextCursor !== null;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    summary.errors = 1;
    summary.ok = false;
  }
  return summary;
}

async function sendBatch(cursor: string | undefined, limit: number): Promise<SendResult> {
  const base = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
  const token = process.env.FLUNCLE_API_TOKEN;
  if (!token) {
    throw new Error("FLUNCLE_API_TOKEN is required");
  }
  const response = await fetch(`${base}/api/v1/admin/follow-digests/send`, {
    body: JSON.stringify({ cursor, limit }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) {
    throw new Error(`send_follow_digests returned HTTP ${response.status}`);
  }
  return (await response.json()) as SendResult;
}

if (import.meta.main) {
  const summary = await runFollowDigestSweep(sendBatch);
  console.log(JSON.stringify(summary));
  if (!summary.ok) {
    process.exit(1);
  }
}
