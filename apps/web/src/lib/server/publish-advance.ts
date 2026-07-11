// The render → publish AUTO-ADVANCE — the last autonomy gap in the finding pipeline.
//
// Every step of a finding's life already runs on its own (add → enrich → context note →
// note → observation → render), but publishing needed an operator beat: the render
// conductor finished a video, and then a human tapped Push on the board. This closes that
// gap. A freshly-rendered, READY finding advances into the publish push by itself —
// YouTube Shorts hands-off (a direct PUBLIC upload; nothing left for a human), TikTok to
// the inbox draft the operator still finishes in-app (a platform limit — the licensed
// sound attaches only there — not ours).
//
// THIS AUTOMATES A PUBLIC PUBLISH. A human used to be the last gate before something
// appeared on Fluncle's YouTube channel; this removes that gate. So the module is built
// around four properties, each provable rather than asserted:
//
//   1. NEVER TWICE. The advance only ever picks a finding with NO `social_posts` row for
//      the platform, and it CLAIMS that row (`claimPost` — an atomic
//      `insert … on conflict do nothing` against the (track, platform) unique index)
//      BEFORE any call to Postiz. Two overlapping ticks race on the index; the loser
//      skips. Idempotence is against persisted state, never against a timing assumption.
//
//   2. NEVER HALF-RENDERED. "READY" is defined below (`advanceCandidates` + `bundleGaps`)
//      and gated on, in three layers: the DB says the render FINALIZED with both masters
//      (`video_url` + `video_squared_at` — the two-master layout, so the portrait
//      `footage.social.mp4` both platforms push actually exists); R2 says the whole
//      publishable bundle is SERVED (a HEAD per required object — the server-side mirror
//      of the CLI's `bundle_incomplete` guard, which hard-errors a footage-only upload
//      before any network call; the one path that can bypass it is `--allow-partial`, and
//      this catches that); and the caption is non-empty (an auto-published Short with an
//      empty description is not an artifact we would ship). A settle window on top
//      (`ADVANCE_SETTLE_MS`) means a bad render is still the operator's to requeue before
//      it can go public.
//
//   3. A KILL SWITCH. `publish_advance_paused` on the shared `settings` KV (./settings.ts)
//      — the same shape the clip drip-feed's switch rides, deliberately not a second
//      mechanism. The tick reads it FIRST and no-ops while paused. One flip from
//      `/admin/findings` or `fluncle admin tracks publish-pause` stops every future
//      auto-publish, with no deploy. It ships PAUSED.
//
//   4. FAIL CLOSED, VISIBLY. A failed push leaves the claim row `failed` and is NEVER
//      auto-retried (the advance only picks findings with no row at all). The finding
//      keeps its `post-youtube` / `post-tiktok` row in the `/admin` attention queue — the
//      same row the operator worked before this existed — so a broken auto-publisher
//      degrades into the manual flow instead of silently doing nothing.

import { FOUND_BASE } from "../media";
import { getDb, typedRows } from "./db";
import { getSetting, setSetting } from "./settings";

/** The kill-switch key on the shared `settings` KV. */
export const PUBLISH_ADVANCE_PAUSED_KEY = "publish_advance_paused";

/** The platforms the advance pushes, in push order: YouTube first (the hands-off public
 *  Short — the one that makes the chain autonomous), then the TikTok inbox draft. */
export const ADVANCE_PLATFORMS = ["youtube", "tiktok"] as const;
export type AdvancePlatform = (typeof ADVANCE_PLATFORMS)[number];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * How long a finalized render must SETTLE before it can auto-publish. The bytes are on R2
 * before `finalize_track_video` is ever called (the CLI is presign → PUT each file →
 * finalize), so this is not about the upload landing — it is the operator's window: a
 * render that came out wrong can be requeued (`requeue_video`) inside it and the
 * auto-advance will never have touched it. It also gives Cloudflare's Media
 * Transformations, which the TikTok cut is derived through, time to warm.
 */
