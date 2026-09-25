import { type DiscogsLabelCandidate, type DiscogsReleaseEvidence } from "@fluncle/contracts/orpc";
import { readOptionalEnv } from "./env";
import { logEvent } from "./log";
import {
  MB_USER_AGENT,
  mbFetch as mbFetchShared,
  setMusicbrainzRateLimitForTests,
} from "./musicbrainz";

const DISCOGS_API_ROOT = "https://api.discogs.com";

const USER_AGENT = MB_USER_AGENT;

const CONFIDENCE_THRESHOLD = 0.9;

const MAX_CANDIDATES = 4;

let rateLimitIntervalMs = 1100;

export function __setRateLimitForTests(ms: number): void {
  rateLimitIntervalMs = ms;
  setMusicbrainzRateLimitForTests(ms);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function noop(): void {}

const throttleDiscogs = makeRateLimiter();

export type DiscogsReleaseFacts = {
  catno?: string;

  styles?: string[];
};

export type DiscogsEnrichment = DiscogsReleaseFacts & {
  masterId?: number;

  rateLimitedBy?: DiscogsThrottleVendor;
  releaseId?: number;

  rateLimited?: boolean;
};

export type DiscogsThrottleVendor = "discogs" | "musicbrainz";

type RateLimitSignal = { hit: boolean; vendor?: DiscogsThrottleVendor };

function rateLimitedOutcome(signal: RateLimitSignal): DiscogsEnrichment {
  return signal.hit && signal.vendor ? { rateLimited: true, rateLimitedBy: signal.vendor } : {};
}

export type DiscogsResolveInput = {
  artists: string[];
  title: string;
  isrc?: string;
  album?: string;
  label?: string;

  releaseDate?: string;
};

function casefold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(title: string): string {
  const folded = casefold(title)
    .replace(/\b(feat|featuring|ft|with)\b.*$/u, "")
    .trim();

  return folded || casefold(title);
}

function normalizeArtist(artist: string): string {
  return casefold(artist)
    .replace(/\b(and|feat|featuring|ft|vs|versus|x)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(value.split(" ").filter(Boolean));
}

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

function yearOf(value: string | undefined): number | undefined {
  const match = value?.match(/\b(\d{4})\b/);

  return match ? Number(match[1]) : undefined;
}

export function parseDiscogsUrl(
  url: string,
): { kind: "master" | "release"; id: number } | undefined {
  const match = url.match(/discogs\.com\/(?:[a-z-]+\/)?(release|master)\/(\d+)/i);

  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }

  return { id: Number(match[2]), kind: match[1].toLowerCase() === "master" ? "master" : "release" };
}

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

async function mbFetch<T>(path: string, signal?: RateLimitSignal): Promise<T | undefined> {
  const { data, rateLimited } = await mbFetchShared<T>(path);

  if (rateLimited && signal) {
    signal.hit = true;
    signal.vendor = "musicbrainz";
  }

  return data ?? undefined;
}

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

async function resolveViaMusicBrainz(
  input: DiscogsResolveInput,
  signal?: RateLimitSignal,
): Promise<DiscogsEnrichment | undefined> {
  const isrc = input.isrc?.trim();

  if (!isrc) {
    return undefined;
  }

  const lookup = await mbFetch<MbIsrcLookup>(
    `/isrc/${encodeURIComponent(isrc)}?inc=releases+url-rels`,
    signal,
  );

  if (!lookup || lookup.error || !Array.isArray(lookup.recordings)) {
    return undefined;
  }

  const wantTitle = normalizeTitle(input.title);

  const recording = lookup.recordings.find(
    (candidate) => candidate.title && similarity(normalizeTitle(candidate.title), wantTitle) >= 0.6,
  );

  if (!recording) {
    return undefined;
  }

  const onRecording = discogsRelation(recording.relations);

  if (onRecording) {
    return relationToEnrichment(onRecording);
  }

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

type DiscogsSearchHit = {
  id?: number;
  master_id?: number;
  title?: string;
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

type DiscogsLabel = { name?: string; catno?: string };

type DiscogsRelease = {
  id?: number;
  master_id?: number;
  title?: string;
  year?: number;
  artists?: DiscogsArtist[];
  labels?: DiscogsLabel[];
  styles?: string[];
  formats?: { name?: string }[];
  tracklist?: DiscogsTrack[];
};

type ScoredCandidate = {
  release: DiscogsReleaseEvidence;
  score: number;
};

function normalizeReleaseEvidence(
  release: DiscogsRelease,
  searchMasterId?: number,
): DiscogsReleaseEvidence | undefined {
  if (typeof release.id !== "number" || release.id <= 0) {
    return undefined;
  }

  const masterId =
    typeof release.master_id === "number" && release.master_id > 0 ? release.master_id : undefined;

  return {
    artists: (release.artists ?? []).map((artist) =>
      artist.name === undefined ? {} : { name: artist.name },
    ),
    formats: (release.formats ?? []).map((format) =>
      format.name === undefined ? {} : { name: format.name },
    ),
    id: release.id,
    labels: (release.labels ?? []).map((label) => ({
      ...(label.catno === undefined ? {} : { catno: label.catno }),
      ...(label.name === undefined ? {} : { name: label.name }),
    })),
    ...(masterId === undefined ? {} : { masterId }),
    ...(searchMasterId === undefined || searchMasterId <= 0 ? {} : { searchMasterId }),
    styles: release.styles ?? [],
    ...(release.title === undefined ? {} : { title: release.title }),
    tracklist: (release.tracklist ?? []).map((track) =>
      track.title === undefined ? {} : { title: track.title },
    ),
    ...(release.year === undefined ? {} : { year: release.year }),
  };
}

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

      const remainingHeader = response.headers.get("X-Discogs-Ratelimit-Remaining");
      const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);

      if (signal && Number.isFinite(remaining) && remaining <= 1) {
        signal.hit = true;
        signal.vendor = "discogs";
      }

      if (response.status === 429 && signal) {
        signal.hit = true;
        signal.vendor = "discogs";
      }

      if (!response.ok) {
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

function scoreRelease(input: DiscogsResolveInput, release: DiscogsReleaseEvidence): number {
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

  const wantTitle = normalizeTitle(input.title);
  const titleSim = Math.max(
    similarity(wantTitle, normalizeTitle(release.title ?? "")),
    ...trackTitles.map((track) => similarity(wantTitle, normalizeTitle(track))),
    0,
  );

  const styleText = casefold((release.styles ?? []).join(" "));
  const formatText = casefold((release.formats ?? []).map((f) => f.name ?? "").join(" "));
  const styleFormat = /drum and bass|drum n bass|jungle|neurofunk|liquid|halftime|single|maxi/.test(
    `${styleText} ${formatText}`,
  )
    ? 1
    : 0;

  let weighted = artistSim * 0.3 + titleSim * 0.3 + 0.1 + styleFormat * 0.05;
  let total = 0.3 + 0.3 + 0.1 + 0.05;

  const wantLabel = input.label ? casefold(input.label) : "";

  if (wantLabel) {
    const haveLabel = (release.labels ?? []).map((label) => casefold(label.name ?? "")).join(" ");
    weighted += similarity(wantLabel, haveLabel) * 0.15;
    total += 0.15;
  }

  const wantYear = yearOf(input.releaseDate);
  const haveYear = release.year && release.year > 0 ? release.year : undefined;

  if (wantYear && haveYear) {
    weighted += (Math.abs(wantYear - haveYear) <= 1 ? 1 : 0) * 0.1;
    total += 0.1;
  }

  return total === 0 ? 0 : weighted / total;
}

export function releaseFacts(release: DiscogsReleaseEvidence): DiscogsReleaseFacts {
  const catno = (release.labels ?? [])
    .map((label) => label.catno?.trim() ?? "")
    .find((value) => value.length > 0 && value.toLowerCase() !== "none");

  const styles = (release.styles ?? [])
    .map((style) => style.trim())
    .filter((style) => style.length > 0);

  return {
    ...(catno ? { catno } : {}),
    ...(styles.length > 0 ? { styles } : {}),
  };
}

function searchVariants(input: DiscogsResolveInput): URLSearchParams[] {
  const artist = input.artists[0]?.trim();
  const variants: URLSearchParams[] = [];

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

function discogsSearchQueries(input: DiscogsResolveInput): string[] {
  return searchVariants(input).map((variant) => variant.toString());
}

export async function prepareDiscogsRelease(
  input: DiscogsResolveInput,
): Promise<{ enrichment: DiscogsEnrichment; queries: string[] }> {
  const signal: RateLimitSignal = { hit: false };

  try {
    const enrichment = (await resolveViaMusicBrainz(input, signal)) ?? rateLimitedOutcome(signal);

    return { enrichment, queries: discogsSearchQueries(input) };
  } catch (error) {
    logEvent("error", "discogs.prepare-failed", { error, title: input.title });

    return { enrichment: rateLimitedOutcome(signal), queries: discogsSearchQueries(input) };
  }
}

export function scoreDiscogsReleaseCandidates(
  input: DiscogsResolveInput,
  releases: DiscogsReleaseEvidence[],
): DiscogsEnrichment {
  const seen = new Set<number>();
  let best: ScoredCandidate | undefined;

  for (const release of releases) {
    if (seen.has(release.id)) {
      continue;
    }

    seen.add(release.id);
    const score = scoreRelease(input, release);

    if (score > 0 && (!best || score > best.score)) {
      best = { release, score };
    }
  }

  if (!best || best.score < CONFIDENCE_THRESHOLD) {
    return {};
  }

  const masterId = best.release.masterId ?? best.release.searchMasterId;

  return {
    ...releaseFacts(best.release),
    ...(masterId === undefined ? {} : { masterId }),
    releaseId: best.release.id,
  };
}

async function resolveViaDiscogsSearch(
  input: DiscogsResolveInput,
  token: string,
  signal?: RateLimitSignal,
): Promise<ScoredCandidate | undefined> {
  const seen = new Set<number>();
  let best: ScoredCandidate | undefined;

  for (const variant of searchVariants(input)) {
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

      const rawRelease = await discogsFetch<DiscogsRelease>(`/releases/${hit.id}`, token, signal);
      const release = rawRelease ? normalizeReleaseEvidence(rawRelease, hit.master_id) : undefined;

      if (!release) {
        continue;
      }

      const score = scoreRelease(input, release);

      if (score > 0 && (!best || score > best.score)) {
        best = { release, score };

        if (score >= 0.99) {
          return best;
        }
      }
    }
  }

  return best;
}

export async function discogsResolveRelease(
  input: DiscogsResolveInput,
): Promise<DiscogsEnrichment> {
  const cleanArtist = input.artists[0]?.trim();
  const cleanTitle = input.title.trim();

  if (!cleanArtist || !cleanTitle) {
    return {};
  }

  const signal: RateLimitSignal = { hit: false };

  try {
    const viaMb = await resolveViaMusicBrainz(input, signal);

    if (viaMb && (viaMb.releaseId || viaMb.masterId)) {
      return viaMb;
    }

    if (signal.hit) {
      return rateLimitedOutcome(signal);
    }

    const token = await readOptionalEnv("DISCOGS_USER_TOKEN");

    if (!token) {
      return rateLimitedOutcome(signal);
    }

    const best = await resolveViaDiscogsSearch(input, token, signal);

    if (!best || best.score < CONFIDENCE_THRESHOLD) {
      return rateLimitedOutcome(signal);
    }

    const { release } = best;
    const masterId = release.masterId ?? release.searchMasterId;

    return {
      ...releaseFacts(release),

      masterId,
      releaseId: release.id,
    };
  } catch (error) {
    logEvent("error", "discogs.resolve-failed", { artist: cleanArtist, error, title: cleanTitle });

    return rateLimitedOutcome(signal);
  }
}

export async function fetchDiscogsReleaseFacts(
  releaseId: number,
  token: string,
): Promise<{ facts?: DiscogsReleaseFacts; found: boolean; rateLimited: boolean }> {
  const signal: RateLimitSignal = { hit: false };

  try {
    const rawRelease = await discogsFetch<DiscogsRelease>(`/releases/${releaseId}`, token, signal);
    const release = rawRelease ? normalizeReleaseEvidence(rawRelease) : undefined;

    if (signal.hit) {
      return { found: false, rateLimited: true };
    }

    if (!release) {
      return { found: false, rateLimited: false };
    }

    return { facts: releaseFacts(release), found: true, rateLimited: false };
  } catch (error) {
    logEvent("error", "discogs.release-facts-failed", { error, releaseId });

    return { found: false, rateLimited: signal.hit };
  }
}

export function discogsReleaseUrl(releaseId: number): string {
  return `https://www.discogs.com/release/${releaseId}`;
}

export function parseDiscogsLabelUrl(url: string): number | undefined {
  const match = url.match(/discogs\.com\/(?:[a-z-]+\/)?label\/(\d+)/i);

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

type DiscogsImage = {
  type?: string;
  uri?: string;
};

type DiscogsLabelDetail = {
  id?: number;
  name?: string;
  images?: DiscogsImage[];
};

export type DiscogsLabelImage = { bytes: ArrayBuffer; mime: string };

const MAX_LABEL_IMAGE_BYTES = 5_000_000;

function pickLabelImageUri(images: DiscogsImage[] | undefined): string | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }

  const primary = images.find((image) => image.type === "primary");

  return (primary ?? images[0])?.uri;
}

const LABEL_IMAGE_SIGNATURES: { bytes: number[]; mime: string }[] = [
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },

  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
];

function sniffLabelImageMime(bytes: ArrayBuffer): string | undefined {
  const head = new Uint8Array(bytes);

  const match = LABEL_IMAGE_SIGNATURES.find(
    (candidate) =>
      head.length >= candidate.bytes.length &&
      candidate.bytes.every((byte, index) => head[index] === byte),
  );

  if (match?.mime !== "image/webp") {
    return match?.mime;
  }

  const isWebp = [0x57, 0x45, 0x42, 0x50].every((byte, index) => head[8 + index] === byte);

  return isWebp ? "image/webp" : undefined;
}

function decodeBase64Image(value: string): ArrayBuffer | undefined {
  try {
    const decoded = atob(value);

    if (decoded.length === 0 || decoded.length > MAX_LABEL_IMAGE_BYTES) {
      return undefined;
    }

    const bytes = new Uint8Array(decoded.length);

    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }

    return bytes.buffer;
  } catch {
    return undefined;
  }
}

function isDiscogsImageUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "discogs.com" || url.hostname.endsWith(".discogs.com"))
    );
  } catch {
    return false;
  }
}

export function verifyDiscogsLabelEvidence(
  evidence: DiscogsLabelCandidate,
): { kind: "image"; image: DiscogsLabelImage } | { kind: "none" } | { kind: "invalid" } {
  if (evidence.detail.id !== evidence.discogsLabelId) {
    return { kind: "invalid" };
  }

  const selectedUri = pickLabelImageUri(evidence.detail.images);
  const suppliedImage = evidence.image;

  if (!selectedUri) {
    return suppliedImage === undefined ? { kind: "none" } : { kind: "invalid" };
  }

  if (!isDiscogsImageUri(selectedUri) || !suppliedImage || suppliedImage.uri !== selectedUri) {
    return { kind: "invalid" };
  }

  const bytes = decodeBase64Image(suppliedImage.bytesBase64);

  if (!bytes) {
    return { kind: "invalid" };
  }

  const sniffed = sniffLabelImageMime(bytes);

  return sniffed ? { image: { bytes, mime: sniffed }, kind: "image" } : { kind: "invalid" };
}

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

    const image = await throttleDiscogs(async () => {
      const response = await fetch(uri, {
        headers: { Authorization: `Discogs token=${token}`, "User-Agent": USER_AGENT },
      });

      if (response.status === 429) {
        signal.hit = true;
        signal.vendor = "discogs";

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
