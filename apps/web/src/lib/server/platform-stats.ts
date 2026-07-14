// The /reach store — the server side of the public "how far Fluncle reaches" page.
// A NOUN-SWAP of `record_health` (status.ts): a daily on-box trigger fires the
// agent-tier `record_platform_stats` op, the WORKER fetches each platform with the
// auth it already holds, and one append-only `platform_stats` snapshot row lands per
// (platform, metric) per day. Two halves, mirroring status.ts:
//
//   - WRITE (the box cron): `recordPlatformStats` — run the COLLECTOR (every Tier-1
//     platform, each isolated best-effort), then insert its rows with ON CONFLICT(id)
//     DO NOTHING (the idempotent daily snapshot, the record_cost discipline).
//   - READ (the public page): `listPlatformStats(windowDays)` — per (platform, metric)
//     the latest value + the bounded series (last N days), grouped in ONE page read.
//     Bounded + ordered in SQL (the getServiceCheckSamples precedent).
//
// THE COLLECTOR is the noun-swap's other half of `record_health`'s per-probe
// discipline: one fetcher per platform, EACH wrapped so a failure or a missing env
// SKIPS that platform (a logEvent warn + a `{ platform, reason }` skip) and NEVER
// fails the snapshot. Every number collected is already public on its own platform,
// so `platform_stats` is public-safe by construction.
//
// The standardization taxonomy (audience / reach / depth buckets) is deliberately
// NOT stored here — the rows stay raw and the page slice decides how to group them.

import { getDb, typedRows } from "./db";
import { type FetchImpl, readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { getPostizPlatformAnalytics } from "./postiz";
import { countSegmentRecipients } from "./resend";
import { fetchPlaylistFollowerCount } from "./spotify";
import { getTwitchAccessToken, readTwitchClientId } from "./twitch";

// The injectable fetch — the default is the global `fetch`; the tests pass a fake
// that routes by URL, so every collector is unit-testable with zero real network. The
// canonical alias lives in env.ts (a leaf module); re-exported here so its long-standing
// import site (`./platform-stats`) and the fetcher tests keep working.
export type { FetchImpl };

/** One measured number a platform fetcher returns (metric name + integer value). */
export type PlatformMetric = { metric: string; value: number };

/** One row to persist — a (platform, metric) snapshot at `capturedAt`. */
export type PlatformStatRow = {
  capturedAt: string;
  id: string;
  metric: string;
  platform: string;
  value: number;
};

/** A platform whose numbers landed this collect (the metric names written). */
export type CollectedPlatform = { metrics: string[]; platform: string };

/** A platform that was skipped this collect (unconfigured, or a fetch fault). */
export type SkippedPlatform = { platform: string; reason: string };

/** The collector's outcome — the rows to write + the per-platform summary. */
export type PlatformStatsCollection = {
  collected: CollectedPlatform[];
  rows: PlatformStatRow[];
  skipped: SkippedPlatform[];
};

/** What `recordPlatformStats` returns: the summary + the count actually written. */
export type PlatformStatsRecordResult = {
  collected: CollectedPlatform[];
  inserted: number;
  skipped: SkippedPlatform[];
};

// A finding's User-Agent — GitHub REQUIRES one, and the others accept it. Fluncle,
// the curation side-project (mirrors lastfm.ts's USER_AGENT precedent).
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

// The public handles Fluncle is reachable by, per platform. Public IDENTIFIERS, not
// secrets — safe to commit (AGENTS.md: a public runtime identifier grants nothing).
const MIXCLOUD_USER = "fluncle";
const BLUESKY_ACTOR = "fluncle.com";
const GITHUB_REPO = "mauricekleine/fluncle";
const NPM_PACKAGE = "fluncle";
const LASTFM_USER = "fluncle";
const APPSTORE_BUNDLE_ID = "com.fluncle.app";
const YOUTUBE_HANDLE = "@fluncle";

// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Coerce a platform field into a non-negative integer count, THROWING when it is
 * absent or non-numeric (Last.fm/YouTube return counts as STRINGS; Mixcloud/Telegram
 * as numbers, so both are accepted). A throw here is caught by the collector and
 * turned into an honest skip, never a stored garbage number.
 */
export function requireCount(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} is missing or non-numeric`);
  }

  return Math.trunc(parsed);
}

// ── Per-platform collectors (each exported for its unit test) ────────────────
//
// Keyless collectors take the injected `fetchImpl` and are pure fetch+parse. The
// secret/DB-backed ones (lastfm/telegram/youtube read env; spotify/newsletter reuse
// a helper) read their credential inside and throw a clean reason when unconfigured.

/** Mixcloud — GET api.mixcloud.com/<user> (keyless). */
export async function collectMixcloud(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(`https://api.mixcloud.com/${MIXCLOUD_USER}/`);

  if (!response.ok) {
    throw new Error(`Mixcloud responded ${response.status}`);
  }

  const data = (await response.json()) as {
    cloudcast_count?: unknown;
    follower_count?: unknown;
    listen_count?: unknown;
  };

  return [
    { metric: "followers", value: requireCount(data.follower_count, "Mixcloud follower_count") },
    { metric: "listens", value: requireCount(data.listen_count, "Mixcloud listen_count") },
    { metric: "uploads", value: requireCount(data.cloudcast_count, "Mixcloud cloudcast_count") },
  ];
}

