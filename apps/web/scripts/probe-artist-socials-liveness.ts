#!/usr/bin/env bun
/**
 * Probe every `artist_socials` link for liveness and remove the genuinely-dead ones.
 *
 * ── Removal policy (clean-safe) ────────────────────────────────────────────────────────
 * Only links whose oracle runs against a VALID-cert, stable host are removable, because
 * there an HTTP 404 is an honest "gone":
 *   - soundcloud  → `soundcloud.com/oembed` JSON (404 = account gone)
 *   - mixcloud    → `api.mixcloud.com/<user>/` (404 = gone)
 *   - youtube     → `youtube.com/@|user|channel` (404 = handle/channel gone)
 * bandcamp + homepage are RELIABLE enough to REPORT but NOT to auto-remove: they probe
 * arbitrary artist domains, where an expired TLS cert or a timeout is caught as "dead"
 * while the site is actually live (verified: foxstevenson.com throws cert-expired yet is
 * up). Those are held for the operator. Soft platforms (instagram/tiktok/facebook/twitter/
 * beatport/twitch) are platform-hosted (host always up) and login-walled — no logged-out
 * oracle exists, so they are not network-probed at all (zero signal, and it spares the IP).
 *
 * Safety: a removable-dead verdict is confirmed on TWO passes; a per-platform confirmed-dead
 * rate above `FUSE_RATE` trips a fuse that removes NOTHING there (assume the oracle broke);
 * every removal is written to a rollback file first.
 *
 * Operator-gated: plain run is a DRY RUN; `--confirm` deletes. Creds + dump prereqs as in
 * backfill-artist-socials-from-mb-dump.ts (TURSO_* env, `.dev.vars` fallback).
 *
 * Usage:
 *   bun run apps/web/scripts/probe-artist-socials-liveness.ts            # dry run + report
 *   bun run apps/web/scripts/probe-artist-socials-liveness.ts --confirm  # remove honest-404 deaths
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, "..", ".dev", "artist-socials");
const CONCURRENCY = 8;
const TIMEOUT_MS = 10_000;
export const FUSE_RATE = 0.25;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Oracles trustworthy enough to REPORT a death (valid-cert stable host OR arbitrary domain). */
export const RELIABLE: ReadonlySet<string> = new Set([
  "soundcloud",
  "mixcloud",
  "youtube",
  "bandcamp",
  "homepage",
]);
/** Subset trustworthy enough to auto-REMOVE — arbitrary-domain oracles (bandcamp/homepage) are NOT. */
export const REMOVABLE: ReadonlySet<string> = new Set(["soundcloud", "mixcloud", "youtube"]);

export type Verdict = "live" | "dead" | "unknown" | "host-dead";
export type Row = {
  id: string;
  artist_id: string;
  platform: string;
  url: string;
  status: string;
  source: string;
};
export type PlatformTally = { live: number; dead: number; unknown: number; total: number };

/** Map a fetched HTTP status (or "neterr" for a thrown request) to a verdict for a platform. */
export function interpretStatus(platform: string, status: number | "neterr"): Verdict {
  if (platform === "soundcloud" || platform === "mixcloud" || platform === "youtube") {
    if (status === "neterr") {
      return "unknown";
    }
    return status === 200 ? "live" : status === 404 ? "dead" : "unknown";
  }
  if (platform === "bandcamp" || platform === "homepage") {
    if (status === "neterr") {
      return "host-dead";
    }
    return status < 400 ? "live" : status === 404 || status === 410 ? "dead" : "unknown";
  }
  // soft platforms — not probed
  return "unknown";
}

/** Platforms whose confirmed-dead rate exceeds the fuse — their oracle is suspect, remove none. */
export function computeFusedPlatforms(
  perPlatform: Map<string, PlatformTally>,
  fuseRate = FUSE_RATE,
): Set<string> {
  const fused = new Set<string>();
  for (const [platform, tally] of perPlatform) {
    if (RELIABLE.has(platform) && tally.total > 0 && tally.dead / tally.total > fuseRate) {
      fused.add(platform);
    }
  }
  return fused;
}

async function fetchStatus(
  url: string,
  headers: Record<string, string> = {},
): Promise<number | "neterr"> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, ...headers },
      redirect: "follow",
      signal: ctrl.signal,
    });
    return r.status;
  } catch {
    return "neterr";
  } finally {
    clearTimeout(timer);
  }
}

