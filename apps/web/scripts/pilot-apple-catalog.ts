#!/usr/bin/env bun
/**
 * THE APPLE CATALOG PILOT — go/no-go, operator-run, DRY (no writes, ever).
 *
 * The RFC `docs/musickit-second-authority-rfc.md` U0 gate: before ANY unit fans out
 * an Apple sweep, this pilot samples ~50 CATALOGUE ISRCs (crawled `tracks` rows with
 * no `findings` row) and measures whether Apple actually covers Fluncle's underground
 * DnB — the one load-bearing unknown that "is outside our control, measured by the
 * pilot, not assumed" (§1). It runs the SINGLE-ISRC catalog read (`include=albums`,
 * the picker path) on each, at a polite pace, and prints:
 *
 *   - hit-rate                       — the number that decides whether U1/U2/U3's
 *     Apple rungs are worth their sweeps.
 *   - multi-pressing distribution    — how many album candidates each ISRC resolves
 *     to (the picker earns its keep only when this is > 1).
 *   - distributor-recordLabel freq   — how often a candidate's `recordLabel` is a
 *     distributor (seeded from the RFC U2a denylist), i.e. how often the picker /
 *     denylist is protecting the label graph.
 *   - canonicalAlbum-undefined rate  — the honest-miss rate (compilation-only sets).
 *   - artwork max-size distribution  — the native cover resolution available (the
 *     render-defect fix depends on ≥1920 sources existing).
 *
 * It reads env the way the other operator scripts do: `.dev.vars` provides both the
 * Turso URL/token (to sample ISRCs) and the three `APPLE_MUSIC_*` MusicKit secrets
 * (to authenticate). The lookup is a NO-OP until those are set — the pilot says so
 * and exits rather than pretending.
 *
 * Usage (on the operator machine, from apps/web):
 *   bun run scripts/pilot-apple-catalog.ts                    # sample 50 catalogue ISRCs
 *   bun run scripts/pilot-apple-catalog.ts --limit 100
 *   bun run scripts/pilot-apple-catalog.ts --delay 3000       # ms between calls (default 3000)
 *   bun run scripts/pilot-apple-catalog.ts --file isrcs.txt   # skip the DB; read ISRCs from a file
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AppleAlbumCandidate,
  buildCatalogBundle,
  collectAlbumCandidates,
  requestAppleCatalog,
} from "../src/lib/server/apple-music";

// The distributor denylist, seeded verbatim from the RFC U2a guardrail — a
// distributor's `recordLabel` is NOT the imprint. Matched case/space-folded, by
// substring, so "The Orchard Music" counts as "The Orchard".
const DISTRIBUTOR_DENYLIST = [
  "Believe",
  "AEI",
  "Kontor New Media",
  "The Orchard",
  "Absolute",
  "FUGA",
  "Ingrooves",
  "Symphonic",
  "ADA",
  "Horus Music",
];

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DENYLIST_FOLDED = DISTRIBUTOR_DENYLIST.map(fold);

function isDistributor(label: string | undefined): boolean {
  if (!label) {
    return false;
  }

  const folded = fold(label);

  return DENYLIST_FOLDED.some((dist) => folded.includes(dist));
}

function numberArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);

  if (index < 0) {
    return fallback;
  }

  const parsed = Number(process.argv[index + 1]);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Load .dev.vars into process.env (the readOptionalEnv path the lookup uses reads
// process.env directly outside the Vite/Worker runtime), unless the env is already
// provisioned (e.g. run with the secrets exported).
function loadEnv(): void {
  if (!process.env.TURSO_DATABASE_URL || !process.env.APPLE_MUSIC_TEAM_ID) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }
}

async function sampleIsrcsFromDb(limit: number): Promise<string[]> {
  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is required to sample catalogue ISRCs (set it in apps/web/.dev.vars, or pass --file).",
    );
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });

  // A CATALOGUE row is a `tracks` row with no `findings` row (docs/the-ear.md); we
  // want the ones carrying an ISRC, sampled at random so the pilot is representative.
  const result = await client.execute({
    args: [limit],
    sql: `select tracks.isrc as isrc
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where findings.track_id is null
            and tracks.isrc is not null
            and trim(tracks.isrc) <> ''
          order by random()
          limit ?`,
  });

  const isrcs: string[] = [];

  for (const row of result.rows) {
    const isrc = typeof row.isrc === "string" ? row.isrc.trim() : "";

    if (isrc) {
      isrcs.push(isrc);
    }
  }

  return isrcs;
}

async function readIsrcsFromFile(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// A histogram printer: buckets a list of numbers into labelled counts.
function printBuckets(title: string, counts: Map<string, number>): void {
  console.log(`\n${title}`);

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    console.log("  (none)");
    return;
  }

  for (const [label, n] of entries) {
    console.log(`  ${label.padEnd(24)} ${n}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Tally = {
  sampled: number;
  hits: number;
  misses: number;
  errors: number;
  canonicalUndefined: number;
  distributorSeen: number;
  pressingCounts: Map<string, number>;
  distributorFreq: Map<string, number>;
  artworkMax: Map<string, number>;
};

function artworkBucket(dimension: number): string {
  if (dimension >= 3000) {
    return "≥3000";
  }
  if (dimension >= 1920) {
    return "1920–2999";
  }
  if (dimension >= 1200) {
    return "1200–1919";
  }
  if (dimension >= 640) {
    return "640–1199";
  }
  if (dimension > 0) {
    return "<640";
  }
  return "none";
}

function recordArtwork(tally: Tally, candidates: AppleAlbumCandidate[], songArtMax: number): void {
  // The best native cover resolution we could source for this ISRC: the song's own
  // artwork or any candidate album's — whichever is largest.
  let max = songArtMax;

  for (const album of candidates) {
    if (album.artwork) {
      max = Math.max(max, album.artwork.width, album.artwork.height);
    }
  }

  const bucket = artworkBucket(max);

  tally.artworkMax.set(bucket, (tally.artworkMax.get(bucket) ?? 0) + 1);
}

async function main(): Promise<void> {
  loadEnv();

  const filePath = stringArg("--file");
  const limit = numberArg("--limit", 50);
  const delayMs = numberArg("--delay", 3000);

  const isrcs = filePath
    ? (await readIsrcsFromFile(filePath)).slice(0, limit)
    : await sampleIsrcsFromDb(limit);

  if (isrcs.length === 0) {
    console.log("No catalogue ISRCs to sample. Nothing to do.");
    return;
  }

  console.log(
    `Apple catalog pilot — ${isrcs.length} ISRC${isrcs.length === 1 ? "" : "s"} ` +
      `${filePath ? `from ${filePath}` : "sampled from catalogue rows"}, ~${delayMs}ms apart.\n`,
  );

  const tally: Tally = {
    artworkMax: new Map(),
    canonicalUndefined: 0,
    distributorFreq: new Map(),
    distributorSeen: 0,
    errors: 0,
    hits: 0,
    misses: 0,
    pressingCounts: new Map(),
    sampled: isrcs.length,
  };

  for (let i = 0; i < isrcs.length; i += 1) {
    const isrc = isrcs[i] ?? "";
    // The single-ISRC read (include=albums) — the exact path appleCatalogLookupByIsrc
    // takes, driven at the low level so the pilot can also see the raw pressing set.
    const outcome = await requestAppleCatalog(
      `filter%5Bisrc%5D=${encodeURIComponent(isrc)}&include=albums`,
    );

    if (!outcome.configured) {
      console.error(
        "\nApple Music is UNCONFIGURED (APPLE_MUSIC_TEAM_ID / KEY_ID / PRIVATE_KEY unset in .dev.vars). " +
          "The lookup is a no-op until the MusicKit key is provisioned — nothing to measure.",
      );
      return;
    }

    if (!outcome.ok) {
      tally.errors += 1;
      console.log(
        `  [${i + 1}/${isrcs.length}] ${isrc}  ERROR${outcome.rateLimited ? " (rate-limited)" : ""}: ${outcome.error}`,
      );
    } else {
      const bundle = buildCatalogBundle(outcome.body);
      const candidates = collectAlbumCandidates(outcome.body);

      if (!bundle) {
        tally.misses += 1;
        console.log(`  [${i + 1}/${isrcs.length}] ${isrc}  no match`);
      } else {
        tally.hits += 1;

        const pressingKey = candidates.length >= 3 ? "3+" : String(candidates.length);
        tally.pressingCounts.set(pressingKey, (tally.pressingCounts.get(pressingKey) ?? 0) + 1);

        if (!bundle.canonicalAlbum) {
          tally.canonicalUndefined += 1;
        }

        let sawDistributor = false;

        for (const album of candidates) {
          if (isDistributor(album.recordLabel) && album.recordLabel) {
            sawDistributor = true;
            tally.distributorFreq.set(
              album.recordLabel,
              (tally.distributorFreq.get(album.recordLabel) ?? 0) + 1,
            );
          }
        }

        if (sawDistributor) {
          tally.distributorSeen += 1;
        }

        const songArtMax = bundle.songArtwork
          ? Math.max(bundle.songArtwork.width, bundle.songArtwork.height)
          : 0;
        recordArtwork(tally, candidates, songArtMax);

        console.log(
          `  [${i + 1}/${isrcs.length}] ${isrc}  hit · ${candidates.length} album(s)` +
            `${bundle.canonicalAlbum?.recordLabel ? ` · ${bundle.canonicalAlbum.recordLabel}` : bundle.canonicalAlbum ? "" : " · (no canonical album)"}`,
        );
      }
    }

    if (i < isrcs.length - 1) {
      await delay(delayMs);
    }
  }

  // ── The go/no-go report ──────────────────────────────────────────────────────
  const resolved = tally.hits + tally.misses;
  const hitRate = resolved > 0 ? ((tally.hits / resolved) * 100).toFixed(1) : "0.0";
  const undefinedRate =
    tally.hits > 0 ? ((tally.canonicalUndefined / tally.hits) * 100).toFixed(1) : "0.0";
  const distributorRate =
    tally.hits > 0 ? ((tally.distributorSeen / tally.hits) * 100).toFixed(1) : "0.0";

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  APPLE CATALOG PILOT — GO / NO-GO REPORT");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  Sampled ISRCs           ${tally.sampled}`);
  console.log(`  Errors                  ${tally.errors}`);
  console.log(`  HIT-RATE                ${hitRate}%  (${tally.hits}/${resolved} resolved)`);
  console.log(
    `  canonicalAlbum missing  ${undefinedRate}%  (${tally.canonicalUndefined}/${tally.hits} hits — compilation-only)`,
  );
  console.log(
    `  distributor recordLabel ${distributorRate}%  (${tally.distributorSeen}/${tally.hits} hits touched a denylisted distributor)`,
  );

  printBuckets("Multi-pressing distribution (album candidates per hit)", tally.pressingCounts);
  printBuckets("Distributor recordLabel frequency (by name)", tally.distributorFreq);
  printBuckets("Artwork native-max distribution (best source per hit)", tally.artworkMax);

  console.log(
    "\nGo/no-go read: a healthy hit-rate is what justifies U1/U2/U3's Apple rungs; a low one " +
      "re-scopes them honestly (U1 still pays on findings + the covered fraction). This run wrote nothing.",
  );
}

if (import.meta.main) {
  await main();
}
