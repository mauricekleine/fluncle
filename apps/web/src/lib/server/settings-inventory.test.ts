import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const SERVER_DIR = import.meta.dirname;

// The settings.ts register, made executable. Adding a key is a two-sided change:
// its module must call get/set/delete, and this inventory must name the owner.
// A registered key with no reader or writer is an orphan; an unregistered key in
// code is inventory drift. Both fail the build.
const SETTINGS_INVENTORY = {
  "anchor-apify.ts": ["anchor_apify_disabled_at", "anchor_apify_enabled"],
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
  "due-work-cutover.ts": ["track_work_due_cutover_enabled"],
  "env.ts": ["admin_grant_epoch"],
  "frontier-playlist.ts": ["frontier.minting"],
  "logbook-echo.ts": ["logbook_echo_max_overlap", "logbook_echo_min_phrase_words"],
  "note-rejections.ts": ["note_echo_max_overlap", "note_echo_min_phrase_words"],
  "observation-rejections.ts": [
    "observation_echo_max_overlap",
    "observation_echo_min_phrase_words",
  ],
  "publish-advance.ts": ["publish_advance_paused"],
  "sonar.ts": [
    "sonar_artists_enabled",
    "sonar_log_enabled",
    "sonar_mix_enabled",
    "sonar_recs_catalogue_enabled",
    "sonar_recs_enabled",
    "sonar_sonic_enabled",
  ],
  "spotify-anchor-breaker.ts": [
    "spotify_anchor_breaker_failures",
    "spotify_anchor_breaker_last_failure_at",
    "spotify_anchor_breaker_reason",
    "spotify_anchor_breaker_tripped_at",
  ],
  "spotify-budget.ts": ["spotify_calls_window_count", "spotify_calls_window_start"],
  "telescope-playlist.ts": ["telescope.last_mirror", "telescope.spotify_playlist_id"],
} as const satisfies Record<string, readonly string[]>;

type SettingUsage = {
  operation: "deleteSetting" | "getSetting" | "setSetting";
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

  for (const path of sourceFiles(SERVER_DIR)) {
    const source = readFileSync(path, "utf8");
    const constants = new Map<string, string>();
    const constantPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(.*?)\2/g;

    for (const match of source.matchAll(constantPattern)) {
      const name = match[1];
      const value = match[3];

      if (name && value !== undefined) {
        constants.set(name, value);
      }
    }

    const callPattern = /\b(deleteSetting|getSetting|setSetting)\(\s*([^,\n)]+)/g;

    for (const match of source.matchAll(callPattern)) {
      const operation = match[1] as SettingUsage["operation"] | undefined;
      const argument = match[2]?.trim();

      if (!operation || !argument) {
        continue;
      }

      const literal = argument.match(/^(["'])(.*?)\1$/)?.[2];
      const key = literal ?? constants.get(argument);
      const sourceName = relative(SERVER_DIR, path);

      if (!key) {
        unresolved.push(`${sourceName}: ${operation}(${argument})`);
        continue;
      }

      const entries = usage.get(key) ?? [];
      entries.push({ operation, source: sourceName });
      usage.set(key, entries);
    }
  }

  return { unresolved, usage };
}

describe("settings inventory drift", () => {
  it("keeps the executable inventory and every get/set/delete call in lockstep", () => {
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
          .filter(({ source }) => basename(source) !== owner)
          .map(({ source }) => `${key}: registered to ${owner}, used by ${source}`),
      )
      .sort();

    expect(unresolved, "Every settings call must use a literal or same-file constant").toEqual([]);
    expect(orphaned, "Registered settings keys with no reader and no writer").toEqual([]);
    expect(unregistered, "Settings keys used by code but missing from the inventory").toEqual([]);
    expect(wrongOwner, "Settings keys used outside their registered owner module").toEqual([]);
    expect(registered.size).toBe(38);
    expect(Object.keys(SETTINGS_INVENTORY)).toHaveLength(17);
  });
});
