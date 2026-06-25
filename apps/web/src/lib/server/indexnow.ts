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
 * Submit a newly published finding's log page to IndexNow. Best-effort,
 * fire-and-forget: never throws, never blocks the publish — same discipline as
 * `notifyNewFinding` / `lastfmLove`. No-op on a missing/blank logId.
 */
export function submitFindingToIndexNow(logId?: string): void {
  if (!logId?.trim()) {
    return;
  }

  const task = ping(logPageUrl(logId.trim()));

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
// covers it), so the outcome is intentionally ignored.
async function ping(url: string): Promise<void> {
  try {
    await fetch(INDEXNOW_ENDPOINT, {
      body: JSON.stringify(buildIndexNowPayload([url])),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
  } catch {
    // Side-channel: a submit failure must never fail or delay a publish.
  }
}
