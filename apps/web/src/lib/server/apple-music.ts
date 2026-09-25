import { readOptionalEnv } from "./env";
import { logEvent } from "./log";

const CATALOG_SONGS_URL = "https://api.music.apple.com/v1/catalog/us/songs";
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

const TOKEN_TTL_SECONDS = 150 * 24 * 60 * 60;
const TOKEN_REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;

export type AppleMusicLookupOutcome =
  | { configured: false }
  | { configured: true; ok: true; url: string | null }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

type AppleMusicCredentials = {
  keyId: string;
  privateKeyPem: string;
  teamId: string;
};

async function readAppleMusicCredentials(): Promise<AppleMusicCredentials | undefined> {
  const [teamId, keyId, privateKeyPem] = await Promise.all([
    readOptionalEnv("APPLE_MUSIC_TEAM_ID"),
    readOptionalEnv("APPLE_MUSIC_KEY_ID"),
    readOptionalEnv("APPLE_MUSIC_PRIVATE_KEY"),
  ]);

  if (!teamId || !keyId || !privateKeyPem) {
    return undefined;
  }

  return { keyId, privateKeyPem, teamId };
}

function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(utf8Bytes(value));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcs8DerFromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export async function buildAppleMusicJwt(
  credentials: AppleMusicCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "ES256", kid: credentials.keyId, typ: "JWT" };
  const payload = { exp: nowSeconds + TOKEN_TTL_SECONDS, iat: nowSeconds, iss: credentials.teamId };

  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(
    JSON.stringify(payload),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8DerFromPem(credentials.privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    key,
    utf8Bytes(signingInput),
  );

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

let cachedToken: { expiresAtMs: number; keyId: string; token: string } | undefined;

async function developerToken(credentials: AppleMusicCredentials): Promise<string> {
  const now = Date.now();

  if (
    cachedToken &&
    cachedToken.keyId === credentials.keyId &&
    cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now
  ) {
    return cachedToken.token;
  }

  const nowSeconds = Math.floor(now / 1000);
  const token = await buildAppleMusicJwt(credentials, nowSeconds);

  cachedToken = {
    expiresAtMs: (nowSeconds + TOKEN_TTL_SECONDS) * 1000,
    keyId: credentials.keyId,
    token,
  };

  return token;
}

type AppleMusicSongsResponse = {
  data?: Array<{ attributes?: { url?: string } }>;
};

export function extractAppleMusicUrl(body: unknown): string | null {
  const url = (body as AppleMusicSongsResponse | null | undefined)?.data?.[0]?.attributes?.url;

  return typeof url === "string" && url.trim() ? url.trim() : null;
}

export async function appleMusicLookupByIsrc(isrc: string): Promise<AppleMusicLookupOutcome> {
  const clean = isrc.trim();

  if (!clean) {
    return { configured: true, ok: true, url: null };
  }

  const credentials = await readAppleMusicCredentials();

  if (!credentials) {
    return { configured: false };
  }

  try {
    const token = await developerToken(credentials);
    const url = `${CATALOG_SONGS_URL}?filter%5Bisrc%5D=${encodeURIComponent(clean)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
    });

    if (response.status === 429) {
      return {
        configured: true,
        error: `Apple Music request failed: 429 ${response.statusText}`,
        ok: false,
        rateLimited: true,
      };
    }

    if (!response.ok) {
      const authFailed = response.status === 401 || response.status === 403;

      if (authFailed) {
        cachedToken = undefined;
      }

      return {
        authFailed,
        configured: true,
        error: `Apple Music request failed: ${response.status} ${response.statusText}`,
        ok: false,
        rateLimited: false,
      };
    }

    const body = await response.json().catch(() => ({}));

    return { configured: true, ok: true, url: extractAppleMusicUrl(body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "apple-music.lookup-failed", { error, isrc: clean });

    return { configured: true, error: message, ok: false, rateLimited: false };
  }
}

export type AppleArtwork = {
  urlTemplate: string;
  width: number;
  height: number;
  bgColor?: string;
  textColor1?: string;
  textColor2?: string;
  textColor3?: string;
  textColor4?: string;
};

export type AppleCatalogBundle = {
  songUrl: string;
  songId: string;
  songArtwork?: AppleArtwork;
  canonicalAlbum?: {
    id: string;
    recordLabel?: string;
    upc?: string;
    editorialNotesStandard?: string;
    editorialNotesShort?: string;
    artwork?: AppleArtwork;
  };
  preview?: { url: string };
};

export type AppleCatalogBatchBundle = {
  songUrl: string;
  songId: string;
  songArtwork?: AppleArtwork;
  preview?: { url: string };
};

export type AppleAlbumCandidate = {
  id: string;
  recordLabel?: string;
  upc?: string;
  releaseDate?: string;
  isCompilation?: boolean;
  isSingle?: boolean;
  editorialNotesStandard?: string;
  editorialNotesShort?: string;
  artwork?: AppleArtwork;
};

const CATALOG_ISRC_BATCH_MAX = 25;

type AppleRawArtwork = {
  url?: string;
  width?: number;
  height?: number;
  bgColor?: string;
  textColor1?: string;
  textColor2?: string;
  textColor3?: string;
  textColor4?: string;
};

type AppleRawResourceRef = { id?: string; type?: string };

type AppleRawSong = {
  id?: string;
  type?: string;
  attributes?: {
    url?: string;
    isrc?: string;
    artwork?: AppleRawArtwork;
    previews?: Array<{ url?: string }>;
  };

  relationships?: { albums?: { data?: AppleRawAlbum[] } };
};

type AppleRawAlbum = {
  id?: string;
  type?: string;
  attributes?: {
    recordLabel?: string;
    upc?: string;
    releaseDate?: string;
    isCompilation?: boolean;
    isSingle?: boolean;
    editorialNotes?: { standard?: string; short?: string };
    artwork?: AppleRawArtwork;
  };
};

type AppleRawCatalogResponse = {
  data?: AppleRawSong[];
  included?: AppleRawAlbum[];
  meta?: { filters?: { isrc?: Record<string, AppleRawResourceRef[]> } };
};

export function appleArtworkUrl(artwork: AppleArtwork, width: number, height: number): string {
  const w = width > 0 ? Math.min(width, artwork.width) : artwork.width;
  const h = height > 0 ? Math.min(height, artwork.height) : artwork.height;

  return artwork.urlTemplate.replace("{w}", String(w)).replace("{h}", String(h));
}

export const RENDER_ARTWORK_TARGET_PX = 2048;

export function composeAppleArtworkUrl(
  urlTemplate: string | null | undefined,
  width: number | null | undefined,
  height: number | null | undefined,
  target: number = RENDER_ARTWORK_TARGET_PX,
): string | undefined {
  if (
    !urlTemplate ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }

  return appleArtworkUrl({ height, urlTemplate, width }, target, target);
}

function parseArtwork(raw: AppleRawArtwork | undefined): AppleArtwork | undefined {
  if (!raw || typeof raw.url !== "string" || !raw.url.trim()) {
    return undefined;
  }

  const width = typeof raw.width === "number" ? raw.width : 0;
  const height = typeof raw.height === "number" ? raw.height : 0;

  return {
    bgColor: raw.bgColor,
    height,
    textColor1: raw.textColor1,
    textColor2: raw.textColor2,
    textColor3: raw.textColor3,
    textColor4: raw.textColor4,
    urlTemplate: raw.url.trim(),
    width,
  };
}

function parseAlbum(raw: AppleRawAlbum): AppleAlbumCandidate | undefined {
  if (typeof raw.id !== "string" || !raw.id) {
    return undefined;
  }

  const attributes = raw.attributes ?? {};

  return {
    artwork: parseArtwork(attributes.artwork),
    editorialNotesShort: attributes.editorialNotes?.short,
    editorialNotesStandard: attributes.editorialNotes?.standard,
    id: raw.id,
    isCompilation: attributes.isCompilation,
    isSingle: attributes.isSingle,
    recordLabel: attributes.recordLabel?.trim() ? attributes.recordLabel.trim() : undefined,
    releaseDate: attributes.releaseDate,
    upc: attributes.upc?.trim() ? attributes.upc.trim() : undefined,
  };
}

export function collectAlbumCandidates(body: unknown): AppleAlbumCandidate[] {
  const response = (body ?? {}) as AppleRawCatalogResponse;
  const included = Array.isArray(response.included) ? response.included : [];
  const songs = Array.isArray(response.data) ? response.data : [];

  const albumsById = new Map<string, AppleAlbumCandidate>();

  for (const raw of included) {
    if (raw.type === "albums") {
      const album = parseAlbum(raw);

      if (album) {
        albumsById.set(album.id, album);
      }
    }
  }

  const candidates: AppleAlbumCandidate[] = [];
  const seen = new Set<string>();

  for (const song of songs) {
    for (const ref of song.relationships?.albums?.data ?? []) {
      const id = ref.id;

      if (typeof id !== "string" || seen.has(id)) {
        continue;
      }

      const album = (ref.attributes ? parseAlbum(ref) : undefined) ?? albumsById.get(id);

      if (album) {
        seen.add(id);
        candidates.push(album);
      }
    }
  }

  return candidates;
}

function compareAlbumCandidates(a: AppleAlbumCandidate, b: AppleAlbumCandidate): number {
  const compilationRank = (a.isCompilation === true ? 1 : 0) - (b.isCompilation === true ? 1 : 0);

  if (compilationRank !== 0) {
    return compilationRank;
  }

  const aDate = a.releaseDate ?? "9999-99-99";
  const bDate = b.releaseDate ?? "9999-99-99";

  if (aDate !== bDate) {
    return aDate < bDate ? -1 : 1;
  }

  const singleRank = (a.isSingle === true ? 1 : 0) - (b.isSingle === true ? 1 : 0);

  if (singleRank !== 0) {
    return singleRank;
  }

  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }

  return 0;
}

export function pickCanonicalAlbum(albums: AppleAlbumCandidate[]): AppleAlbumCandidate | undefined {
  if (albums.length === 0) {
    return undefined;
  }

  return [...albums].sort(compareAlbumCandidates)[0];
}

function parsePreview(previews: Array<{ url?: string }> | undefined): { url: string } | undefined {
  const url = previews?.[0]?.url;

  return typeof url === "string" && url.trim() ? { url: url.trim() } : undefined;
}

export function buildCatalogBundle(body: unknown): AppleCatalogBundle | null {
  const response = (body ?? {}) as AppleRawCatalogResponse;
  const primary = Array.isArray(response.data) ? response.data[0] : undefined;
  const songUrl = primary?.attributes?.url;

  if (
    !primary ||
    typeof primary.id !== "string" ||
    typeof songUrl !== "string" ||
    !songUrl.trim()
  ) {
    return null;
  }

  const picked = pickCanonicalAlbum(collectAlbumCandidates(response));
  const canonical = picked && picked.isCompilation !== true ? picked : undefined;

  const bundle: AppleCatalogBundle = {
    songId: primary.id,
    songUrl: songUrl.trim(),
  };

  const songArtwork = parseArtwork(primary.attributes?.artwork);

  if (songArtwork) {
    bundle.songArtwork = songArtwork;
  }

  const preview = parsePreview(primary.attributes?.previews);

  if (preview) {
    bundle.preview = preview;
  }

  if (canonical) {
    bundle.canonicalAlbum = {
      artwork: canonical.artwork,
      editorialNotesShort: canonical.editorialNotesShort,
      editorialNotesStandard: canonical.editorialNotesStandard,
      id: canonical.id,
      recordLabel: canonical.recordLabel,
      upc: canonical.upc,
    };
  }

  return bundle;
}

export function buildBatchBundles(
  body: unknown,
  requestedIsrcs: string[],
): Map<string, AppleCatalogBatchBundle> {
  const response = (body ?? {}) as AppleRawCatalogResponse;
  const songs = Array.isArray(response.data) ? response.data : [];
  const filters = response.meta?.filters?.isrc ?? {};

  const songsById = new Map<string, AppleRawSong>();

  for (const song of songs) {
    if (typeof song.id === "string") {
      songsById.set(song.id, song);
    }
  }

  const bundles = new Map<string, AppleCatalogBatchBundle>();

  for (const isrc of requestedIsrcs) {
    const refIds = new Set((filters[isrc] ?? []).map((ref) => ref.id).filter(Boolean));

    const primary =
      songs.find((song) => typeof song.id === "string" && refIds.has(song.id)) ??
      songs.find((song) => song.attributes?.isrc === isrc);

    const songUrl = primary?.attributes?.url;

    if (
      !primary ||
      typeof primary.id !== "string" ||
      typeof songUrl !== "string" ||
      !songUrl.trim()
    ) {
      continue;
    }

    const bundle: AppleCatalogBatchBundle = { songId: primary.id, songUrl: songUrl.trim() };
    const songArtwork = parseArtwork(primary.attributes?.artwork);

    if (songArtwork) {
      bundle.songArtwork = songArtwork;
    }

    const preview = parsePreview(primary.attributes?.previews);

    if (preview) {
      bundle.preview = preview;
    }

    bundles.set(isrc, bundle);
  }

  return bundles;
}

export type AppleCatalogRequestOutcome =
  | { configured: false }
  | { configured: true; ok: true; body: unknown }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

export async function requestAppleCatalog(
  query: string,
  signal?: AbortSignal,
): Promise<AppleCatalogRequestOutcome> {
  const credentials = await readAppleMusicCredentials();

  if (!credentials) {
    return { configured: false };
  }

  try {
    const token = await developerToken(credentials);

    const response = await fetch(`${CATALOG_SONGS_URL}?${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
      signal,
    });

    if (response.status === 429) {
      return {
        configured: true,
        error: `Apple Music request failed: 429 ${response.statusText}`,
        ok: false,
        rateLimited: true,
      };
    }

    if (!response.ok) {
      const authFailed = response.status === 401 || response.status === 403;

      if (authFailed) {
        cachedToken = undefined;
      }

      return {
        authFailed,
        configured: true,
        error: `Apple Music request failed: ${response.status} ${response.statusText}`,
        ok: false,
        rateLimited: false,
      };
    }

    const body = await response.json().catch(() => ({}));

    return { body, configured: true, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "apple-music.catalog-failed", { error, query });

    return { configured: true, error: message, ok: false, rateLimited: false };
  }
}

