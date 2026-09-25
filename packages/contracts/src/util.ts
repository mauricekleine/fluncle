export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function parseDuration(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
      return null;
    }
    const nums = parts.map((part) => Number(part));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      return null;
    }
    if (parts.length === 3) {
      const [hours, minutes, seconds] = nums;
      if (hours === undefined || minutes === undefined || seconds === undefined) {
        return null;
      }
      if (minutes >= 60 || seconds >= 60) {
        return null;
      }
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
    const [minutes, seconds] = nums;
    if (minutes === undefined || seconds === undefined) {
      return null;
    }
    if (seconds >= 60) {
      return null;
    }
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const VERSION_MARKER =
  /\b(mix|edit|version|remix|dub|vip|bootleg|rework|re-?edit|flip|refix|remaster(?:ed)?|instrumental)\b/i;

const REMIX_MARKER = /\b(remix|bootleg|vip|rework|re-?edit|flip|refix)\b/i;

const VERSION_STOPWORDS = new Set(["mix", "the", "and", "feat", "ft", "edit", "version", "remix"]);

export function isRemix(title: string): boolean {
  return REMIX_MARKER.test(title);
}

export function stripVersionSuffix(title: string): string {
  const parts = title.split(/\s+-\s+/);
  if (parts.length > 1 && VERSION_MARKER.test(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" - ").trim();
  }
  return title.trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function versionTokens(title: string): Set<string> {
  const parts = title.split(/\s+-\s+/);
  const tail = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  if (parts.length > 1 && VERSION_MARKER.test(tail)) {
    return new Set(tokenize(tail));
  }

  const bracketed = /[([]([^)\]]*?)[)\]]/.exec(title);
  if (bracketed?.[1] && VERSION_MARKER.test(bracketed[1])) {
    return new Set(tokenize(bracketed[1]));
  }
  return new Set();
}

export function versionMatches(findingTitle: string, candidateTitle: string): boolean {
  const findingIsRemix = isRemix(findingTitle);
  const candidateIsRemix = isRemix(candidateTitle);

  if (findingIsRemix) {
    if (!candidateIsRemix) {
      return false;
    }
    const want = [...versionTokens(findingTitle)].filter((t) => !VERSION_STOPWORDS.has(t));
    if (want.length === 0) {
      return true;
    }
    const have = versionTokens(candidateTitle);
    for (const token of want) {
      if (!have.has(token)) {
        return false;
      }
    }
    return true;
  }

  return !candidateIsRemix;
}

export type ClipTrackInput = {
  artists: string[];

  logId?: string;

  startMs?: number;
  title: string;
};

export type ResolvedClipTrack = {
  label: string;

  logId?: string;

  startMs: number;
};

export function trackLabel(artists: string[], title: string): string {
  const joined = artists.join(", ");

  return joined && title ? `${joined} — ${title}` : joined || title;
}

export function r2PublicUrl(base: string, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");

  return `${base}/${path}`;
}

export function resolveClipTracks(options: {
  inMs: number;
  members: ClipTrackInput[];
  outMs: number;
  setDurationMs: number;
}): ResolvedClipTrack[] {
  const { inMs, members, outMs, setDurationMs } = options;

  const cued = members
    .filter((member): member is ClipTrackInput & { startMs: number } => member.startMs != null)
    .sort((a, b) => a.startMs - b.startMs);

  if (cued.length === 0) {
    return [];
  }

  const lastIndex = cued.length - 1;

  return cued
    .filter((member, index) => {
      const lo = index === 0 ? Math.min(member.startMs, inMs) : member.startMs;
      const hi =
        index === lastIndex
          ? Math.max(setDurationMs, outMs)
          : (cued[index + 1]?.startMs ?? Number.POSITIVE_INFINITY);

      return lo < outMs && inMs < hi;
    })
    .map((member) => ({
      label: trackLabel(member.artists, member.title),
      logId: member.logId,
      startMs: member.startMs,
    }));
}

export type MixcloudSection = { artist: string; song: string; start_time: number };

const MIXCLOUD_API_BASE = "https://api.mixcloud.com";

export function mixcloudSections(members: ClipTrackInput[]): MixcloudSection[] {
  return members
    .filter((member): member is ClipTrackInput & { startMs: number } => member.startMs != null)
    .sort((a, b) => a.startMs - b.startMs)
    .map((member) => ({
      artist: member.artists.join(", "),
      song: member.title,
      start_time: Math.floor(member.startMs / 1000),
    }));
}

export function mixcloudSectionFields(sections: MixcloudSection[]): [string, string][] {
  return sections.flatMap((section, index) => [
    [`sections-${index}-artist`, section.artist],
    [`sections-${index}-song`, section.song],
    [`sections-${index}-start_time`, String(section.start_time)],
  ]);
}

export function mixcloudEditUrl(key: string): string {
  const withLeading = key.startsWith("/") ? key : `/${key}`;
  const path = withLeading.endsWith("/") ? withLeading : `${withLeading}/`;

  return `${MIXCLOUD_API_BASE}/upload${path}edit/`;
}

export const TIKTOK_DRAFT_STALE_MS = 24 * 60 * 60 * 1000;

export type SocialPostStaleInput = {
  platform: string;
  status: string;

  updatedAt?: string;
};

export function tikTokDraftAgeHours(post: SocialPostStaleInput, now: number): number | null {
  if (post.platform !== "tiktok" || post.status !== "draft") {
    return null;
  }
  const stamp = post.updatedAt ? Date.parse(post.updatedAt) : Number.NaN;
  if (Number.isNaN(stamp)) {
    return null;
  }
  return Math.max(0, Math.floor((now - stamp) / (60 * 60 * 1000)));
}

export function isStaleTikTokDraft(post: SocialPostStaleInput, now: number): boolean {
  if (post.platform !== "tiktok" || post.status !== "draft") {
    return false;
  }
  const stamp = post.updatedAt ? Date.parse(post.updatedAt) : Number.NaN;
  if (Number.isNaN(stamp)) {
    return false;
  }
  return now - stamp >= TIKTOK_DRAFT_STALE_MS;
}

export function baseTitleMatches(findingTitle: string, candidateTitle: string): boolean {
  const want = new Set(tokenize(stripVersionSuffix(findingTitle)));
  const have = new Set(tokenize(stripVersionSuffix(candidateTitle)));
  if (want.size === 0) {
    return false;
  }
  for (const token of want) {
    if (!have.has(token)) {
      return false;
    }
  }
  return true;
}