async function probe(row: Row): Promise<Verdict> {
  const { platform, url } = row;
  try {
    if (platform === "soundcloud") {
      return interpretStatus(
        platform,
        await fetchStatus(
          `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`,
        ),
      );
    }
    if (platform === "mixcloud") {
      const user = new URL(url).pathname.split("/").filter(Boolean)[0];
      if (!user) {
        return "unknown";
      }
      return interpretStatus(platform, await fetchStatus(`https://api.mixcloud.com/${user}/`));
    }
    if (platform === "youtube") {
      return interpretStatus(platform, await fetchStatus(url, { cookie: "SOCS=CAI" }));
    }
    if (platform === "bandcamp") {
      return interpretStatus(platform, await fetchStatus(new URL(url).origin));
    }
    if (platform === "homepage") {
      return interpretStatus(platform, await fetchStatus(url));
    }
    return "unknown"; // soft platforms — never network-probed
  } catch {
    return "unknown";
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) {
          return;
        }
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function dbFromEnv(): Client {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(SCRIPT_DIR, "..", ".dev.vars") });
  }
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is required (export prod creds, or set apps/web/.dev.vars)",
    );
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  return createClient(authToken ? { authToken, url } : { url });
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const db = dbFromEnv();
  const rows = (
    await db.execute(`select id, artist_id, platform, url, status, source from artist_socials`)
  ).rows as unknown as Row[];
  console.log(
    `probing ${rows.length} links @ concurrency ${CONCURRENCY} (${confirm ? "CONFIRM" : "DRY RUN"})...`,
  );

  let done = 0;
  const pass1 = await pool(rows, CONCURRENCY, async (row) => {
    const v = await probe(row);
    if (++done % 2000 === 0) {
      console.log(`  pass1 ${done}/${rows.length}`);
    }
    return v;
  });

  // confirm reliable-dead on a second pass
  const deadCandidates = rows
    .map((r, i) => ({ r, v: pass1[i] }))
    .filter((x) => RELIABLE.has(x.r.platform) && (x.v === "dead" || x.v === "host-dead"));
  const pass2 = await pool(deadCandidates, CONCURRENCY, (x) => probe(x.r));
  const confirmedDead = new Set<string>();
  deadCandidates.forEach((x, k) => {
    if (pass2[k] === "dead" || pass2[k] === "host-dead") {
      confirmedDead.add(x.r.id);
    }
  });

  const perPlatform = new Map<string, PlatformTally>();
  rows.forEach((r, i) => {
    const t = perPlatform.get(r.platform) ?? { dead: 0, live: 0, total: 0, unknown: 0 };
    t.total++;
    if (pass1[i] === "live") {
      t.live++;
    } else if ((pass1[i] === "dead" || pass1[i] === "host-dead") && confirmedDead.has(r.id)) {
      t.dead++;
    } else {
      t.unknown++;
    }
    perPlatform.set(r.platform, t);
  });

  const fusedOut = computeFusedPlatforms(perPlatform);
  for (const p of fusedOut) {
    console.log(`  ⚠ FUSE ${p}: >${FUSE_RATE * 100}% dead — removing none, reporting instead`);
  }

  const toRemove = rows.filter(
    (r) => REMOVABLE.has(r.platform) && !fusedOut.has(r.platform) && confirmedDead.has(r.id),
  );
  const heldForReview = rows.filter(
    (r) => RELIABLE.has(r.platform) && !REMOVABLE.has(r.platform) && confirmedDead.has(r.id),
  );

  const compact = (r: Row) => ({ id: r.id, platform: r.platform, status: r.status, url: r.url });
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, "liveness-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        confirmed: confirm,
        fusedPlatforms: [...fusedOut],
        heldForReview: heldForReview.map(compact),
        heldForReviewNote:
          "homepage/bandcamp flagged-dead — NOT removed. An expired TLS cert or timeout on an arbitrary domain reads as dead while the site is live. Confirm manually before removing.",
        perPlatform: Object.fromEntries(perPlatform),
        removed: toRemove.map(compact),
        totals: {
          heldForReview: heldForReview.length,
          links: rows.length,
          toRemove: toRemove.length,
        },
      },
      null,
      2,
    ),
  );

  console.log(`per-platform (live/dead/unknown):`);
  for (const [p, t] of [...perPlatform.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${p.padEnd(11)} ${t.live}/${t.dead}/${t.unknown} (n=${t.total})${fusedOut.has(p) ? " [FUSED]" : ""}`,
    );
  }
  console.log(`removable honest-404 deaths : ${toRemove.length}`);
  console.log(`held for review (hp/bandcamp): ${heldForReview.length}`);
  console.log(`report → ${reportPath}`);

  if (!confirm) {
    console.log(`\nDRY RUN — no deletes. Re-run with --confirm to remove the ${toRemove.length}.`);
    return;
  }
  if (toRemove.length === 0) {
    console.log(`\nnothing to remove.`);
    return;
  }
  const rollbackPath = join(OUT_DIR, "liveness-removal-rollback.json");
  writeFileSync(
    rollbackPath,
    JSON.stringify({ at: new Date().toISOString(), rows: toRemove }, null, 2),
  );
  const CHUNK = 200;
  for (let i = 0; i < toRemove.length; i += CHUNK) {
    await db.batch(
      toRemove
        .slice(i, i + CHUNK)
        .map((r) => ({ args: [r.id], sql: `delete from artist_socials where id = ?` })),
      "write",
    );
  }
  console.log(`\nRemoved ${toRemove.length} confirmed-dead links. Rollback: ${rollbackPath}`);
}

if (import.meta.main) {
  await main();
}
