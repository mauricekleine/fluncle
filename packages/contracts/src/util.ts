// Tiny shared RUNTIME helpers for the surfaces over the Fluncle API (the CLI binary
// and the web Worker). The `.` entry stays type-only (no runtime) for the zod-free
// extension/CLI-type consumers; this `/util` subpath is the one place a byte-shared
// pure helper lives, so a copy can't drift. Keep it zod-free and dependency-free —
// pure functions only.

/** `3:42` from milliseconds. The shared finding-duration formatter (web + CLI). */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** An `Error`'s message, or `String(value)` for a non-Error throw. The shared error-stringifier (web + CLI). */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Parse a duration input to milliseconds, or `null` when it isn't a valid
 * duration. Accepts `M:SS`, `H:MM:SS`, or bare milliseconds. The shared duration
 * parser (the web admin mixtape editor + the CLI `mixtapes` cue parser read the
 * same).
 */
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

// ── Version-aware recording matching ─────────────────────────────────────────
//
// A finding's ISRC uniquely identifies the EXACT recording: an original and its
// remix carry DIFFERENT ISRCs. When a resolver has to fall back to an artist+title
// name search (no ISRC, or the ISRC lookup found no preview), the search returns
// the whole release family — the original, every remix, radio/extended edits — and
// it must NOT pick the original when the finding is a remix (or vice-versa). These
// helpers gate that fuzzy fallback: the candidate's version descriptor must AGREE
// with the finding's, and the base title must actually match. SAFETY-CRITICAL — a
// wrong match archives the wrong audio, then served as confidence-1 "exact" to
// every future render (the worst blast radius). Mirrors the discipline in
// apps/web/src/lib/server/discogs.ts. Shared by the CLI preview-archive backfill
// and the @fluncle/video preview resolver so a copy can't drift.

/** Casefold, strip accents, drop bracketed credits, collapse to single spaces. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Any word that marks a track as a specific version rather than the bare title.
const VERSION_MARKER =
  /\b(mix|edit|version|remix|dub|vip|bootleg|rework|re-?edit|flip|refix|remaster(?:ed)?|instrumental)\b/i;
// A third-party / alternate REWORK (not the artist's own original/extended/radio
// cut) — different musical content than the finding, so the WRONG recording.
const REMIX_MARKER = /\b(remix|bootleg|vip|rework|re-?edit|flip|refix)\b/i;

// Stopwords carry no recording identity ("mix"/"the" appear on every remix); the
// remixer name is what disambiguates one remix from another.
const VERSION_STOPWORDS = new Set(["mix", "the", "and", "feat", "ft", "edit", "version", "remix"]);

/** True when the title carries a third-party rework marker (remix/VIP/bootleg/…). */
export function isRemix(title: string): boolean {
  return REMIX_MARKER.test(title);
}

/**
 * Strip a trailing version/mix descriptor so a title like "Days Like These -
 * Original Mix" compares equal to a bare "Days Like These". Only strips a tail
 * that actually names a version, so an ordinary "A - B" title is left untouched.
 */
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

/**
 * The version descriptor of a title as a normalized token set: the trailing "- …"
 * segment when it names a version (e.g. "- Calyx & TeeBee Remix" →
 * {calyx, teebee, remix}), or a bracketed "(… Remix)" descriptor. Empty when the
 * title is the bare original. This is what must AGREE between the finding and a
 * candidate so a remix never matches the original.
 */
export function versionTokens(title: string): Set<string> {
  const parts = title.split(/\s+-\s+/);
  const tail = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  if (parts.length > 1 && VERSION_MARKER.test(tail)) {
    return new Set(tokenize(tail));
  }
  // Bracketed version: "Title (Calyx & TeeBee Remix)". `normalize` drops brackets,
  // so read the descriptor out of the brackets explicitly here.
  const bracketed = /[([]([^)\]]*?)[)\]]/.exec(title);
  if (bracketed?.[1] && VERSION_MARKER.test(bracketed[1])) {
    return new Set(tokenize(bracketed[1]));
  }
  return new Set();
}

/**
 * Whether a candidate title is the SAME version as the finding title (directional,
 * Discogs-style): the finding's version descriptor must AGREE with the candidate's.
 *   - finding is a remix → candidate must be the same remix: it must itself be a
 *     remix, and every meaningful descriptor token of the finding (the remixer
 *     name) must appear in the candidate. The bare original is rejected.
 *   - finding is NOT a remix (original / extended / radio edit) → the candidate
 *     must NOT be a third-party remix; an original matches an original.
 */
