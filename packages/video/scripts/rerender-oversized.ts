// rerender-oversized.ts — the guarded batch loop that replaces oversized R2
// clips with fresh, under-ceiling re-renders.
//
//   bun scripts/rerender-oversized.ts [--manifest <file>] [--max-bytes <n>] [--apply]
//
// ────────────────────────────────────────────────────────────────────────────
//  THIS SCRIPT DOES NOT RE-RENDER FOR YOU.
//  Re-rendering the brand's clips is the operator's bespoke, GPU-heavy step,
//  run via the @fluncle-video runbook so the quality bar is held. This script is
//  the *replace* half: it pre-flights every fresh local bundle and, only under
//  --apply, overwrites the live R2 object through the admin upload path.
// ────────────────────────────────────────────────────────────────────────────
//
// Contract per manifest entry (logId, vehicle, current size):
//   1. Operator re-renders the clip locally, PRESERVING the recorded vehicle:
//        bun src/pipeline/social-preview.ts <trackId>
//        bun src/pipeline/ship.ts <logId> --vehicle "<recorded vehicle>"
//      → produces the bundle at out/<logId>/ with footage.mp4 + render.json
//        (render.json carries the vehicle; the upload reads it back).
//   2. This script PRE-FLIGHTS the bundle: footage.mp4 exists and is < ceiling,
//      render.json's vehicle matches the manifest (a re-render must not silently
//      drop or change the diversity-ledger entry).
//   3. With --apply, it replaces the live clip in place via:
//        fluncle admin track video <logId> --dir out/<logId>
//      The Worker owns the bucket and overwrites the SAME R2 key
//      (<log-id>/footage.mp4 + footage-silent.mp4 + …) — no R2 creds here.
//
// DEFAULT IS DRY-RUN: it reports what it WOULD upload and why each entry is or
// isn't ready. --apply MUTATES PRODUCTION R2 IN PLACE with NO BACKUP (the
// operator's batch sign-off decision). Spot-check every local re-render first.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { type OversizedEntry, type OversizedManifest } from "./find-oversized";

const OUT_DIR = path.resolve(import.meta.dirname, "../out");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

// Must match find-oversized's ceiling so a clip that passes pre-flight here can't
// reappear in the next census.
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const log = (message: string) => console.error(`[rerender-oversized] ${message}`);

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

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RenderManifest = { vehicle?: string | null };

type PreflightOutcome =
  | { ready: true; bundle: string; bytes: number; vehicle: string | null }
  | { ready: false; reason: string };

/**
 * Check a single bundle is ready to upload: footage exists, is under the
 * ceiling, and its recorded vehicle matches what the original render used.
 */
