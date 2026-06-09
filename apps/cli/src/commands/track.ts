import { adminApiPatch, adminApiPostForm, publicApiGet } from "../api";

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
    tags?: string[];
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
  tags?: string[];
  tagsSource?: "auto" | "manual";
  videoUrl?: string;
};

type TrackUpdateResult = {
  fields: string[];
  ok: true;
  trackId: string;
};

export type TrackVideoOptions = {
  caption?: string;
  poster?: string;
  review?: string;
  social?: string;
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

  append("review", files.review, "review.mp4");
  append("social", files.social, "social.mp4");
  append("poster", files.poster, "poster.jpg");
  append("caption", files.caption, "caption.txt");

  return adminApiPostForm<TrackVideoResult>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/video`,
    form,
  );
}

export async function trackUpdateCommand(
  trackId: string,
  options: TrackUpdateOptions,
): Promise<TrackUpdateResult> {
  // Provenance defaults to "manual" (the operator path); the enrichment agent
  // passes "auto". Manual always wins server-side (auto never clobbers manual).
  const body: Record<string, unknown> = { tagsSource: options.tagsSource ?? "manual" };

  if (options.tags !== undefined) {
    body.tags = options.tags;
  }
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
