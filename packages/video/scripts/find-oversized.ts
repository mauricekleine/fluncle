// find-oversized.ts — read-only census of R2 video clips over the 100MB ceiling.
//
//   bun scripts/find-oversized.ts [--limit <n>] [--max-bytes <n>] [--json] [--out <file>]
//
// Why: TikTok/social ingest and the web preview both choke on the heavy early
// renders. R2 holds the brand's clips at `<log-id>/footage.mp4` (and the
// audio-less `<log-id>/footage-silent.mp4`) on found.fluncle.com — see
// apps/web/src/lib/media.ts for that key convention. This script enumerates
// every finding that has a video (via `fluncle admin vehicles --json`, which
// returns logId + vehicle newest-first), HEADs each cut for its Content-Length,
// and emits a manifest of the clips whose footage exceeds the ceiling.
//
// It is SAFE to run: it only reads (CLI list + HTTP HEAD). It mutates nothing.
// The manifest it writes (default out/oversized.json) is the input the operator
// hands to scripts/rerender-oversized.ts.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The single source of the R2 key convention lives in apps/web/src/lib/media.ts;
// this is the same base + `<log-id>/<name>` shape, re-stated here because scripts
// can't import app code across the package boundary.
const FOUND_BASE = "https://found.fluncle.com";

// The ceiling, in bytes. 100MB = 100 * 1024 * 1024 (binary MB, matching how R2 /
// most tooling reports object size). Overridable via --max-bytes for what-if runs.
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

// The CLI caps --limit at 100. Real video count is well under that today, but we
// page defensively: request up to this cap and warn loudly if the result count
// hits it (the list may be truncated and the census incomplete).
const VEHICLE_LIMIT_CAP = 100;

const OUT_DIR = path.resolve(import.meta.dirname, "../out");

type VehicleEntry = {
  addedAt: string;
  artists: string[];
  logId?: string;
  title: string;
  vehicle?: string;
};

type CutCensus = {
  /** HTTP status of the HEAD (200 expected; non-200 means missing/unreadable). */
  status: number;
  /** Content-Length in bytes, or null when absent/unreadable. */
  bytes: number | null;
};

export type OversizedEntry = {
  addedAt: string;
  artists: string[];
  logId: string;
  title: string;
  vehicle: string | null;
  /** The with-audio cut — the one that matters; the threshold is measured on it. */
  footage: CutCensus;
  /** The audio-less cut — reported for context (re-render replaces both). */
  footageSilent: CutCensus;
};

export type OversizedManifest = {
  generatedAt: string;
  base: string;
  maxBytes: number;
  /** Every finding with a video that we measured. */
  measured: number;
  /** True when the vehicle list hit the CLI cap and may be incomplete. */
  truncated: boolean;
  /** The clips over the ceiling — what the operator re-renders. */
  oversized: OversizedEntry[];
};

const log = (message: string) => console.error(`[find-oversized] ${message}`);

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer (got "${raw}")`);
  }

  return value;
}

/** Pull the video ledger (newest-first) via the CLI. Throws on any CLI failure. */
function fetchVehicles(limit: number): { entries: VehicleEntry[]; truncated: boolean } {
  const result = spawnSync("fluncle", ["admin", "vehicles", "--limit", String(limit), "--json"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").toString().slice(0, 400);

    throw new Error(`\`fluncle admin vehicles\` failed (status ${result.status}): ${detail}`);
  }

  let parsed: { ok: boolean; vehicles?: VehicleEntry[] };

  try {
    parsed = JSON.parse(result.stdout.toString()) as typeof parsed;
  } catch {
    throw new Error(`could not parse vehicles JSON: ${result.stdout.toString().slice(0, 200)}`);
  }

  if (!parsed.ok || !Array.isArray(parsed.vehicles)) {
    throw new Error(`unexpected vehicles payload: ${result.stdout.toString().slice(0, 200)}`);
  }

  return { entries: parsed.vehicles, truncated: parsed.vehicles.length >= limit };
}

