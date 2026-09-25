import { ORPCError } from "@orpc/server";
import { mixcloudEditUrl, mixcloudSectionFields, mixcloudSections } from "@fluncle/contracts/util";
import { buildClipCaption } from "../clip-caption";
import {
  CLIP_DRIP_PLATFORM,
  countDueClipPosts,
  countRecentPostedInWindow,
  deleteClipPost,
  dueClipPosts,
  getClipPost,
  isDripPaused,
  listClipPosts,
  nextDripSlot,
  postedClipPostsAwaitingUrl,
  setClipPostStatus,
  setDripPaused,
  upsertClipPost,
} from "../clip-social";
import { createClip, deleteClip, getClip, listClips, markClipCutDone, updateClip } from "../clips";
import { logEvent } from "../log";
import { postizSetReleaseId, pushInstagramReel, resolveSocialUrl } from "../postiz";
import { clipDownloadUrls } from "../../studio-clips";
import { youtubeDescription } from "../../mixtape-chapters";
import { getMixcloudAccessToken } from "../mixcloud";
import { finalizeMixtapeDistribution, listMixtapeSocialPosts } from "../mixtape-social";
import {
  announceMixtape,
  getMixtapeById,
  listMixtapes,
  setMixtapeCues,
  updateMixtape,
} from "../mixtapes";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { R2_MAX_PARTS, VIDEOS_BUCKET, presignMultipartUpload, presignUploads } from "../r2-presign";
import { videoVersion } from "../../media";
import { purgeClipCache } from "../video-cache";
import { getYouTubeAccessToken } from "../youtube";
import { apiFault, type Implementer, toFault } from "./_shared";

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

const DRIP_PER_TICK_CAP = 3;
const DRIP_IG_DAILY_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

async function captureDripPermalinks(): Promise<number> {
  const pending = await postedClipPostsAwaitingUrl();
  let captured = 0;

  for (const row of pending) {
    try {
      const resolved = await resolveSocialUrl(row.postizId, CLIP_DRIP_PLATFORM);

      if (!resolved) {
        continue;
      }

      await setClipPostStatus(row.clipId, "posted", { postedUrl: resolved.url });
      await postizSetReleaseId(row.postizId, resolved.nativeId);
      captured += 1;
    } catch (error) {
      logEvent("warn", "drip-clips.ig-permalink-capture-failed", { clipId: row.clipId, error });
    }
  }

  return captured;
}

async function trySetThumbnail(logId: string | undefined, videoId: string): Promise<void> {
  if (!logId) {
    return;
  }

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

export function adminMixtapesHandlers(os: Implementer) {
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
                categoryId: "10",
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
          logEvent("warn", "mixtape.youtube-thumbnail-set-failed", {
            error,
            logId: mixtape.logId,
            mixtapeId: input.mixtapeId,
          });
        });

        return { mixtape, ok: true as const, platform: "youtube" };
      } catch (error) {
        throw toFault(error);
      }
    });

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

  const resyncMixtapeMixcloudHandler = os.resync_mixtape_mixcloud
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const posts = await listMixtapeSocialPosts(input.mixtapeId);
        const mixcloud = posts.find((post) => post.platform === "mixcloud");

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

  const announceMixtapeHandler = os.announce_mixtape
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { message, mixtape } = await announceMixtape(input.mixtapeId);

        return { message, mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

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

  const listClipPostsHandler = os.list_clip_posts.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, posts: await listClipPosts() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const dripClipsHandler = os.drip_clips.use(adminAuth).handler(async () => {
    try {
      const captured = await captureDripPermalinks();

      if (await isDripPaused()) {
        return {
          attempted: 0,
          captured,
          failed: 0,
          ok: true as const,
          paused: true,
          posted: 0,
          skippedBlank: 0,
          skippedCapped: 0,
        };
      }

      const sinceIso = new Date(Date.now() - DAY_MS).toISOString();
      const recentPosted = await countRecentPostedInWindow(sinceIso);
      const remaining24h = Math.max(0, DRIP_IG_DAILY_CAP - recentPosted);
      const budget = Math.min(DRIP_PER_TICK_CAP, remaining24h);

      const totalDue = await countDueClipPosts();
      const due = await dueClipPosts({ limit: budget });

      const skippedCapped = Math.max(0, totalDue - due.length);

      let posted = 0;
      let failed = 0;
      let skippedBlank = 0;

      for (const item of due) {
        try {
          const built = await buildClipCaption(item.clipId);

          if (!built.builtCaption.trim()) {
            logEvent("warn", "drip-clips.blank-caption-skipped", { clipId: item.clipId });
            skippedBlank += 1;
            continue;
          }

          const { withAudio } = clipDownloadUrls(item.clipId);
          const { postId } = await pushInstagramReel({
            caption: built.builtCaption,
            videoUrl: withAudio,
          });

          await setClipPostStatus(item.clipId, "posted", { postizId: postId });
          posted += 1;
        } catch (error) {
          logEvent("warn", "drip-clips.instagram-post-failed", { clipId: item.clipId, error });
          await setClipPostStatus(item.clipId, "failed");
          failed += 1;
        }
      }

      return {
        attempted: due.length,
        captured,
        failed,
        ok: true as const,
        paused: false,
        posted,
        skippedBlank,
        skippedCapped,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

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

  const setClipSchedulesHandler = os.set_clip_schedules
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        let scheduled = 0;

        for (const clipId of input.clipIds) {
          const scheduledFor = await nextDripSlot();
          const built = await buildClipCaption(clipId);
          await upsertClipPost({ caption: built.builtCaption, clipId, scheduledFor });
          scheduled += 1;
        }

        return { ok: true as const, scheduled };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const deleteClipScheduleHandler = os.delete_clip_schedule
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await getClip(input.clipId);
        await deleteClipPost(input.clipId);

        return { ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

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

  const presignClipUploadHandler = os.presign_clip_upload
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const contentType =
          typeof input.contentType === "string" && input.contentType
            ? input.contentType
            : "video/mp4";

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

  const finalizeClipCutHandler = os.finalize_clip_cut.use(adminAuth).handler(async ({ input }) => {
    try {
      const clip = await markClipCutDone(input.clipId);

      purgeClipCache(input.clipId, videoVersion(clip.updatedAt));

      return { clip, ok: true as const };
    } catch (error) {
      throw toFault(error);
    }
  });

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

  return {
    announce_mixtape: announceMixtapeHandler,
    create_clip: createClipHandler,
    delete_clip: deleteClipHandler,
    delete_clip_schedule: deleteClipScheduleHandler,
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
    set_clip_schedules: setClipSchedulesHandler,
    set_mixtape_cues: setMixtapeCuesHandler,
    update_clip: updateClipHandler,
    update_mixtape: updateMixtapeHandler,
  };
}
