// The `admin-social` domain router module — a finding's per-platform publication
// control plane. Each handler reuses the live `/api/admin/tracks/*/social/*`
// route logic verbatim; the auth tier moves to the oRPC procedure middleware
// (../orpc-auth), and the `draft` route's field-level operator guard reads
// `context.role` in-handler.
//
//   - `list_track_social` — admin tier (live `requireAdmin`): `adminAuth` only.
//   - `update_track_social` — operator tier (live `requireOperator`): `adminAuth`
//     + `operatorGuard`.
//   - `draft_track_social` — admin tier (`adminAuth`) WITH a field-level operator
//     guard for `youtube`: the live route runs `requireAdmin`, then for youtube
//     additionally `requireOperator`. Ported VERBATIM: the in-handler check reads
//     `context.role`, so a youtube push by the agent is a 403 (the order matches
//     the live route — the `unsupported_platform` check runs BEFORE the operator
//     gate, the track lookup AFTER it). After the operator gate, a YouTube push
//     also passes the push gate (`hasPostAwaitingUrl("youtube")` → 409
//     `youtube_url_pending`): exactly one YouTube upload may be pending its URL,
//     so the post-push capture stays unambiguous. On a successful push the live
//     URL is auto-resolved (`resolveSocialUrl`: YouTube builds the canonical
//     `…/shorts/<id>` form from the videoId Postiz auto-populates on the published
//     post; TikTok builds it from the `/missing` native aweme id) and recorded
//     (`recordPostUrl`), and the Postiz
//     release-id is linked for analytics; a miss leaves `url` null for the capture
//     sweep (below) or the operator's manual "Update URL" fallback.
//   - `capture_post_urls` — admin tier: the polling SWEEP. Drains the "pushed but
//     no URL" backlog across youtube + tiktok via `resolveSocialUrl` (YouTube's
//     canonical `…/shorts/<id>` from the videoId / TikTok's `/missing` aweme id),
//     recording each
//     url, linking the release-id, and flipping a captured TikTok `draft` →
//     `published`. The box capture cron drives this.

import { ORPCError } from "@orpc/server";
import { trackMedia, videoAudioStripped, videoVersion } from "../../media";
import { readCaptions } from "../captions";
import { logEvent } from "../log";
import { captionForPlatform } from "../mentions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { postizSetReleaseId, pushTikTokDraft, pushYouTubeShort, resolveSocialUrl } from "../postiz";
import {
  ADVANCE_DAILY_PUSH_CAP,
  ADVANCE_PER_TICK_CAP,
  type AdvanceHeld,
  type AdvancePlatform,
  type AdvancePush,
  advanceCandidates,
  bundleGaps,
  DAY_MS,
  isPublishAdvancePaused,
  setPublishAdvancePaused,
  TIKTOK_INBOX_DRAFT_CAP,
} from "../publish-advance";
import {
  claimPost,
  countPushesSince,
  countTikTokInboxDrafts,
  hasPostAwaitingUrl,
  isUrlClaimedByOtherTrack,
  listPostsAwaitingUrl,
  listSocialPosts,
  recordPostUrl,
  type SocialStatusUpdate,
  updateSocialStatus,
  upsertPost,
} from "../social";
import { parseLimit, requireTrack, type Implementer, toFault } from "./_shared";

// Ported verbatim from the live draft route. TikTok is the SELF_ONLY inbox draft
// (agent-allowed); YouTube is the direct PUBLIC upload (operator only).
const SUPPORTED = new Set(["tiktok", "youtube"]);

/** The minimum a push needs to know about a finding — shared by the operator's manual
 *  `draft_track_social` and the `advance_publish_queue` tick, so the two can never drift
 *  on WHICH cut goes to WHICH platform. */
type PushTarget = {
  logId: string;
  title: string;
  trackId: string;
  /** Set ⇒ the two-master layout: the portrait baked-text `footage.social.mp4` exists. */
  videoSquaredAt?: string;
};

