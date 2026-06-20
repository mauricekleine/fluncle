// Worker-safe (HTTP-only), read-only Discogs enrichment: resolve a finding to its
// Discogs RELEASE id (or the MASTER that groups its versions) so the release
// metadata corroborates the finding and `discogs.com/release/{id}` becomes a
// per-finding `sameAs` for the track. No writes to Discogs — search + release
// lookup only. See docs/rfcs/lastfm-discogs-sync.md §2.
//
// THE STANDARD: a wrong ID is worse than a missing one. Discogs search ranking is
// unreliable (it's release-centric, variant-heavy, community-entered) while our
// input is recording-centric, so we NEVER store the top hit blindly. The resolver
// is a scored cascade with a tracklist-confirm gate:
//
//   1. MusicBrainz bridge (primary). ISRC → MB recording → its releases /
//      release-groups → a human-verified Discogs relation (url-rels) → the Discogs
//      release/master id. MB is recording-centric and its Discogs relations are
//      curated, so a title-confirmed relation is accepted directly.
//   2. Discogs search fallback (scored, GATED). Query Discogs with several query
//      variants, fetch each candidate release, and SCORE it locally — and the gate
//      is that the candidate's tracklist must actually CONTAIN the track title.
//      Only a score >= CONFIDENCE_THRESHOLD stores anything; below it we store
//      nothing (null = "unresolved" is the correct, preferred state).
//
// Auth: Discogs uses a personal access token sent as `Authorization: Discogs
// token=…` (lifts the rate limit to ~60 req/min); the lookup no-ops without it.
// MusicBrainz needs no token but REQUIRES an identifiable User-Agent and is capped
// at ~1 req/sec. Both are best-effort: any failure resolves to {} and never blocks
// the add — same side-channel discipline as enrichFromDeezer / lastfmLove.

import { readOptionalEnv } from "./env";

const DISCOGS_API_ROOT = "https://api.discogs.com";
const MUSICBRAINZ_API_ROOT = "https://musicbrainz.org/ws/2";
// Discogs AND MusicBrainz both REJECT/limit generic User-Agents — an identifiable
// one with contact info is mandatory (Discogs developer docs + MB rate-limit docs,
// 2026-06-20). Same discipline as the Last.fm / Deezer lookups.
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

// The auto-store bar. >= this score (or a title-confirmed MusicBrainz relation)
// stores the id; anything below stores NOTHING. Tuned so a confident exact match
// (artist + title + tracklist-contains + a corroborating signal) clears it while a
// VA-compilation / wrong-variant / near-name collision falls short.
export const CONFIDENCE_THRESHOLD = 0.9;

// How many Discogs search candidates to fetch + score per query variant. Each fetch
// is one release lookup; a couple per finding stays well inside the rate limit.
const MAX_CANDIDATES = 4;

export type DiscogsEnrichment = {
  masterId?: number;
  releaseId?: number;
};

// The richer signal the publish path already holds. All optional except title so
// the resolver degrades gracefully (e.g. no ISRC → skip the MB bridge).
export type DiscogsResolveInput = {
  artists: string[];
  title: string;
  isrc?: string;
  album?: string;
  label?: string;
  // Spotify release date: "YYYY", "YYYY-MM", or "YYYY-MM-DD".
  releaseDate?: string;
};

// ───────────────────────────── normalization ─────────────────────────────

/** Casefold, strip accents, drop punctuation, collapse whitespace. */
function casefold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a title for FUZZY matching: casefold and drop `feat.`/`featuring`
 * credit tails, but PRESERVE version tokens (remix/VIP/dub/edit…) — they survive
 * casefold as ordinary words and distinguish different recordings in DnB.
 */
function normalizeTitle(title: string): string {
  const folded = casefold(title)
    // Drop "feat. X" / "featuring X" / "ft X" / "with X" credit tails — they're not
    // part of the recording identity and Discogs is inconsistent about them.
    .replace(/\b(feat|featuring|ft|with)\b.*$/u, "")
    .trim();

  return folded || casefold(title);
}

