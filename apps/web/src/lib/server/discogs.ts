// Worker-safe (HTTP-only), read-only Discogs enrichment: resolve a finding to its
// Discogs RELEASE id (or the MASTER that groups its versions) so the release
// metadata corroborates the finding and `discogs.com/release/{id}` becomes a
// per-finding `sameAs` for the track. No writes to Discogs — search + release
// lookup only.
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
import { logEvent } from "./log";
import {
  MB_USER_AGENT,
  mbFetch as mbFetchShared,
  setMusicbrainzRateLimitForTests,
} from "./musicbrainz";

const DISCOGS_API_ROOT = "https://api.discogs.com";
// Discogs AND MusicBrainz both REJECT/limit generic User-Agents — an identifiable
// one with contact info is mandatory (Discogs developer docs + MB rate-limit docs,
// 2026-06-20). Same discipline as the Last.fm / Deezer lookups. The MB half of that
// rule (and the 1 req/s gate, and the Retry-After handling) now lives in
// ./musicbrainz.ts, the ONE MB client every caller shares.
const USER_AGENT = MB_USER_AGENT;

// The auto-store bar. >= this score (or a title-confirmed MusicBrainz relation)
// stores the id; anything below stores NOTHING. Tuned so a confident exact match
// (artist + title + tracklist-contains + a corroborating signal) clears it while a
// VA-compilation / wrong-variant / near-name collision falls short.
const CONFIDENCE_THRESHOLD = 0.9;

// How many Discogs search candidates to fetch + score per query variant. Each fetch
// is one release lookup; a couple per finding stays well inside the rate limit.
const MAX_CANDIDATES = 4;

// Discogs (authed) and MusicBrainz both cap at ~1 request/second; a single finding
// fans out into several calls (search variants + per-candidate release fetches; the
// ISRC lookup + per-release + per-release-group detail), so pacing only BETWEEN
// findings bursts straight past the ceiling and earns a wall of 429/503. Serialize
// every call to a service through its own gate, spaced by this floor. The MB gate is
// the shared one in ./musicbrainz.ts; this one is the Discogs gate.
// The pacing floor. Mutable only via the test seam below, so the resolver's unit
// tests run instantly instead of incurring real multi-second waits.
let rateLimitIntervalMs = 1100;

/**
 * Test seam: set the pacing floor (and, at 0, the retry backoff) to run the
 * resolver without real timers — for BOTH gates this resolver drives (Discogs's own,
 * and the shared MusicBrainz one). Production never calls this.
 */