/**
 * Push one finding's video to one platform. The PLAYABLE portrait cut both platforms
 * push: under the two-master layout (videoSquaredAt set) that is the baked-text
 * `footage.social.mp4` — `footage.mp4` is the clean square crop source. A legacy finding
 * (no signal) keeps pushing `footage.mp4`. TikTok takes it audio-stripped (the licensed
 * sound attaches in-app) and lands as a SELF_ONLY inbox `draft`; YouTube takes it as-is
 * and lands `published` — a direct PUBLIC upload.
 */
async function pushToPlatform(
  target: PushTarget,
  platform: AdvancePlatform,
  caption: string,
): Promise<{ postId: string; status: "draft" | "published" }> {
  const media = trackMedia(target.logId);
  const social = target.videoSquaredAt ? media.socialVideoUrl : media.videoUrl;

  if (platform === "tiktok") {
    const silent = target.videoSquaredAt
      ? videoAudioStripped(social, videoVersion(target.videoSquaredAt))
      : social.replace(/footage\.mp4$/, "footage-silent.mp4");
    const { postId } = await pushTikTokDraft({ caption, videoUrl: silent });

    return { postId, status: "draft" };
  }

  const { postId } = await pushYouTubeShort({
    description: caption,
    title: target.title,
    videoUrl: social,
  });

  return { postId, status: "published" };
}

/**
 * Auto-record the live YouTube URL after a push. Postiz returns only its own postId on
 * create, so read the post back from the dated `/posts` list (the publish is async). Once
 * PUBLISHED, Postiz auto-populates `releaseURL` — the real watch URL — on the post;
 * `resolveSocialUrl` returns it VERBATIM. Store it on the row and link the Postiz
 * release-id (the videoId) for analytics. Best-effort: on a miss the url stays null and
 * the capture sweep (or the operator's manual "Update URL") is the fallback.
 */
async function linkYouTubeUrl(trackId: string, postId: string): Promise<void> {
  const resolved = await resolveSocialUrl(postId, "youtube");

  if (resolved) {
    await recordPostUrl(trackId, "youtube", resolved.url);
    await postizSetReleaseId(postId, resolved.nativeId);
  }
}

/**
 * Build the `admin-social` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware (with the
 * `draft` route keeping its per-platform operator branch in-handler).
 */