export const ADVANCE_SETTLE_MS = 15 * MINUTE_MS;

/** Findings advanced per tick. ONE. A public publish is not something to batch: a bug
 *  gets one shot per tick to be caught, never a burst. */
export const ADVANCE_PER_TICK_CAP = 1;

/**
 * The rolling-24h backstop: at most this many pushes (across both platforms, hand-pushed
 * ones included) may be created in a day. A finding costs two (YouTube + TikTok), so this
 * is ~3 findings/day — comfortably above the render conductor's real output (~1–4/day)
 * and far below anything that could dump the archive onto the feed if a gate broke.
 */
export const ADVANCE_DAILY_PUSH_CAP = 6;

/**
 * TikTok caps UNPUBLISHED inbox drafts at 5 per rolling 24h and bounces the 6th
 * asynchronously — the push "succeeds" and the draft silently never appears. So the
 * advance holds TikTok back once the inbox is full, rather than burning a finding on a
 * draft TikTok will drop. (YouTube keeps flowing; the two platforms gate independently.)
 */
export const TIKTOK_INBOX_DRAFT_CAP = 5;

/**
 * The bundle a finding MUST have publicly served on R2 before it may auto-publish.
 *
 * The two masters — `footage.mp4` (the clean square crop source) and `footage.social.mp4`
 * (the portrait baked-text cut BOTH platforms push; TikTok as an audio-stripped Media
 * Transformation of it) — plus the re-render contract, which is EXACTLY the set the CLI's
 * `bundle_incomplete` guard hard-errors on (`checkBundleCompleteness`, apps/cli track.ts).
 * That guard fires before any network call, so a footage-only bundle normally cannot even
 * reach `finalize` — but `--allow-partial` is a deliberate escape hatch, and a partial
 * bundle must never be something the machine publishes on its own. Checking the same set
 * server-side, against the PUBLIC URLs (which is what Postiz actually pulls from), closes
 * that.
 */
export const REQUIRED_BUNDLE_FILES = [
  "footage.mp4",
  "footage.social.mp4",
  "composition.tsx",
  "props.json",
  "render.json",
] as const;

/**
 * Whether the render → publish auto-advance is paused (the kill switch).
 *
 * DEFAULT-DENY, and note the inversion against the clip drip's switch: only the EXPLICIT
 * string `"false"` means running. An unset key, an empty database, a fresh preview, a
 * value nobody recognises — every one of them reads as PAUSED. This is the property that
 * lets the feature ship dark and stay honest: the machine can publish to Fluncle's public
 * YouTube channel only because an operator deliberately wrote `false` into this row, and
 * anything that loses that row falls back to silence rather than to posting.
 */
export async function isPublishAdvancePaused(): Promise<boolean> {
  return (await getSetting(PUBLISH_ADVANCE_PAUSED_KEY)) !== "false";
}

/** Pause / resume the auto-advance (the kill switch). Pausing halts every future
 *  auto-publish within one tick; nothing else about a finding changes. */
export async function setPublishAdvancePaused(paused: boolean): Promise<void> {
  await setSetting(PUBLISH_ADVANCE_PAUSED_KEY, paused ? "true" : "false");
}

/** A finding the advance may push, and the platforms it has no post row for yet. */
export type AdvanceCandidate = {
  logId: string;
  /** The platforms with NO `social_posts` row — the only ones the advance may touch. */
  pending: AdvancePlatform[];
  title: string;
  trackId: string;
  /** When the render finalized both masters — the settle clock and the queue order. */
  videoSquaredAt: string;
};

type CandidateRow = {
  log_id: string;
  title: string;
  tiktok_posted: number;
  track_id: string;
  video_squared_at: string;
  youtube_posted: number;
};

