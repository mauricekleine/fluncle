#!/usr/bin/env bun

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const log = (message: string) => console.error(`[funnel-snapshot-sweep] ${message}`);

export type SnapshotRow = {
  certified?: number;
  crawled?: number;
  day?: string;
  recEligible?: number;
};

export type RecordSnapshotResponse = {
  backfilledDays?: string[];
  ok?: boolean;
  snapshot?: SnapshotRow;
};

export type FunnelSnapshotSummary = {
  backfilled: number;
  backfilledDays: string[];
  certified: null | number;
  checked: null | number;
  crawled: null | number;
  day: null | string;
  error: null | string;
  errors: number;
  ok: boolean;
  produced: null | number;
  recEligible: null | number;
};

export type FunnelSnapshotDeps = {
  log: (message: string) => void;
  record: () => Promise<RecordSnapshotResponse>;

  sleep?: (ms: number) => Promise<void>;
};

const RECORD_ATTEMPTS = 3;
const RECORD_BACKOFF_MS = [5_000, 20_000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runFunnelSnapshotTick(
  deps: FunnelSnapshotDeps,
): Promise<FunnelSnapshotSummary> {
  const summary: FunnelSnapshotSummary = {
    backfilled: 0,
    backfilledDays: [],
    certified: null,
    checked: null,
    crawled: null,
    day: null,
    error: null,
    errors: 0,
    ok: true,
    produced: null,
    recEligible: null,
  };
  const sleep = deps.sleep ?? wait;

  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    const last = attempt === RECORD_ATTEMPTS;

    try {
      const response = await deps.record();
      const snapshot = response.snapshot;

      if (response.ok !== true || !snapshot) {
        summary.checked = 1;
        summary.errors = 1;
        summary.ok = false;
        summary.produced = 0;
        summary.error = "record_catalogue_snapshot did not return a snapshot";

        if (last) {
          return summary;
        }

        await sleep(RECORD_BACKOFF_MS[attempt - 1] ?? 0);
        continue;
      }

      const backfilledDays = Array.isArray(response.backfilledDays) ? response.backfilledDays : [];

      return {
        ...summary,
        backfilled: backfilledDays.length,
        backfilledDays,
        certified: typeof snapshot.certified === "number" ? snapshot.certified : null,
        checked: 1,
        crawled: typeof snapshot.crawled === "number" ? snapshot.crawled : null,
        day: snapshot.day ?? null,
        error: null,
        errors: 0,
        ok: true,
        produced: 1,
        recEligible: typeof snapshot.recEligible === "number" ? snapshot.recEligible : null,
      };
    } catch (error) {
      summary.checked = null;
      summary.errors = 1;
      summary.ok = false;
      summary.produced = null;
      summary.error = error instanceof Error ? error.message : String(error);
      deps.log(`snapshot failed (attempt ${attempt}/${RECORD_ATTEMPTS}): ${summary.error}`);

      if (last) {
        return summary;
      }

      await sleep(RECORD_BACKOFF_MS[attempt - 1] ?? 0);
    }
  }

  return summary;
}

async function recordSnapshot(): Promise<RecordSnapshotResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/funnel/snapshot`, {
    body: JSON.stringify({}),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(
      `record_catalogue_snapshot failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  return (await res.json()) as RecordSnapshotResponse;
}

export function missingApiTokenSummary() {
  return {
    checked: null,
    errors: 1,
    ok: false,
    produced: null,
    reason: "missing_api_token",
  } as const;
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify(missingApiTokenSummary()));
    process.exit(1);
  }

  const summary = await runFunnelSnapshotTick({ log, record: recordSnapshot });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`funnel-snapshot-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: null,
        error: message,
        errors: 1,
        ok: false,
        produced: null,
        reason: "funnel_snapshot_failed",
      }),
    );
    process.exit(1);
  });
}
