import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const SERVER_DIR = import.meta.dirname;

const SETTINGS_INVENTORY = {
  "anchor-apify.ts": [
    "anchor_apify_daily_rows",
    "anchor_apify_disabled_at",
    "anchor_apify_enabled",
  ],
  "anchor-spotify-search.ts": ["anchor_spotify_search_enabled"],
  "apple-breaker.ts": [
    "apple_auth_breaker_failures",
    "apple_auth_breaker_tripped_at",
    "apple_calls_window_count",
    "apple_calls_window_start",
  ],
  "capture-budget.ts": [
    "catalogue_capture_daily_bytes",
    "catalogue_capture_daily_tracks",
    "catalogue_capture_paused",
  ],
  "catalogue.ts": [
    "catalogue_affinity_cache",
    "catalogue_rank_state_cache",
    "catalogue_summary_cache",
  ],
  "clip-social.ts": ["clip_drip_paused"],
  "crawl-cutover.ts": ["crawl_box_fetch_enabled", "crawl_due_cutover_enabled"],
  "crawl-plausibility.ts": ["crawl_plausibility_hold_enabled"],
  "due-work-cutover.ts": ["track_work_due_cutover_enabled"],
  "env.ts": ["admin_grant_epoch"],
  "follow-digest.ts": ["follow_digest_paused"],
  "frontier-playlist.ts": ["frontier.minting"],
  "health-receipt-cutover.ts": ["health_snapshot_receipts_enabled"],
  "label-outliers.ts": ["label_outliers_last_run"],
  "logbook-echo.ts": ["logbook_echo_max_overlap", "logbook_echo_min_phrase_words"],
  "note-rejections.ts": ["note_echo_max_overlap", "note_echo_min_phrase_words"],
  "observation-rejections.ts": [
    "observation_echo_max_overlap",
    "observation_echo_min_phrase_words",
  ],
  "public-projection-cutover.ts": ["public_projection_cutover_enabled"],
  "publish-advance.ts": ["publish_advance_paused"],
  "sonar.ts": [
    "sonar_artists_enabled",
    "sonar_log_enabled",
    "sonar_mix_enabled",
    "sonar_recs_catalogue_enabled",
    "sonar_recs_enabled",
    "sonar_sonic_enabled",
    "sonar_track_enabled",
  ],
  "spotify-anchor-breaker.ts": [
    "spotify_anchor_breaker_failures",
    "spotify_anchor_breaker_last_failure_at",
    "spotify_anchor_breaker_reason",
    "spotify_anchor_breaker_tripped_at",
  ],
  "spotify-budget.ts": [
    "anchor_spotify_daily_calls",
    "artist_spotify_daily_calls",
    "public_search_spotify_daily_calls",
    "spotify_quota_hold_until",
  ],
  "telescope-playlist.ts": ["telescope.last_mirror", "telescope.spotify_playlist_id"],
  "turso-usage.ts": ["turso_usage_alert_threshold_usd"],
} as const satisfies Record<string, readonly string[]>;

type SettingUsage = {
  operation: "deleteSetting" | "getSetting" | "getSettings" | "setSetting";
  source: string;
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "settings.ts"
    ) {
      files.push(path);
    }
  }

  return files;
}

function collectSettingUsage(): {
  unresolved: string[];
  usage: Map<string, SettingUsage[]>;
} {
  const unresolved: string[] = [];
  const usage = new Map<string, SettingUsage[]>();

  const files = sourceFiles(SERVER_DIR);
  const exportedConstants = new Map<string, string>();
  const exportedLists = new Map<string, string>();
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(.*?)\2/g,
    )) {
      if (match[1] && match[3] !== undefined) {
        exportedConstants.set(match[1], match[3]);
      }
    }
    const localConstants = new Map<string, string>();
    for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(.*?)\2/g)) {
      if (match[1] && match[3] !== undefined) {
        localConstants.set(match[1], match[3]);
      }
    }
    for (const match of source.matchAll(
      /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(\[[\s\S]*?\])/g,
    )) {
      if (match[1] && match[2]) {
        exportedLists.set(
          match[1],
          match[2].replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => {
            const value = localConstants.get(name);
            return value === undefined ? name : JSON.stringify(value);
          }),
        );
      }
    }
  }

  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const constants = new Map(exportedConstants);
    const lists = new Map(exportedLists);
    const constantPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(.*?)\2/g;

    for (const match of source.matchAll(constantPattern)) {
      const name = match[1];
      const value = match[3];

      if (name && value !== undefined) {
        constants.set(name, value);
      }
    }

    for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(\[[\s\S]*?\])/g)) {
      if (match[1] && match[2]) {
        lists.set(match[1], match[2]);
      }
    }

    const resolveKeys = (argument: string): Array<string | undefined> => {
      const list = argument.startsWith("[") ? argument : lists.get(argument);
      if (list !== undefined) {
        return list
          .slice(1, -1)
          .split(",")
          .filter((item) => item.trim())
          .flatMap((item) => resolveKeys(item.trim().replace(/^\.\.\./, "")));
      }
      return [argument.match(/^(["'])(.*?)\1$/)?.[2] ?? constants.get(argument)];
    };
    const callPattern =
      /\b(deleteSetting|getSetting|getSettings|setSetting)\(\s*(\[[\s\S]*?\]|[^,\n)]+)/g;

    for (const match of source.matchAll(callPattern)) {
      const operation = match[1] as SettingUsage["operation"] | undefined;
      const argument = match[2]?.trim();

      if (!operation || !argument) {
        continue;
      }

      const sourceName = relative(SERVER_DIR, path);
      for (const key of resolveKeys(argument)) {
        if (!key) {
          unresolved.push(`${sourceName}: ${operation}(${argument})`);
          continue;
        }
        const entries = usage.get(key) ?? [];
        entries.push({ operation, source: sourceName });
        usage.set(key, entries);
      }
    }
  }

  return { unresolved, usage };
}

describe("settings inventory drift", () => {
  it("keeps the executable inventory and every scalar and batched settings call in lockstep", () => {
    const { unresolved, usage } = collectSettingUsage();
    const registered = new Map<string, string>();

    for (const [owner, keys] of Object.entries(SETTINGS_INVENTORY)) {
      for (const key of keys) {
        registered.set(key, owner);
      }
    }

    const orphaned = [...registered.keys()].filter((key) => !usage.has(key)).sort();
    const unregistered = [...usage.keys()].filter((key) => !registered.has(key)).sort();
    const wrongOwner = [...registered.entries()]
      .flatMap(([key, owner]) =>
        (usage.get(key) ?? [])
          .filter(({ operation, source }) => {
            const sharedGateBatch =
              operation === "getSettings" &&
              source === "anchor-spotify-search.ts" &&
              (owner === "spotify-anchor-breaker.ts" ||
                key === "spotify_quota_hold_until" ||
                key === "anchor_spotify_daily_calls");
            return basename(source) !== owner && !sharedGateBatch;
          })
          .map(({ source }) => `${key}: registered to ${owner}, used by ${source}`),
      )
      .sort();

    expect(
      unresolved,
      "Every settings call must resolve to literal keys or constant key lists",
    ).toEqual([]);
    expect(orphaned, "Registered settings keys with no reader and no writer").toEqual([]);
    expect(unregistered, "Settings keys used by code but missing from the inventory").toEqual([]);
    expect(wrongOwner, "Settings keys used outside their registered owner module").toEqual([]);
    expect(registered.size).toBe(50);
    expect(Object.keys(SETTINGS_INVENTORY)).toHaveLength(24);
  });
});