/** Bluesky — GET the public AppView getProfile (keyless). */
export async function collectBluesky(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(BLUESKY_ACTOR)}`,
  );

  if (!response.ok) {
    throw new Error(`Bluesky responded ${response.status}`);
  }

  const data = (await response.json()) as { followersCount?: unknown; postsCount?: unknown };

  return [
    { metric: "followers", value: requireCount(data.followersCount, "Bluesky followersCount") },
    { metric: "posts", value: requireCount(data.postsCount, "Bluesky postsCount") },
  ];
}

/**
 * GitHub — GET /repos/{owner}/{repo}. Keyless in principle, but the unauthenticated quota is
 * 60 req/hr PER IP and the Worker egresses from Cloudflare's SHARED pool — other tenants
 * exhaust it constantly (day 2's snapshot missed exactly this way). An optional GITHUB_TOKEN
 * (a fine-grained PAT with public-read only — it grants nothing) lifts the quota to 5,000/hr
 * on Fluncle's own bucket; absent, the keyless attempt still runs and may get lucky.
 */
export async function collectGithub(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const token = await readOptionalEnv("GITHUB_TOKEN");
  const response = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub responded ${response.status}`);
  }

  const data = (await response.json()) as { stargazers_count?: unknown };

  return [
    { metric: "stars", value: requireCount(data.stargazers_count, "GitHub stargazers_count") },
  ];
}

/** npm — GET the last-week downloads point (keyless). */
export async function collectNpm(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(
    `https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`,
  );

  if (!response.ok) {
    throw new Error(`npm responded ${response.status}`);
  }

  const data = (await response.json()) as { downloads?: unknown };

  return [{ metric: "downloads_weekly", value: requireCount(data.downloads, "npm downloads") }];
}

/**
 * App Store — GET the iTunes lookup by bundle id (keyless). Returns `resultCount: 0`
 * until the app is LIVE, which is an honest skip (the app is pending), NOT an error —
 * so a zero result throws the "not live yet" reason the collector records as a skip.
 */
export async function collectAppStore(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const response = await fetchImpl(
    `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APPSTORE_BUNDLE_ID)}`,
  );

  if (!response.ok) {
    throw new Error(`App Store responded ${response.status}`);
  }

  const data = (await response.json()) as {
    resultCount?: number;
    results?: { userRatingCount?: unknown }[];
  };

  if (!data.resultCount || data.resultCount === 0 || !data.results?.[0]) {
    throw new Error("App Store app is not live yet (resultCount 0)");
  }

  return [
    {
      metric: "rating_count",
      value: requireCount(data.results[0].userRatingCount, "App Store userRatingCount"),
    },
  ];
}

/**
 * Last.fm — two public reads (only `api_key`, no session/signing): `user.getInfo`
 * → playcount (scrobbles), `user.getLovedTracks` → @attr.total (loved_tracks). Skips
 * cleanly when LASTFM_API_KEY is unset.
 */
