import { waitUntil } from "cloudflare:workers";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { type EntityCacheKind, entityPurgeUrl } from "./edge-cache";
import { getTrackEntityPurgeTargets } from "./entity-cache-purge";

export const INDEXNOW_KEY = "8337c1b41068549f248bf56f1fc465df";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

const INDEXNOW_HOST = new URL(siteUrl).host;

type IndexNowPayload = {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
};

export function buildIndexNowPayload(urlList: string[]): IndexNowPayload {
  return {
    host: INDEXNOW_HOST,
    key: INDEXNOW_KEY,
    keyLocation: `${siteUrl}/${INDEXNOW_KEY}.txt`,
    urlList,
  };
}

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

export function submitFindingToIndexNow(logId?: string, trackId?: string): void {
  if (!logId?.trim()) {
    return;
  }

  const task = ping(logId.trim(), trackId?.trim() || undefined);

  try {
    waitUntil(task);
  } catch {
    void task;
  }
}

async function ping(logId: string, trackId?: string): Promise<void> {
  try {
    const entityTargets = trackId ? await getTrackEntityPurgeTargets(trackId) : [];

    await fetch(INDEXNOW_ENDPOINT, {
      body: JSON.stringify(buildIndexNowPayload(buildFindingIndexNowUrls(logId, entityTargets))),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
  } catch {}
}
