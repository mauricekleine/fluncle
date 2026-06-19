// Postiz public-API adapter — pushes a track's video to a connected channel.
//
// Three flows, one shape: resolve the connected integration id → register the
// media with Postiz via upload-from-url (Postiz pulls our public R2 URL) → POST
// the post with type "now" and per-platform settings.
//
// - TikTok: content_posting_method UPLOAD + SELF_ONLY → lands in the @fluncle app
//   inbox as a private draft; the operator adds the official sound (licensed
//   sounds attach only in-app) and the caption (the inbox/UPLOAD flow drops
//   value[].content), then publishes manually. Type "draft" would keep it in
//   Postiz and send nothing, so it would never reach TikTok.
// - Instagram Reel & YouTube Short: the API carries caption + the video's own
//   (baked-in) audio, and YouTube also takes a custom thumbnail, so these post
//   DIRECTLY (no inbox, no manual finish) per the operator's choice. We push the
//   with-audio cut, not the silent one. See docs/track-lifecycle.md (Phase 3).
//
// The Worker owns the Postiz key; the agent/CLI never sees it.

import { readEnv, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const DEFAULT_BASE = "https://api.postiz.com/public/v1";

// YouTube enforces a 2–100 char title.
const YT_TITLE_MAX = 100;

type Integration = {
  disabled?: boolean;
  id: string;
  identifier: string;
  name?: string;
  profile?: string;
};

type Media = { id: string; path: string };

async function postizFetch(path: string, init: RequestInit): Promise<Response> {
  const key = await readEnv("POSTIZ_API_KEY");
  const base = (await readOptionalEnv("POSTIZ_API_URL")) ?? DEFAULT_BASE;

  // Postiz wants the raw key in Authorization — no "Bearer" prefix.
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: key, ...(init.headers as Record<string, string> | undefined) },
  });
}

/**
 * The connected channel id for a platform. `candidates` are the Postiz
 * `identifier`s to accept, in priority order — a platform can surface under more
 * than one (e.g. Instagram standalone vs. Facebook-business), so we take the
 * first connected match. On a miss we name what *is* connected, to make a
 * mis-set identifier obvious from the error alone.
 */
async function resolveIntegrationId(candidates: string[]): Promise<string> {
  const response = await postizFetch("/integrations", { method: "GET" });

  if (!response.ok) {
    throw new ApiError(
      "postiz_integrations",
      `Postiz integrations failed (${response.status})`,
      502,
    );
  }

  const list = (await response.json()) as Integration[];
  const live = list.filter((item) => !item.disabled);

  for (const candidate of candidates) {
    const match = live.find((item) => item.identifier === candidate);

    if (match) {
      return match.id;
    }
  }

  const connected = live.map((item) => item.identifier).join(", ") || "none";

  throw new ApiError(
    "no_integration",
    `No connected ${candidates[0]} channel in Postiz (looked for ${candidates.join("/")}; connected: ${connected})`,
    400,
  );
}

/**
 * Whether a public HTTPS URL resolves (HEAD 2xx). Used to probe an optional R2
 * object before asking Postiz to pull it — older bundles can lack a cover.jpg,
 * and we'd rather post thumbnail-less than 502 the whole push. A non-2xx or a
 * network error both read as "absent" (treat the asset as missing, continue).
 */
async function urlExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });

    return response.ok;
  } catch {
    return false;
  }
}

/** Register a public HTTPS media URL with Postiz (it pulls it). Returns the ref. */
async function uploadFromUrl(url: string): Promise<Media> {
  const response = await postizFetch("/upload-from-url", {
    body: JSON.stringify({ url }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError("postiz_upload", `Postiz upload-from-url failed (${response.status})`, 502);
  }

  const media = (await response.json()) as Media;

  return { id: media.id, path: media.path };
}

/** Create a Postiz post. `type: "now"` sends it; the settings decide the platform. */
async function createPost(input: {
  content: string;
  integrationId: string;
  media: Media;
  settings: Record<string, unknown>;
}): Promise<{ postId: string }> {
  const body = {
    // Required by the schema; for type "now" it's not a scheduled time.
    date: new Date().toISOString(),
    posts: [
      {
        integration: { id: input.integrationId },
        settings: input.settings,
        value: [
          { content: input.content, image: [{ id: input.media.id, path: input.media.path }] },
        ],
      },
    ],
    shortLink: false,
    tags: [],
    type: "now",
  };

  const response = await postizFetch("/posts", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError("postiz_post", `Postiz post create failed (${response.status})`, 502);
  }

  const created = (await response.json()) as Array<{ integration: string; postId: string }>;
  const postId = created[0]?.postId;

  if (!postId) {
    throw new ApiError("postiz_no_post_id", "Postiz returned no post id", 502);
  }

  return { postId };
}

/** Push a TikTok draft (video to the app inbox, SELF_ONLY). Returns the post id. */
export async function pushTikTokDraft(input: {
  caption: string;
  videoUrl: string;
}): Promise<{ postId: string }> {
  const integrationId = await resolveIntegrationId(["tiktok"]);
  const media = await uploadFromUrl(input.videoUrl);

  return createPost({
    content: input.caption,
    integrationId,
    media,
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
  });
}

// Instagram is intentionally not wired: there's no legitimate automated audio
// path. Baking the master into a Reel gets muted/removed on a business/creator
// account, and IG's licensed library is app-only (and locked for business), so
// it can't mirror TikTok's add-sound-in-app flow. IG presence is a manual,
// in-app post. See docs/track-lifecycle.md (Phase 3) and the fluncle-publish skill.

/** Upload a YouTube Short directly (public), with a custom thumbnail. */
export async function pushYouTubeShort(input: {
  coverUrl?: string;
  description: string;
  title: string;
  videoUrl: string;
}): Promise<{ postId: string }> {
  const integrationId = await resolveIntegrationId(["youtube"]);
  const media = await uploadFromUrl(input.videoUrl);

  // The cover is optional: older bundles can lack a cover.jpg in R2. Probe it
  // first, so a missing cover degrades to a thumbnail-less Short instead of
  // 502-ing the whole push. A real upload error (cover present but Postiz
  // rejects the pull) still surfaces from uploadFromUrl.
  let thumbnail: Media | undefined;

  if (input.coverUrl && (await urlExists(input.coverUrl))) {
    thumbnail = await uploadFromUrl(input.coverUrl);
  } else if (input.coverUrl) {
    console.warn(
      `postiz: cover not found, posting YouTube Short without thumbnail (${input.coverUrl})`,
    );
  }

  return createPost({
    content: input.description,
    integrationId,
    media,
    settings: {
      __type: "youtube",
      selfDeclaredMadeForKids: "no",
      tags: [],
      thumbnail: thumbnail ? { id: thumbnail.id, path: thumbnail.path } : null,
      title: input.title.slice(0, YT_TITLE_MAX),
      type: "public",
    },
  });
}
