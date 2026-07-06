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
//   (baked-in) audio, so these post DIRECTLY (no inbox, no manual finish) per the
//   operator's choice. We push the with-audio cut, not the silent one, and set NO
//   custom YouTube thumbnail — the auto-picked frame reads better.
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
async function resolveIntegration(
  candidates: string[],
): Promise<{ id: string; identifier: string }> {
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
      return { id: match.id, identifier: match.identifier };
    }
  }

  const connected = live.map((item) => item.identifier).join(", ") || "none";

  throw new ApiError(
    "no_integration",
    `No connected ${candidates[0]} channel in Postiz (looked for ${candidates.join("/")}; connected: ${connected})`,
    400,
  );
}

/** The connected channel id for a platform (the `resolveIntegration` id, discarding the
 *  matched identifier). Most callers only need the id; the Reel push also needs the
 *  identifier (its `__type`), so it uses `resolveIntegration` directly. */
async function resolveIntegrationId(candidates: string[]): Promise<string> {
  return (await resolveIntegration(candidates)).id;
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

/**
 * Parse a Postiz JSON body LENIENTLY. Verified against live Postiz: the dated
 * `/posts` list returns post `content` with UNESCAPED newlines (a raw control
 * char inside a JSON string), which `Response.json()` rejects. So read the text
 * and escape bare control characters inside the body before `JSON.parse`. On any
 * parse failure the caller degrades to "nothing found", never throws.
 */
async function readLenientJson(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    // Escape the bare control chars (newline/tab/CR) Postiz leaves unescaped
    // inside string values, then retry. A still-unparseable body yields null.
    const escaped = text
      .replace(/\r\n/g, "\\n")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\n")
      .replace(/\t/g, "\\t");

    try {
      return JSON.parse(escaped);
    } catch {
      return null;
    }
  }
}

/** A post as the dated `/posts` list returns it. `releaseId`/`releaseURL` are
 *  AUTO-POPULATED by Postiz on a published YouTube direct post (the videoId + the
 *  real watch URL); a TikTok inbox draft keeps `releaseId === "missing"` and a
 *  useless `…/messages?…` placeholder `releaseURL`. */
export type PostizListPost = {
  content?: string;
  id: string;
  integration?: { providerIdentifier?: string };
  publishDate?: string;
  releaseId?: string | null;
  releaseURL?: string | null;
  state?: string;
};

// The dated-list window: look back 7 days, forward 1 day (covers a just-pushed
// post whose publishDate the server may stamp slightly ahead of our clock).
const LIST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_LOOKAHEAD_MS = 1 * 24 * 60 * 60 * 1000;

/**
 * The dated `/posts` list. Verified against live Postiz: BOTH `startDate` and
 * `endDate` are REQUIRED (a 400 without either) and must be ISO-8601 strings.
 * There is NO single-post-by-id endpoint (`GET /posts/{id}` is a 404), so this
 * window is how we read a post object back. The body parses leniently (the post
 * `content` carries unescaped newlines). A non-2xx / unparseable body degrades to
 * an empty list — the caller treats it as "not resolved yet", not a hard failure.
 */
