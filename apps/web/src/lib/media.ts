import { r2PublicUrl } from "@fluncle/contracts/util";

export const FOUND_BASE = "https://found.fluncle.com";

export function mixtapeAudioUrl(logId: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/mixtape.m4a`;
}

export function mixtapeSetVideoUrl(logId: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/set.mp4`;
}

export function recordingSetVideoUrl(r2Key: string): string {
  return r2PublicUrl(FOUND_BASE, r2Key);
}

export function versionedObservationAudioUrl(
  bareUrl: string | undefined,
  generatedAt: string | undefined,
): string | undefined {
  if (!bareUrl) {
    return bareUrl;
  }

  if (!generatedAt) {
    return bareUrl;
  }

  const version = Date.parse(generatedAt);

  if (Number.isNaN(version)) {
    return bareUrl;
  }

  return `${bareUrl}?v=${version}`;
}

export type TrackMedia = {
  coverUrl: string;

  noteUrl: string;

  observationAudioUrl: string;

  observationTextUrl: string;

  observationJsonUrl: string;

  posterUrl: string;

  videoUrl: string;

  socialVideoUrl: string;
};

export function trackMedia(logId: string): TrackMedia {
  const base = `${FOUND_BASE}/${encodeURIComponent(logId)}`;

  return {
    coverUrl: `${base}/cover.jpg`,
    noteUrl: `${base}/note.txt`,
    observationAudioUrl: `${base}/observation.mp3`,
    observationJsonUrl: `${base}/observation.json`,
    observationTextUrl: `${base}/observation.txt`,
    posterUrl: `${base}/poster.jpg`,
    socialVideoUrl: `${base}/footage.social.mp4`,
    videoUrl: `${base}/footage.mp4`,
  };
}

const SPOTIFY_IMAGE_SIZE_CODE = {
  large: "ab67616d0000b273",
  medium: "ab67616d00001e02",
  small: "ab67616d00004851",
} as const;

export type CoverSize = "hub" | "large" | "medium" | "small" | "tile" | "xl";

const OWNED_COVER_WIDTH: Record<CoverSize, number> = {
  hub: 128,
  large: 640,
  medium: 300,
  small: 64,
  tile: 300,
  xl: 1200,
};

export const HUB_COVER_TILE_SIZE: CoverSize = "tile";

export const COVER_TILE_SIZE: CoverSize = "medium";

const SPOTIFY_ALBUM_IMAGE_RE = /^(https:\/\/i\.scdn\.co\/image\/)ab67616d[0-9a-f]{8}([0-9a-f]+)$/;

const SPOTIFY_ARTIST_IMAGE_SIZE_CODE = {
  large: "ab6761610000e5eb",
  medium: "ab67616100005174",
  small: "ab6761610000f178",
} as const;

const SPOTIFY_ARTIST_IMAGE_RE = /^(https:\/\/i\.scdn\.co\/image\/)ab676161[0-9a-f]{8}([0-9a-f]+)$/;

const COVER_ART_ARCHIVE_FRONT_RE =
  /^(https:\/\/coverartarchive\.org\/release\/[0-9a-f-]{36}\/front)(?:-(?:250|500|1200))?(\?.*)?$/;
const COVER_ART_ARCHIVE_WIDTH: Record<Exclude<CoverSize, "large">, number> = {
  hub: 250,
  medium: 500,
  small: 250,
  tile: 250,
  xl: 1200,
};

const IMAGE_TRANSFORM_BASE = `${FOUND_BASE}/cdn-cgi/image`;

const OWNED_COVER_WIDTH_RE = /(\/cdn-cgi\/image\/width=)\d+(,)/;

function ownedCoverVintage(imageUpdatedAt: string | null | undefined): number {
  if (!imageUpdatedAt) {
    return 1;
  }

  const epoch = Date.parse(imageUpdatedAt);

  return Number.isNaN(epoch) ? 1 : epoch;
}

export function ownedCoverUrl(
  imageKey: string | null | undefined,
  imageUpdatedAt: string | null | undefined,
  size: CoverSize = "large",
): string | undefined {
  if (!imageKey) {
    return undefined;
  }

  const source = `${r2PublicUrl(FOUND_BASE, imageKey)}?v=${ownedCoverVintage(imageUpdatedAt)}`;

  return `${IMAGE_TRANSFORM_BASE}/width=${OWNED_COVER_WIDTH[size]},format=auto/${source}`;
}

export function labelLogoUrl(
  imageKey: string | null | undefined,
  imageUpdatedAt: string | null | undefined,
  size: CoverSize = "large",
): string | undefined {
  return ownedCoverUrl(imageKey, imageUpdatedAt, size);
}

