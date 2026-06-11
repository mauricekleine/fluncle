import { adminApiGet, adminApiPatch, adminApiPost, adminApiPostForm, publicApiGet } from "../api";

export type TrackGetResult = {
  ok: true;
  track: {
    artists: string[];
    bpm?: number;
    durationMs: number;
    enrichmentStatus: string;
    isrc?: string;
    key?: string;
    label?: string;
    logId?: string;
    title: string;
    trackId: string;
  };
};

export async function trackGetCommand(idOrLogId: string): Promise<TrackGetResult> {
  return publicApiGet<TrackGetResult>(`/api/tracks/${encodeURIComponent(idOrLogId)}`);
}

export type TrackUpdateOptions = {
  bpm?: number;
  features?: string;
  key?: string;
  note?: string;
  status?: string;
  videoUrl?: string;
};

type TrackUpdateResult = {
  fields: string[];
  ok: true;
  trackId: string;
};

export type TrackVideoOptions = {
  composition?: string;
  cover?: string;
  footage?: string;
  footageSilent?: string;
  note?: string;
  poster?: string;
  props?: string;
  render?: string;
};

type TrackVideoResult = {
  logId: string;
  ok: true;
  trackId: string;
  urls: Record<string, string>;
};

// Uploads a track's video bundle (multipart) to the admin endpoint, which stores
// each artifact in R2 under <log-id>/ and links the review cut as video_url.
export async function trackVideoCommand(
  idOrLogId: string,
  files: TrackVideoOptions,
): Promise<TrackVideoResult> {
  const form = new FormData();
  const append = (field: string, filePath: string | undefined, name: string) => {
    if (filePath) {
      form.append(field, Bun.file(filePath), name);
    }
  };

  append("footage", files.footage, "footage.mp4");
  append("footage-silent", files.footageSilent, "footage-silent.mp4");
  append("poster", files.poster, "poster.jpg");
  append("cover", files.cover, "cover.jpg");
  append("note", files.note, "note.txt");
  append("composition", files.composition, "composition.tsx");
  append("props", files.props, "props.json");
  append("render", files.render, "render.json");

  return adminApiPostForm<TrackVideoResult>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video`,
    form,
  );
}

type TrackDraftResult = {
  externalId: string;
  ok: true;
  platform: string;
  status: string;
  trackId: string;
};

// Pushes a platform draft (e.g. TikTok via Postiz) for a track's video.
export async function trackDraftCommand(
  idOrLogId: string,
  platform: string,
): Promise<TrackDraftResult> {
  return adminApiPost(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/social/${platform}/draft`,
  );
}

export type TrackSocialUpdateOptions = {
  scheduledFor?: string;
  status: string;
  url?: string;
};

type TrackSocialUpdateResult = { ok: true; platform: string; status: string; trackId: string };

// Updates a per-platform post's status after manual review/publish in-app.
export async function trackSocialUpdateCommand(
  idOrLogId: string,
  platform: string,
  options: TrackSocialUpdateOptions,
): Promise<TrackSocialUpdateResult> {
  const body: Record<string, unknown> = { status: options.status };

  if (options.url !== undefined) {
    body.url = options.url;
  }

  if (options.scheduledFor !== undefined) {
    body.scheduledFor = options.scheduledFor;
  }

  return adminApiPatch(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/social/${platform}`,
    body,
  );
}

type TrackSocialShowResult = {
  ok: true;
  posts: Array<{
    platform: string;
    publishedAt?: string;
    scheduledFor?: string;
    status: string;
    url?: string;
  }>;
  trackId: string;
};

// Lists a track's per-platform publication state.
export async function trackSocialShowCommand(idOrLogId: string): Promise<TrackSocialShowResult> {
  return adminApiGet(`/api/admin/tracks/${encodeURIComponent(idOrLogId)}/social`);
}

export async function trackUpdateCommand(
  trackId: string,
  options: TrackUpdateOptions,
): Promise<TrackUpdateResult> {
  const body: Record<string, unknown> = {};

  if (options.bpm !== undefined) {
    body.bpm = options.bpm;
  }
  if (options.key !== undefined) {
    body.key = options.key;
  }
  if (options.videoUrl !== undefined) {
    body.videoUrl = options.videoUrl;
  }
  if (options.status !== undefined) {
    body.enrichmentStatus = options.status;
  }
  if (options.features !== undefined) {
    body.features = options.features;
  }
  if (options.note !== undefined) {
    body.note = options.note;
  }

  return adminApiPatch<TrackUpdateResult>(`/api/admin/tracks/${encodeURIComponent(trackId)}`, body);
}
