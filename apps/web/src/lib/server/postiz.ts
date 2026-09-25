import { readEnv, readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

const DEFAULT_BASE = "https://api.postiz.com/public/v1";

const YT_TITLE_MAX = 100;

type Integration = {
  disabled?: boolean;
  id: string;
  identifier: string;
  name?: string;
  profile?: string;
};

type Media = { id: string; path: string };

async function postizFetch(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const key = await readEnv("POSTIZ_API_KEY");
  const base = (await readOptionalEnv("POSTIZ_API_URL")) ?? DEFAULT_BASE;

  return fetchImpl(`${base}${path}`, {
    ...init,
    headers: { Authorization: key, ...(init.headers as Record<string, string> | undefined) },
  });
}

async function resolveIntegration(
  candidates: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; identifier: string }> {
  const response = await postizFetch("/integrations", { method: "GET" }, fetchImpl);

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

async function resolveIntegrationId(candidates: string[]): Promise<string> {
  return (await resolveIntegration(candidates)).id;
}

export type PostizMetric = { label: string; latestTotal: number };

export async function getPostizPlatformAnalytics(
  candidates: string[],
  days = 7,
  fetchImpl: typeof fetch = fetch,
): Promise<PostizMetric[]> {
  const { id } = await resolveIntegration(candidates, fetchImpl);
  const response = await postizFetch(`/analytics/${id}?date=${days}`, { method: "GET" }, fetchImpl);

  if (!response.ok) {
    throw new ApiError("postiz_analytics", `Postiz analytics failed (${response.status})`, 502);
  }

  const body = (await response.json()) as unknown;

  if (!Array.isArray(body)) {
    throw new ApiError(
      "postiz_analytics_shape",
      "Postiz analytics returned a non-array payload",
      502,
    );
  }

  const list = body as {
    data?: { date?: string; total?: unknown }[];
    label?: string;
  }[];

  const metrics: PostizMetric[] = [];

  for (const entry of list) {
    const latest = entry.data?.at(-1)?.total;
    const value = typeof latest === "string" ? Number(latest) : latest;

    if (entry.label && typeof value === "number" && Number.isFinite(value)) {
      metrics.push({ label: entry.label, latestTotal: Math.trunc(value) });
    }
  }

  return metrics;
}

export type SocialPostMetrics = {
  averageViewPercentage: null | number;
  comments: null | number;
  impressions: null | number;
  likes: null | number;
  saves: null | number;
  shares: null | number;
  views: null | number;
  watchTimeSeconds: null | number;
};

export type PostAnalyticsResult =
  | { kind: "metrics"; metrics: SocialPostMetrics }
  | { kind: "missing" };

function latestTotal(data: unknown): null | number {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const last = data.at(-1) as { total?: unknown } | undefined;
  const raw = last?.total;
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;

  return Number.isFinite(value) ? value : null;
}

export function parsePostAnalytics(raw: unknown): PostAnalyticsResult {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    if ((raw as Record<string, unknown>).missing === true) {
      return { kind: "missing" };
    }
  }

  const metrics: SocialPostMetrics = {
    averageViewPercentage: null,
    comments: null,
    impressions: null,
    likes: null,
    saves: null,
    shares: null,
    views: null,
    watchTimeSeconds: null,
  };

  const entries = Array.isArray(raw) ? (raw as { data?: unknown; label?: unknown }[]) : [];

  for (const entry of entries) {
    if (typeof entry.label !== "string") {
      continue;
    }

    const label = entry.label.toLowerCase();
    const value = latestTotal(entry.data);

    if (value === null) {
      continue;
    }

    if (label.includes("average") || label.includes("percentage") || label.includes("retention")) {
      metrics.averageViewPercentage = value;
    } else if (label.includes("watch")) {
      metrics.watchTimeSeconds = Math.trunc(value);
    } else if (label.includes("impression") || label.includes("reach")) {
      metrics.impressions = Math.trunc(value);
    } else if (label.includes("comment")) {
      metrics.comments = Math.trunc(value);
    } else if (label.includes("share") || label.includes("repost") || label.includes("retweet")) {
      metrics.shares = Math.trunc(value);
    } else if (label.includes("save") || label.includes("bookmark") || label.includes("favorite")) {
      metrics.saves = Math.trunc(value);
    } else if (label.includes("like")) {
      metrics.likes = Math.trunc(value);
    } else if (label.includes("view") || label.includes("play")) {
      metrics.views = Math.trunc(value);
    }
  }

  return { kind: "metrics", metrics };
}

export async function getPostizPostAnalytics(
  postId: string,
  days = 7,
  fetchImpl: typeof fetch = fetch,
): Promise<PostAnalyticsResult> {
  const response = await postizFetch(
    `/analytics/post/${encodeURIComponent(postId)}?date=${days}`,
    { method: "GET" },
    fetchImpl,
  );

  if (!response.ok) {
    throw new ApiError(
      "postiz_post_analytics",
      `Postiz post analytics failed (${response.status})`,
      502,
    );
  }

  return parsePostAnalytics(await readLenientJson(response));
}

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

async function createPost(input: {
  content: string;
  integrationId: string;
  media: Media;
  settings: Record<string, unknown>;
}): Promise<{ postId: string }> {
  const body = {
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

async function readLenientJson(response: Response): Promise<unknown> {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
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

export type PostizListPost = {
  content?: string;
  id: string;
  integration?: { providerIdentifier?: string };
  publishDate?: string;
  releaseId?: string | null;
  releaseURL?: string | null;
  state?: string;
};

const LIST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_LOOKAHEAD_MS = 1 * 24 * 60 * 60 * 1000;

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

  logEvent("warn", "postiz.posts-raw-body", { query, raw });

  const posts = isRecord(raw) && Array.isArray(raw.posts) ? (raw.posts as unknown[]) : [];

  return posts.flatMap((post) =>
    isRecord(post) && typeof post.id === "string" ? [post as PostizListPost] : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function getMissingContent(
  postId: string,
): Promise<Array<{ id: string; url: string }>> {
  const response = await postizFetch(`/posts/${postId}/missing`, { method: "GET" });

  if (!response.ok) {
    return [];
  }

  const raw = await readLenientJson(response);

  logEvent("warn", "postiz.missing-raw-body", { postId, raw });

  const items = Array.isArray(raw) ? (raw as Array<{ id?: unknown; url?: unknown }>) : [];

  return items.flatMap((item) =>
    typeof item.id === "string" && typeof item.url === "string"
      ? [{ id: item.id, url: item.url }]
      : [],
  );
}

const TIKTOK_HANDLE = "fluncle";

export function permalinkFromMissingId(platform: string, id: string): string | null {
  const trimmed = id.trim();

  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (platform === "tiktok") {
    return `https://www.tiktok.com/@${TIKTOK_HANDLE}/video/${encodeURIComponent(trimmed)}`;
  }

  return null;
}

export function isYouTubeUrl(value: string): boolean {
  return /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(value.trim());
}

export function isInstagramUrl(value: string): boolean {
  return /^https:\/\/(www\.)?instagram\.com\//i.test(value.trim());
}

const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;

const YOUTUBE_ID_FROM_URL = /(?:shorts\/|v=)([\w-]{11})/;

export function youtubeShortUrl(releaseId: string, releaseUrl: string): string | null {
  if (YOUTUBE_VIDEO_ID.test(releaseId)) {
    return `https://www.youtube.com/shorts/${releaseId}`;
  }

  const fromUrl = releaseUrl.match(YOUTUBE_ID_FROM_URL)?.[1];

  return fromUrl ? `https://www.youtube.com/shorts/${fromUrl}` : null;
}

export type ResolvedSocialContent = { nativeId: string; url: string };

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

  if (platform === "instagram") {
    return resolveInstagramFromList(postId);
  }

  return null;
}

async function resolveYouTubeFromList(postId: string): Promise<ResolvedSocialContent | null> {
  const posts = await getDatedPosts();
  const post = posts.find((item) => item.id === postId);

  if (!post || post.state !== "PUBLISHED") {
    return null;
  }

  const releaseId = typeof post.releaseId === "string" ? post.releaseId.trim() : "";
  const releaseUrl = typeof post.releaseURL === "string" ? post.releaseURL.trim() : "";

  if (releaseId && releaseId !== "missing" && isYouTubeUrl(releaseUrl)) {
    const shortUrl = youtubeShortUrl(releaseId, releaseUrl);

    if (shortUrl) {
      return { nativeId: releaseId, url: shortUrl };
    }
  }

  return null;
}

async function resolveTikTokFromMissing(postId: string): Promise<ResolvedSocialContent | null> {
  const items = await getMissingContent(postId);

  for (const item of items) {
    const permalink = permalinkFromMissingId("tiktok", item.id);

    if (permalink) {
      return { nativeId: item.id, url: permalink };
    }
  }

  return null;
}

async function resolveInstagramFromList(postId: string): Promise<ResolvedSocialContent | null> {
  const posts = await getDatedPosts();
  const post = posts.find((item) => item.id === postId);

  if (!post || post.state !== "PUBLISHED") {
    return null;
  }

  const releaseId = typeof post.releaseId === "string" ? post.releaseId.trim() : "";
  const releaseUrl = typeof post.releaseURL === "string" ? post.releaseURL.trim() : "";

  if (isInstagramUrl(releaseUrl)) {
    return { nativeId: releaseId, url: releaseUrl };
  }

  return null;
}

export async function postizSetReleaseId(postId: string, releaseId: string): Promise<void> {
  const trimmed = releaseId.trim();

  if (!trimmed || trimmed === "missing") {
    return;
  }

  const response = await postizFetch(`/posts/${postId}/release-id`, {
    body: JSON.stringify({ releaseId: trimmed }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  if (!response.ok) {
    logEvent("warn", "postiz.release-link-failed", { postId, status: response.status });
  }
}

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
      content_posting_method: "UPLOAD",
      duet: false,
      privacy_level: "SELF_ONLY",
      stitch: false,
      title: "",
      video_made_with_ai: false,
    },
  });
}

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