export async function getDatedPosts(): Promise<PostizListPost[]> {
  const now = Date.now();
  const startDate = new Date(now - LIST_LOOKBACK_MS).toISOString();
  const endDate = new Date(now + LIST_LOOKAHEAD_MS).toISOString();
  const query = `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

  const response = await postizFetch(`/posts${query}`, { method: "GET" });

  if (!response.ok) {
    return [];
  }

  const raw = await readLenientJson(response);

  // Log the raw body for observability — so the operator can inspect exactly what
  // Postiz returns for each platform (and so we can tighten the resolver from it).
  console.warn(`postiz: GET /posts${query} raw body:`, JSON.stringify(raw));

  const posts = isRecord(raw) && Array.isArray(raw.posts) ? (raw.posts as unknown[]) : [];

  return posts.flatMap((post) =>
    isRecord(post) && typeof post.id === "string" ? [post as PostizListPost] : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Postiz's `/missing` for a post: the provider's recent published content as
 * `[{ id, url }]`, where `id` is the platform's NATIVE content id (e.g. the
 * TikTok aweme id) and `url` is a COVER THUMBNAIL image, NOT a permalink.
 *
 * VERIFIED against live Postiz: `/missing` is populated ONLY while the post's
 * `releaseId === "missing"`. That holds for a TikTok inbox draft the operator
 * finishes in-app (TikTok's API never reports the post back, so `releaseId`
 * stays `"missing"` and `releaseURL` is a useless `…/messages?…` placeholder) —
 * for those we recover the native aweme id here and BUILD the permalink
 * ourselves. A YouTube direct post, by contrast, has Postiz AUTO-POPULATE
 * `releaseId`/`releaseURL` on the post object once published, so its `/missing`
 * returns `[]` and we read the URL straight off the post (see `resolveSocialUrl`).
 *
 * A non-2xx degrades to an empty list — the caller treats "no id yet" as a
 * best-effort miss, not a hard failure (docs: GET /public/v1/posts/{postId}/missing).
 */
export async function getMissingContent(
  postId: string,
): Promise<Array<{ id: string; url: string }>> {
  const response = await postizFetch(`/posts/${postId}/missing`, { method: "GET" });

  if (!response.ok) {
    return [];
  }

  const raw = await readLenientJson(response);

  // Log the FULL raw body so the operator can inspect exactly what Postiz returns
  // for the TikTok path (and so we can tighten the permalink builder from real data).
  console.warn(`postiz: /posts/${postId}/missing raw body:`, JSON.stringify(raw));

  const items = Array.isArray(raw) ? (raw as Array<{ id?: unknown; url?: unknown }>) : [];

  return items.flatMap((item) =>
    typeof item.id === "string" && typeof item.url === "string"
      ? [{ id: item.id, url: item.url }]
      : [],
  );
}

// The owned-channel handle the TikTok permalink is built under (@fluncle).
const TIKTOK_HANDLE = "fluncle";

/**
 * Build a public TikTok permalink from the native aweme id (the `/missing` `id`).
 * TikTok's API never reports a finished inbox draft back to Postiz, so its
 * `releaseURL` is a useless `…/messages?…` placeholder — we recover the aweme id
 * from `/missing` and build `https://www.tiktok.com/@fluncle/video/<awemeId>`.
 * Defensive: an empty/whitespace id yields null rather than a broken link, and
 * any already-absolute URL (in case Postiz ever returns one in `id`) passes through.
 */
export function permalinkFromMissingId(platform: string, id: string): string | null {
  const trimmed = id.trim();

  if (!trimmed) {
    return null;
  }

  // Defensive: if Postiz ever hands back a full URL in `id`, keep it verbatim.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (platform === "tiktok") {
    return `https://www.tiktok.com/@${TIKTOK_HANDLE}/video/${encodeURIComponent(trimmed)}`;
  }

  // YouTube reads its URL straight off the post's `releaseURL` (see
  // `resolveSocialUrl`); any other platform isn't auto-captured.
  return null;
}

/** Whether a string is a real YouTube watch/share URL — the shape Postiz
 *  auto-populates into `releaseURL` for a published YouTube post (a
 *  `youtube.com`/`youtu.be` https link). Guards against the `…/messages?…`
 *  placeholder Postiz returns for an unfinished post. */
export function isYouTubeUrl(value: string): boolean {
  return /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(value.trim());
}

// A bare YouTube videoId: 11 chars of the URL-safe base64 alphabet.
const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;
// Pull the videoId out of a watch (`v=…`) or shorts (`shorts/…`) URL.
const YOUTUBE_ID_FROM_URL = /(?:shorts\/|v=)([\w-]{11})/;