function preflight(entry: OversizedEntry, maxBytes: number): PreflightOutcome {
  const bundle = path.join(OUT_DIR, entry.logId);
  const footage = path.join(bundle, "footage.mp4");

  if (!existsSync(footage)) {
    return {
      ready: false,
      reason: `no fresh re-render at ${path.relative(PACKAGE_ROOT, footage)} — run social-preview + ship first`,
    };
  }

  const bytes = statSync(footage).size;

  if (bytes > maxBytes) {
    return {
      ready: false,
      reason: `re-render is still ${formatMB(bytes)} (> ${formatMB(maxBytes)}) — shorten/re-encode before uploading`,
    };
  }

  // Vehicle must survive the re-render: read it back from render.json (written by
  // `ship --vehicle`). A mismatch means the operator shipped the wrong vehicle.
  let recordedVehicle: string | null = null;
  const renderJson = path.join(bundle, "render.json");

  if (existsSync(renderJson)) {
    try {
      const parsed = JSON.parse(readFileSync(renderJson, "utf8")) as RenderManifest;
      recordedVehicle = parsed.vehicle ?? null;
    } catch (error) {
      return {
        ready: false,
        reason: `render.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (entry.vehicle && recordedVehicle !== entry.vehicle) {
    return {
      ready: false,
      reason: `vehicle drift: manifest recorded "${entry.vehicle}" but the bundle's render.json says ${recordedVehicle === null ? "none" : `"${recordedVehicle}"`} — re-ship with: ship ${entry.logId} --vehicle "${entry.vehicle}"`,
    };
  }

  return { bundle, bytes, ready: true, vehicle: recordedVehicle };
}

/** Overwrite the live R2 object in place via the admin upload path. */
function upload(logId: string, bundle: string): boolean {
  const relativeDir = path.relative(process.cwd(), bundle);
  log(`uploading ${logId} (fluncle admin track video ${logId} --dir ${relativeDir})…`);

  const result = spawnSync("fluncle", ["admin", "track", "video", logId, "--dir", bundle], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    log(`UPLOAD FAILED for ${logId} (status ${result.status})`);
    return false;
  }

  return true;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "usage: bun scripts/rerender-oversized.ts [--manifest <file>] [--max-bytes <n>] [--apply]",
    );
    return;
  }

  const apply = process.argv.includes("--apply");
  const maxBytes = parsePositiveInt(
    parseFlagValue("--max-bytes"),
    DEFAULT_MAX_BYTES,
    "--max-bytes",
  );
  const manifestArg = parseFlagValue("--manifest");
  const manifestPath = manifestArg
    ? path.resolve(process.cwd(), manifestArg)
    : path.join(OUT_DIR, "oversized.json");

  if (!existsSync(manifestPath)) {
    throw new Error(
      `no manifest at ${manifestPath} — run \`bun scripts/find-oversized.ts\` first to produce it`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OversizedManifest;

  if (!Array.isArray(manifest.oversized)) {
    throw new Error(`malformed manifest at ${manifestPath}: missing "oversized" array`);
  }

  if (manifest.oversized.length === 0) {
    log("manifest is empty — nothing to re-render.");
    return;
  }

  if (apply) {
    log("");
    log("================  --apply: PRODUCTION OVERWRITE  ================");
    log("This OVERWRITES live R2 clips IN PLACE, with NO BACKUP.");
    log("Every entry below should be a spot-checked local re-render.");
    log("================================================================");
    log("");
  } else {
    log("DRY-RUN (no --apply): reporting readiness only. Nothing will be uploaded.");
  }

  const ready: { entry: OversizedEntry; bundle: string; bytes: number; vehicle: string | null }[] =
    [];
  const blocked: { entry: OversizedEntry; reason: string }[] = [];

  for (const entry of manifest.oversized) {
    const outcome = preflight(entry, maxBytes);

    if (outcome.ready) {
      ready.push({ bundle: outcome.bundle, bytes: outcome.bytes, entry, vehicle: outcome.vehicle });
      log(
        `READY   ${entry.logId} — ${formatMB(outcome.bytes)} (was ${formatMB(entry.footage.bytes ?? 0)}), vehicle "${outcome.vehicle ?? "—"}"`,
      );
    } else {
      blocked.push({ entry, reason: outcome.reason });
      log(`BLOCKED ${entry.logId} — ${outcome.reason}`);
    }
  }

  log("");
  log(`${ready.length} ready, ${blocked.length} blocked, of ${manifest.oversized.length} total.`);

  if (!apply) {
    log("");
    log("Re-run with --apply once every READY clip has been spot-checked locally.");
    log("(BLOCKED clips need a fresh re-render + ship first — see each reason above.)");
    return;
  }

  if (blocked.length > 0) {
    log("");
    log(
      `REFUSING to apply: ${blocked.length} clip(s) are not ready. Resolve them or remove from the manifest, then re-run --apply.`,
    );
    process.exit(1);
  }

  let uploaded = 0;
  const failures: string[] = [];

  for (const item of ready) {
    if (upload(item.entry.logId, item.bundle)) {
      uploaded += 1;
    } else {
      failures.push(item.entry.logId);
    }
  }

  log("");
  log(`uploaded ${uploaded}/${ready.length}.`);

  if (failures.length > 0) {
    log(
      `FAILED: ${failures.join(", ")} — re-run --apply to retry (already-uploaded clips re-PUT).`,
    );
    process.exit(1);
  }

  log("Done. Re-run `bun scripts/find-oversized.ts` to confirm the census is clear.");
}

main().catch((error) => {
  console.error(`[rerender-oversized] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
