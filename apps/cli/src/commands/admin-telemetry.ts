// `fluncle admin telemetry read` — the operator's thin HTTP reader for the SECOND
// `fluncle-telemetry` database. The Worker owns filtering, pagination, and aggregates;
// the CLI only serializes query options and renders the returned evidence.

import { type RunLedgerPage } from "@fluncle/contracts/orpc";
import { adminApiGet } from "../api";

export type TelemetryMissingField =
  | "checked"
  | "errors"
  | "expected_interval_ms"
  | "produced"
  | "queue_depth";

export type TelemetryReadOptions = {
  blind?: boolean;
  cursor?: string;
  limit: number;
  liar?: boolean;
  missing?: boolean;
  missingField?: TelemetryMissingField;
  ok?: boolean;
  since?: string;
  unit?: string;
  until?: string;
};

/** Read one page. The response is a passthrough; no client-side verdict is computed. */
export async function telemetryCommand(options: TelemetryReadOptions): Promise<RunLedgerPage> {
  const params = new URLSearchParams({ limit: String(options.limit) });

  if (options.blind === true) {
    params.set("blind", "true");
  }

  if (options.cursor !== undefined) {
    params.set("cursor", options.cursor);
  }

  if (options.liar === true) {
    params.set("liar", "true");
  }

  if (options.missing === true) {
    params.set("missing", "true");
  }

  if (options.missingField !== undefined) {
    params.set("missingField", options.missingField);
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

function cadence(expectedIntervalMs: number | null): string {
  if (expectedIntervalMs === null) {
    return "-";
  }

  const units = [
    { label: "d", milliseconds: 24 * 60 * 60 * 1000 },
    { label: "h", milliseconds: 60 * 60 * 1000 },
    { label: "m", milliseconds: 60 * 1000 },
    { label: "s", milliseconds: 1000 },
  ];

  for (const unit of units) {
    if (expectedIntervalMs % unit.milliseconds === 0) {
      return `${expectedIntervalMs / unit.milliseconds}${unit.label}`;
    }
  }

  return `${expectedIntervalMs}ms`;
}

type TelemetryRenderOptions = {
  missing?: boolean;
};

/** Terse operator rendering. `--json` remains the lossless run-ledger read. */
export function telemetryLines(
  page: RunLedgerPage,
  options: TelemetryRenderOptions = {},
): string[] {
  if (!page.available) {
    return ["Telemetry database is not configured."];
  }

  if (options.missing === true || page.missingRoster.length > 0) {
    if (page.missingRoster.length === 0) {
      return ["No expected writers are missing."];
    }

    const missingHeader = ["MISSING UNIT", "CADENCE"];
    const missingRows = page.missingRoster.map((entry) => [
      entry.unit,
      cadence(entry.expectedIntervalMs),
    ]);
    const missingWidths = missingHeader.map((header, index) =>
      Math.max(header.length, ...missingRows.map((row) => row[index]?.length ?? 0)),
    );

    return [
      `Expected writers with no run (${missingRows.length})`,
      padded(missingHeader, missingWidths),
      ...missingRows.map((row) => padded(row, missingWidths)),
    ];
  }

  if (page.rows.length === 0 && page.rollups.length === 0) {
    return ["No run events matched."];
  }

  const rollupHeader = ["UNIT", "CADENCE", "RUNS", "LAST", "OK=0", "LIAR", "BLIND"];
  const rollupRows = page.rollups.map((rollup) => [
    rollup.unit,
    cadence(rollup.expectedIntervalMs),
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
    "OPERATION",
    "ACCESS",
    "OUTCOME",
    "ATTEMPTS",
    "BATCH",
    "DURATION",
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
    row.operationId ?? "-",
    row.accessClass ?? "-",
    row.outcome,
    cell(row.attemptCount),
    cell(row.batchCount),
    cell(row.runDurationMs),
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
  const lines: string[] = [];

  if (rollupRows.length > 0) {
    lines.push(
      "Unit rollups (all runs in the selected time/unit window)",
      padded(rollupHeader, rollupWidths),
      ...rollupRows.map((row) => padded(row, rollupWidths)),
    );
  }

  if (lines.length > 0) {
    lines.push("");
  }

  if (runRows.length === 0) {
    lines.push("No evidence rows matched.");
  } else {
    lines.push(
      `Evidence rows (${page.rows.length} of ${page.totalCount} matching; this page)`,
      padded(runHeader, runWidths),
      ...runRows.map((row) => padded(row, runWidths)),
    );
  }

  if (page.nextCursor !== null) {
    lines.push("", `Next cursor: ${page.nextCursor}`);
  }

  return lines;
}