export async function collectLastfm(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const apiKey = await readOptionalEnv("LASTFM_API_KEY");

  if (!apiKey) {
    throw new Error("LASTFM_API_KEY is not set");
  }

  const root = "https://ws.audioscrobbler.com/2.0/";
  const infoResponse = await fetchImpl(
    `${root}?method=user.getinfo&user=${LASTFM_USER}&api_key=${encodeURIComponent(apiKey)}&format=json`,
    { headers: { "User-Agent": USER_AGENT } },
  );

  if (!infoResponse.ok) {
    throw new Error(`Last.fm user.getInfo responded ${infoResponse.status}`);
  }

  const info = (await infoResponse.json()) as { user?: { playcount?: unknown } };

  const lovedResponse = await fetchImpl(
    `${root}?method=user.getlovedtracks&user=${LASTFM_USER}&api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`,
    { headers: { "User-Agent": USER_AGENT } },
  );

  if (!lovedResponse.ok) {
    throw new Error(`Last.fm user.getLovedTracks responded ${lovedResponse.status}`);
  }

  const loved = (await lovedResponse.json()) as {
    lovedtracks?: { "@attr"?: { total?: unknown } };
  };

  return [
    { metric: "scrobbles", value: requireCount(info.user?.playcount, "Last.fm playcount") },
    {
      metric: "loved_tracks",
      value: requireCount(loved.lovedtracks?.["@attr"]?.total, "Last.fm loved @attr.total"),
    },
  ];
}

/**
 * Telegram — Bot API getChatMemberCount for the channel. Records the RAW count (no
 * −1 for the bot itself; honesty lives in the data, display decisions in the page).
 * Skips cleanly when the bot token / channel id are unset.
 */
export async function collectTelegram(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const token = await readOptionalEnv("TELEGRAM_BOT_TOKEN");
  const channelId = await readOptionalEnv("TELEGRAM_CHANNEL_ID");

  if (!token || !channelId) {
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID are not set");
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${token}/getChatMemberCount?chat_id=${encodeURIComponent(channelId)}`,
  );

  if (!response.ok) {
    throw new Error(`Telegram responded ${response.status}`);
  }

  const data = (await response.json()) as { ok?: boolean; result?: unknown };

  if (!data.ok) {
    throw new Error("Telegram getChatMemberCount returned ok:false");
  }

  return [{ metric: "audience", value: requireCount(data.result, "Telegram member count") }];
}

/**
 * Newsletter — reuse `countSegmentRecipients` (the Resend segment size), the only
 * reach read that already existed. It returns null on any failure (incl. an unset
 * segment id), which is a clean skip.
 */
export async function collectNewsletter(): Promise<PlatformMetric[]> {
  const count = await countSegmentRecipients();

  if (count === null) {
    throw new Error("newsletter recipient count is unavailable");
  }

  return [{ metric: "audience", value: requireCount(count, "newsletter recipient count") }];
}

/**
 * Spotify — the playlist's saved/follower count (`fetchPlaylistFollowerCount`, the
 * one number that survived the Feb-2026 gutting). Throws (→ skip) when the playlist
 * id is unset or `spotify_auth` is disconnected.
 */
export async function collectSpotifyPlaylist(): Promise<PlatformMetric[]> {
  const total = await fetchPlaylistFollowerCount();

  return [{ metric: "playlist_saves", value: requireCount(total, "Spotify followers.total") }];
}

/**
 * YouTube — Data API v3 channels.list?part=statistics with a PLAIN key (not OAuth;
 * the stats are public). `forHandle=@fluncle` resolves the channel and returns its
 * statistics in one call → subscriberCount, viewCount. Env-gated: no key → skip.
 */
export async function collectYoutube(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const key = await readOptionalEnv("YOUTUBE_API_KEY");

  if (!key) {
    throw new Error("YOUTUBE_API_KEY is not set");
  }

  const response = await fetchImpl(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=${encodeURIComponent(YOUTUBE_HANDLE)}&key=${encodeURIComponent(key)}`,
  );

  if (!response.ok) {
    throw new Error(`YouTube responded ${response.status}`);
  }

  const data = (await response.json()) as {
    items?: { statistics?: { subscriberCount?: unknown; viewCount?: unknown } }[];
  };
  const statistics = data.items?.[0]?.statistics;

  if (!statistics) {
    throw new Error("YouTube channels.list returned no channel for the handle");
  }

  return [
    {
      metric: "subscribers",
      value: requireCount(statistics.subscriberCount, "YouTube subscriberCount"),
    },
    { metric: "views", value: requireCount(statistics.viewCount, "YouTube viewCount") },
  ];
}