export function __setRateLimitForTests(ms: number): void {
  rateLimitIntervalMs = ms;
  setMusicbrainzRateLimitForTests(ms);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A per-service serializer with BOTH properties the musicbrainz.ts gate learned across
// 2026-07-18/19 (see the long comment there): SINGLE-FILE — each call runs after the previous
// settles, so concurrent callers share one honest rate budget — and WEDGE-IMMUNE — the wait on
// the predecessor races a deadline on the CALLER'S OWN clock, because a predecessor whose
// request context died (client timeout) can leave frozen timers/fetches the runtime never
// settles. The old unbounded chain wedged label-images' isolates exactly that way (2026-07-20:
// box ticks hit their poisoned isolate for hours while fresh connections resolved in seconds).
// Slot pacing on top keeps the arrival gap honest even when a predecessor was raced past.
function makeRateLimiter() {
  let tail: Promise<unknown> = Promise.resolve();
  let nextSlotAt = 0;
  const CHAIN_WAIT_FACTOR = 40;

  return <T>(call: () => Promise<T>): Promise<T> => {
    const prev = tail;

    const run = (async () => {
      const chainWait = rateLimitIntervalMs * CHAIN_WAIT_FACTOR;

      if (chainWait > 0) {
        await Promise.race([prev.then(noop, noop), delay(chainWait)]);
      }

      const now = Date.now();
      const slotAt = Math.max(now, nextSlotAt);
      nextSlotAt = slotAt + rateLimitIntervalMs;

      if (slotAt > now) {
        await delay(slotAt - now);
      }

      return call();
    })();

    tail = run.then(noop, noop);

    return run;
  };
}

function noop(): void {
  // Chain links only sequence; they never propagate results or rejections.
}

const throttleDiscogs = makeRateLimiter();

export type DiscogsEnrichment = {
  masterId?: number;
  releaseId?: number;
  // True when a Discogs (429) or MusicBrainz (503) call EXHAUSTED its in-slot
  // retries during this resolution — i.e. the vendor is actively rate-limiting us.
  // An empty `{}` with `rateLimited: true` means "unresolved because we got
  // throttled", NOT "unresolved because there is no match"; the Worker-paced
  // backfill reads it to back the finding off hard instead of retrying next tick.
  rateLimited?: boolean;
};

// A mutable per-resolution flag threaded through the rate-limited fetch helpers so
// `discogsResolveRelease` can report whether the vendor throttled us this pass
// (vs the call genuinely finding nothing). Module-level fetchers can't return it
// out-of-band, so they flip it on a flag the caller owns for the duration.
type RateLimitSignal = { hit: boolean };

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

/**
 * Pull the Discogs `release` / `master` id out of any discogs.com URL. Exported for the
 * catalogue crawler, which reaches the Discogs release graph the same way this resolver
 * does — through MusicBrainz's curated `url-rels`, not through the Discogs API.
 */
export function parseDiscogsUrl(
  url: string,
): { kind: "master" | "release"; id: number } | undefined {
  const match = url.match(/discogs\.com\/(?:[a-z-]+\/)?(release|master)\/(\d+)/i);

  if (match?.[1] === undefined || match[2] === undefined) {
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

/**
 * The shared MB client (./musicbrainz.ts), adapted to this module's `RateLimitSignal`
 * convention: an exhausted 503 flips the caller-owned flag so `discogsResolveRelease`
 * can report "unresolved because throttled" rather than "unresolved because no match".
 */
async function mbFetch<T>(path: string, signal?: RateLimitSignal): Promise<T | undefined> {
  const { data, rateLimited } = await mbFetchShared<T>(path);

  if (rateLimited && signal) {
    signal.hit = true;
  }

  return data ?? undefined;
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
  signal?: RateLimitSignal,
): Promise<DiscogsEnrichment | undefined> {
  const isrc = input.isrc?.trim();

  if (!isrc) {
    return undefined;
  }

  // One call: the recording(s) for this ISRC, with their releases + url relations.
  // `release-groups` is dropped here — combined with releases+url-rels on a recording
  // it 400s, and the code reads release-groups off the per-release detail below anyway.
  const lookup = await mbFetch<MbIsrcLookup>(
    `/isrc/${encodeURIComponent(isrc)}?inc=releases+url-rels`,
    signal,
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
      signal,
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
      const group = await mbFetch<MbReleaseGroupLookup>(
        `/release-group/${groupId}?inc=url-rels`,
        signal,
      );
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

function discogsFetch<T>(
  path: string,
  token: string,
  signal?: RateLimitSignal,
): Promise<T | undefined> {
  return throttleDiscogs(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${DISCOGS_API_ROOT}${path}`, {
        headers: {
          Authorization: `Discogs token=${token}`,
          "User-Agent": USER_AGENT,
        },
      });

      // Proactive throttle: Discogs recommends honouring its rate-limit headers
      // (`X-Discogs-Ratelimit-Remaining`, a 60s moving window). When the budget is
      // nearly spent, trip the breaker BEFORE the next call earns a 429 — the sweep
      // stops clean instead of storming, and the next 30-min tick starts a fresh
      // window. This is the local throttle Discogs's docs ask for.
      // Guard on the header being PRESENT — `Number(null)` is 0, not NaN, so an
      // absent header would otherwise read as "0 remaining" and trip falsely.
      const remainingHeader = response.headers.get("X-Discogs-Ratelimit-Remaining");
      const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);

      if (signal && Number.isFinite(remaining) && remaining <= 1) {
        signal.hit = true;
      }

      // 429 = Discogs is rate-limiting. Do NOT retry within the request: once the
      // token's per-minute window is tripped, every call in it 429s, so retrying
      // just storms (and times out the caller). Flag it on the FIRST 429 and bail —
      // the variant loop + the backfill's run-level circuit breaker stop here, and
      // the next 30-min tick retries with a fresh window. One call, not a wall.
      if (response.status === 429 && signal) {
        signal.hit = true;
      }

      if (!response.ok) {
        // Surface the status — a swallowed 401 (bad/expired token) or an exhausted 429
        // looks exactly like a no-match downstream, so a wrong prod token reads as a
        // clean "0 resolved". Visible in `wrangler tail`.
        logEvent("warn", "discogs.request-failed", {
          path,
          status: response.status,
          statusText: response.statusText,
        });
        return undefined;
      }

      return (await response.json()) as T;
    }

    return undefined;
  });
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
  signal?: RateLimitSignal,
): Promise<ScoredCandidate | undefined> {
  const seen = new Set<number>();
  let best: ScoredCandidate | undefined;

  for (const variant of searchVariants(input)) {
    // Stop trying more query variants once a 429 has exhausted its retries — the
    // token is rate-limited, so each further variant just adds to the storm. Bail
    // and let the backfill's circuit breaker stop the run.
    if (signal?.hit) {
      break;
    }

    const search = await discogsFetch<DiscogsSearchResult>(
      `/database/search?${variant.toString()}`,
      token,
      signal,
    );

    const hits = (search?.results ?? []).filter(
      (hit): hit is DiscogsSearchHit & { id: number } => typeof hit.id === "number",
    );

    for (const hit of hits.slice(0, MAX_CANDIDATES)) {
      if (seen.has(hit.id)) {
        continue;
      }

      seen.add(hit.id);

      const release = await discogsFetch<DiscogsRelease>(`/releases/${hit.id}`, token, signal);

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

  // Owned for this resolution: any exhausted 429/503 flips it, so a `{}` return can
  // report "throttled" vs "no match" to the Worker-paced backfill.
  const signal: RateLimitSignal = { hit: false };

  try {
    // 1. MusicBrainz bridge — accepted directly when present (human-verified).
    const viaMb = await resolveViaMusicBrainz(input, signal);

    if (viaMb && (viaMb.releaseId || viaMb.masterId)) {
      return viaMb;
    }

    // MusicBrainz already exhausted a 503 — don't march into Discogs and storm a
    // second vendor; report throttled so the backfill's circuit breaker trips.
    if (signal.hit) {
      return { rateLimited: true };
    }

    // 2. Discogs scored search — needs the token. No token → no-op (stays inert).
    const token = await readOptionalEnv("DISCOGS_USER_TOKEN");

    if (!token) {
      return signal.hit ? { rateLimited: true } : {};
    }

    const best = await resolveViaDiscogsSearch(input, token, signal);

    // 3. The gate: store NOTHING below the threshold. "Unresolved" is correct —
    // but distinguish "unresolved because throttled" so the backfill backs off.
    if (!best || best.score < CONFIDENCE_THRESHOLD) {
      return signal.hit ? { rateLimited: true } : {};
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
    logEvent("error", "discogs.resolve-failed", { artist: cleanArtist, error, title: cleanTitle });

    return signal.hit ? { rateLimited: true } : {};
  }
}

/** The public `discogs.com/release/{id}` URL — the per-finding `sameAs` for a track. */
export function discogsReleaseUrl(releaseId: number): string {
  return `https://www.discogs.com/release/${releaseId}`;
}

// ───────────────────────────── label logo (the label entity's own image) ─────────────────────
//
// Labels are FIRST-CLASS on Discogs: `GET /labels/{id}` returns an `images[]` array with the
// real logo. The label-images resolve sweep (label-images.ts) reaches that id the same way
// this resolver reaches releases — through MusicBrainz's curated `url-rels`, not through the
// Discogs API — then downloads the logo ONCE and stores it in our own R2. Discogs image
// requests need the authed token and an identifiable UA and MUST NOT be hotlinked (their ToS
// forbids it), which is exactly why this lives here on the one authed Discogs client.

/**
 * Pull the Discogs `label` id out of any discogs.com label URL — the label sibling of
 * `parseDiscogsUrl` (which parses release/master). Used by the label-images sweep to read a
 * label's Discogs id off the MusicBrainz label entity's curated Discogs relation.
 */
export function parseDiscogsLabelUrl(url: string): number | undefined {
  const match = url.match(/discogs\.com\/(?:[a-z-]+\/)?label\/(\d+)/i);

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

type DiscogsImage = {
  type?: string; // "primary" | "secondary"
  uri?: string; // the full-size image URL (on i.discogs.com)
};

type DiscogsLabelDetail = {
  id?: number;
  name?: string;
  images?: DiscogsImage[];
};

/** A downloaded label logo — the bytes to store in R2 plus its content type. */
export type DiscogsLabelImage = { bytes: ArrayBuffer; mime: string };

// A real label logo is tens-to-hundreds of KB; anything past this is not a logo worth storing
// (and the ceiling protects the 128 MB Worker isolate from a pathological image).
const MAX_LABEL_IMAGE_BYTES = 5_000_000;

/** The primary image URI (else the first) from a Discogs label's `images[]`. */
function pickLabelImageUri(images: DiscogsImage[] | undefined): string | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }

  const primary = images.find((image) => image.type === "primary");

  return (primary ?? images[0])?.uri;
}

/**
 * Fetch a Discogs label's primary logo image bytes: `GET /labels/{id}` for the image URI, then
 * the image itself — BOTH authed (`Authorization: Discogs token=…`) and BOTH on the shared
 * Discogs rate-limit gate, so this shares the resolver's one honest budget. Returns the bytes +
 * mime, or `image` undefined when the label has no image (or it isn't an image / is too large),
 * plus `rateLimited` when Discogs threw a 429 so the sweep backs off rather than storms. NEVER
 * throws — same side-channel discipline as `discogsResolveRelease`.
 */
export async function fetchDiscogsLabelImage(
  discogsLabelId: number,
  token: string,
): Promise<{ image?: DiscogsLabelImage; rateLimited: boolean }> {
  const signal: RateLimitSignal = { hit: false };

  try {
    const detail = await discogsFetch<DiscogsLabelDetail>(
      `/labels/${discogsLabelId}`,
      token,
      signal,
    );
    const uri = pickLabelImageUri(detail?.images);

    if (!uri || signal.hit) {
      return { rateLimited: signal.hit };
    }

    // The image host (i.discogs.com) requires the token + an identifiable UA — it is NOT
    // hotlinkable, which is the whole reason we download + re-host. Throttled on the same gate.
    const image = await throttleDiscogs(async () => {
      const response = await fetch(uri, {
        headers: { Authorization: `Discogs token=${token}`, "User-Agent": USER_AGENT },
      });

      if (response.status === 429) {
        signal.hit = true;

        return undefined;
      }

      if (!response.ok) {
        logEvent("warn", "discogs.label-image-failed", {
          discogsLabelId,
          status: response.status,
        });

        return undefined;
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.startsWith("image/")) {
        logEvent("warn", "discogs.label-image-not-image", { contentType, discogsLabelId });

        return undefined;
      }

      const bytes = await response.arrayBuffer();

      if (bytes.byteLength === 0 || bytes.byteLength > MAX_LABEL_IMAGE_BYTES) {
        return undefined;
      }

      return { bytes, mime: contentType.split(";")[0]?.trim() || "image/jpeg" };
    });

    return { image, rateLimited: signal.hit };
  } catch (error) {
    logEvent("error", "discogs.label-image-error", { discogsLabelId, error });

    return { rateLimited: signal.hit };
  }
}