/**
 * Normalize an artist name / a joined artist credit: casefold and unify the many
 * ways multiple artists get joined (`&`, `and`, `,`, `+`, `x`, `vs`) so
 * "Dimension & Sub Focus" and "Dimension, Sub Focus" compare equal.
 */
function normalizeArtist(artist: string): string {
  return casefold(artist)
    .replace(/\b(and|feat|featuring|ft|vs|versus|x)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token set of a normalized string (for set-based similarity). */
function tokens(value: string): Set<string> {
  return new Set(value.split(" ").filter(Boolean));
}

/**
 * Token-set Jaccard-ish similarity in [0,1]: |intersection| / |union|. Robust to
 * word order and to the artist-join differences normalizeArtist already folds out.
 */
function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);

  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const token of ta) {
    if (tb.has(token)) {
      shared += 1;
    }
  }

  const union = ta.size + tb.size - shared;

  return union === 0 ? 0 : shared / union;
}

/** True when every token of the title appears somewhere in the haystack tokens. */
function containsTitle(haystack: string, title: string): boolean {
  const want = tokens(normalizeTitle(title));
  const have = tokens(normalizeTitle(haystack));

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

/** Extract the leading 4-digit year from a Spotify/Discogs date-ish string. */
function yearOf(value: string | undefined): number | undefined {
  const match = value?.match(/\b(\d{4})\b/);

  return match ? Number(match[1]) : undefined;
}

/** Pull the Discogs `release` / `master` id out of any discogs.com URL. */
function parseDiscogsUrl(url: string): { kind: "master" | "release"; id: number } | undefined {
  const match = url.match(/discogs\.com\/(?:[a-z-]+\/)?(release|master)\/(\d+)/i);

  if (!match) {
    return undefined;
  }

  return { id: Number(match[2]), kind: match[1].toLowerCase() === "master" ? "master" : "release" };
}

// ───────────────────────────── MusicBrainz bridge ─────────────────────────────

type MbRelation = {
  type?: string;
  url?: { resource?: string };
};

type MbReleaseGroup = { id?: string; title?: string };

type MbRelease = {
  id?: string;
  title?: string;
  relations?: MbRelation[];
  "release-group"?: MbReleaseGroup;
};

type MbRecording = {
  id?: string;
  title?: string;
  relations?: MbRelation[];
  releases?: MbRelease[];
};

type MbIsrcLookup = {
  recordings?: MbRecording[];
  error?: unknown;
};

type MbReleaseLookup = MbRelease & { error?: unknown };
type MbReleaseGroupLookup = MbRelease & { error?: unknown };

async function mbFetch<T>(path: string): Promise<T | undefined> {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${MUSICBRAINZ_API_ROOT}${path}${separator}fmt=json`, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    return undefined;
  }

  return (await response.json()) as T;
}

/** First curated Discogs relation in a relations array, parsed to ids. */
function discogsRelation(
  relations: MbRelation[] | undefined,
): { kind: "master" | "release"; id: number } | undefined {
  for (const relation of relations ?? []) {
    const resource = relation.url?.resource;

    if (relation.type === "discogs" && resource) {
      const parsed = parseDiscogsUrl(resource);

      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

function relationToEnrichment(relation: {
  kind: "master" | "release";
  id: number;
}): DiscogsEnrichment {
  return relation.kind === "master" ? { masterId: relation.id } : { releaseId: relation.id };
}

/**
 * Primary path: ISRC → MusicBrainz recording → a human-verified Discogs relation.
 * MB stores curated Discogs links on releases AND release-groups, so we check the
 * recording's relations, then each of its releases (url-rels), then those releases'
 * release-groups. We only accept when the recording title matches the finding (a
 * shared-ISRC mixup or a bad ISRC would otherwise bridge to the wrong recording).
 * Returns undefined when MB has nothing usable, deferring to the Discogs cascade.
 */
async function resolveViaMusicBrainz(
  input: DiscogsResolveInput,
): Promise<DiscogsEnrichment | undefined> {
  const isrc = input.isrc?.trim();

  if (!isrc) {
    return undefined;
  }

  // One call: the recording(s) for this ISRC, with their releases + url relations.
  const lookup = await mbFetch<MbIsrcLookup>(
    `/isrc/${encodeURIComponent(isrc)}?inc=releases+url-rels+release-groups`,
  );

  if (!lookup || lookup.error || !Array.isArray(lookup.recordings)) {
    return undefined;
  }

  const wantTitle = normalizeTitle(input.title);

  // Pick the recording whose title matches the finding — never bridge a mismatch.
  const recording = lookup.recordings.find(
    (candidate) => candidate.title && similarity(normalizeTitle(candidate.title), wantTitle) >= 0.6,
  );

  if (!recording) {
    return undefined;
  }

  // (a) A Discogs relation directly on the recording (rare but cleanest).
  const onRecording = discogsRelation(recording.relations);

  if (onRecording) {
    return relationToEnrichment(onRecording);
  }

  // (b) A Discogs relation on one of its releases. The ISRC lookup carries releases
  // but not always their url-rels, so fetch the release detail with url-rels.
  for (const release of recording.releases ?? []) {
    if (!release.id) {
      continue;
    }

    const detail = await mbFetch<MbReleaseLookup>(
      `/release/${release.id}?inc=url-rels+release-groups`,
    );

    if (!detail || detail.error) {
      continue;
    }

    const onRelease = discogsRelation(detail.relations);

    if (onRelease) {
      return relationToEnrichment(onRelease);
    }

    // (c) The release-group (Discogs "master" family) often carries the link.
    const groupId = detail["release-group"]?.id;

    if (groupId) {
      const group = await mbFetch<MbReleaseGroupLookup>(`/release-group/${groupId}?inc=url-rels`);
      const onGroup = discogsRelation(group?.relations);

      if (onGroup) {
        return relationToEnrichment(onGroup);
      }
    }
  }

  return undefined;
}

// ───────────────────────────── Discogs scored cascade ─────────────────────────────

type DiscogsSearchHit = {
  id?: number;
  master_id?: number;
  title?: string; // "Artist - Title" on Discogs
  year?: string;
  label?: string[];
  format?: string[];
  style?: string[];
};

type DiscogsSearchResult = {
  message?: string;
  results?: DiscogsSearchHit[];
};

type DiscogsTrack = { title?: string };

type DiscogsArtist = { name?: string };

type DiscogsLabel = { name?: string };

type DiscogsRelease = {
  id?: number;
  master_id?: number;
  title?: string; // release title only (not "Artist - Title")
  year?: number;
  artists?: DiscogsArtist[];
  labels?: DiscogsLabel[];
  styles?: string[];
  formats?: { name?: string }[];
  tracklist?: DiscogsTrack[];
};

type ScoredCandidate = {
  release: DiscogsRelease;
  score: number;
};

async function discogsFetch<T>(path: string, token: string): Promise<T | undefined> {
  const response = await fetch(`${DISCOGS_API_ROOT}${path}`, {
    headers: {
      Authorization: `Discogs token=${token}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    return undefined;
  }

  return (await response.json()) as T;
}