export function adminSocialHandlers(os: Implementer) {
  // GET /admin/tracks/{trackId}/social — admin tier (live `requireAdmin`).
  const listTrackSocialHandler = os.list_track_social.use(adminAuth).handler(async ({ input }) => {
    try {
      const idOrLogId = input.trackId;
      const track = await requireTrack(idOrLogId);

      const posts = await listSocialPosts(track.trackId);

      return { ok: true as const, posts, trackId: track.trackId };
    } catch (error) {
      throw toFault(error);
    }
  });

  // PATCH /admin/tracks/{trackId}/social/{platform} — operator tier (live
  // `requireOperator`).
  const updateTrackSocialHandler = os.update_track_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const platform = input.platform;
        const status = input.status;

        if (status !== "scheduled" && status !== "published" && status !== "failed") {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "bad_status",
              apiMessage: "status must be scheduled, published, or failed",
            },
            message: "status must be scheduled, published, or failed",
            status: 400,
          });
        }

        if (status === "published" && typeof input.url !== "string") {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "url_required", apiMessage: "Publishing requires the post --url" },
            message: "Publishing requires the post --url",
            status: 400,
          });
        }

        const update: SocialStatusUpdate = { status };

        if (typeof input.url === "string") {
          update.url = input.url;
        }

        if (typeof input.scheduledFor === "string") {
          update.scheduledFor = input.scheduledFor;
        }

        const track = await requireTrack(idOrLogId);

        const updated = await updateSocialStatus(track.trackId, platform, update);

        if (!updated) {
          throw new ORPCError("NOT_FOUND", {
            data: {
              apiCode: "no_post",
              apiMessage: `No ${platform} post for this track; push a draft first`,
            },
            message: `No ${platform} post for this track; push a draft first`,
            status: 404,
          });
        }

        return { ok: true as const, platform, status, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/social/{platform}/draft — admin tier (live
  // `requireAdmin`) with a FIELD-LEVEL operator guard for youtube.
  const draftTrackSocialHandler = os.draft_track_social
    .use(adminAuth)
    .handler(async ({ context, input }) => {
      try {
        const idOrLogId = input.trackId;
        const platform = input.platform;

        if (!SUPPORTED.has(platform)) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "unsupported_platform",
              apiMessage: `Unsupported platform: ${platform}`,
            },
            message: `Unsupported platform: ${platform}`,
            status: 400,
          });
        }

        // tiktok is a SELF_ONLY inbox draft (the agent may push it); youtube is a
        // direct PUBLIC upload — operator only. Ported verbatim from the live
        // route's `if (platform === "youtube") requireOperator(...)`, read from the
        // oRPC context (lifted by `adminAuth`), not re-derived.
        if (platform === "youtube" && context.role !== "operator") {
          throw new ORPCError("FORBIDDEN", {
            data: { apiCode: "forbidden", apiMessage: "This action requires the operator role" },
            message: "This action requires the operator role",
            status: 403,
          });
        }

        // The push gate: block a new YouTube push while any finding is still
        // "pushed but no URL" for YouTube. The capture resolves a post by id from
        // the dated `/posts` list, so the gate is a safety belt — it keeps the
        // backlog shallow and the operator queue legible. Keep one in flight.
        if (platform === "youtube" && (await hasPostAwaitingUrl("youtube"))) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "youtube_url_pending",
              apiMessage:
                "A YouTube post is still awaiting its URL — record it first, then push the next one.",
            },
            message: "A YouTube post is still awaiting its URL — record it first.",
            status: 409,
          });
        }

        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        if (!track.videoUrl) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_video",
              apiMessage: "Track has no video; render + upload it first",
            },
            message: "Track has no video; render + upload it first",
            status: 400,
          });
        }

        const captions = await readCaptions([track.logId]);
        const rawCaption = captions[track.logId] ?? "";
        const mentionPlatform = platform === "tiktok" ? "tiktok" : "youtube";
        // Weave in the finding's trusted lead-artist @handles for THIS platform, read at
        // push time so the freshest artist_socials trust state applies (and each platform
        // gets its own handle). Byte-identical to the bundle caption when there is none.
        const caption = await captionForPlatform(track.trackId, mentionPlatform, rawCaption);

        // The same push the auto-advance makes — one code path, so the manual tap and the
        // machine can never disagree about which cut goes to which platform.
        const { postId, status } = await pushToPlatform(
          {
            logId: track.logId,
            title: track.title,
            trackId: track.trackId,
            ...(track.videoSquaredAt ? { videoSquaredAt: track.videoSquaredAt } : {}),
          },
          platform === "tiktok" ? "tiktok" : "youtube",
          caption,
        );

        await upsertPost(track.trackId, platform, status, postId);

        // Auto-record the live YouTube URL (a side-effect, not part of the draft
        // envelope) — see `linkYouTubeUrl`.
        if (platform === "youtube") {
          await linkYouTubeUrl(track.trackId, postId);
        }

        return {
          externalId: postId,
          ok: true as const,
          platform,
          status,
          trackId: track.trackId,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/social/posts/capture — admin tier (the on-box capture cron is
  // agent-allowed: it only fills the public `url` Postiz withheld on create and
  // links the analytics release-id; it never publishes anything new). The polling
  // SWEEP that drains the "pushed but no URL" backlog: select every youtube/tiktok
  // post with a Postiz id but no captured `url` (status published/draft), resolve
  // each via `resolveSocialUrl` (YouTube reads the auto-populated `releaseURL` off
  // the dated `/posts` list; TikTok builds the permalink from the `/missing` aweme
  // id), record it (`recordPostUrl` — fill-empty-only, never clobbers a manual
  // url), link the Postiz release-id, and flip a captured TikTok `draft` →
  // `published`. The draft handler already attempts an inline resolve on a fresh
  // YouTube push; this catches the misses (publish lag) and every TikTok the
  // operator finished in-app. A resolved url already claimed by ANOTHER track is
  // skipped (`isUrlClaimedByOtherTrack`) — TikTok's `/missing` returns the
  // account's newest aweme, which while the draft is unpublished is the previous
  // track's video, so the row stays pending until a fresh permalink appears.
  // Best-effort: a post not yet resolved is simply skipped (it stays pending for
  // the next sweep), and `resolveSocialUrl`/`postizSetReleaseId` degrade rather
  // than throw, so one lagging post never burns the batch.
  const capturePostUrlsHandler = os.capture_post_urls.use(adminAuth).handler(async ({ input }) => {
    try {
      const limit = parseLimit(typeof input.limit === "string" ? input.limit : undefined, 25, 100);
      const pending = await listPostsAwaitingUrl(limit);

      const captured: Array<{ platform: string; trackId: string; url: string }> = [];
      let polled = 0;

      for (const post of pending) {
        polled += 1;

        const resolved = await resolveSocialUrl(post.externalId, post.platform);

        if (!resolved) {
          continue;
        }

        // The TikTok newest-account-URL trap: TikTok never reports a finished
        // inbox draft back, so the permalink is built from the @fluncle account's
        // NEWEST aweme (`/missing`). While this track's draft still sits
        // unpublished in the inbox, that "newest" is the PREVIOUS track's video —
        // a URL already stored on another track's row. Never attach a claimed URL;
        // leave the row pending until TikTok surfaces a fresh, unclaimed permalink
        // (i.e. once the draft is actually published in-app).
        if (await isUrlClaimedByOtherTrack(resolved.url, post.trackId)) {
          continue;
        }

        // Fill the empty url (never clobbers a manual entry). Skip the side-effects
        // if there was no row to fill — the post vanished or was filled meanwhile.
        const recorded = await recordPostUrl(post.trackId, post.platform, resolved.url);

        if (!recorded) {
          continue;
        }

        await postizSetReleaseId(post.externalId, resolved.nativeId);

        // A captured TikTok draft has now reached the app and gone live (the
        // operator finished it in-app), so flip draft → published with its url.
        if (post.platform === "tiktok" && post.status === "draft") {
          await updateSocialStatus(post.trackId, post.platform, {
            status: "published",
            url: resolved.url,
          });
        }

        captured.push({ platform: post.platform, trackId: post.trackId, url: resolved.url });
      }

      return { captured, ok: true as const, polled };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/social/publish/advance — ADMIN tier (the on-box `fluncle-publish-advance`
  // cron drives it with the agent token; the box holds no Postiz key, it only triggers —
  // the `drip_clips` / `capture_post_urls` precedent). ONE bounded, idempotent tick of the
  // render → publish auto-advance.
  //
  // The order below IS the safety argument, and it is the order for a reason:
  //
  //   (a) The KILL SWITCH first. A paused tick reads nothing and pushes nothing. One
  //       operator flip (from /admin/findings or `fluncle admin tracks publish-pause`)
  //       stops every future auto-publish inside one tick, no deploy.
  //   (b) The READY set (`advanceCandidates`) — video finalized with BOTH masters, past
  //       the settle window, and NO `social_posts` row for the platform. A platform that
  //       already has a row (pushed / published / `failed`) is never touched again: that
  //       is the never-twice rule AND the fail-closed rule in one predicate.
  //   (c) The rolling-24h push budget — a backstop, so a broken gate cannot dump the
  //       archive onto the feed.
  //   (d) The BUNDLE gate — the whole publishable bundle must be SERVED on R2 and the
  //       caption non-empty. The server-side mirror of the CLI's `bundle_incomplete`
  //       guard: a half-rendered finding is never advanced.
  //   (e) The per-platform gates — one YouTube push may be pending its URL at a time (the
  //       manual path's 409, honoured here as a skip), and TikTok's inbox holds at most 5
  //       unfinished drafts before it starts bouncing them.
  //   (f) The CLAIM (`claimPost`) — atomic, and BEFORE any call to Postiz. Two overlapping
  //       ticks race on the (track, platform) unique index; only the winner pushes.
  //   (g) The push. On an error the claim row is ALREADY `failed` (that is what a claim
  //       writes), so the finding stays in the operator's attention queue as an unposted
  //       leg and is never auto-retried.
  const advancePublishQueueHandler = os.advance_publish_queue.use(adminAuth).handler(async () => {
    try {
      // (a) The kill switch.
      if (await isPublishAdvancePaused()) {
        return {
          candidates: 0,
          failed: [],
          held: [],
          ok: true as const,
          paused: true,
          pushed: [],
        };
      }

      const now = Date.now();

      // (b) The READY set, oldest render first.
      const candidates = await advanceCandidates({ limit: ADVANCE_PER_TICK_CAP, nowMs: now });

      // (c) The rolling-24h backstop (hand-pushed rows spend from the same budget).
      const recent = await countPushesSince(new Date(now - DAY_MS).toISOString());
      let budget = Math.max(0, ADVANCE_DAILY_PUSH_CAP - recent);

      const pushed: AdvancePush[] = [];
      const held: AdvanceHeld[] = [];
      const failed: Array<{ platform: AdvancePlatform; trackId: string }> = [];
      const hold = (
        platform: AdvancePlatform,
        reason: AdvanceHeld["reason"],
        trackId: string,
        missing?: string[],
      ) => held.push({ platform, reason, trackId, ...(missing ? { missing } : {}) });

      for (const candidate of candidates) {
        // (d) The bundle gate — never advance a half-rendered finding.
        const missing = await bundleGaps(candidate.logId);

        if (missing.length > 0) {
          for (const platform of candidate.pending) {
            hold(platform, "bundle_incomplete", candidate.trackId, missing);
          }

          continue;
        }

        const captions = await readCaptions([candidate.logId]);
        const rawCaption = captions[candidate.logId] ?? "";

        if (!rawCaption) {
          for (const platform of candidate.pending) {
            hold(platform, "no_caption", candidate.trackId);
          }

          continue;
        }

        for (const platform of candidate.pending) {
          if (budget <= 0) {
            hold(platform, "daily_cap", candidate.trackId);
            continue;
          }

          // (e) The per-platform gates.
          if (platform === "youtube" && (await hasPostAwaitingUrl("youtube"))) {
            hold(platform, "youtube_url_pending", candidate.trackId);
            continue;
          }

          if (platform === "tiktok" && (await countTikTokInboxDrafts()) >= TIKTOK_INBOX_DRAFT_CAP) {
            hold(platform, "tiktok_inbox_full", candidate.trackId);
            continue;
          }

          // (f) The CLAIM — atomic, before any network call. A tick that loses the race
          // (another tick claimed it first) simply moves on; it never double-pushes.
          if (!(await claimPost(candidate.trackId, platform))) {
            continue;
          }

          budget -= 1;

          // (g) The push. The claim row is already `failed`, so an error here needs no
          // write — it just stops, visibly, and the operator owns the retry. The caption
          // gains this platform's trusted lead-artist @handles here (per-platform, read at
          // push time), so a fresh confirm reaches an already-rendered bundle.
          try {
            const caption = await captionForPlatform(candidate.trackId, platform, rawCaption);
            const { postId, status } = await pushToPlatform(candidate, platform, caption);

            await upsertPost(candidate.trackId, platform, status, postId);

            if (platform === "youtube") {
              await linkYouTubeUrl(candidate.trackId, postId);
            }

            pushed.push({
              externalId: postId,
              logId: candidate.logId,
              platform,
              status,
              trackId: candidate.trackId,
            });
          } catch (error) {
            logEvent("warn", "publish-advance.push-failed", {
              error,
              logId: candidate.logId,
              platform,
            });
            failed.push({ platform, trackId: candidate.trackId });
          }
        }
      }

      return {
        candidates: candidates.length,
        failed,
        held,
        ok: true as const,
        paused: false,
        pushed,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // PUT /admin/social/publish/advance/state — OPERATOR tier. The kill switch (the
  // `set_clip_drip` shape, on the same `settings` KV). The agent may never flip it.
  const setPublishAdvanceHandler = os.set_publish_advance
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setPublishAdvancePaused(input.paused);

        return { ok: true as const, paused: input.paused };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    advance_publish_queue: advancePublishQueueHandler,
    capture_post_urls: capturePostUrlsHandler,
    draft_track_social: draftTrackSocialHandler,
    list_track_social: listTrackSocialHandler,
    set_publish_advance: setPublishAdvanceHandler,
    update_track_social: updateTrackSocialHandler,
  };
}