export function versionMatches(findingTitle: string, candidateTitle: string): boolean {
  const findingIsRemix = isRemix(findingTitle);
  const candidateIsRemix = isRemix(candidateTitle);

  if (findingIsRemix) {
    if (!candidateIsRemix) {
      return false;
    }
    const want = [...versionTokens(findingTitle)].filter((t) => !VERSION_STOPWORDS.has(t));
    if (want.length === 0) {
      // No remixer name to key on (just "- Remix"); both being remixes is the best
      // we can assert.
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

  // Finding is the original (or the artist's own edit): reject a third-party remix.
  return !candidateIsRemix;
}

// ── Clip track resolution (the changing on-screen Track-ID) ──────────────────
//
// A Fluncle set-cut clip is a window `[inMs, outMs)` of a mixtape's staged set
// video. When the set is cued (each member carries a `startMs`), the clip should
// stamp the track(s) actually PLAYING in that window as its primary overlay —
// changing across a blend when the window straddles a cue boundary. These helpers
// resolve the window → the ordered track(s), shared by the CLI cut (which turns
// the result into gated `drawtext` lines) so the interval logic can't drift and is
// unit-tested without ffmpeg. Un-cued sets return `[]` and the cut falls back to
// the static mixtape title.

/** The minimal member shape the resolver reads (a structural subset of `MixtapeMember`). */
export type ClipTrackInput = {
  artists: string[];
  /** The member's cue start in the set (ms). Absent ⇒ un-cued. */
  startMs?: number;
  title: string;
};

/** A resolved clip track: its "Artist — Title" label + its cue start (ms). */
export type ResolvedClipTrack = {
  /** `Artist — Title` (em dash — the sanctioned trackLine format; multiple artists join with ", "). */
  label: string;
  /** The track's cue start in the set (ms). */
  startMs: number;
};

/** The trackLine label: `Artist — Title` (em dash), mirroring @fluncle/video's FloatingType. */
export function trackLabel(artists: string[], title: string): string {
  const joined = artists.join(", ");

  return joined && title ? `${joined} — ${title}` : joined || title;
}

/**
 * Resolve which track(s) play in a clip window `[inMs, outMs)` from a mixtape's
 * cued members. Each cued member owns the half-open interval `[startMs, nextStartMs)`;
 * the last cued member runs to `setDurationMs`. Returns the members (in play order)
 * whose interval overlaps the window — length 1 = a single track, ≥2 = a blend (the
 * window straddles a cue boundary). The window is CLAMPED to the cued span: a window
 * before the first cue resolves to the first track, one after the last cue to the last
 * track. An UN-CUED set (no member has a `startMs`) returns `[]` — the caller then
 * falls back to the static mixtape title.
 */
export function resolveClipTracks(options: {
  inMs: number;
  members: ClipTrackInput[];
  outMs: number;
  setDurationMs: number;
}): ResolvedClipTrack[] {
  const { inMs, members, outMs, setDurationMs } = options;

  // Only cued members can be placed on the timeline; sort by start so intervals line up.
  const cued = members
    .filter((member): member is ClipTrackInput & { startMs: number } => member.startMs != null)
    .sort((a, b) => a.startMs - b.startMs);

  if (cued.length === 0) {
    return [];
  }

  const lastIndex = cued.length - 1;

  return cued
    .filter((member, index) => {
      // The half-open interval this member owns. Clamp the two ENDS so a window that
      // spills before the first cue or past the last cue still resolves to that track.
      const lo = index === 0 ? Math.min(member.startMs, inMs) : member.startMs;
      const hi =
        index === lastIndex
          ? Math.max(setDurationMs, outMs)
          : (cued[index + 1]?.startMs ?? Number.POSITIVE_INFINITY);

      // Half-open overlap of `[lo, hi)` with the window `[inMs, outMs)`.
      return lo < outMs && inMs < hi;
    })
    .map((member) => ({
      label: trackLabel(member.artists, member.title),
      startMs: member.startMs,
    }));
}

// ── Mixcloud tracklist sections (the mixtape `sections[]` wire shape) ─────────
//
// A published Mixcloud cloudcast carries a tracklist as indexed `sections-N-*`
// multipart fields. Both the DISTRIBUTE upload (CLI-direct) and the RE-SYNC edit
// (server-side, in the Worker) derive that tracklist from the mixtape's cued
// members, so the derivation + the wire-field shape + the edit-endpoint URL live
// here — the one byte-shared place a copy can't drift (the `resolveClipTracks`
// precedent above). Pure + dependency-free; the base URL is a bare literal.

/** A Mixcloud tracklist section (the API's shape). `start_time` is integer seconds. */
export type MixcloudSection = { artist: string; song: string; start_time: number };

const MIXCLOUD_API_BASE = "https://api.mixcloud.com";

/**
 * Mixcloud `sections[]` from a mixtape's members: keep only the cued ones (a
 * `startMs`), sort by offset, and convert ms → integer seconds. The minimal member
 * shape (`artists`/`title`/`startMs?`) is the same `ClipTrackInput` the clip
 * resolver reads, so both the CLI `MixtapeMemberItem` and the web `MixtapeMember`
 * pass structurally.
 */
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

/**
 * The `sections-N-*` multipart field pairs Mixcloud expects, shared by the upload
 * and the re-sync edit so the wire shape can never drift between them.
 */
export function mixcloudSectionFields(sections: MixcloudSection[]): [string, string][] {
  return sections.flatMap((section, index) => [
    [`sections-${index}-artist`, section.artist],
    [`sections-${index}-song`, section.song],
    [`sections-${index}-start_time`, String(section.start_time)],
  ]);
}

/**
 * The Mixcloud edit endpoint for a cloudcast key. The stored key is `/fluncle/<slug>/`
 * (leading + trailing slash), and the edit URL is `/upload/<user>/<slug>/edit/`, so
 * this splices `edit/` after the key under `/upload`. Normalizes a stray missing slash.
 */
export function mixcloudEditUrl(key: string): string {
  const withLeading = key.startsWith("/") ? key : `/${key}`;
  const path = withLeading.endsWith("/") ? withLeading : `${withLeading}/`;

  return `${MIXCLOUD_API_BASE}/upload${path}edit/`;
}

/** True when every base-title token of the finding appears in the candidate's. */
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
