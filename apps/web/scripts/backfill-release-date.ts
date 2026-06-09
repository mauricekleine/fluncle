// Backfill each track's release date (the year/date the recording came out).
//
// Spotify supplies release_date at add time now, but finds that predate that
// change have a null release_date. This script resolves one from Deezer by ISRC
// (GET https://api.deezer.com/track/isrc:<ISRC> → release_date, YYYY-MM-DD).
//
// DRY RUN BY DEFAULT — read-only. It pulls the current track list from the
// `fluncle` CLI (`fluncle recent --limit 100 --json`, which carries isrc per
// track), fetches each track's Deezer release_date, and prints a table of what
// it WOULD set. It makes ZERO database writes.
//
//   bun run apps/web/scripts/backfill-release-date.ts            # dry run
//   bun run apps/web/scripts/backfill-release-date.ts --write    # apply writes
//
// Only --write touches Turso (via @libsql/client, reading
// TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from apps/web/.dev.vars, mirroring
// backfill-log-ids.ts). The dry run needs no credentials.

import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "../.dev.vars") });

const write = process.argv.includes("--write");
const limit = 100;

type RecentTrack = {
  artists?: string[];
  isrc?: string;
  releaseDate?: string;
  title?: string;
  trackId?: string;
};

type DeezerTrack = {
  error?: unknown;
  id?: number;
  release_date?: string;
};

type Plan = {
  artists: string[];
  current?: string;
  isrc?: string;
  resolved?: string;
  status: "would-set" | "already-set" | "no-isrc" | "deezer-miss";
  title: string;
  trackId: string;
};

async function resolveFromDeezer(isrc: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);

    if (!response.ok) {
      return undefined;
    }

    const track = (await response.json()) as DeezerTrack;

    if (track.error || !track.id) {
      return undefined;
    }

    const releaseDate = track.release_date?.trim();

    // Deezer returns "0000-00-00" for unknown dates; treat that as a miss.
    return releaseDate && releaseDate !== "0000-00-00" ? releaseDate : undefined;
  } catch {
    return undefined;
  }
}

function line(plan: Plan): string {
  return `${plan.artists.join(", ")} — ${plan.title}`;
}

async function loadRecentTracks(): Promise<RecentTrack[]> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--cwd",
      join(here, "../../cli"),
      "fluncle",
      "recent",
      "--limit",
      String(limit),
      "--json",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`fluncle recent failed (exit ${exitCode}):\n${stderr.trim()}`);
  }

  const parsed = JSON.parse(stdout) as RecentTrack[] | { tracks?: RecentTrack[] };

  return Array.isArray(parsed) ? parsed : (parsed.tracks ?? []);
}

const tracks = await loadRecentTracks();
console.log(
  `[backfill-release-date] ${tracks.length} track(s) from \`fluncle recent --limit ${limit}\`\n`,
);

const plans: Plan[] = [];

for (const track of tracks) {
  const base = {
    artists: track.artists ?? [],
    current: track.releaseDate,
    isrc: track.isrc,
    title: track.title ?? "(untitled)",
    trackId: track.trackId ?? "",
  };

  if (track.releaseDate?.trim()) {
    plans.push({ ...base, status: "already-set" });
    continue;
  }

  if (!track.isrc?.trim()) {
    plans.push({ ...base, status: "no-isrc" });
    continue;
  }

  const resolved = await resolveFromDeezer(track.isrc.trim());
  plans.push(
    resolved ? { ...base, resolved, status: "would-set" } : { ...base, status: "deezer-miss" },
  );
}

const wouldSet = plans.filter((plan) => plan.status === "would-set");
const alreadySet = plans.filter((plan) => plan.status === "already-set");
const noIsrc = plans.filter((plan) => plan.status === "no-isrc");
const deezerMiss = plans.filter((plan) => plan.status === "deezer-miss");

console.log("Deezer CAN supply a release date for:");
if (wouldSet.length === 0) {
  console.log("  (none)");
}
for (const plan of wouldSet) {
  console.log(`  ${plan.resolved}  ${line(plan)}  [isrc ${plan.isrc}]`);
}

console.log("\nDeezer CANNOT supply a release date for:");
if (deezerMiss.length === 0 && noIsrc.length === 0) {
  console.log("  (none)");
}
for (const plan of noIsrc) {
  console.log(`  no ISRC      ${line(plan)}`);
}
for (const plan of deezerMiss) {
  console.log(`  deezer miss  ${line(plan)}  [isrc ${plan.isrc}]`);
}

console.log("\nAlready has a release date (skipped):");
if (alreadySet.length === 0) {
  console.log("  (none)");
}
for (const plan of alreadySet) {
  console.log(`  ${plan.current}  ${line(plan)}`);
}

console.log(
  `\nSummary: ${wouldSet.length} resolvable · ${deezerMiss.length} deezer miss · ${noIsrc.length} no ISRC · ${alreadySet.length} already set`,
);

if (!write) {
  console.log("\nDRY RUN — no database writes were made. Re-run with --write to apply.");
  process.exit(0);
}

// --write path: apply resolved release dates to Turso.
const { createClient } = await import("@libsql/client");
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  throw new Error(
    "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required for --write (set them in apps/web/.dev.vars).",
  );
}

const db = createClient({ authToken, url });
let written = 0;

for (const plan of wouldSet) {
  await db.execute({
    args: [plan.resolved ?? null, plan.trackId],
    sql: `update tracks set release_date = ? where track_id = ? and release_date is null`,
  });
  written += 1;
  console.log(`[write] ${plan.resolved}  ${line(plan)}`);
}

console.log(`\n[backfill-release-date] wrote ${written} release date(s).`);
