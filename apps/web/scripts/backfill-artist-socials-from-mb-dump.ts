#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type ArtistSocialPlatform } from "../src/lib/artist-socials";
import {
  classifyMbUrl,
  isLinkHubUrl,
  normalizeProfileUrl,
} from "../src/lib/server/artist-resolution";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DUMP =
  process.env.MB_ARTIST_DUMP ?? join(SCRIPT_DIR, "..", "..", "..", "data", "artist.tar.xz");
const OUT_DIR = join(SCRIPT_DIR, "..", ".dev", "artist-socials");

export const SOCIAL_PLATFORMS: ReadonlySet<ArtistSocialPlatform> = new Set([
  "youtube",
  "mixcloud",
  "soundcloud",
  "instagram",
  "tiktok",
  "bandcamp",
  "beatport",
  "twitter",
  "facebook",
  "twitch",
  "homepage",
]);

export type MatchKey = "spotify" | "mbid" | "qid";
const KEY_RANK: Record<MatchKey, number> = { mbid: 2, qid: 1, spotify: 3 };

export type ArtistIdentity = {
  id: string;
  name: string;
  spotifyArtistId: string | null;
  mbid: string | null;
  wikidataQid: string | null;
};

export type PlannedInsert = {
  artistId: string;
  id: string;
  platform: string;
  status: "auto" | "candidate";
  url: string;
};

export function statusForKey(key: MatchKey): "auto" | "candidate" {
  return key === "qid" ? "candidate" : "auto";
}

export function betterKey(a: MatchKey, b: MatchKey): MatchKey {
  return KEY_RANK[a] >= KEY_RANK[b] ? a : b;
}

export function planInserts(
  matches: Map<string, { key: MatchKey; socials: Map<string, string> }>,
  existingByArtist: Map<string, Set<string>>,
  newId: () => string = randomUUID,
): PlannedInsert[] {
  const plan: PlannedInsert[] = [];
  for (const [artistId, match] of matches) {
    const status = statusForKey(match.key);
    const already = existingByArtist.get(artistId) ?? new Set<string>();
    for (const [platform, url] of match.socials) {
      if (already.has(platform)) {
        continue;
      }
      plan.push({ artistId, id: newId(), platform, status, url });
    }
  }
  return plan;
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
  return createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
}

