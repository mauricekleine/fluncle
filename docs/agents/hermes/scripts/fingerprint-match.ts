import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAX_BER = 0.2;

export function maxBer(): number {
  const raw = Number(process.env.FLUNCLE_VERIFY_MAX_BER ?? "");

  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : DEFAULT_MAX_BER;
}

export const MIN_OVERLAP_FRAMES = 30;

export function popcount32(value: number): number {
  let v = value | 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;

  return ((v * 0x01010101) >>> 24) & 0xff;
}

export type MatchResult = {
  ber: number;

  match: boolean;

  overlap: number;
};

export function slidingWindowMatch(
  a: readonly number[],
  b: readonly number[],
  threshold: number = maxBer(),
): MatchResult | null {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  if (short.length < MIN_OVERLAP_FRAMES || long.length === 0) {
    return null;
  }

  const window = short.length;
  const totalBits = window * 32;
  let bestBits = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset + window <= long.length; offset += 1) {
    let bits = 0;

    for (let index = 0; index < window; index += 1) {
      bits += popcount32((short[index] ?? 0) ^ (long[offset + index] ?? 0));

      if (bits >= bestBits) {
        break;
      }
    }

    if (bits < bestBits) {
      bestBits = bits;
    }
  }

  const ber = bestBits / totalBits;

  return { ber, match: ber <= threshold, overlap: window };
}

export const CONSENSUS_WINDOW_FRAMES = 240;

export function mutualWindowMatch(
  a: readonly number[],
  b: readonly number[],
  threshold: number = maxBer(),
): MatchResult | null {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  if (short.length < MIN_OVERLAP_FRAMES) {
    return null;
  }

  const window = Math.min(CONSENSUS_WINDOW_FRAMES, short.length);
  const start = Math.floor((short.length - window) / 2);

  return slidingWindowMatch(short.slice(start, start + window), long, threshold);
}

export function parseFpcalcJson(stdout: string): number[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const fingerprint = (parsed as { fingerprint?: unknown } | null)?.fingerprint;

  if (!Array.isArray(fingerprint) || fingerprint.length === 0) {
    return null;
  }

  const out: number[] = [];

  for (const entry of fingerprint) {
    const value = Number(entry);

    if (!Number.isFinite(value)) {
      return null;
    }

    out.push(value | 0);
  }

  return out;
}