/** HEAD a single R2 object and read its Content-Length. */
async function headBytes(url: string): Promise<CutCensus> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    const header = response.headers.get("content-length");
    const bytes = header === null ? null : Number.parseInt(header, 10);

    return { bytes: Number.isFinite(bytes) ? bytes : null, status: response.status };
  } catch (error) {
    log(`HEAD failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);

    return { bytes: null, status: 0 };
  }
}

function formatMB(bytes: number | null): string {
  if (bytes === null) {
    return "   —   ";
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render the human table the operator reads. */
function renderTable(manifest: OversizedManifest): string {
  if (manifest.oversized.length === 0) {
    return "No clips exceed the ceiling. Nothing to re-render.";
  }

  const header = ["Log ID", "Footage", "Silent", "Vehicle", "Title"];
  const rows = manifest.oversized.map((entry) => [
    entry.logId,
    formatMB(entry.footage.bytes),
    formatMB(entry.footageSilent.bytes),
    entry.vehicle ?? "—",
    `${entry.title} — ${entry.artists.join(", ")}`,
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");

  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "usage: bun scripts/find-oversized.ts [--limit <n>] [--max-bytes <n>] [--json] [--out <file>]",
    );
    return;
  }

  const json = process.argv.includes("--json");
  const limit = Math.min(
    parsePositiveInt(parseFlagValue("--limit"), VEHICLE_LIMIT_CAP, "--limit"),
    VEHICLE_LIMIT_CAP,
  );
  const maxBytes = parsePositiveInt(
    parseFlagValue("--max-bytes"),
    DEFAULT_MAX_BYTES,
    "--max-bytes",
  );
  const outArg = parseFlagValue("--out");
  const outPath = outArg
    ? path.resolve(process.cwd(), outArg)
    : path.join(OUT_DIR, "oversized.json");

  log(`listing videos (limit ${limit})…`);
  const { entries, truncated } = fetchVehicles(limit);

  if (truncated) {
    log(
      `WARNING: ${entries.length} videos returned — the CLI cap was hit. The census may be INCOMPLETE; the CLI exposes no cursor for a deeper page.`,
    );
  }

  const withLogId = entries.filter(
    (entry): entry is VehicleEntry & { logId: string } =>
      typeof entry.logId === "string" && entry.logId.length > 0,
  );

  log(`measuring ${withLogId.length} clips against ${formatMB(maxBytes)}…`);

  const oversized: OversizedEntry[] = [];

  for (const entry of withLogId) {
    const base = `${FOUND_BASE}/${encodeURIComponent(entry.logId)}`;
    const [footage, footageSilent] = await Promise.all([
      headBytes(`${base}/footage.mp4`),
      headBytes(`${base}/footage-silent.mp4`),
    ]);

    if (footage.status !== 200) {
      log(`${entry.logId}: footage.mp4 returned ${footage.status} (skipped from oversized list)`);
    }

    if (footage.bytes !== null && footage.bytes > maxBytes) {
      oversized.push({
        addedAt: entry.addedAt,
        artists: entry.artists,
        footage,
        footageSilent,
        logId: entry.logId,
        title: entry.title,
        vehicle: entry.vehicle ?? null,
      });
    }
  }

  // Heaviest first — the worst offenders lead the operator's re-render queue.
  oversized.sort((a, b) => (b.footage.bytes ?? 0) - (a.footage.bytes ?? 0));

  const manifest: OversizedManifest = {
    base: FOUND_BASE,
    generatedAt: new Date().toISOString(),
    maxBytes,
    measured: withLogId.length,
    oversized,
    truncated,
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest written → ${outPath}`);

  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  console.log(renderTable(manifest));
  console.log(
    `\n${oversized.length} of ${withLogId.length} clips exceed ${formatMB(maxBytes)}. Manifest: ${outPath}`,
  );
}

main().catch((error) => {
  console.error(`[find-oversized] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
