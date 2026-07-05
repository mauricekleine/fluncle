// The `admin-mixtapes` domain router module — the audio→Mixcloud /
// video→YouTube distribution control plane for PROMOTED mixtapes. Each handler
// reuses the live `/api/admin/mixtapes/*` route logic verbatim; the auth tier
// moves to the oRPC procedure middleware (../orpc-auth). The draft-authoring
// handlers (create/members/publish/delete) retired with draft mixtapes — a
// mixtape is only ever born via `promote_recording`; plans own pre-publish
// authoring.
//
// VERIFIED auth tiers (against the live handlers):
//   - `list_mixtapes_admin` / `get_mixtape_social` — admin tier (`adminAuth`).
//   - everything else — operator tier (`adminAuth` + `operatorGuard`).
//
// The live YouTube routes read their body via `parseJsonBody` (which returns a
// Response on a non-JSON body); oRPC's OpenAPIHandler already decodes the body to
// build `input`, so the handlers read the fields off `input` and reproduce the
// in-handler validation (`invalid_request`, the status/log-id 409s, the YouTube
// 502s) byte-for-byte.

import { ORPCError } from "@orpc/server";
import { mixcloudEditUrl, mixcloudSectionFields, mixcloudSections } from "@fluncle/contracts/util";
import { buildClipCaption } from "../clip-caption";
import {
  countDueClipPosts,
  countRecentPostedInWindow,
  dueClipPosts,
  getClipPost,
  isDripPaused,
  listClipPosts,
  setClipPostStatus,
  setDripPaused,
  upsertClipPost,
} from "../clip-social";
import { createClip, deleteClip, getClip, listClips, markClipCutDone, updateClip } from "../clips";
import { pushInstagramReel } from "../postiz";
import { clipDownloadUrls } from "../../studio-clips";
import { youtubeDescription } from "../../mixtape-chapters";
import { getMixcloudAccessToken } from "../mixcloud";
import { finalizeMixtapeDistribution, listMixtapeSocialPosts } from "../mixtape-social";
import {
  getMixtapeById,
  listMixtapes,
  setMixtapeCue,
  setMixtapeCues,
  updateMixtape,
} from "../mixtapes";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { R2_MAX_PARTS, VIDEOS_BUCKET, presignMultipartUpload, presignUploads } from "../r2-presign";
import { videoVersion } from "../../media";
import { purgeClipCache } from "../video-cache";
import { getYouTubeAccessToken } from "../youtube";
import { apiFault, type Implementer, toFault } from "./_shared";

// YouTube's thumbnail cap, ported verbatim from the live finalize route.
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

// The clip drip-feed's per-tick + rolling-24h caps (clip-drip-feed RFC §3/§4). At ~1
// clip/day these never bite; they are the safety backstops. The 24h cap sits well under
// Meta's ~25/day so the account never trips a rate flag.
const DRIP_PER_TICK_CAP = 3;
const DRIP_IG_DAILY_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// Ported verbatim from the live youtube/finalize route: a best-effort custom
// thumbnail (the wide cover, rendered in-process). A thumbnail failure must not
// fail finalize.
async function trySetThumbnail(logId: string | undefined, videoId: string): Promise<void> {
  if (!logId) {
    return;
  }

  // Lazy import: `mixtape-cover` pulls in `workers-og` (a yoga WASM module) that is
  // heavy to evaluate and breaks under the vitest module resolver. Loading it only
  // when a thumbnail is actually rendered keeps `./orpc`'s module graph clean (the
  // live route loaded it lazily-by-route the same way).
  const { renderMixtapeCover } = await import("../mixtape-cover");
  const cover = await renderMixtapeCover(logId, "wide");

  if (!cover) {
    return;
  }

  const image = await cover.arrayBuffer();

  if (image.byteLength > THUMBNAIL_MAX_BYTES) {
    throw new Error(`cover PNG is ${image.byteLength} bytes (> 2MB cap)`);
  }

  const accessToken = await getYouTubeAccessToken();
  const setResponse = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      body: image,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "image/png",
      },
      method: "POST",
    },
  );

  if (!setResponse.ok) {
    const detail = (await setResponse.text().catch(() => "")).slice(0, 300);
    throw new Error(`thumbnails.set ${setResponse.status} ${setResponse.statusText}: ${detail}`);
  }
}

