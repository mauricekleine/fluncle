// `fluncle admin telemetry read` — the operator's thin HTTP reader for the SECOND
// `fluncle-telemetry` database. The Worker owns filtering, pagination, and aggregates;
// the CLI only serializes query options and renders the returned evidence.

import { adminApiGet } from "../api";

export type RunLedgerRow = {
  checked: number | null;
  createdAt: string;
  endedAt: string;
  errors: number | null;
  exitCode: number;
  expectedIntervalMs: number | null;
  gateState: "active" | "disabled" | "dry-run" | "forced" | "locked" | "paused" | null;
  id: string;
  missingFields: string[];
  occurredAt: string;
  ok: boolean;
  produced: number | null;
  queueDepth: number | null;
  runDurationMs: number | null;
  selfAssertedOk: boolean | null;
  summaryRaw: string | null;
  summaryStatus: "absent" | "malformed" | "not_object" | "parsed";
  unit: string;
  unrecognisedFields: string[];
  vendorCalls: number | null;
};

export type RunLedgerUnitRollup = {
  blindCount: number;
  failedCount: number;
  lastOccurredAt: string;
  liarCount: number;
  runCount: number;
  unit: string;
};

export type RunLedgerPage = {
  available: boolean;
  nextCursor: string | null;
  rollups: RunLedgerUnitRollup[];
  rows: RunLedgerRow[];
  totalCount: number;
};

export type TelemetryReadOptions = {
  cursor?: string;
  limit: number;
  ok?: boolean;
  since?: string;
  unit?: string;
  until?: string;
};

/** Read one page. The response is a passthrough; no client-side verdict is computed. */
export async function telemetryCommand(options: TelemetryReadOptions): Promise<RunLedgerPage> {
  const params = new URLSearchParams({ limit: String(options.limit) });

  if (options.cursor !== undefined) {
    params.set("cursor", options.cursor);
  }

  if (options.ok !== undefined) {
    params.set("ok", String(options.ok));
  }

  if (options.since !== undefined) {
    params.set("since", options.since);
  }

  if (options.unit !== undefined) {
    params.set("unit", options.unit);
  }

  if (options.until !== undefined) {
    params.set("until", options.until);
  }

  return adminApiGet<RunLedgerPage>(`/api/v1/admin/telemetry/runs?${params.toString()}`);
}

function cell(value: boolean | number | null): string {
  if (value === null) {
    return "-";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  return String(value);
}

function padded(columns: string[], widths: number[]): string {
  return columns
    .map((column, index) => column.padEnd(widths[index] ?? 0))
    .join("  ")
    .trimEnd();
}

/** Terse operator rendering. `--json` remains the lossless 20-column read. */
export function telemetryLines(page: RunLedgerPage): string[] {
  if (!page.available) {
    return ["Telemetry database is not configured."];
  }

  if (page.rows.length === 0) {
    return ["No run events matched."];
  }

  const rollupHeader = ["UNIT", "RUNS", "LAST", "OK=0", "LIAR", "BLIND"];
  const rollupRows = page.rollups.map((rollup) => [
    rollup.unit,
    String(rollup.runCount),
    rollup.lastOccurredAt,
    String(rollup.failedCount),
    String(rollup.liarCount),
    String(rollup.blindCount),
  ]);
  const rollupWidths = rollupHeader.map((header, index) =>
    Math.max(header.length, ...rollupRows.map((row) => row[index]?.length ?? 0)),
  );
  const runHeader = [
    "OCCURRED",
    "UNIT",
    "OK",
    "SELF",
    "CHECKED",
    "PRODUCED",
    "QUEUE",
    "EXIT",
    "SUMMARY",
  ];
  const runRows = page.rows.map((row) => [
    row.occurredAt,
    row.unit,
    cell(row.ok),
    cell(row.selfAssertedOk),
    cell(row.checked),
    cell(row.produced),
    cell(row.queueDepth),
    String(row.exitCode),
    row.summaryStatus,
  ]);
  const runWidths = runHeader.map((header, index) =>
    Math.max(header.length, ...runRows.map((row) => row[index]?.length ?? 0)),
  );
  const lines = [
    `Unit rollups (${page.totalCount} matching runs)`,
    padded(rollupHeader, rollupWidths),
    ...rollupRows.map((row) => padded(row, rollupWidths)),
    "",
    `Runs (${page.rows.length} on this page)`,
    padded(runHeader, runWidths),
    ...runRows.map((row) => padded(row, runWidths)),
  ];

  if (page.nextCursor !== null) {
    lines.push("", `Next cursor: ${page.nextCursor}`);
  }

  return lines;
}
