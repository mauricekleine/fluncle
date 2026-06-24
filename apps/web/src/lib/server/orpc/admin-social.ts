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
//     so the post-push `/missing` newest-match stays unambiguous. On a successful
//     push the live YouTube URL is auto-resolved (`resolveYouTubeUrl`) and
//     recorded (`recordPostUrl`); a miss leaves `url` null for the operator's
//     manual "Update URL" fallback.

import { ORPCError } from "@orpc/server";
import { trackMedia, videoAudioStripped } from "../../media";
import { readCaptions } from "../captions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { pushTikTokDraft, pushYouTubeShort, resolveYouTubeUrl } from "../postiz";
import {
  hasPostAwaitingUrl,
  listSocialPosts,
  recordPostUrl,
  type SocialStatusUpdate,
  updateSocialStatus,
  upsertPost,
} from "../social";
import { getTrackByIdOrLogId } from "../tracks";
import { apiFault, type Implementer } from "./_shared";

// Ported verbatim from the live draft route. TikTok is the SELF_ONLY inbox draft
// (agent-allowed); YouTube is the direct PUBLIC upload (operator only).
const SUPPORTED = new Set(["tiktok", "youtube"]);

// The fault wrapper: an ORPCError (a guard or an in-handler reject) passes through
// untouched; anything else (an ApiError from a reused helper, or an unexpected
// throw) becomes a wire-compatible fault via `apiFault`.
function toFault(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error;
  }

  return apiFault(error);
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
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
          message: `No track with id ${idOrLogId}`,
          status: 404,
        });
      }

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
        const body = input as { scheduledFor?: unknown; status?: unknown; url?: unknown };
        const status = body.status;

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

        if (status === "published" && typeof body.url !== "string") {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "url_required", apiMessage: "Publishing requires the post --url" },
            message: "Publishing requires the post --url",
            status: 400,
          });
        }

        const update: SocialStatusUpdate = { status };

        if (typeof body.url === "string") {
          update.url = body.url;
        }

        if (typeof body.scheduledFor === "string") {
          update.scheduledFor = body.scheduledFor;
        }

        const track = await getTrackByIdOrLogId(idOrLogId);

        if (!track) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
            message: `No track with id ${idOrLogId}`,
            status: 404,
          });
        }

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
        // "pushed but no URL" for YouTube. Postiz returns the live URL only via
        // `/missing` (matched by the newest published item), so a second pending
        // upload would make that match ambiguous. Keep exactly one in flight.
        if (platform === "youtube" && (await hasPostAwaitingUrl("youtube"))) {
          throw new ORPCError("CONFLICT", {
            data: {
              apiCode: "youtube_url_pending",
              apiMessage:
                "A YouTube post is still awaiting its URL — record it first (or run the URL resolver), then push the next one.",
            },
            message: "A YouTube post is still awaiting its URL — record it first.",
            status: 409,
          });
        }

        const track = await getTrackByIdOrLogId(idOrLogId);

        if (!track) {
          throw new ORPCError("NOT_FOUND", {
            data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
            message: `No track with id ${idOrLogId}`,
            status: 404,
          });
        }

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

        // The PLAYABLE portrait cut both platforms push (docs/video-variants.md):
        // under the two-master layout (videoSquaredAt set) that is the baked-text
        // footage.social.mp4 — footage.mp4 is the clean square crop source. A
        // legacy finding (no signal) keeps pushing footage.mp4.
        const media = trackMedia(track.logId);
        const social = track.videoSquaredAt ? media.socialVideoUrl : media.videoUrl;
        const captions = await readCaptions([track.logId]);
        const caption = captions[track.logId] ?? "";

        let postId: string;
        let status: "draft" | "published";

        if (platform === "tiktok") {
          const silent = track.videoSquaredAt
            ? videoAudioStripped(social)
            : social.replace(/footage\.mp4$/, "footage-silent.mp4");
          ({ postId } = await pushTikTokDraft({ caption, videoUrl: silent }));
          status = "draft";
        } else {
          ({ postId } = await pushYouTubeShort({
            coverUrl: media.coverUrl,
            description: caption,
            title: track.title,
            videoUrl: social,
          }));
          status = "published";
        }

        await upsertPost(track.trackId, platform, status, postId);

        // Auto-record the live YouTube URL: Postiz returns only its own postId on
        // create, so poll `/missing` (the publish is async) and store the newest
        // YouTube permalink on the row — surfaced via `list_track_social`. A
        // side-effect, not part of the draft envelope. Best-effort and coverless:
        // on a miss the url stays null and the operator's manual "Update URL" is
        // the fallback (and the push gate then holds the next push until it's set).
        if (platform === "youtube") {
          const resolved = await resolveYouTubeUrl(postId);

          if (resolved) {
            await recordPostUrl(track.trackId, platform, resolved);
          }
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

  return {
    draft_track_social: draftTrackSocialHandler,
    list_track_social: listTrackSocialHandler,
    update_track_social: updateTrackSocialHandler,
  };
}