/**
 * Build the `admin-mixtapes` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminMixtapesHandlers(os: Implementer) {
  // GET /admin/mixtapes — admin tier (live `requireAdmin`).
  const listMixtapesAdminHandler = os.list_mixtapes_admin.use(adminAuth).handler(async () => {
    try {
      return {
        mixtapes: await listMixtapes({ hydrateMembers: true, includeUnpublished: true }),
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PATCH /admin/mixtapes/{mixtapeId} — operator tier (live `requireOperator`).
  const updateMixtapeHandler = os.update_mixtape
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { mixtapeId, ...body } = input;
        const mixtape = await updateMixtape(mixtapeId, body);

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // GET /admin/mixtapes/{mixtapeId}/social — admin tier (live `requireAdmin`).
  const getMixtapeSocialHandler = os.get_mixtape_social
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const posts = await listMixtapeSocialPosts(input.mixtapeId);

        return { mixtapeId: input.mixtapeId, ok: true as const, posts };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize — operator tier (live
  // `requireOperator`). The live route validates `url` (`invalid_request`/400).
  const finalizeMixtapeMixcloudHandler = os.finalize_mixtape_mixcloud
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        if (typeof input.url !== "string" || input.url.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "invalid_request",
              apiMessage: "Mixcloud finalize requires a url",
            },
            message: "Mixcloud finalize requires a url",
            status: 400,
          });
        }

        const mixtape = await finalizeMixtapeDistribution(input.mixtapeId, "mixcloud", {
          externalId: typeof input.externalId === "string" ? input.externalId : undefined,
          url: input.url,
        });

        return { mixtape, ok: true as const, platform: "mixcloud" };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/youtube/initiate — operator tier (live
  // `requireOperator`).
  const initiateMixtapeYoutubeHandler = os.initiate_mixtape_youtube
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const contentLength = Number(input.contentLength);
        const contentType =
          typeof input.contentType === "string" && input.contentType
            ? input.contentType
            : "video/mp4";

        if (!Number.isFinite(contentLength) || contentLength <= 0) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "invalid_request",
              apiMessage: "contentLength must be a positive number",
            },
            message: "contentLength must be a positive number",
            status: 400,
          });
        }

        const mixtape = await getMixtapeById(input.mixtapeId);

        if (mixtape.status !== "distributing" && mixtape.status !== "published") {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "mixtape_not_distributing",
              apiMessage: "Mint the mixtape (publish) before distributing its video",
            },
            message: "Mint the mixtape (publish) before distributing its video",
            status: 409,
          });
        }

        if (!mixtape.logId) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "mixtape_no_log_id",
              apiMessage: "Mixtape has no committed Log ID",
            },
            message: "Mixtape has no committed Log ID",
            status: 409,
          });
        }

        const accessToken = await getYouTubeAccessToken();
        const title = mixtape.title.slice(0, 100);
        const description = youtubeDescription(mixtape.note ?? "", mixtape.logId, mixtape.members);

        const initiate = await fetch(
          "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
          {
            body: JSON.stringify({
              snippet: {
                categoryId: "10", // Music
                description,
                title,
              },
              status: {
                privacyStatus: "unlisted",
                selfDeclaredMadeForKids: false,
              },
            }),
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json; charset=UTF-8",
              "X-Upload-Content-Length": String(contentLength),
              "X-Upload-Content-Type": contentType,
            },
            method: "POST",
          },
        );

        if (!initiate.ok) {
          const detail = (await initiate.text().catch(() => "")).slice(0, 500);
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "youtube_initiate_failed",
              apiMessage: `YouTube rejected the upload session (${initiate.status} ${initiate.statusText})${detail ? `: ${detail}` : ""}`,
            },
            message: `YouTube rejected the upload session (${initiate.status} ${initiate.statusText})${detail ? `: ${detail}` : ""}`,
            status: 502,
          });
        }

        const sessionUri = initiate.headers.get("Location");

        if (!sessionUri) {
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "youtube_no_session",
              apiMessage: "YouTube did not return a resumable session URI",
            },
            message: "YouTube did not return a resumable session URI",
            status: 502,
          });
        }

        return { accessToken, ok: true as const, sessionUri };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/youtube/finalize — operator tier (live
  // `requireOperator`).
  const finalizeMixtapeYoutubeHandler = os.finalize_mixtape_youtube
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const videoId = typeof input.videoId === "string" ? input.videoId.trim() : "";

        if (!videoId) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "invalid_request", apiMessage: "videoId is required" },
            message: "videoId is required",
            status: 400,
          });
        }

        const mixtape = await finalizeMixtapeDistribution(input.mixtapeId, "youtube", {
          externalId: videoId,
          url: `https://youtu.be/${videoId}`,
        });

        await trySetThumbnail(mixtape.logId, videoId).catch((error) => {
          console.warn(
            `[mixtape ${input.mixtapeId}] YouTube thumbnail set failed (non-fatal):`,
            error instanceof Error ? error.message : String(error),
          );
        });

        return { mixtape, ok: true as const, platform: "youtube" };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/youtube/publish — operator tier (live
  // `requireOperator`).
  const publishMixtapeYoutubeHandler = os.publish_mixtape_youtube
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const posts = await listMixtapeSocialPosts(input.mixtapeId);
        const youtube = posts.find((post) => post.platform === "youtube");
        const videoId = youtube?.externalId;

        if (!videoId) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "youtube_not_distributed",
              apiMessage: "No YouTube video to publish — distribute the mixtape first",
            },
            message: "No YouTube video to publish — distribute the mixtape first",
            status: 409,
          });
        }

        const accessToken = await getYouTubeAccessToken();
        const response = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
          body: JSON.stringify({
            id: videoId,
            status: {
              privacyStatus: "public",
              selfDeclaredMadeForKids: false,
            },
          }),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        });

        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 500);
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "youtube_publish_failed",
              apiMessage: `YouTube rejected the visibility flip (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
            },
            message: `YouTube rejected the visibility flip (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
            status: 502,
          });
        }

        const url = youtube.url ?? `https://youtu.be/${videoId}`;

        return { ok: true as const, url };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/youtube/resync — operator tier. Re-derive the
  // description + chapters from the mixtape's CURRENT cues and push them to the live
  // video via videos.update — no re-upload. Server-side (the Worker holds the refresh
  // token), like publish_mixtape_youtube. videos.update replaces the WHOLE snippet
  // part, so we first videos.list the current snippet (title, categoryId, tags, …) and
  // patch ONLY its description — nothing else about the video moves.
  const resyncMixtapeYoutubeHandler = os.resync_mixtape_youtube
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const posts = await listMixtapeSocialPosts(input.mixtapeId);
        const youtube = posts.find((post) => post.platform === "youtube");
        const videoId = youtube?.externalId;

        if (!videoId) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "youtube_not_distributed",
              apiMessage: "No YouTube video to re-sync — distribute the mixtape first",
            },
            message: "No YouTube video to re-sync — distribute the mixtape first",
            status: 409,
          });
        }

        const mixtape = await getMixtapeById(input.mixtapeId);

        if (!mixtape.logId) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "mixtape_no_log_id", apiMessage: "Mixtape has no committed Log ID" },
            message: "Mixtape has no committed Log ID",
            status: 409,
          });
        }

        const accessToken = await getYouTubeAccessToken();

        // videos.update needs the FULL snippet (title + categoryId are required); read
        // the current one so the update preserves everything except the description.
        const listResponse = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (!listResponse.ok) {
          const detail = (await listResponse.text().catch(() => "")).slice(0, 500);
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "youtube_resync_failed",
              apiMessage: `YouTube rejected the snippet read (${listResponse.status} ${listResponse.statusText})${detail ? `: ${detail}` : ""}`,
            },
            message: `YouTube rejected the snippet read (${listResponse.status} ${listResponse.statusText})${detail ? `: ${detail}` : ""}`,
            status: 502,
          });
        }

        const listData = (await listResponse.json().catch(() => ({}))) as {
          items?: { snippet?: Record<string, unknown> }[];
        };
        const currentSnippet = listData.items?.[0]?.snippet;

        if (!currentSnippet) {
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "youtube_video_not_found",
              apiMessage: `YouTube returned no snippet for video ${videoId}`,
            },
            message: `YouTube returned no snippet for video ${videoId}`,
            status: 502,
          });
        }

        const description = youtubeDescription(mixtape.note ?? "", mixtape.logId, mixtape.members);

        const updateResponse = await fetch(
          "https://www.googleapis.com/youtube/v3/videos?part=snippet",
          {
            body: JSON.stringify({
              id: videoId,
              // Keep the whole existing snippet (title, categoryId, tags, …); replace
              // only the description with the freshly-derived prose + chapter block.
              snippet: { ...currentSnippet, description },
            }),
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          },
        );

        if (!updateResponse.ok) {
          const detail = (await updateResponse.text().catch(() => "")).slice(0, 500);
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "youtube_resync_failed",
              apiMessage: `YouTube rejected the description update (${updateResponse.status} ${updateResponse.statusText})${detail ? `: ${detail}` : ""}`,
            },
            message: `YouTube rejected the description update (${updateResponse.status} ${updateResponse.statusText})${detail ? `: ${detail}` : ""}`,
            status: 502,
          });
        }

        const url = youtube.url ?? `https://youtu.be/${videoId}`;

        return { ok: true as const, url, videoId };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/mixcloud/resync — operator tier. Re-derive the
  // Mixcloud `sections[]` tracklist from the mixtape's CURRENT cues and push it to the
  // live cloudcast via the Mixcloud edit endpoint — sections-only, NO audio re-upload.
  // Server-side parity with resync_mixtape_youtube: the Worker holds the mixcloud_auth
  // token (getMixcloudAccessToken), so this bytes-free edit runs here rather than
  // CLI-side. Posting any `sections-*` field overwrites the whole tracklist; sending
  // ONLY the section fields leaves name/description/picture untouched.
  const resyncMixtapeMixcloudHandler = os.resync_mixtape_mixcloud
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const posts = await listMixtapeSocialPosts(input.mixtapeId);
        const mixcloud = posts.find((post) => post.platform === "mixcloud");
        // The cloudcast key/url live on the mixcloud distribution row (the SSOT);
        // `externalId` is the key `/fluncle/<slug>/`. The recorded url/key never change
        // on a re-sync, so there is nothing to finalize.
        const key = mixcloud?.externalId;

        if (!key) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "mixcloud_not_distributed",
              apiMessage: "No Mixcloud cloudcast to re-sync — distribute the mixtape first",
            },
            message: "No Mixcloud cloudcast to re-sync — distribute the mixtape first",
            status: 409,
          });
        }

        const mixtape = await getMixtapeById(input.mixtapeId);
        const sections = mixcloudSections(mixtape.members);

        if (sections.length === 0) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "mixcloud_no_cues",
              apiMessage: "No cued members to sync — mark cues on the mixtape first",
            },
            message: "No cued members to sync — mark cues on the mixtape first",
            status: 409,
          });
        }

        const token = await getMixcloudAccessToken();

        const form = new FormData();
        for (const [name, value] of mixcloudSectionFields(sections)) {
          form.append(name, value);
        }

        // Mixcloud diverges from Bearer auth — the token rides as a query param.
        const response = await fetch(
          `${mixcloudEditUrl(key)}?access_token=${encodeURIComponent(token)}`,
          { body: form, method: "POST" },
        );

        const text = await response.text();

        if (!response.ok) {
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "mixcloud_resync_failed",
              apiMessage: `Mixcloud rejected the section edit (${response.status} ${response.statusText})${text ? `: ${text.slice(0, 300)}` : ""}`,
            },
            message: `Mixcloud rejected the section edit (${response.status} ${response.statusText})`,
            status: 502,
          });
        }

        // Mixcloud answers 200 even on a validation failure; the body carries the real
        // outcome (`{ result: { success, message } }`).
        let success = false;
        let detail = text.slice(0, 300);
        try {
          const data = JSON.parse(text) as { result?: { message?: string; success?: boolean } };
          success = data.result?.success === true;
          detail = data.result?.message ?? detail;
        } catch {
          success = false;
        }

        if (!success) {
          throw new ORPCError("BAD_GATEWAY", {
            data: {
              apiCode: "mixcloud_resync_failed",
              apiMessage: `Mixcloud rejected the section edit: ${detail}`,
            },
            message: `Mixcloud rejected the section edit: ${detail}`,
            status: 502,
          });
        }

        const url = mixcloud?.url ?? `https://www.mixcloud.com${key}`;

        return { ok: true as const, url };
      } catch (error) {
        throw toFault(error);
      }
    });

  // ── Fluncle Studio: clips + cue backfill ──

  // GET /admin/clips — admin tier (agent-allowed read). Optional ?recordingId/?status.
  const listClipsHandler = os.list_clips.use(adminAuth).handler(async ({ input }) => {
    try {
      return {
        clips: await listClips({
          recordingId: input.recordingId,
          status: input.status,
        }),
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/clips/{clipId}/caption — admin tier (agent-allowed read). Build the
  // clip's caption: the stored-clean caption + the `fluncle://` coordinate line(s).
  const getClipCaptionHandler = os.get_clip_caption.use(adminAuth).handler(async ({ input }) => {
    try {
      const built = await buildClipCaption(input.clipId);

      return {
        builtCaption: built.builtCaption,
        caption: built.caption,
        clipId: built.clipId,
        coordinates: built.coordinates,
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/clips/social — admin tier (agent-allowed read). Every clip's IG drip row,
  // so the library / CLI can show each clip's scheduled/posted/failed state.
  const listClipPostsHandler = os.list_clip_posts.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, posts: await listClipPosts() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/clips/drip — ADMIN tier (agent-allowed), NOT operator: the on-box
  // `fluncle-clip-drip` cron drives it with the agent token (the `finalize_clip_cut` /
  // `record_health` precedent — the box holds no Postiz key, so it only TRIGGERS the
  // Worker, which owns the key). One bounded, idempotent tick of the drip-feed.
  const dripClipsHandler = os.drip_clips.use(adminAuth).handler(async () => {
    try {
      // (a) The kill switch — a paused tick posts nothing (the schedule stays intact).
      if (await isDripPaused()) {
        return {
          attempted: 0,
          failed: 0,
          ok: true as const,
          paused: true,
          posted: 0,
          skippedCapped: 0,
        };
      }

      // (b) The budget: the per-tick cap AND the rolling-24h IG cap, whichever is smaller.
      const sinceIso = new Date(Date.now() - DAY_MS).toISOString();
      const recentPosted = await countRecentPostedInWindow(sinceIso);
      const remaining24h = Math.max(0, DRIP_IG_DAILY_CAP - recentPosted);
      const budget = Math.min(DRIP_PER_TICK_CAP, remaining24h);

      const totalDue = await countDueClipPosts();
      const due = await dueClipPosts({ limit: budget });
      // What the cap deferred to a later tick (the due backlog beyond this tick's budget).
      const skippedCapped = Math.max(0, totalDue - due.length);

      let posted = 0;
      let failed = 0;

      // (c) Post each due, cut clip. A single failure marks its row `failed` (retryable by
      // the operator rescheduling it) and never aborts the rest of the tick.
      for (const item of due) {
        try {
          // Rebuild the caption fresh at fire time, so a late re-cut / edit is reflected.
          const built = await buildClipCaption(item.clipId);
          const { withAudio } = clipDownloadUrls(item.clipId);
          const { postId } = await pushInstagramReel({
            caption: built.builtCaption,
            videoUrl: withAudio,
          });

          await setClipPostStatus(item.clipId, "posted", { postizId: postId });
          posted += 1;
        } catch (error) {
          console.warn(`drip_clips: failed to post clip ${item.clipId} to Instagram`, error);
          await setClipPostStatus(item.clipId, "failed");
          failed += 1;
        }
      }

      // TODO(clip-drip capture-back): backfill `posted_url` with the IG permalink from
      // Postiz's dated `/posts` list (the `resolveSocialUrl` reader, extended for
      // "instagram"), the way the social-capture sweep does for YouTube/TikTok. Deferred
      // to a follow-up: the post itself succeeds now; the permalink is a display nicety.
      return {
        attempted: due.length,
        failed,
        ok: true as const,
        paused: false,
        posted,
        skippedCapped,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PATCH /admin/clips/{clipId}/schedule — operator tier. The operator's schedule control:
  // set/override a clip's drip slot. Confirms the clip exists (clean 404), re-snapshots the
  // caption, and re-arms the row (a `failed`/`posted` row can be rescheduled).
  const setClipScheduleHandler = os.set_clip_schedule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await getClip(input.clipId);
        const built = await buildClipCaption(input.clipId);
        await upsertClipPost({
          caption: built.builtCaption,
          clipId: input.clipId,
          scheduledFor: input.scheduledFor,
        });

        const post = await getClipPost(input.clipId);

        if (!post) {
          throw apiFault(new Error("Failed to read back the scheduled clip post"));
        }

        return { ok: true as const, post };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PUT /admin/clips/drip/state — operator tier. The global kill switch. Pausing halts
  // every future scheduled post within one tick; resuming continues the drip.
  const setClipDripHandler = os.set_clip_drip
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setDripPaused(input.paused);

        return { ok: true as const, paused: input.paused };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/recordings/{recordingId}/clips — operator tier. LOOSE body → createClip
  // (recording-scoped under the RFC recording-primitive; the legacy mixtape path is gone).
  const createClipHandler = os.create_clip
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { recordingId, ...body } = input;

        return { clip: await createClip(recordingId, body), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PATCH /admin/clips/{clipId} — operator tier. LOOSE body → updateClip.
  const updateClipHandler = os.update_clip
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { clipId, ...body } = input;

        return { clip: await updateClip(clipId, body), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // DELETE /admin/clips/{clipId} — operator tier.
  const deleteClipHandler = os.delete_clip
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await deleteClip(input.clipId);

        return { ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/clips/{clipId}/presign — AGENT tier (Fluncle Studio Unit C). The box's
  // clip-cut cron signs its OWN clip output with the agent token (the render-box
  // `presign_track_video_uploads` precedent — adminAuth only, no operatorGuard). A clip
  // is < 100 MB, so this is a SINGLE-PUT presign for `<clipId>/footage.mp4`.
  const presignClipUploadHandler = os.presign_clip_upload
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const contentType =
          typeof input.contentType === "string" && input.contentType
            ? input.contentType
            : "video/mp4";

        // Confirm the clip exists for a clean 404 before signing (getClip throws
        // `clip_not_found`/404). The footage key is the clip's pseudo-finding master
        // (`trackMedia(clipId).videoUrl` is `<base>/<clipId>/footage.mp4`), so the merged
        // `videoCrop(clipId)` / poster / silent MT helpers finish it.
        await getClip(input.clipId);

        const footageKey = `${input.clipId}/footage.mp4`;
        const [signed] = await presignUploads(VIDEOS_BUCKET, [{ contentType, key: footageKey }]);

        if (!signed) {
          throw apiFault(new Error("Failed to presign the clip upload"));
        }

        return {
          clipId: input.clipId,
          contentType: signed.contentType,
          key: signed.key,
          ok: true as const,
          url: signed.url,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/clips/{clipId}/cut/finalize — AGENT tier (Fluncle Studio Unit C). After
  // the box uploads `<clipId>/footage.mp4`, mark the cut `done` (the operator
  // `update_clip` is unreachable to the agent token) AND purge the clip's stale edge
  // renditions server-side (the box holds no Cloudflare creds), so a re-cut to the same
  // clipId never keeps serving the old cut. Mirrors `finalize_track_video`.
  const finalizeClipCutHandler = os.finalize_clip_cut.use(adminAuth).handler(async ({ input }) => {
    try {
      const clip = await markClipCutDone(input.clipId);

      // Best-effort, off the request lifecycle (waitUntil). A genuine first cut has
      // nothing cached yet, so this is a harmless no-op; a re-cut evicts the stale set.
      // The fresh `updatedAt` is the vintage the clip surfaces mint as their `?v`
      // token from now on (media.ts videoVersion) — the actual MT-rendition evictor.
      purgeClipCache(input.clipId, videoVersion(clip.updatedAt));

      return { clip, ok: true as const };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/mixtapes/{mixtapeId}/set-video/presign — operator tier (Fluncle
  // Studio Unit A). Open a multipart direct-to-R2 upload for the mixtape's set-video
  // rendition at `<logId>/set.mp4` + presign every leg; the CLI streams the ~1.5GB
  // rendition straight to R2. Gates like the YouTube initiate: a minted mixtape only
  // (it needs a committed Log ID for the key).
  const presignSetVideoUploadHandler = os.presign_set_video_upload
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const partCount = Number(input.partCount);

        if (!Number.isInteger(partCount) || partCount < 1 || partCount > R2_MAX_PARTS) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "invalid_request",
              apiMessage: `partCount must be an integer 1..${R2_MAX_PARTS}`,
            },
            message: `partCount must be an integer 1..${R2_MAX_PARTS}`,
            status: 400,
          });
        }

        const contentType =
          typeof input.contentType === "string" && input.contentType
            ? input.contentType
            : "video/mp4";

        const mixtape = await getMixtapeById(input.mixtapeId);

        if (mixtape.status !== "distributing" && mixtape.status !== "published") {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "mixtape_not_distributing",
              apiMessage: "Mint the mixtape (publish) before staging its set video",
            },
            message: "Mint the mixtape (publish) before staging its set video",
            status: 409,
          });
        }

        if (!mixtape.logId) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "mixtape_no_log_id", apiMessage: "Mixtape has no committed Log ID" },
            message: "Mixtape has no committed Log ID",
            status: 409,
          });
        }

        const presign = await presignMultipartUpload(
          VIDEOS_BUCKET,
          `${mixtape.logId}/set.mp4`,
          contentType,
          partCount,
        );

        return {
          abortUrl: presign.abortUrl,
          completeUrl: presign.completeUrl,
          key: presign.key,
          logId: mixtape.logId,
          mixtapeId: input.mixtapeId,
          ok: true as const,
          parts: presign.parts,
          uploadId: presign.uploadId,
        };
      } catch (error) {
        throw toFault(error);
      }
    });

  // PUT /admin/mixtapes/{mixtapeId}/cues — operator tier. The hardened post-publish
  // cue backfill. LOOSE body → setMixtapeCues, which owns the minted-only + member-set
  // + monotonic/start-at-0 guards.
  const setMixtapeCuesHandler = os.set_mixtape_cues
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { mixtapeId, ...body } = input;
        const mixtape = await setMixtapeCues(mixtapeId, body);

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PUT /admin/mixtapes/{mixtapeId}/cues/{ref} — operator tier. The INTERACTIVE
  // single-cue write behind the Studio cue rail (mark/clear one member at the
  // playhead). LOOSE body → setMixtapeCue, which owns the startMs validation + the
  // minted-only + membership guards; `startMs: null` clears the cue. No coverage/order
  // constraint (that is the batch set_mixtape_cues' job).
  const updateMixtapeCueHandler = os.update_mixtape_cue
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const mixtape = await setMixtapeCue(input.mixtapeId, {
          ref: input.ref,
          startMs: input.startMs,
        });

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    create_clip: createClipHandler,
    delete_clip: deleteClipHandler,
    drip_clips: dripClipsHandler,
    finalize_clip_cut: finalizeClipCutHandler,
    finalize_mixtape_mixcloud: finalizeMixtapeMixcloudHandler,
    finalize_mixtape_youtube: finalizeMixtapeYoutubeHandler,
    get_clip_caption: getClipCaptionHandler,
    get_mixtape_social: getMixtapeSocialHandler,
    initiate_mixtape_youtube: initiateMixtapeYoutubeHandler,
    list_clip_posts: listClipPostsHandler,
    list_clips: listClipsHandler,
    list_mixtapes_admin: listMixtapesAdminHandler,
    presign_clip_upload: presignClipUploadHandler,
    presign_set_video_upload: presignSetVideoUploadHandler,
    publish_mixtape_youtube: publishMixtapeYoutubeHandler,
    resync_mixtape_mixcloud: resyncMixtapeMixcloudHandler,
    resync_mixtape_youtube: resyncMixtapeYoutubeHandler,
    set_clip_drip: setClipDripHandler,
    set_clip_schedule: setClipScheduleHandler,
    set_mixtape_cues: setMixtapeCuesHandler,
    update_clip: updateClipHandler,
    update_mixtape: updateMixtapeHandler,
    update_mixtape_cue: updateMixtapeCueHandler,
  };
}