export function albumCoverAtSize(url: string | undefined, size: CoverSize): string | undefined {
  if (!url) {
    return url;
  }

  if (OWNED_COVER_WIDTH_RE.test(url)) {
    return url.replace(OWNED_COVER_WIDTH_RE, `$1${OWNED_COVER_WIDTH[size]}$2`);
  }

  const album = SPOTIFY_ALBUM_IMAGE_RE.exec(url);

  if (album) {
    const code =
      SPOTIFY_IMAGE_SIZE_CODE[
        size === "xl" ? "large" : size === "tile" || size === "hub" ? "medium" : size
      ];

    return `${album[1]}${code}${album[2]}`;
  }

  const artist = SPOTIFY_ARTIST_IMAGE_RE.exec(url);

  if (artist) {
    const code =
      SPOTIFY_ARTIST_IMAGE_SIZE_CODE[
        size === "xl" ? "large" : size === "tile" ? "medium" : size === "hub" ? "small" : size
      ];

    return `${artist[1]}${code}${artist[2]}`;
  }

  const coverArtArchive = COVER_ART_ARCHIVE_FRONT_RE.exec(url);

  if (coverArtArchive) {
    if (size === "large") {
      return url;
    }

    return `${coverArtArchive[1]}-${COVER_ART_ARCHIVE_WIDTH[size]}${coverArtArchive[2] ?? ""}`;
  }

  return url;
}

export function hubCoverSrcSet(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  const small = albumCoverAtSize(url, "hub");
  const large = albumCoverAtSize(url, "tile");

  if (!small || !large) {
    return undefined;
  }

  if (OWNED_COVER_WIDTH_RE.test(url)) {
    return `${small} 128w, ${large} 300w`;
  }

  if (SPOTIFY_ARTIST_IMAGE_RE.test(url)) {
    return `${small} 160w, ${large} 320w`;
  }

  if (SPOTIFY_ALBUM_IMAGE_RE.test(url)) {
    const thumbnail = albumCoverAtSize(url, "small");

    return thumbnail ? `${thumbnail} 64w, ${large} 300w` : undefined;
  }

  if (COVER_ART_ARCHIVE_FRONT_RE.test(url)) {
    const medium = albumCoverAtSize(url, "medium");

    return medium && medium !== small ? `${small} 250w, ${medium} 500w` : undefined;
  }

  return undefined;
}

export function freshStandoutSrcSet(url: string | undefined): string | undefined {
  const hub = hubCoverSrcSet(url);

  if (!url || !hub) {
    return undefined;
  }

  if (COVER_ART_ARCHIVE_FRONT_RE.test(url)) {
    const xl = albumCoverAtSize(url, "xl");

    return xl ? `${hub}, ${xl} 1200w` : hub;
  }

  const large = albumCoverAtSize(url, "large");

  return large ? `${hub}, ${large} 640w` : hub;
}

export function bestAlbumCoverUrl(cover: {
  imageKey: string | null | undefined;
  imageState: string | null | undefined;
  imageUpdatedAt: string | null | undefined;
  spotifyUrl: string | null | undefined;
}): string | undefined {
  if (cover.imageState === "resolved") {
    const owned = ownedCoverUrl(cover.imageKey, cover.imageUpdatedAt, "large");

    if (owned) {
      return owned;
    }
  }

  return albumCoverAtSize(cover.spotifyUrl ?? undefined, "large");
}

export function bestArtistAvatarUrl(avatar: {
  imageKey: string | null | undefined;
  imageState: string | null | undefined;
  imageUpdatedAt: string | null | undefined;
  imageUrl: string | null | undefined;
}): string | undefined {
  if (avatar.imageState === "resolved") {
    const owned = ownedCoverUrl(avatar.imageKey, avatar.imageUpdatedAt, "large");

    if (owned) {
      return owned;
    }
  }

  return albumCoverAtSize(avatar.imageUrl ?? undefined, "large");
}

function avatarKey(userId: string, ext: string): string {
  return `avatars/${userId}.${ext}`;
}

export function avatarDisplayUrl(
  userId: string,
  ext: string,
  version: number,
  width = 256,
): string {
  const source = `${r2PublicUrl(FOUND_BASE, avatarKey(userId, ext))}?v=${version}`;

  return `${IMAGE_TRANSFORM_BASE}/width=${width},format=auto/${source}`;
}

const MEDIA_TRANSFORM_BASE = `${FOUND_BASE}/cdn-cgi/media`;

const TRANSFORM_VERSION = 1;

