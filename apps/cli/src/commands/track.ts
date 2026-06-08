import { adminApiPatch } from "../api";

export type TrackUpdateOptions = {
  bpm?: number;
  key?: string;
  note?: string;
  status?: string;
  tags?: string[];
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
  // Admin/manual edit → provenance is "manual" (never overwritten by the agent).
  const body: Record<string, unknown> = { tagsSource: "manual" };

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
  if (options.note !== undefined) {
    body.note = options.note;
  }

  return adminApiPatch<TrackUpdateResult>(`/api/admin/tracks/${encodeURIComponent(trackId)}`, body);
}