/**
 * Score a fetched Discogs release against the finding, in [0,1], as a WEIGHTED
 * AVERAGE over the signals that are actually present:
 *   artistSim*0.30 + titleOrTrackSim*0.30 + tracklistContainsTitle*0.10 (always)
 *   + labelSim*0.15 (only when we have a label) + yearMatch*0.10 (only when both
 *     years are known) + style/format*0.05 (always)
 * The label/year weights drop out of BOTH numerator and denominator when their
 * input is missing, so an absent label (Deezer often omits it) doesn't structurally
 * cap a perfect artist+title+tracklist match below the threshold — it just removes
 * a corroborator. Returns 0 (a hard reject) when the GATE fails: the tracklist must
 * actually contain the track title. The gate is what kills the VA-compilation /
 * wrong-release matches Discogs' own ranking surfaces.
 */
function scoreRelease(input: DiscogsResolveInput, release: DiscogsRelease): number {
  // The gate: the title must appear in the tracklist (or, for a single named after
  // its A-side, in the release title). Without a tracklist we cannot confirm.
  const trackTitles = (release.tracklist ?? [])
    .map((track) => track.title)
    .filter((title): title is string => Boolean(title));

  const tracklistContains =
    trackTitles.some((track) => containsTitle(track, input.title)) ||
    containsTitle(release.title ?? "", input.title);

  if (!tracklistContains) {
    return 0;
  }

  const wantArtist = normalizeArtist(input.artists.join(" "));
  const haveArtist = normalizeArtist((release.artists ?? []).map((a) => a.name ?? "").join(" "));
  const artistSim = similarity(wantArtist, haveArtist);

  // Title vs the best track-title match (the recording lives on a track of a release
  // whose own title may differ — e.g. an EP or a VA comp).
  const wantTitle = normalizeTitle(input.title);
  const titleSim = Math.max(
    similarity(wantTitle, normalizeTitle(release.title ?? "")),
    ...trackTitles.map((track) => similarity(wantTitle, normalizeTitle(track))),
    0,
  );

  // Style/format corroboration: any DnB-ish style or a single/EP format nudges it.
  const styleText = casefold((release.styles ?? []).join(" "));
  const formatText = casefold((release.formats ?? []).map((f) => f.name ?? "").join(" "));
  const styleFormat = /drum and bass|drum n bass|jungle|neurofunk|liquid|halftime|single|maxi/.test(
    `${styleText} ${formatText}`,
  )
    ? 1
    : 0;

  // Always-present signals (numerator + denominator).
  let weighted = artistSim * 0.3 + titleSim * 0.3 + 0.1 /* gate, true here */ + styleFormat * 0.05;
  let total = 0.3 + 0.3 + 0.1 + 0.05;

  // Label: only counts when we actually have one to compare.
  const wantLabel = input.label ? casefold(input.label) : "";

  if (wantLabel) {
    const haveLabel = (release.labels ?? []).map((label) => casefold(label.name ?? "")).join(" ");
    weighted += similarity(wantLabel, haveLabel) * 0.15;
    total += 0.15;
  }

  // Year: only counts when both sides know a year.
  const wantYear = yearOf(input.releaseDate);
  const haveYear = release.year && release.year > 0 ? release.year : undefined;

  if (wantYear && haveYear) {
    weighted += (Math.abs(wantYear - haveYear) <= 1 ? 1 : 0) * 0.1;
    total += 0.1;
  }

  return total === 0 ? 0 : weighted / total;
}

