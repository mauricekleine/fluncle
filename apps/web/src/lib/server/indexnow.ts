// IndexNow auto-submit: ping the search engines (Bing/Yandex and the shared
// IndexNow network) the instant a new finding publishes, so a fresh log page is
// crawled within minutes instead of waiting for the next organic recrawl.
//
// IndexNow is a key-ownership protocol, not an authenticated API: you publish a
// PUBLIC key file at the site root (`/<key>.txt` returns exactly the key), then
// POST the changed URL list with that key. The key is an ownership token, NOT a
// secret — it is committed here and served by the matching TanStack route at
// `routes/[$INDEXNOW_KEY][.]txt.ts`. No operator secret is needed.
//
// SAFETY — the swallow-and-continue discipline of the other publish side-channels
// (lastfm.ts, push.ts): the ping NEVER throws and NEVER blocks the publish. It
// schedules the POST on `waitUntil` (so the publish response returns immediately)
// and the POST itself catches everything. A submit failure can never fail or delay
// a finding going out.

import { waitUntil } from "cloudflare:workers";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { type EntityCacheKind, entityPurgeUrl } from "./edge-cache";
import { getTrackEntityPurgeTargets } from "./entity-cache-purge";

// The public IndexNow ownership key (32-char lowercase hex). Served verbatim at
// `https://www.fluncle.com/<key>.txt` by the matching root route. PUBLIC, not a
// secret — committed on purpose so indexing is hands-off (no env wiring).
export const INDEXNOW_KEY = "8337c1b41068549f248bf56f1fc465df";

// The shared IndexNow endpoint. A single POST here fans out to every participating
// engine (Bing, Yandex, …), so one call covers them all.
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

// www.fluncle.com — the canonical host IndexNow checks the key file against.
const INDEXNOW_HOST = new URL(siteUrl).host;

type IndexNowPayload = {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
};

/**
 * Build the IndexNow request body for a set of URLs. Exported for the unit test —
 * the host/keyLocation derivation is the load-bearing, easy-to-get-wrong bit (the
 * key file must live on the same host as the submitted URLs or the engine rejects
 * the batch).
 */
export function buildIndexNowPayload(urlList: string[]): IndexNowPayload {
  return {
    host: INDEXNOW_HOST,
    key: INDEXNOW_KEY,
    keyLocation: `${siteUrl}/${INDEXNOW_KEY}.txt`,
    urlList,
  };
}

/**
 * The full set of URLs a fresh finding lights up, deduped: its own `/log/<id>` page, every
 * public GRAPH page the finding joins (its artist(s), album, and label detail pages), and the
 * `/fresh` new-releases lens the release now sits atop. This is the SAME surface set
 * `publish.ts` drops from the edge cache on a publish — the entity targets come straight from
 * the purge's own resolver (`getTrackEntityPurgeTargets`), not a second query — so IndexNow
 * asks the engines to recrawl exactly what just changed. Exported for the unit test.
 */
export function buildFindingIndexNowUrls(
  logId: string,
  entityTargets: { kind: EntityCacheKind; slug: string }[],
): string[] {
  return [
    ...new Set([
      logPageUrl(logId),
      ...entityTargets.map((target) => entityPurgeUrl(target.kind, target.slug)),
      `${siteUrl}/fresh`,
    ]),
  ];
}

/**
 * Submit a newly published finding's whole surface set to IndexNow — its log page PLUS the
 * graph pages it joins (artist/label/album) and the `/fresh` lens — so every page the publish
 * touched is recrawled within minutes, not just the coordinate page. Best-effort,
 * fire-and-forget: never throws, never blocks the publish — same discipline as
 * `notifyNewFinding` / `lastfmLove`. No-op on a missing/blank logId; a missing trackId simply
 * submits the log page + `/fresh` (no graph pages to resolve).
 */
export function submitFindingToIndexNow(logId?: string, trackId?: string): void {
  if (!logId?.trim()) {
    return;
  }

  const task = ping(logId.trim(), trackId?.trim() || undefined);

  try {
    waitUntil(task);
  } catch {
    // No Worker execution context (outside workerd, e.g. unit tests): the promise
    // still runs; we just don't extend the lifecycle. The catch keeps the publish
    // path clean.
    void task;
  }
}

// The actual POST. NEVER throws — every failure is swallowed so the publish it
// rides behind is never affected. IndexNow answers 200/202 on accept and 4xx on a
// bad key/host; either way a miss is harmless (the next publish or organic recrawl
// covers it), so the outcome is intentionally ignored. Resolving the graph pages is
// part of the same swallow: a failed slug read falls back to the log page + `/fresh`.
async function ping(logId: string, trackId?: string): Promise<void> {
  try {
    const entityTargets = trackId ? await getTrackEntityPurgeTargets(trackId) : [];

    await fetch(INDEXNOW_ENDPOINT, {
      body: JSON.stringify(buildIndexNowPayload(buildFindingIndexNowUrls(logId, entityTargets))),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
  } catch {
    // Side-channel: a submit failure must never fail or delay a publish.
  }
}
