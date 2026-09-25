import { env, waitUntil } from "cloudflare:workers";
import { videoPurgeUrls } from "../media";
import { clipPurgeUrls } from "../studio-clips";
import { logEvent } from "./log";

const CLOUDFLARE_PURGE_MAX_FILES = 30;

export function purgeVideoCache(
  logId: string | null | undefined,
  squared: boolean,
  version?: number,
): void {
  if (!logId?.trim()) {
    return;
  }

  fireAndForget(
    logId.trim(),
    purgeFiles(logId.trim(), videoPurgeUrls(logId.trim(), { squared, version })),
  );
}

export function purgeClipCache(clipId: string | null | undefined, version?: number): void {
  if (!clipId?.trim()) {
    return;
  }

  fireAndForget(clipId.trim(), purgeFiles(clipId.trim(), clipPurgeUrls(clipId.trim(), version)));
}

function fireAndForget(label: string, task: Promise<void>): void {
  try {
    waitUntil(task);
  } catch {
    void task;
  }

  void label;
}

async function purgeFiles(label: string, files: string[]): Promise<void> {
  const zoneId = readPurgeBinding("CF_CACHE_PURGE_ZONE_ID");
  const token = readPurgeBinding("CF_CACHE_PURGE_TOKEN");

  if (!zoneId || !token) {
    logEvent("warn", "video-cache.purge-skipped-no-token", { label });

    return;
  }

  if (files.length === 0) {
    return;
  }

  for (let i = 0; i < files.length; i += CLOUDFLARE_PURGE_MAX_FILES) {
    const chunk = files.slice(i, i + CLOUDFLARE_PURGE_MAX_FILES);

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
        {
          body: JSON.stringify({ files: chunk }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );

      if (!response.ok) {
        logEvent("warn", "video-cache.purge-request-failed", {
          label,
          status: response.status,
          urlCount: chunk.length,
        });
      }
    } catch (error) {
      logEvent("warn", "video-cache.purge-error", { error, label });
    }
  }
}

function readPurgeBinding(
  key: "CF_CACHE_PURGE_ZONE_ID" | "CF_CACHE_PURGE_TOKEN",
): string | undefined {
  const value = (env as unknown as Record<string, string | undefined>)[key];

  return value?.trim() ? value : undefined;
}