export function videoVersion(stamp: string | null | undefined): number | undefined {
  if (!stamp) {
    return undefined;
  }

  const epoch = Date.parse(stamp);

  return Number.isNaN(epoch) ? undefined : epoch;
}

function versionedSource(source: string, version?: number): string {
  return `${source}?v=${version ?? TRANSFORM_VERSION}`;
}

export type RenditionWidth = 360 | 480 | 720 | 1080;

export function videoRendition(
  logId: string,
  {
    master = "footage.mp4",
    version,
    width,
  }: { master?: string; version?: number; width: RenditionWidth },
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/${master}`, version);

  return `${MEDIA_TRANSFORM_BASE}/mode=video,width=${width}/${source}`;
}

export function videoPoster(logId: string, master = "footage.mp4", version?: number): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/${master}`, version);

  return `${MEDIA_TRANSFORM_BASE}/mode=frame,time=0s,format=jpg/${source}`;
}

export type CropOrientation = "landscape" | "portrait";

const CROP_GEOMETRY: Record<CropOrientation, { nativeWidth: number; ratio: number }> = {
  landscape: { nativeWidth: 1920, ratio: 9 / 16 },
  portrait: { nativeWidth: 1080, ratio: 16 / 9 },
};

export function videoCrop(
  logId: string,
  orientation: CropOrientation,
  width?: number,
  silent = false,
  version?: number,
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`, version);
  const { nativeWidth, ratio } = CROP_GEOMETRY[orientation];
  const cropWidth = width ?? nativeWidth;
  const cropHeight = Math.round(cropWidth * ratio);

  const audio = silent ? ",audio=false" : "";

  return `${MEDIA_TRANSFORM_BASE}/fit=cover,width=${cropWidth},height=${cropHeight}${audio}/${source}`;
}

export function videoCropPoster(
  logId: string,
  orientation: CropOrientation,
  width?: number,
  atSeconds = 0,
  version?: number,
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`, version);
  const { nativeWidth, ratio } = CROP_GEOMETRY[orientation];
  const cropWidth = width ?? nativeWidth;
  const cropHeight = Math.round(cropWidth * ratio);
  const time = Math.max(0, Math.floor(atSeconds));

  return `${MEDIA_TRANSFORM_BASE}/fit=cover,width=${cropWidth},height=${cropHeight},mode=frame,time=${time}s,format=jpg/${source}`;
}

export function videoClipCrop(
  logId: string,
  orientation: CropOrientation,
  startSeconds: number,
  width?: number,
  durationSeconds = 60,
  version?: number,
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`, version);
  const { nativeWidth, ratio } = CROP_GEOMETRY[orientation];
  const cropWidth = width ?? nativeWidth;
  const cropHeight = Math.round(cropWidth * ratio);
  const start = Math.max(0, Math.floor(startSeconds));

  const duration = Math.min(60, Math.max(1, Math.floor(durationSeconds)));

  return `${MEDIA_TRANSFORM_BASE}/fit=cover,width=${cropWidth},height=${cropHeight},audio=false,time=${start}s,duration=${duration}s/${source}`;
}

const AUDIO_STRIPPED_WIDTH = 1080;

export function videoAudioStripped(source: string, version?: number): string {
  return `${MEDIA_TRANSFORM_BASE}/mode=video,audio=false,width=${AUDIO_STRIPPED_WIDTH}/${versionedSource(source, version)}`;
}

const PURGE_RENDITION_WIDTHS: readonly RenditionWidth[] = [360, 480, 720, 1080];

export function videoPurgeUrls(
  logId: string,
  { squared, version }: { squared: boolean; version?: number },
): string[] {
  const media = trackMedia(logId);
  const urls = new Set<string>();

  urls.add(media.videoUrl);
  urls.add(media.socialVideoUrl);

  urls.add(videoAudioStripped(media.socialVideoUrl, version));

  urls.add(media.posterUrl);
  urls.add(media.coverUrl);

  if (squared) {
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const width of PURGE_RENDITION_WIDTHS) {
        urls.add(videoCrop(logId, orientation, width, false, version));
        urls.add(videoCrop(logId, orientation, width, true, version));
        urls.add(videoCropPoster(logId, orientation, width, 0, version));
      }

      urls.add(videoCrop(logId, orientation, undefined, false, version));
      urls.add(videoCrop(logId, orientation, undefined, true, version));
      urls.add(videoCropPoster(logId, orientation, undefined, 0, version));
    }
  } else {
    for (const width of PURGE_RENDITION_WIDTHS) {
      urls.add(videoRendition(logId, { version, width }));
    }

    urls.add(videoPoster(logId, undefined, version));
  }

  return [...urls];
}