const SPOTIFY_RE = /open\.spotify\.com\/artist\/([A-Za-z0-9]+)/;
const QID_RE = /wikidata\.org\/wiki\/(Q\d+)/;

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const db = dbFromEnv();

  const artists = (
    await db.execute(`select id, name, spotify_artist_id, mbid, wikidata_qid from artists`)
  ).rows as unknown as {
    id: string;
    name: string;
    spotify_artist_id: string | null;
    mbid: string | null;
    wikidata_qid: string | null;
  }[];
  const socials = (await db.execute(`select artist_id, platform from artist_socials`))
    .rows as unknown as {
    artist_id: string;
    platform: string;
  }[];

  const existingByArtist = new Map<string, Set<string>>();
  for (const s of socials) {
    let set = existingByArtist.get(s.artist_id);
    if (!set) {
      existingByArtist.set(s.artist_id, (set = new Set()));
    }
    set.add(s.platform);
  }

  const bySpotify = new Map<string, ArtistIdentity>();
  const byMbid = new Map<string, ArtistIdentity>();
  const byQid = new Map<string, ArtistIdentity>();
  for (const a of artists) {
    const identity: ArtistIdentity = {
      id: a.id,
      mbid: a.mbid,
      name: a.name,
      spotifyArtistId: a.spotify_artist_id,
      wikidataQid: a.wikidata_qid,
    };
    if (a.spotify_artist_id) {
      bySpotify.set(a.spotify_artist_id, identity);
    }
    if (a.mbid) {
      byMbid.set(a.mbid, identity);
    }
    if (a.wikidata_qid) {
      byQid.set(a.wikidata_qid, identity);
    }
  }

  const matches = new Map<string, { key: MatchKey; socials: Map<string, string> }>();
  const record = (artistId: string, key: MatchKey, socials: Map<string, string>) => {
    const cur = matches.get(artistId);
    if (!cur) {
      matches.set(artistId, { key, socials });
    } else {
      cur.key = betterKey(cur.key, key);
    }
  };

  let scanned = 0;
  const proc = Bun.spawn(["bash", "-lc", `xz -dc ${DUMP} | tar -xO mbdump/artist`], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dumpIdentityKeys = (
    rels: { "target-type"?: string; url?: { resource?: string } }[],
  ): { qid: null | string; spotify: null | string } => {
    let spotify: string | null = null;
    let qid: string | null = null;
    for (const rel of rels) {
      const resource = rel["target-type"] === "url" ? rel.url?.resource : undefined;
      if (!resource) {
        continue;
      }
      spotify ??= SPOTIFY_RE.exec(resource)?.[1] ?? null;
      qid ??= QID_RE.exec(resource)?.[1] ?? null;
    }
    return { qid, spotify };
  };

  const handleLine = async (line: string) => {
    if (!line) {
      return;
    }
    let record_: { id: string; name?: string; relations?: unknown[] };
    try {
      record_ = JSON.parse(line);
    } catch {
      return;
    }
    scanned++;
    const rels = record_.relations;
    if (!Array.isArray(rels) || rels.length === 0) {
      return;
    }

    const { qid: dumpQid, spotify: dumpSpotify } = dumpIdentityKeys(rels);
    const viaSpotify = dumpSpotify ? bySpotify.get(dumpSpotify) : undefined;
    const viaMbid = byMbid.get(record_.id);
    const viaQid = dumpQid ? byQid.get(dumpQid) : undefined;
    if (!viaSpotify && !viaMbid && !viaQid) {
      return;
    }

    const socials_ = new Map<string, string>();
    for (const rel of rels as {
      type?: string;
      "target-type"?: string;
      url?: { resource?: string };
    }[]) {
      const resource = rel["target-type"] === "url" ? rel.url?.resource : undefined;
      if (!resource || isLinkHubUrl(resource)) {
        continue;
      }
      const platform = classifyMbUrl(resource, rel.type);
      if (!platform || !SOCIAL_PLATFORMS.has(platform as ArtistSocialPlatform)) {
        continue;
      }
      if (socials_.has(platform)) {
        continue;
      }
      const normalized = await normalizeProfileUrl(platform, resource);
      if (normalized) {
        socials_.set(platform, normalized);
      }
    }
    if (socials_.size === 0) {
      return;
    }
    if (viaSpotify) {
      record(viaSpotify.id, "spotify", socials_);
    }
    if (viaMbid) {
      record(viaMbid.id, "mbid", socials_);
    }
    if (viaQid) {
      record(viaQid.id, "qid", socials_);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      await handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) {
    await handleLine(buffer);
  }

  const plan = planInserts(matches, existingByArtist);
  const auto = plan.filter((p) => p.status === "auto").length;

  console.log(`dump artists scanned : ${scanned.toLocaleString()}`);
  console.log(`artists matched      : ${matches.size}`);
  console.log(
    `net-new links        : ${plan.length} (auto ${auto}, candidate ${plan.length - auto})`,
  );

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Re-run with --confirm to insert.`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const rollbackPath = join(OUT_DIR, "backfill-rollback.json");
  writeFileSync(
    rollbackPath,
    JSON.stringify({ at: new Date().toISOString(), rows: plan }, null, 2),
  );
  console.log(`rollback → ${rollbackPath} (${plan.length} ids)`);

  const nowIso = new Date().toISOString();
  const CHUNK = 200;
  for (let i = 0; i < plan.length; i += CHUNK) {
    await db.batch(
      plan.slice(i, i + CHUNK).map((p) => ({
        args: [
          p.id,
          p.artistId,
          p.platform,
          p.url,
          "musicbrainz",
          p.status,
          nowIso,
          nowIso,
          nowIso,
        ],
        sql: `insert into artist_socials
                (id, artist_id, platform, url, source, status, reviewed_at, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(artist_id, platform) do nothing`,
      })),
      "write",
    );
  }
  console.log(
    `\nInserted up to ${plan.length} rows (on-conflict-do-nothing). Rollback: ${rollbackPath}`,
  );
}

if (import.meta.main) {
  await main();
}