/**
 * The canonical Short permalink for a published YouTube post. Every Fluncle
 * video is uploaded as a Short, so we capture one consistent
 * `https://www.youtube.com/shorts/<id>` form rather than Postiz's `watch?v=<id>`
 * `releaseURL`. Prefer the post's `releaseId` (which IS the 11-char videoId);
 * as a defensive fallback, extract the id from the `releaseURL` (watch or shorts
 * shape). Returns null when neither yields a real id, so a malformed URL (a bare
 * `/shorts/`) is never built.
 */
export function youtubeShortUrl(releaseId: string, releaseUrl: string): string | null {
  if (YOUTUBE_VIDEO_ID.test(releaseId)) {
    return `https://www.youtube.com/shorts/${releaseId}`;
  }

  const fromUrl = releaseUrl.match(YOUTUBE_ID_FROM_URL)?.[1];

  return fromUrl ? `https://www.youtube.com/shorts/${fromUrl}` : null;
}

/** A resolved post's public permalink + the platform's native content id (used
 *  to set the Postiz release-id for analytics). For YouTube the `nativeId` is the
 *  videoId Postiz auto-populated as `releaseId`; for TikTok it's the `/missing`
 *  aweme id. */
export type ResolvedSocialContent = { nativeId: string; url: string };

/**
 * Resolve the live permalink for a pushed post. Verified against live Postiz —
 * the path splits by platform:
 *
 *   - YouTube: a direct Short. Once published, Postiz AUTO-POPULATES `releaseId`
 *     (the videoId) and `releaseURL` (a `watch?v=<id>` URL) ON the post object, and
 *     its `/missing` returns `[]`. So read the dated `/posts` list, find this post
 *     by id, and if it's PUBLISHED with a real videoId + YouTube `releaseURL`,
 *     return the canonical `…/shorts/<id>` form (built from `releaseId`) so every
 *     captured URL is one consistent shape. Not yet published → null (the sweep
 *     retries next tick).
 *   - TikTok: an inbox draft the operator finishes in-app. `releaseId` stays
 *     `"missing"` and `releaseURL` is a `…/messages?…` placeholder, so fall back
 *     to `/missing` and BUILD `…/@fluncle/video/<awemeId>` from the newest item's
 *     native id. The one-pending push gate keeps "newest" unambiguous. Empty →
 *     null (not finished in-app yet; retry).
 *
 * Returns the permalink AND the native id (for the release-id link), or null on a
 * miss — the caller leaves the row's `url` unset, so the operator's manual
 * "Update URL" (or the next sweep tick) is the fallback.
 */
export async function resolveSocialUrl(
  postId: string,
  platform: string,
): Promise<ResolvedSocialContent | null> {
  if (platform === "youtube") {
    return resolveYouTubeFromList(postId);
  }

  if (platform === "tiktok") {
    return resolveTikTokFromMissing(postId);
  }

  return null;
}

/** The YouTube path: find the post in the dated list; if published with a real
 *  auto-populated `releaseURL`, build the canonical `…/shorts/<id>` permalink from
 *  the videoId (never capture Postiz's `watch?v=<id>` shape). */
async function resolveYouTubeFromList(postId: string): Promise<ResolvedSocialContent | null> {
  const posts = await getDatedPosts();
  const post = posts.find((item) => item.id === postId);

  if (!post || post.state !== "PUBLISHED") {
    return null;
  }

  const releaseId = typeof post.releaseId === "string" ? post.releaseId.trim() : "";
  const releaseUrl = typeof post.releaseURL === "string" ? post.releaseURL.trim() : "";

  // A genuine published YouTube post has BOTH a real videoId (`releaseId`, not
  // "" / "missing") AND a real YouTube `releaseURL`. Capture the canonical Short
  // form, built from the videoId (or recovered from the URL as a fallback).
  if (releaseId && releaseId !== "missing" && isYouTubeUrl(releaseUrl)) {
    const shortUrl = youtubeShortUrl(releaseId, releaseUrl);

    if (shortUrl) {
      return { nativeId: releaseId, url: shortUrl };
    }
  }

  return null;
}

