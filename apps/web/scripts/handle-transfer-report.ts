#!/usr/bin/env bun
/**
 * Handle-transfer RECALL report — find likely TikTok accounts for artists that have a
 * trusted handle on another platform but no TikTok link. REPORT ONLY: writes nothing to
 * the database (existence is not identity — namesakes and squatters exist, so every hit
 * is a candidate for the operator / a verifier to confirm, never an auto-write).
 *
 * For each artist with a trusted (`auto`/`confirmed`) handle anchor on instagram /
 * soundcloud / twitter / youtube-@ but NO tiktok row, transfer the handle to
 * `tiktok.com/@<handle>` and check existence via the profile's `followerCount` marker
 * (the follower count is the operator's triage signal — a single-digit "hit" is likely a
 * squatter, not the artist). Short/namesake-prone handles are flagged. Probes are capped
 * and throttled to protect the runner's IP; handle variants are listed, not probed.
 *
 * Creds prereqs as in the sibling scripts (TURSO_* env, `.dev.vars` fallback).
 *
 * Usage:
 *   bun run apps/web/scripts/handle-transfer-report.ts
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, "..", ".dev", "artist-socials");
const PROBE_CAP = 2000;
const CONCURRENCY = 4;
const TIMEOUT_MS = 12_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Anchors we can lift a usable handle from, in preference order. */
export const HANDLE_ANCHORS = ["instagram", "soundcloud", "twitter", "youtube"] as const;

/** Extract a bare handle from a profile URL, or null when the URL carries no usable handle. */
export function handleFromUrl(platform: string, url: string): string | null {
  try {
    if (platform === "youtube") {
      // only @handle youtube URLs carry a transferable handle; channel/UC… / user/ do not
      if (!url.includes("/@")) {
        return null;
      }
      const h = url.split("/@")[1]?.split(/[/?#]/)[0]?.trim() ?? "";
      return h && /^[A-Za-z0-9._-]+$/.test(h) ? h : null;
    }
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "").trim();
    return seg && /^[A-Za-z0-9._-]+$/.test(seg) ? seg : null;
  } catch {
    return null;
  }
}

/** Deterministic handle variants to suggest for a miss (listed in the report, not probed). */
export function handleVariants(handle: string): string[] {
  const base = handle.toLowerCase();
  return [
    ...new Set([base, base.replace(/[._-]/g, ""), `${base}dnb`, `${base}music`, `${base}official`]),
  ];
}

/** A normalized handle of 6 chars or fewer is namesake-prone — flag it for stricter review. */
export function isShortHandle(handle: string): boolean {
  return handle.replace(/[._-]/g, "").length <= 6;
}

/** Parse a TikTok profile HTML body for existence + follower count. */
export function parseTiktokProfile(
  body: string,
  handle: string,
): { exists: boolean; followers: string | null } {
  const m = body.match(/"followerCount":(\d+)/);
  const named = body.includes(`@${handle} on TikTok`) || body.includes(`"uniqueId":"${handle}"`);
  return { exists: Boolean(m || named), followers: m?.[1] ?? null };
}

async function tiktokProfile(
  handle: string,
): Promise<{ exists: boolean; followers: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://www.tiktok.com/@${handle}`, {
      headers: { "user-agent": UA },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      return { exists: false, followers: null };
    }
    return parseTiktokProfile(await r.text(), handle);
  } catch {
    return { exists: false, followers: null };
  } finally {
    clearTimeout(timer);
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

type Candidate = { artistId: string; name: string; handle: string; anchor: string; short: boolean };

/** Pure: build the transfer candidates (artists with a trusted anchor handle but no tiktok). */
export function buildCandidates(
  anchorsByArtist: Map<string, Map<string, string>>,
  nameById: Map<string, string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [artistId, platforms] of anchorsByArtist) {
    if (platforms.has("tiktok")) {
      continue;
    }
    let picked: { anchor: string; handle: string } | null = null;
    for (const anchor of HANDLE_ANCHORS) {
      const url = platforms.get(anchor);
      if (!url) {
        continue;
      }
      const handle = handleFromUrl(anchor, url);
      if (handle) {
        picked = { anchor, handle };
        break;
      }
    }
    if (!picked) {
      continue;
    }
    out.push({
      anchor: picked.anchor,
      artistId,
      handle: picked.handle,
      name: nameById.get(artistId) ?? "",
      short: isShortHandle(picked.handle),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const db = dbFromEnv();
  const artists = (await db.execute(`select id, name from artists`)).rows as unknown as {
    id: string;
    name: string;
  }[];
  const nameById = new Map(artists.map((a) => [a.id, a.name] as const));
  const socials = (
    await db.execute(
      `select artist_id, platform, url from artist_socials where status in ('auto','confirmed')`,
    )
  ).rows as unknown as { artist_id: string; platform: string; url: string }[];

  const anchorsByArtist = new Map<string, Map<string, string>>();
  for (const s of socials) {
    let m = anchorsByArtist.get(s.artist_id);
    if (!m) {
      anchorsByArtist.set(s.artist_id, (m = new Map()));
    }
    m.set(s.platform, s.url);
  }

  const candidates = buildCandidates(anchorsByArtist, nameById);
  // probe non-short handles first (higher precision), up to the cap
  const probeSet = [...candidates]
    .sort((a, b) => Number(a.short) - Number(b.short))
    .slice(0, PROBE_CAP);
  console.log(
    `candidates ${candidates.length}; probing ${probeSet.length} (cap ${PROBE_CAP}) @ ${CONCURRENCY}...`,
  );

  let done = 0;
  const results = await pool(probeSet, CONCURRENCY, async (c) => {
    const res = await tiktokProfile(c.handle);
    if (++done % 250 === 0) {
      console.log(`  probed ${done}/${probeSet.length}`);
    }
    return { ...c, ...res };
  });
  const hits = results.filter((r) => r.exists);

  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, "handle-transfer-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        hits: hits.map((h) => ({
          artistId: h.artistId,
          followers: h.followers,
          fromAnchor: h.anchor,
          handle: h.handle,
          name: h.name,
          proposedTiktok: `https://www.tiktok.com/@${h.handle}`,
          shortHandleNamesakeRisk: h.short,
          variants: handleVariants(h.handle),
        })),
        note: "REPORT ONLY — no writes. Each hit is a CANDIDATE to verify (existence != identity). Triage by follower count; a single-digit hit is likely a squatter.",
        totals: {
          candidates: candidates.length,
          probed: probeSet.length,
          tiktokHits: hits.length,
          unprobedOverCap: Math.max(0, candidates.length - probeSet.length),
        },
      },
      null,
      2,
    ),
  );

  console.log(
    `candidates ${candidates.length}; probed ${probeSet.length}; tiktok hits ${hits.length}`,
  );
  console.log(`report → ${reportPath}`);
}

if (import.meta.main) {
  await main();
}