// ── Tier-2 collectors (user-OAuth, docs/reach-tier2-activation.md) ───────────
//
// Each reads a durable token minted server-side by its `get<Platform>AccessToken`
// helper (twitch/tiktok/instagram.ts) — DORMANT until the operator connects, so an
// absent env or an unconnected token throws a clean reason the collector turns into an
// honest `{ platform, reason }` skip. The DB-free PARSE half of each is a separate
// exported function (token + fetch injected) so it is unit-testable with zero network.

/**
 * Twitch — the follower TOTAL via Helix, given the broadcaster's own user token +
 * the app's client id. Two reads: `/helix/users` (resolve the authenticated
 * broadcaster's id) then `/helix/channels/followers?broadcaster_id=…` → `total`. Pure
 * fetch+parse; the registry wrapper supplies the token + client id.
 */
export async function collectTwitchFollowers(
  fetchImpl: FetchImpl,
  accessToken: string,
  clientId: string,
): Promise<PlatformMetric[]> {
  const headers = { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId };
  const usersResponse = await fetchImpl("https://api.twitch.tv/helix/users", { headers });

  if (!usersResponse.ok) {
    throw new Error(`Twitch users responded ${usersResponse.status}`);
  }

  const users = (await usersResponse.json()) as { data?: { id?: unknown }[] };
  const broadcasterId = users.data?.[0]?.id;

  if (typeof broadcasterId !== "string" || broadcasterId.length === 0) {
    throw new Error("Twitch users returned no broadcaster id");
  }

  const followersResponse = await fetchImpl(
    `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    { headers },
  );

  if (!followersResponse.ok) {
    throw new Error(`Twitch channels/followers responded ${followersResponse.status}`);
  }

  const data = (await followersResponse.json()) as { total?: unknown };

  return [{ metric: "followers", value: requireCount(data.total, "Twitch followers total") }];
}

/** Twitch registry wrapper — supplies the stored token + the app client id. */
export async function collectTwitch(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const [accessToken, clientId] = await Promise.all([getTwitchAccessToken(), readTwitchClientId()]);

  return collectTwitchFollowers(fetchImpl, accessToken, clientId);
}

/**
 * Map a Postiz analytics payload's platform-dependent LABELS onto reach metric names —
 * the shared parse half of the two Postiz-backed collectors, pure + unit-testable. A label
 * Postiz stops sending degrades to a missing metric (never a wrong one), and an entirely
 * empty result throws so the collector records an honest skip instead of a hollow row.
 */
export function mapPostizMetrics(
  metrics: { label: string; latestTotal: number }[],
  labelMap: Record<string, string>,
  platform: string,
): PlatformMetric[] {
  const out: PlatformMetric[] = [];

  for (const entry of metrics) {
    const metric = labelMap[entry.label];

    if (metric && entry.latestTotal >= 0) {
      out.push({ metric, value: entry.latestTotal });
    }
  }

  if (out.length === 0) {
    throw new Error(`${platform}: no mapped metrics in the Postiz analytics payload`);
  }

  return out;
}

/**
 * TikTok — via POSTIZ platform analytics (the account is already connected there for the
 * publish drafts, and Postiz exposes MORE than TikTok's own Display API would have:
 * followers + total likes + total views, no TikTok developer app, no scope review). The
 * 2026-07-14 live probe's labels: "Followers" / "Total Likes" / "Views" (plus
 * Following/Videos/Recent-* — deliberately unmapped: the reach page tracks audience and
 * carry, not the posting cadence). Supersedes the retired TikTok user-OAuth leg.
 */
export async function collectTiktok(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const metrics = await getPostizPlatformAnalytics(["tiktok"], 7, fetchImpl);

  return mapPostizMetrics(
    metrics,
    { Followers: "followers", "Total Likes": "likes", Views: "views" },
    "tiktok",
  );
}

/**
 * Instagram — via POSTIZ platform analytics. The standalone-Instagram connection exposes
 * ENGAGEMENT only (Reach/Views/Likes/Saves — the 2026-07-14 live probe), NOT a follower
 * count, so the reach page carries Instagram's `views` and the audience number stays absent
 * (honest) until the dormant Instagram-Login OAuth leg (instagram.ts + its auth routes) is
 * ever activated through Meta's business verification — see docs/reach-tier2-activation.md.
 */
export async function collectInstagram(fetchImpl: FetchImpl): Promise<PlatformMetric[]> {
  const metrics = await getPostizPlatformAnalytics(
    ["instagram-standalone", "instagram"],
    7,
    fetchImpl,
  );

  return mapPostizMetrics(metrics, { Views: "views" }, "instagram");
}

// The registry — the drain order is stable so the collect summary reads the
// same each run. A keyless collector takes `fetchImpl`; the module-backed ones
// ignore it (they route through a helper), which is why the signature is uniform.
type PlatformFetcher = {
  collect: (fetchImpl: FetchImpl) => Promise<PlatformMetric[]>;
  platform: string;
};

const PLATFORM_FETCHERS: PlatformFetcher[] = [
  { collect: collectMixcloud, platform: "mixcloud" },
  { collect: collectBluesky, platform: "bluesky" },
  { collect: collectGithub, platform: "github" },
  { collect: collectNpm, platform: "npm" },
  { collect: collectLastfm, platform: "lastfm" },
  { collect: collectAppStore, platform: "appstore" },
  { collect: collectTelegram, platform: "telegram" },
  { collect: () => collectNewsletter(), platform: "newsletter" },
  { collect: () => collectSpotifyPlaylist(), platform: "spotify_playlist" },
  { collect: collectYoutube, platform: "youtube" },
  // Postiz-backed (the accounts are connected there for publishing; analytics ride the
  // same POSTIZ_API_KEY — read-only, one integrations lookup + one analytics read each).
  { collect: collectTiktok, platform: "tiktok" },
  { collect: collectInstagram, platform: "instagram" },
  // Tier-2 (user-OAuth, DORMANT until the operator connects — skips cleanly while
  // its token/env is absent). See docs/reach-tier2-activation.md.
  { collect: collectTwitch, platform: "twitch" },
];

/**
 * Run every Tier-1 platform fetcher, EACH isolated best-effort: a failure or a
 * missing env skips THAT platform (a logEvent warn + a `{ platform, reason }` skip)
 * and never fails the whole snapshot — the healthcheck's per-probe discipline. The
 * `id` is the client-stable `${platform}:${metric}:${yyyy-mm-dd}` (the day derived
 * from `at`), so a second collect the same UTC day re-inserts the same ids and is
 * ignored. Sequential on purpose — a daily cron, not a hot path.
 */
export async function collectPlatformStats(
  options: { at?: string; fetchImpl?: FetchImpl } = {},
): Promise<PlatformStatsCollection> {
  const at = options.at ?? new Date().toISOString();
  const day = at.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;

  const rows: PlatformStatRow[] = [];
  const collected: CollectedPlatform[] = [];
  const skipped: SkippedPlatform[] = [];

  for (const { collect, platform } of PLATFORM_FETCHERS) {
    try {
      const metrics = await collect(fetchImpl);

      if (metrics.length === 0) {
        logEvent("warn", "platform-stats.collect-empty", { platform });
        skipped.push({ platform, reason: "no metrics returned" });
        continue;
      }

      for (const metric of metrics) {
        rows.push({
          capturedAt: at,
          id: `${platform}:${metric.metric}:${day}`,
          metric: metric.metric,
          platform,
          value: metric.value,
        });
      }

      collected.push({ metrics: metrics.map((metric) => metric.metric), platform });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logEvent("warn", "platform-stats.collect-skipped", { error, platform });
      skipped.push({ platform, reason });
    }
  }

  return { collected, rows, skipped };
}

/**
 * Append snapshot rows IDEMPOTENTLY — one multi-row `insert … on conflict(id) do
 * nothing`, returning the count ACTUALLY written (a same-day retry lands zero). The
 * `insertCostEvents` shape.
 */
export async function insertPlatformStats(rows: PlatformStatRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const db = await getDb();
  const placeholders = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const args: (number | string)[] = [];

  for (const row of rows) {
    args.push(row.id, row.platform, row.metric, row.value, row.capturedAt);
  }

  const result = await db.execute({
    args,
    sql: `insert into platform_stats (id, platform, metric, value, captured_at)
            values ${placeholders}
            on conflict(id) do nothing`,
  });

  return result.rowsAffected;
}

/**
 * Collect one snapshot and persist it. Runs the collector (Worker-side, every
 * platform best-effort), inserts its rows idempotently, and returns the per-platform
 * summary + the count written — the `record_platform_stats` handler's body.
 */
export async function recordPlatformStats(
  options: { at?: string; fetchImpl?: FetchImpl } = {},
): Promise<PlatformStatsRecordResult> {
  const collection = await collectPlatformStats(options);
  const inserted = await insertPlatformStats(collection.rows);

  return { collected: collection.collected, inserted, skipped: collection.skipped };
}

// ── The public read (`/reach`) ───────────────────────────────────────────────

/** One point in a metric's series (a day's captured value). */
export type PlatformStatPoint = { capturedAt: string; value: number };

/** One (platform, metric) series: the latest value + the bounded day-by-day points. */
export type PlatformStatSeries = {
  latest: number;
  latestAt: string;
  metric: string;
  platform: string;
  points: PlatformStatPoint[];
};

/** The whole page read — every series within the window. */
export type PlatformStatsView = {
  series: PlatformStatSeries[];
  windowDays: number;
};

// The default page window — a season of daily snapshots, bounded so the read stays
// small (≈ 14 metrics × 90 days).
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;

/** One stored row as `platform_stats` returns it. */
type PlatformStatDbRow = {
  captured_at: string;
  metric: string;
  platform: string;
  value: number;
};

/**
 * The page read: every snapshot within the window, ORDERED in SQL by
 * (platform, metric, captured_at) so the grouping and each series' chronology fall
 * straight out of the scan — no arithmetic, no whole-column pull (the
 * getServiceCheckSamples precedent). Grouped in one pass into per-(platform, metric)
 * series, each carrying its bounded points + the latest (last, i.e. max captured_at)
 * value. Bounded by the window, so the read stays small as the ledger grows.
 */
export async function listPlatformStats(windowDays?: number): Promise<PlatformStatsView> {
  const window = clampWindow(windowDays);
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();

  const result = await db.execute({
    args: [since],
    sql: `select platform, metric, value, captured_at
            from platform_stats
           where captured_at >= ?
           order by platform asc, metric asc, captured_at asc`,
  });

  const byKey = new Map<string, PlatformStatSeries>();

  for (const row of typedRows<PlatformStatDbRow>(result.rows)) {
    const key = `${row.platform}:${row.metric}`;
    const point: PlatformStatPoint = { capturedAt: row.captured_at, value: row.value };
    const existing = byKey.get(key);

    if (existing) {
      existing.points.push(point);
      // Rows arrive captured_at ASC, so the last one seen is the latest.
      existing.latest = row.value;
      existing.latestAt = row.captured_at;
    } else {
      byKey.set(key, {
        latest: row.value,
        latestAt: row.captured_at,
        metric: row.metric,
        platform: row.platform,
        points: [point],
      });
    }
  }

  return { series: [...byKey.values()], windowDays: window };
}

/** Clamp the requested window to a sane bounded range (default 90, max 365). */
function clampWindow(windowDays?: number): number {
  if (typeof windowDays !== "number" || !Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_WINDOW_DAYS;
  }

  return Math.min(Math.trunc(windowDays), MAX_WINDOW_DAYS);
}