/** The TikTok path: poll `/missing` for the native aweme id and build the
 *  permalink. The publish is async (the operator finishes in-app), so a longer
 *  lag simply falls back to the manual entry / the next sweep tick. */
async function resolveTikTokFromMissing(postId: string): Promise<ResolvedSocialContent | null> {
  const items = await getMissingContent(postId);

  // Most-recent-first; build a permalink from the newest item's native aweme id.
  for (const item of items) {
    const permalink = permalinkFromMissingId("tiktok", item.id);

    if (permalink) {
      return { nativeId: item.id, url: permalink };
    }
  }

  return null;
}

/**
 * Connect a published Postiz post to its live content for Postiz analytics:
 * `PUT /posts/{postId}/release-id` with the platform's native content id. Postiz
 * uses this link to pull engagement metrics for the post. For a YouTube direct
 * post Postiz already auto-populates the same `releaseId`, so this is an
 * idempotent no-op re-set; for a captured TikTok aweme id it's the real link.
 * Guarded against an empty/`"missing"` id (nothing to link). Best-effort — a
 * non-2xx is logged and swallowed so a capture sweep never fails on the link.
 */
export async function postizSetReleaseId(postId: string, releaseId: string): Promise<void> {
  const trimmed = releaseId.trim();

  // Nothing to link: never PUT an empty / placeholder id.
  if (!trimmed || trimmed === "missing") {
    return;
  }

  const response = await postizFetch(`/posts/${postId}/release-id`, {
    body: JSON.stringify({ releaseId: trimmed }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    console.warn(`postiz: release-id link failed for ${postId} (${response.status})`);
  }
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

/**
 * Push an Instagram Reel directly (public). The clip drip-feed's IG leg: the clip's own
 * live-mixed set audio survives (a set fingerprints differently from a single copyrighted
 * master — the audio-survival spike passed, clip-drip-feed RFC Unit 0), so unlike the
 * old manual-only IG path we post the with-audio cut straight through Postiz. A single
 * video + `post_type: "post"` = a Reel; `type: "now"` fires it (the drip cron calls this
 * at the clip's due time). The `__type` MUST be the connected integration's own
 * identifier (Creator accounts surface as `instagram` or `instagram-standalone`), so we
 * resolve it live and echo it back. The operator validates ONE real post before the drip
 * cron is enabled; the global kill switch (clip-social.ts) is the ongoing guard.
 */
export async function pushInstagramReel(input: {
  caption: string;
  videoUrl: string;
}): Promise<{ postId: string }> {
  const integration = await resolveIntegration(["instagram", "instagram-standalone"]);
  const media = await uploadFromUrl(input.videoUrl);

  return createPost({
    content: input.caption,
    integrationId: integration.id,
    media,
    settings: {
      __type: integration.identifier,
      post_type: "post",
    },
  });
}

/**
 * Push a YouTube Short directly (public). We deliberately set NO custom
 * thumbnail: YouTube's auto-picked frame from each bespoke-shader video reads
 * better than a flat cover plate, so we keep the auto-frame. The push carries
 * title + caption.
 */
export async function pushYouTubeShort(input: {
  description: string;
  title: string;
  videoUrl: string;
}): Promise<{ postId: string }> {
  const integrationId = await resolveIntegrationId(["youtube"]);
  const media = await uploadFromUrl(input.videoUrl);

  return createPost({
    content: input.description,
    integrationId,
    media,
    settings: {
      __type: "youtube",
      selfDeclaredMadeForKids: "no",
      tags: [],
      thumbnail: null,
      title: input.title.slice(0, YT_TITLE_MAX),
      type: "public",
    },
  });
}