/**
 * The findings that are READY to auto-advance, oldest render first.
 *
 * The DB half of "ready" (the R2 + caption half is `bundleGaps` / the caption read):
 *   - `log_id is not null`          — every video needs its coordinate.
 *   - `video_url is not null`       — the render FINALIZED (the queue's own done-gate).
 *   - `video_squared_at is not null`— the TWO-MASTER layout: the finalize that set it was
 *     handed BOTH the square `footage.mp4` and the portrait `footage.social.mp4`. A
 *     legacy/footage-only finding has no such signal and is never auto-advanced — the
 *     operator pushes those by hand.
 *   - the settle window has elapsed (`video_squared_at <= cutoff`).
 *   - at least one platform has NO `social_posts` row. The advance NEVER touches a
 *     platform that already has a row — pushed, drafted, published, or `failed`. That is
 *     both the idempotence rule (a published finding can't re-fire) and the fail-closed
 *     rule (a failed push is the operator's, not the machine's, to retry).
 */
export async function advanceCandidates(options: {
  limit: number;
  nowMs: number;
}): Promise<AdvanceCandidate[]> {
  if (options.limit <= 0) {
    return [];
  }

  const cutoff = new Date(options.nowMs - ADVANCE_SETTLE_MS).toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [cutoff, options.limit],
    sql: `select t.track_id, t.log_id, t.title, t.video_squared_at,
                 (yt.track_id is not null) as youtube_posted,
                 (tk.track_id is not null) as tiktok_posted
          from (findings join tracks on tracks.track_id = findings.track_id) t
          left join social_posts yt on yt.track_id = t.track_id and yt.platform = 'youtube'
          left join social_posts tk on tk.track_id = t.track_id and tk.platform = 'tiktok'
          where t.log_id is not null
            and t.video_url is not null
            and t.video_squared_at is not null
            and t.video_squared_at <= ?
            and (yt.track_id is null or tk.track_id is null)
          order by t.video_squared_at asc
          limit ?`,
  });

  return typedRows<CandidateRow>(result.rows).map((row) => {
    const pending: AdvancePlatform[] = [];

    if (!row.youtube_posted) {
      pending.push("youtube");
    }

    if (!row.tiktok_posted) {
      pending.push("tiktok");
    }

    return {
      logId: row.log_id,
      pending,
      title: row.title,
      trackId: row.track_id,
      videoSquaredAt: row.video_squared_at,
    };
  });
}

/**
 * Which required bundle files are NOT publicly served for a finding — empty ⇒ the bundle
 * is complete and Postiz can pull every byte it needs.
 *
 * HEADs the PUBLIC `found.fluncle.com/<logId>/<file>` URLs rather than the `VIDEOS` R2
 * binding, for the `readCaptions` reason and one better one: the public URL is exactly
 * what Postiz fetches, so serving it IS the precondition we care about (an object that
 * exists in the bucket but 404s at the edge would still fail the push). A network error
 * counts as missing — the gate fails CLOSED.
 *
 * `fetchFn` is injectable so the gate is provable without a network.
 */
export async function bundleGaps(logId: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const results = await Promise.all(
    REQUIRED_BUNDLE_FILES.map(async (file): Promise<string | undefined> => {
      try {
        const response = await fetchFn(`${FOUND_BASE}/${encodeURIComponent(logId)}/${file}`, {
          method: "HEAD",
        });

        return response.ok ? undefined : file;
      } catch {
        return file;
      }
    }),
  );

  return results.filter((file): file is string => typeof file === "string");
}

/** Why a candidate/platform was held back this tick — the tick reports these so a stuck
 *  auto-advance says WHY out loud instead of looking like an empty queue. */
export type AdvanceHold =
  | "bundle_incomplete"
  | "daily_cap"
  | "no_caption"
  | "tiktok_inbox_full"
  | "youtube_url_pending";

/** One platform the tick actually pushed. */
export type AdvancePush = {
  externalId: string;
  logId: string;
  platform: AdvancePlatform;
  status: "draft" | "published";
  trackId: string;
};

/** One platform the tick held back, and why. */
export type AdvanceHeld = {
  /** The bundle files still missing (only on `bundle_incomplete`). */
  missing?: string[];
  platform: AdvancePlatform;
  reason: AdvanceHold;
  trackId: string;
};
