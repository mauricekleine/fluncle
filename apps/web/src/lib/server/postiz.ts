// Postiz public-API adapter — pushes a TikTok DRAFT for a track's video.
//
// Flow (per Postiz public API): resolve the connected TikTok integration id →
// register the video with Postiz via upload-from-url (Postiz pulls our public R2
// URL) → create a `draft` post with content_posting_method UPLOAD + SELF_ONLY so
// it lands in the TikTok app inbox for the operator to add the official sound and
// publish manually. Returns the Postiz post id (stored as social_posts.external_id).
//
// The Worker owns the Postiz key; the agent/CLI never sees it.

import { readEnv, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const DEFAULT_BASE = "https://api.postiz.com/public/v1";

type Integration = {
  disabled?: boolean;
  id: string;
  identifier: string;
  name?: string;
  profile?: string;
};

async function postizFetch(path: string, init: RequestInit): Promise<Response> {
  const key = await readEnv("POSTIZ_API_KEY");
  const base = (await readOptionalEnv("POSTIZ_API_URL")) ?? DEFAULT_BASE;

  // Postiz wants the raw key in Authorization — no "Bearer" prefix.
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: key, ...(init.headers as Record<string, string> | undefined) },
  });
}

/** The connected channel id for a platform (Postiz `identifier`, e.g. "tiktok"). */
async function resolveIntegrationId(platform: string): Promise<string> {
  const response = await postizFetch("/integrations", { method: "GET" });

  if (!response.ok) {
    throw new ApiError(
      "postiz_integrations",
      `Postiz integrations failed (${response.status})`,
      502,
    );
  }

  const list = (await response.json()) as Integration[];
  const match = list.find((item) => item.identifier === platform && !item.disabled);

  if (!match) {
    throw new ApiError("no_integration", `No connected ${platform} channel in Postiz`, 400);
  }

  return match.id;
}

/** Register a public HTTPS video URL with Postiz (it pulls it). Returns the media ref. */
async function uploadFromUrl(url: string): Promise<{ id: string; path: string }> {
  const response = await postizFetch("/upload-from-url", {
    body: JSON.stringify({ url }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError("postiz_upload", `Postiz upload-from-url failed (${response.status})`, 502);
  }

  const media = (await response.json()) as { id: string; path: string };

  return { id: media.id, path: media.path };
}

/** Push a TikTok draft (video to the app inbox). Returns the Postiz post id. */
export async function pushTikTokDraft(input: {
  caption: string;
  videoUrl: string;
}): Promise<{ postId: string }> {
  const integrationId = await resolveIntegrationId("tiktok");
  const media = await uploadFromUrl(input.videoUrl);

  const body = {
    date: new Date().toISOString(), // ignored for type "draft", but required by the schema
    posts: [
      {
        integration: { id: integrationId },
        settings: {
          __type: "tiktok",
          autoAddMusic: "no",
          brand_content_toggle: false,
          brand_organic_toggle: false,
          comment: false,
          content_posting_method: "UPLOAD", // TikTok inbox draft, not DIRECT_POST
          duet: false,
          privacy_level: "SELF_ONLY",
          stitch: false,
          title: "",
          video_made_with_ai: false,
        },
        value: [{ content: input.caption, image: [{ id: media.id, path: media.path }] }],
      },
    ],
    shortLink: false,
    tags: [],
    type: "draft",
  };

  const response = await postizFetch("/posts", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError("postiz_post", `Postiz draft create failed (${response.status})`, 502);
  }

  const created = (await response.json()) as Array<{ integration: string; postId: string }>;
  const postId = created[0]?.postId;

  if (!postId) {
    throw new ApiError("postiz_no_post_id", "Postiz returned no post id", 502);
  }

  return { postId };
}
