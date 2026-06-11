import { basename } from "node:path";
import { adminApiGet, adminApiPostForm, publicApiGet } from "../api";

type PreviewArchiveResult = {
  archivedAt: string;
  key: string;
  logId: string;
  mime: string;
  ok: true;
  source: string;
  trackId: string;
};

type PreviewArchiveStatus = {
  archived: boolean;
  key?: string;
  ok: true;
  trackId: string;
};

type Track = {
  artists: string[];
  isrc?: string;
  logId?: string;
  previewUrl?: string;
  title: string;
  trackId: string;
};

type TracksResponse = {
  nextCursor?: string;
  totalCount: number;
  tracks: Track[];
};

type ResolvedPreview = {
  bytes: ArrayBuffer;
  mime: string;
  source: string;
};

export type PreviewArchiveUploadOptions = {
  file: string;
  mime: string;
  source: string;
};

export async function previewArchiveUploadCommand(
  idOrLogId: string,
  options: PreviewArchiveUploadOptions,
): Promise<PreviewArchiveResult> {
  const form = new FormData();
  form.append("preview", Bun.file(options.file), basename(options.file));
  form.append("source", options.source);
  form.append("mime", options.mime);

  return adminApiPostForm<PreviewArchiveResult>(
    `/api/admin/tracks/${encodeURIComponent(idOrLogId)}/preview-archive`,
    form,
  );
}

export type PreviewArchiveBackfillOptions = {
  dryRun: boolean;
  limit?: number;
};

export type PreviewArchiveBackfillResult = {
  archived: Array<{ logId: string; source: string; trackId: string }>;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  skipped: Array<{ reason: string; trackId: string }>;
};

export async function previewArchiveBackfillCommand(
  options: PreviewArchiveBackfillOptions,
): Promise<PreviewArchiveBackfillResult> {
  const result: PreviewArchiveBackfillResult = {
    archived: [],
    dryRun: options.dryRun,
    failed: [],
    skipped: [],
  };
  let cursor: string | undefined;

  while (result.archived.length < (options.limit ?? Number.POSITIVE_INFINITY)) {
    const page = await publicApiGet<TracksResponse>(
      `/api/tracks?limit=48${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );

    for (const track of page.tracks) {
      if (result.archived.length >= (options.limit ?? Number.POSITIVE_INFINITY)) {
        break;
      }

      if (!track.logId) {
        result.skipped.push({ reason: "no_log_id", trackId: track.trackId });
        continue;
      }

      const status = await adminApiGet<PreviewArchiveStatus>(
        `/api/admin/tracks/${encodeURIComponent(track.trackId)}/preview-archive`,
      );

      if (status.archived) {
        result.skipped.push({ reason: "already_archived", trackId: track.trackId });
        continue;
      }

      try {
        const preview = await resolvePreview(track);

        if (!preview) {
          result.skipped.push({ reason: "no_preview", trackId: track.trackId });
          continue;
        }

        if (!options.dryRun) {
          await uploadResolvedPreview(track.trackId, preview);
        }

        result.archived.push({
          logId: track.logId,
          source: preview.source,
          trackId: track.trackId,
        });
      } catch (error) {
        result.failed.push({
          error: error instanceof Error ? error.message : String(error),
          trackId: track.trackId,
        });
      }
    }

    if (!page.nextCursor) {
      break;
    }

    cursor = page.nextCursor;
  }

  return result;
}

async function uploadResolvedPreview(trackId: string, preview: ResolvedPreview): Promise<void> {
  const form = new FormData();
  const extension = extensionForMime(preview.mime);
  form.append("preview", new Blob([preview.bytes], { type: preview.mime }), `preview.${extension}`);
  form.append("source", preview.source);
  form.append("mime", preview.mime);

  await adminApiPostForm(`/api/admin/tracks/${encodeURIComponent(trackId)}/preview-archive`, form);
}

async function resolvePreview(track: Track): Promise<ResolvedPreview | undefined> {
  const stored = await downloadPreview(track.previewUrl, "deezer:stored");

  if (stored) {
    return stored;
  }

  const deezerIsrc = await resolveDeezerByIsrc(track.isrc);

  if (deezerIsrc) {
    return deezerIsrc;
  }

  const deezerSearch = await resolveDeezerSearch(track);

  if (deezerSearch) {
    return deezerSearch;
  }

  return resolveItunes(track);
}

async function resolveDeezerByIsrc(isrc: string | undefined): Promise<ResolvedPreview | undefined> {
  if (!isrc?.trim()) {
    return undefined;
  }

  try {
    const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
    const body = (await response.json()) as { error?: unknown; preview?: string };

    if (body.error) {
      return undefined;
    }

    return downloadPreview(body.preview, "deezer:isrc");
  } catch {
    return undefined;
  }
}

async function resolveDeezerSearch(track: Track): Promise<ResolvedPreview | undefined> {
  const artist = track.artists[0]?.trim();

  if (!artist || !track.title.trim()) {
    return undefined;
  }

  try {
    const query = `artist:"${artist}" track:"${track.title.trim()}"`;
    const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
    const body = (await response.json()) as {
      data?: Array<{ artist?: { name?: string }; preview?: string; title?: string }>;
    };
    const hit = (body.data ?? []).find((item) => item.preview);

    return downloadPreview(hit?.preview, "deezer:search");
  } catch {
    return undefined;
  }
}

async function resolveItunes(track: Track): Promise<ResolvedPreview | undefined> {
  const artist = track.artists[0]?.trim();

  if (!artist || !track.title.trim()) {
    return undefined;
  }

  try {
    const response = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${track.title}`)}&media=music&limit=10`,
    );
    const body = (await response.json()) as {
      results?: Array<{ artistName?: string; previewUrl?: string; trackName?: string }>;
    };
    const hit = (body.results ?? []).find(
      (item) => item.previewUrl && normalize(item.artistName ?? "").includes(normalize(artist)),
    );

    return downloadPreview(hit?.previewUrl, "itunes");
  } catch {
    return undefined;
  }
}

async function downloadPreview(
  url: string | undefined,
  source: string,
): Promise<ResolvedPreview | undefined> {
  if (!url) {
    return undefined;
  }

  const response = await fetch(url);

  if (!response.ok && response.status !== 206) {
    return undefined;
  }

  const bytes = await response.arrayBuffer();
  const mime = normalizeMime(response.headers.get("content-type") ?? "") ?? inferMimeFromUrl(url);

  if (!mime) {
    throw new Error(`Could not infer preview MIME type for ${source}`);
  }

  return { bytes, mime, source };
}

function normalizeMime(value: string): string | undefined {
  const mime = value.split(";")[0]?.trim().toLowerCase();

  if (mime === "audio/mpeg" || mime === "audio/mp3") {
    return "audio/mpeg";
  }

  if (mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a") {
    return "audio/mp4";
  }

  if (mime === "audio/aac") {
    return "audio/aac";
  }

  return undefined;
}

function inferMimeFromUrl(url: string): string | undefined {
  const pathname = new URL(url).pathname.toLowerCase();

  if (pathname.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  if (pathname.endsWith(".m4a")) {
    return "audio/mp4";
  }

  if (pathname.endsWith(".aac")) {
    return "audio/aac";
  }

  return undefined;
}

function extensionForMime(mime: string): string {
  if (mime === "audio/mpeg") {
    return "mp3";
  }

  if (mime === "audio/mp4") {
    return "m4a";
  }

  if (mime === "audio/aac") {
    return "aac";
  }

  return "bin";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