export function fpcalcFingerprint(
  filePath: string,
  bin: string = process.env.FPCALC_BIN ?? "fpcalc",
): number[] | null {
  let result: ReturnType<typeof spawnSync>;

  try {
    result = spawnSync(bin, ["-raw", "-json", filePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    return null;
  }

  if (result.error || result.status !== 0) {
    return null;
  }

  return parseFpcalcJson(result.stdout ?? "");
}

export async function fetchPreviewFingerprint(options: {
  apiBaseUrl: string;
  apiToken?: string;
  fpcalcBin?: string;
  idOrLogId: string;
}): Promise<number[] | null> {
  const url = `${options.apiBaseUrl}/api/preview/${encodeURIComponent(options.idOrLogId)}`;
  const headers: Record<string, string> = {};

  if (options.apiToken) {
    headers.Authorization = `Bearer ${options.apiToken}`;
  }

  let res: Response;

  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    return null;
  }

  if (!res.ok) {
    return null;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  if (bytes.byteLength === 0) {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "fluncle-verify-"));
  const path = join(dir, "preview.mp3");

  try {
    writeFileSync(path, bytes);

    return fpcalcFingerprint(path, options.fpcalcBin);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const ITUNES_MIN_INTERVAL_MS = Number(process.env.FLUNCLE_ITUNES_MIN_INTERVAL_MS ?? "1000");
const ITUNES_SEARCH_LIMIT = Number(process.env.FLUNCLE_ITUNES_SEARCH_LIMIT ?? "15");

const TOLERANCE_SEC = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_SEC ?? "3");
const TOLERANCE_PCT = Number(process.env.FLUNCLE_CAPTURE_TOLERANCE_PCT ?? "0.03");

export function durationAgrees(
  candidateSec: number,
  targetMs: number | undefined,
  options: { tolerancePct: number; toleranceSec: number } = {
    tolerancePct: TOLERANCE_PCT,
    toleranceSec: TOLERANCE_SEC,
  },
): boolean {
  if (!Number.isFinite(candidateSec) || candidateSec <= 0 || !targetMs || targetMs <= 0) {
    return false;
  }

  const targetSec = targetMs / 1000;
  const allowed = Math.max(options.toleranceSec, targetSec * options.tolerancePct);

  return Math.abs(candidateSec - targetSec) <= allowed;
}

const VERSION_WORDS = new Set([
  "bootleg",
  "dub",
  "edit",
  "extended",
  "flip",
  "instrumental",
  "mix",
  "refix",
  "remaster",
  "remix",
  "rework",
  "rmx",
  "version",
  "vip",
]);
const NEUTRAL_DESCRIPTORS = new Set(["original mix", "original", "extended mix"]);
const ARTIST_SPLIT = /\s*(?:,|&|\/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*/;
const FEAT_INLINE = /\b(?:feat|ft|featuring)\b\.?.*$/i;
const PUNCT = /[^a-z0-9 ]+/g;
const WS = /\s+/g;

function stripAccents(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function fold(text: string): string {
  const folded = stripAccents(text).toLowerCase().replaceAll("&", " and ");

  return folded.replace(PUNCT, " ").replace(WS, " ").trim();
}

export function normalizeArtists(artists: string[] | string): Set<string> {
  const raw = (Array.isArray(artists) ? artists.join(", ") : artists).replace(FEAT_INLINE, "");
  const names = new Set<string>();

  for (const part of raw.split(ARTIST_SPLIT)) {
    const name = fold(part);

    if (name) {
      names.add(name);
    }
  }

  return names;
}

export function splitTitle(title: string): { base: string; descriptor: string } {
  let working = title;
  let descriptor = "";

  const groups = [...working.matchAll(/[([]([^)\]]*)[)\]]/g)];

  for (const match of groups.reverse()) {
    const start = match.index;
    const end = start + match[0].length;
    const foldedInner = fold(match[1] ?? "");

    if (!foldedInner) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    if (/^(?:feat|ft|featuring)\b/.test(foldedInner)) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    const tokens = new Set(foldedInner.split(" "));
    const isVersion = [...tokens].some((token) => VERSION_WORDS.has(token));

    if (isVersion && !NEUTRAL_DESCRIPTORS.has(foldedInner)) {
      descriptor = foldedInner;
    }

    working = working.slice(0, start) + working.slice(end);
  }

  const dash = working.match(/\s[-–—]\s(.+)$/);

  if (dash && dash.index !== undefined) {
    const foldedSuffix = fold(dash[1] ?? "");
    const suffixTokens = new Set(foldedSuffix.split(" "));

    if ([...suffixTokens].some((token) => VERSION_WORDS.has(token))) {
      if (!NEUTRAL_DESCRIPTORS.has(foldedSuffix) && !descriptor) {
        descriptor = foldedSuffix;
      }

      working = working.slice(0, dash.index);
    }
  }

  working = working.replace(FEAT_INLINE, "");

  return { base: fold(working), descriptor };
}

export function matchKey(artists: string[] | string, title: string): string {
  const { base, descriptor } = splitTitle(title);
  const names = [...normalizeArtists(artists)].sort();

  return JSON.stringify([names, base, descriptor]);
}

export type ItunesReference = {
  artistName: string;
  durationSec: number;
  previewUrl: string;
  trackName: string;
};

let itunesNextAllowedAt = 0;

async function itunesThrottle(): Promise<void> {
  const now = Date.now();
  const wait = itunesNextAllowedAt - now;

  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  itunesNextAllowedAt = Math.max(now, itunesNextAllowedAt) + ITUNES_MIN_INTERVAL_MS;
}

export async function searchItunesReferences(term: string): Promise<ItunesReference[]> {
  const query = term.trim();

  if (!query) {
    return [];
  }

  await itunesThrottle();

  const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(
    query,
  )}&media=music&entity=song&limit=${Math.max(1, Math.trunc(ITUNES_SEARCH_LIMIT))}`;

  let res: Response;

  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return [];
  }

  if (!res.ok) {
    return [];
  }

  let body: { results?: unknown };

  try {
    body = (await res.json()) as { results?: unknown };
  } catch {
    return [];
  }

  const results = Array.isArray(body.results) ? body.results : [];
  const out: ItunesReference[] = [];

  for (const entry of results) {
    const hit = entry as {
      artistName?: unknown;
      previewUrl?: unknown;
      trackName?: unknown;
      trackTimeMillis?: unknown;
    };

    if (
      typeof hit.previewUrl !== "string" ||
      !hit.previewUrl ||
      typeof hit.trackName !== "string" ||
      typeof hit.artistName !== "string" ||
      typeof hit.trackTimeMillis !== "number" ||
      !Number.isFinite(hit.trackTimeMillis)
    ) {
      continue;
    }

    out.push({
      artistName: hit.artistName,
      durationSec: hit.trackTimeMillis / 1000,
      previewUrl: hit.previewUrl,
      trackName: hit.trackName,
    });
  }

  return out;
}

export type SearchTarget = {
  artists: string[];
  durationMs?: number;
  title: string;
};

export type SearchPick =
  | { previewUrl: null; reason: "conflict" | "no-hit" }
  | { previewUrl: string };

export function pickSearchReference(
  hits: readonly ItunesReference[],
  target: SearchTarget,
): SearchPick {
  if (!target.durationMs || target.durationMs <= 0) {
    return { previewUrl: null, reason: "no-hit" };
  }

  const rowKey = matchKey(target.artists, target.title);
  const accepted = hits.filter(
    (hit) =>
      hit.previewUrl.trim() !== "" &&
      matchKey([hit.artistName], hit.trackName) === rowKey &&
      durationAgrees(hit.durationSec, target.durationMs),
  );

  if (accepted.length === 0) {
    return { previewUrl: null, reason: "no-hit" };
  }

  const sorted = [...accepted].sort(
    (a, b) =>
      Math.abs(a.durationSec - target.durationMs / 1000) -
      Math.abs(b.durationSec - target.durationMs / 1000),
  );
  const [primary, ...rest] = sorted;

  if (!primary) {
    return { previewUrl: null, reason: "no-hit" };
  }

  const conflict = rest.some((hit) => !durationAgrees(hit.durationSec, primary.durationSec * 1000));

  if (conflict) {
    return { previewUrl: null, reason: "conflict" };
  }

  return { previewUrl: primary.previewUrl };
}

export type SearchReferenceResult =
  | { fingerprint: null; reason: "conflict" | "no-hit" | "no-preview-audio" }
  | { fingerprint: number[] };

export async function resolveSearchPreviewFingerprint(options: {
  artists: string[];
  durationMs?: number;
  fpcalcBin?: string;
  search?: (term: string) => Promise<ItunesReference[]>;
  title: string;
}): Promise<SearchReferenceResult> {
  const artist = options.artists[0]?.trim();
  const title = options.title.trim();

  if (!artist || !title || !options.durationMs || options.durationMs <= 0) {
    return { fingerprint: null, reason: "no-hit" };
  }

  const search = options.search ?? searchItunesReferences;
  const hits = await search(`${artist} ${title}`);
  const pick = pickSearchReference(hits, {
    artists: options.artists,
    durationMs: options.durationMs,
    title: options.title,
  });

  if (pick.previewUrl === null) {
    return { fingerprint: null, reason: pick.reason };
  }

  let res: Response;

  try {
    res = await fetch(pick.previewUrl, { signal: AbortSignal.timeout(30_000) });
  } catch {
    return { fingerprint: null, reason: "no-preview-audio" };
  }

  if (!res.ok) {
    return { fingerprint: null, reason: "no-preview-audio" };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  if (bytes.byteLength === 0) {
    return { fingerprint: null, reason: "no-preview-audio" };
  }

  const dir = mkdtempSync(join(tmpdir(), "fluncle-verify-search-"));
  const path = join(dir, "preview.m4a");

  try {
    writeFileSync(path, bytes);

    const fingerprint = fpcalcFingerprint(path, options.fpcalcBin);

    return fingerprint === null
      ? { fingerprint: null, reason: "no-preview-audio" }
      : { fingerprint };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

export type RejectedSource = {
  at: string;

  reason: string;

  sha256: string;

  videoId?: string;
};

export const REJECTED_MEMORY_CAP = 10;

export function appendRejectedSource(
  existing: readonly RejectedSource[] | null | undefined,
  entry: RejectedSource,
): RejectedSource[] {
  const prior = (existing ?? []).filter(
    (row) => !(row.sha256 === entry.sha256 && (row.videoId ?? "") === (entry.videoId ?? "")),
  );

  return [...prior, entry].slice(-REJECTED_MEMORY_CAP);
}

export function parseRejectedSources(value: unknown): RejectedSource[] {
  const raw = typeof value === "string" ? safeJsonArray(value) : Array.isArray(value) ? value : [];
  const out: RejectedSource[] = [];

  for (const entry of raw) {
    const row = entry as Partial<RejectedSource> | null;

    if (row && typeof row.sha256 === "string" && typeof row.at === "string") {
      out.push({
        at: row.at,
        reason: typeof row.reason === "string" ? row.reason : "rejected",
        sha256: row.sha256,
        ...(typeof row.videoId === "string" ? { videoId: row.videoId } : {}),
      });
    }
  }

  return out;
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rejectedVideoIds(rejected: readonly RejectedSource[]): Set<string> {
  const ids = new Set<string>();

  for (const row of rejected) {
    if (row.videoId) {
      ids.add(row.videoId);
    }
  }

  return ids;
}

export function rejectedShas(rejected: readonly RejectedSource[]): Set<string> {
  return new Set(rejected.map((row) => row.sha256));
}
