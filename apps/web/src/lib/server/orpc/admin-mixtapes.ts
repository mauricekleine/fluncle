// The `admin-mixtapes` domain router module — mixtape authoring + the
// audio→Mixcloud / video→YouTube distribution control plane. Each handler reuses
// the live `/api/admin/mixtapes/*` route logic verbatim; the auth tier moves to
// the oRPC procedure middleware (../orpc-auth).
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
import { createClip, deleteClip, listClips, updateClip } from "../clips";
import { youtubeDescription } from "../../mixtape-chapters";
import { finalizeMixtapeDistribution, listMixtapeSocialPosts } from "../mixtape-social";
import {
  addTracksToMixtape,
  createMixtape,
  deleteMixtape,
  getMixtapeById,
  listMixtapes,
  publishMixtape,
  setMixtapeCues,
  setMixtapeMembers,
  updateMixtape,
} from "../mixtapes";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { R2_MAX_PARTS, VIDEOS_BUCKET, presignMultipartUpload } from "../r2-presign";
import { getYouTubeAccessToken } from "../youtube";
import { apiFault, type Implementer } from "./_shared";

// YouTube's thumbnail cap, ported verbatim from the live finalize route.
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

function toFault(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error;
  }

  return apiFault(error);
}

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
        mixtapes: await listMixtapes({ hydrateMembers: true, includeDrafts: true }),
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/mixtapes — operator tier (live `requireOperator`).
  const createMixtapeHandler = os.create_mixtape
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { mixtape: await createMixtape(input), ok: true as const };
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
        const { mixtapeId, ...body } = input as { mixtapeId: string } & Record<string, unknown>;
        const mixtape = await updateMixtape(mixtapeId, body);

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // DELETE /admin/mixtapes/{mixtapeId} — operator tier (live `requireOperator`).
  const deleteMixtapeHandler = os.delete_mixtape
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await deleteMixtape(input.mixtapeId);

        return { ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/members — operator tier (live
  // `requireOperator`). APPEND to the tracklist.
  const addMixtapeMembersHandler = os.add_mixtape_members
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { mixtapeId, ...body } = input as { mixtapeId: string } & Record<string, unknown>;
        const mixtape = await addTracksToMixtape(mixtapeId, body);

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PUT /admin/mixtapes/{mixtapeId}/members — operator tier (live
  // `requireOperator`). REPLACE the whole tracklist.
  const setMixtapeMembersHandler = os.set_mixtape_members
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { mixtapeId, ...body } = input as { mixtapeId: string } & Record<string, unknown>;
        const mixtape = await setMixtapeMembers(mixtapeId, body);

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/mixtapes/{mixtapeId}/publish — operator tier (live
  // `requireOperator`).
  const publishMixtapeHandler = os.publish_mixtape
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const mixtape = await publishMixtape(input.mixtapeId);

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
        const body = input as { externalId?: unknown; url?: unknown };

        if (typeof body.url !== "string" || body.url.length === 0) {
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
          externalId: typeof body.externalId === "string" ? body.externalId : undefined,
          url: body.url,
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
        const body = input as { contentLength?: unknown; contentType?: unknown };
        const contentLength = Number(body.contentLength);
        const contentType =
          typeof body.contentType === "string" && body.contentType ? body.contentType : "video/mp4";

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

        const mixtape = await getMixtapeById(input.mixtapeId, { includeDrafts: true });

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
        const body = input as { videoId?: unknown };
        const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";

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

  // ── Fluncle Studio: clips + cue backfill (docs/fluncle-studio-rfc.md Unit D) ──

  // GET /admin/clips — admin tier (agent-allowed read). Optional ?mixtapeId/?status.
  const listClipsHandler = os.list_clips.use(adminAuth).handler(async ({ input }) => {
    try {
      return {
        clips: await listClips({ mixtapeId: input.mixtapeId, status: input.status }),
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/mixtapes/{mixtapeId}/clips — operator tier. LOOSE body → createClip.
  const createClipHandler = os.create_clip
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { mixtapeId, ...body } = input as { mixtapeId: string } & Record<string, unknown>;

        return { clip: await createClip(mixtapeId, body), ok: true as const };
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
        const { clipId, ...body } = input as { clipId: string } & Record<string, unknown>;

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
        const body = input as { contentType?: unknown; partCount?: unknown };
        const partCount = Number(body.partCount);

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
          typeof body.contentType === "string" && body.contentType ? body.contentType : "video/mp4";

        const mixtape = await getMixtapeById(input.mixtapeId, { includeDrafts: true });

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
  // cue backfill. LOOSE body → setMixtapeCues, which owns the non-draft + member-set
  // + monotonic/start-at-0 guards.
  const setMixtapeCuesHandler = os.set_mixtape_cues
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { mixtapeId, ...body } = input as { mixtapeId: string } & Record<string, unknown>;
        const mixtape = await setMixtapeCues(mixtapeId, body);

        return { mixtape, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    add_mixtape_members: addMixtapeMembersHandler,
    create_clip: createClipHandler,
    create_mixtape: createMixtapeHandler,
    delete_clip: deleteClipHandler,
    delete_mixtape: deleteMixtapeHandler,
    finalize_mixtape_mixcloud: finalizeMixtapeMixcloudHandler,
    finalize_mixtape_youtube: finalizeMixtapeYoutubeHandler,
    get_mixtape_social: getMixtapeSocialHandler,
    initiate_mixtape_youtube: initiateMixtapeYoutubeHandler,
    list_clips: listClipsHandler,
    list_mixtapes_admin: listMixtapesAdminHandler,
    presign_set_video_upload: presignSetVideoUploadHandler,
    publish_mixtape: publishMixtapeHandler,
    publish_mixtape_youtube: publishMixtapeYoutubeHandler,
    set_mixtape_cues: setMixtapeCuesHandler,
    set_mixtape_members: setMixtapeMembersHandler,
    update_clip: updateClipHandler,
    update_mixtape: updateMixtapeHandler,
  };
}
