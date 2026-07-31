#!/usr/bin/env bun
// worker-trigger-counters.ts — turn the two curl-driven Worker tick responses into
// run-ledger summaries without changing the HTTP request either sweep makes.
//
// social-capture-sweep.sh and publish-advance-sweep.sh still own their curl, timeout,
// auth header, and endpoint. They pipe the successful JSON response through this tiny
// formatter so the last stdout line keeps every domain field and adds the canonical
// checked/produced/errors/failed counters.

type SocialCaptureResponse = {
  captured: Array<{ platform: string; trackId: string; url: string }>;
  ok: boolean;
  polled: number;
};

type PublishAdvanceResponse = {
  candidates: number;
  failed: Array<{ platform: string; trackId: string }>;
  held: Array<{ platform: string; reason: string; trackId: string }>;
  ok: boolean;
  paused: boolean;
  pushed: Array<{ platform: string; trackId: string }>;
};

type TriggerKind = "publish-advance" | "social-capture";

function countDistinctTrackIds(items: ReadonlyArray<{ trackId: string }>): number {
  return new Set(items.map((item) => item.trackId)).size;
}

/** `polled` is the exact number of posts inspected; each captured URL is one successful action. */
export function summarizeSocialCapture(response: SocialCaptureResponse) {
  return {
    ...response,
    checked: response.polled,
    errors: 0,
    failed: 0,
    produced: response.captured.length,
  };
}

/**
 * The endpoint's denominator is FINDINGS (`candidates`), while its pushed/failed arrays
 * are platform legs. Keep the canonical counters in finding units by de-duplicating
 * track ids. Preserve the original failure array as `failedPushes` before numeric
 * `failed` takes the canonical key.
 *
 * A paused tick deliberately does not inspect the queue. NULL says that explicitly;
 * zero would claim a measured empty queue and would be suppressed by the ledger's
 * paused-gate normalization anyway.
 */
export function summarizePublishAdvance(response: PublishAdvanceResponse) {
  const paused = response.paused === true;
  const { failed: failedPushes, ...domain } = response;

  return {
    ...domain,
    checked: paused ? null : response.candidates,
    errors: 0,
    failed: countDistinctTrackIds(failedPushes),
    failedPushes,
    produced: paused ? null : countDistinctTrackIds(response.pushed),
  };
}

export function summarizeTrigger(kind: TriggerKind, response: unknown) {
  if (typeof response !== "object" || response === null) {
    throw new Error(`${kind} returned a non-object response`);
  }

  return kind === "social-capture"
    ? summarizeSocialCapture(response as SocialCaptureResponse)
    : summarizePublishAdvance(response as PublishAdvanceResponse);
}

function parseKind(value: string | undefined): TriggerKind {
  if (value === "publish-advance" || value === "social-capture") {
    return value;
  }

  throw new Error(`unknown Worker trigger kind: ${value ?? "(missing)"}`);
}

if (import.meta.main) {
  try {
    const kind = parseKind(process.argv[2]);
    const response = JSON.parse(await Bun.stdin.text()) as unknown;
    console.log(JSON.stringify(summarizeTrigger(kind, response)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker-trigger-counters] ${message}`);
    console.log(
      JSON.stringify({
        checked: null,
        error: message,
        errors: 1,
        failed: null,
        ok: false,
        produced: null,
        reason: "summary_error",
      }),
    );
    process.exit(1);
  }
}
