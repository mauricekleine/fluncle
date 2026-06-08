import { adminApiPatch, publicApiGet } from "../api";

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