export type AppleCatalogLookupOutcome =
  | { configured: false }
  | { configured: true; ok: true; bundle: AppleCatalogBundle | null }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

export async function appleCatalogLookupByIsrc(isrc: string): Promise<AppleCatalogLookupOutcome> {
  const clean = isrc.trim();

  if (!clean) {
    return { bundle: null, configured: true, ok: true };
  }

  const outcome = await requestAppleCatalog(
    `filter%5Bisrc%5D=${encodeURIComponent(clean)}&include=albums`,
  );

  if (!outcome.configured) {
    return { configured: false };
  }

  if (!outcome.ok) {
    return {
      authFailed: outcome.authFailed,
      configured: true,
      error: outcome.error,
      ok: false,
      rateLimited: outcome.rateLimited,
    };
  }

  return { bundle: buildCatalogBundle(outcome.body), configured: true, ok: true };
}

export type AppleCatalogBatchOutcome =
  | { configured: false }
  | { configured: true; ok: true; bundles: Map<string, AppleCatalogBatchBundle> }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

export async function appleCatalogLookupByIsrcs(
  isrcs: string[],
  signal?: AbortSignal,
): Promise<AppleCatalogBatchOutcome> {
  const clean: string[] = [];
  const seen = new Set<string>();

  for (const raw of isrcs) {
    const value = raw.trim();

    if (value && !seen.has(value)) {
      seen.add(value);
      clean.push(value);
    }
  }

  if (clean.length === 0) {
    return { bundles: new Map(), configured: true, ok: true };
  }

  const bundles = new Map<string, AppleCatalogBatchBundle>();

  for (let start = 0; start < clean.length; start += CATALOG_ISRC_BATCH_MAX) {
    const chunk = clean.slice(start, start + CATALOG_ISRC_BATCH_MAX);
    const outcome = await requestAppleCatalog(
      `filter%5Bisrc%5D=${chunk.map((value) => encodeURIComponent(value)).join(",")}`,
      signal,
    );

    if (!outcome.configured) {
      return { configured: false };
    }

    if (!outcome.ok) {
      return {
        authFailed: outcome.authFailed,
        configured: true,
        error: outcome.error,
        ok: false,
        rateLimited: outcome.rateLimited,
      };
    }

    for (const [isrc, bundle] of buildBatchBundles(outcome.body, chunk)) {
      bundles.set(isrc, bundle);
    }
  }

  return { bundles, configured: true, ok: true };
}