/** Build the ordered Discogs `database/search` query variants we try. */
function searchVariants(input: DiscogsResolveInput): URLSearchParams[] {
  const artist = input.artists[0]?.trim();
  const variants: URLSearchParams[] = [];

  // 1. artist + track title (the recording-centric query).
  if (artist) {
    variants.push(
      new URLSearchParams({
        artist,
        per_page: String(MAX_CANDIDATES),
        track: input.title.trim(),
        type: "release",
      }),
    );
  }

  // 2. release_title (album/EP) + artist + label when we have them — catches the
  //    case where the recording sits on a named EP rather than a single.
  if (artist && input.album?.trim() && input.album.trim() !== input.title.trim()) {
    const params = new URLSearchParams({
      artist,
      per_page: String(MAX_CANDIDATES),
      release_title: input.album.trim(),
      type: "release",
    });

    if (input.label?.trim()) {
      params.set("label", input.label.trim());
    }

    variants.push(params);
  }

  // 3. broad free-text "artist title" — last net for odd credit formatting.
  if (artist) {
    variants.push(
      new URLSearchParams({
        per_page: String(MAX_CANDIDATES),
        q: `${artist} ${input.title.trim()}`,
        type: "release",
      }),
    );
  }

  return variants;
}

/**
 * Discogs fallback: run the query variants, fetch + score each unique candidate
 * release, and return the single best scored candidate. The GATE lives in
 * scoreRelease (tracklist must contain the title). The caller applies the
 * confidence threshold — this just finds the best-scoring real release.
 */
async function resolveViaDiscogsSearch(
  input: DiscogsResolveInput,
  token: string,
): Promise<ScoredCandidate | undefined> {
  const seen = new Set<number>();
  let best: ScoredCandidate | undefined;

  for (const variant of searchVariants(input)) {
    const search = await discogsFetch<DiscogsSearchResult>(
      `/database/search?${variant.toString()}`,
      token,
    );

    const hits = (search?.results ?? []).filter(
      (hit): hit is DiscogsSearchHit & { id: number } => typeof hit.id === "number",
    );

    for (const hit of hits.slice(0, MAX_CANDIDATES)) {
      if (seen.has(hit.id)) {
        continue;
      }

      seen.add(hit.id);

      const release = await discogsFetch<DiscogsRelease>(`/releases/${hit.id}`, token);

      if (!release?.id) {
        continue;
      }

      // Discogs search hits sometimes carry master_id the release detail omits.
      if (!release.master_id && hit.master_id) {
        release.master_id = hit.master_id;
      }

      const score = scoreRelease(input, release);

      if (score > 0 && (!best || score > best.score)) {
        best = { release, score };

        // An effectively perfect match short-circuits the remaining fetches.
        if (score >= 0.99) {
          return best;
        }
      }
    }
  }

  return best;
}

// ───────────────────────────── public surface ─────────────────────────────

/**
 * Resolve a finding to its Discogs release id (or master id), best-effort, with a
 * hard "never store a wrong id" guarantee. Tries the MusicBrainz bridge first
 * (curated ISRC → Discogs relation), then a scored, tracklist-gated Discogs search.
 * Stores nothing below CONFIDENCE_THRESHOLD (null = the correct "unresolved" state).
 * Never throws — any failure resolves to {} so the publish path is untouched.
 *
 * Accepts either the rich input object or the legacy `(artist, title)` positional
 * form (the early call site / tests). When the master is the only clear grouping we
 * return `masterId`; when the exact release is clear we return `releaseId`.
 */
export async function discogsResolveRelease(
  inputOrArtist: DiscogsResolveInput | string | undefined,
  legacyTitle?: string,
): Promise<DiscogsEnrichment> {
  const input: DiscogsResolveInput =
    typeof inputOrArtist === "object"
      ? inputOrArtist
      : { artists: inputOrArtist ? [inputOrArtist] : [], title: legacyTitle ?? "" };

  const cleanArtist = input.artists[0]?.trim();
  const cleanTitle = input.title.trim();

  if (!cleanArtist || !cleanTitle) {
    return {};
  }

  try {
    // 1. MusicBrainz bridge — accepted directly when present (human-verified).
    const viaMb = await resolveViaMusicBrainz(input);

    if (viaMb && (viaMb.releaseId || viaMb.masterId)) {
      return viaMb;
    }

    // 2. Discogs scored search — needs the token. No token → no-op (stays inert).
    const token = await readOptionalEnv("DISCOGS_USER_TOKEN");

    if (!token) {
      return {};
    }

    const best = await resolveViaDiscogsSearch(input, token);

    // 3. The gate: store NOTHING below the threshold. "Unresolved" is correct.
    if (!best || best.score < CONFIDENCE_THRESHOLD) {
      return {};
    }

    const { release } = best;
    const masterId =
      typeof release.master_id === "number" && release.master_id > 0
        ? release.master_id
        : undefined;

    return {
      // Store the exact release when we have it; the master rides along when known.
      masterId,
      releaseId: release.id,
    };
  } catch (error) {
    // Side-channel: log and continue. Read-only, so a later backfill is harmless;
    // the add must never fail on a Discogs/MB miss.
    console.error(
      `Discogs resolve failed for "${cleanArtist} — ${cleanTitle}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return {};
  }
}

/** The public `discogs.com/release/{id}` URL — the per-finding `sameAs` for a track. */
export function discogsReleaseUrl(releaseId: number): string {
  return `https://www.discogs.com/release/${releaseId}`;
}
