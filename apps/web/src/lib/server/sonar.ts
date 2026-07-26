// THE SONAR CLIENT — the Worker's thin HTTP door to the `sonar` vector sidecar (apps/sonar),
// plus the three DARK FLAGS that decide, per surface, whether a vector lookup goes to sonar or
// stays on the existing Turso `vector_distance_cos` scan.
//
// WHY SONAR EXISTS. The live discovery surfaces (sonic search, "sounds like these artists",
// "more like this") rank by cosine similarity against the whole MuQ corpus. On Turso that is a
// linear `vector_distance_cos` scan that GROWS with the catalogue — seconds at scale. `sonar`
// holds the same corpus in RAM and answers the nearest-neighbour part with a flat, SIMD-parallel,
// exact scan (100% recall, tens of ms). It returns only `{id, score}`; the Worker then HYDRATES
// the full row by primary key (a fast, flat lookup), so the expensive scan is gone while every
// output DTO stays byte-identical to the Turso path.
//
// THE SAFETY CONTRACT (the whole point of this slice). A surface routes to sonar ONLY when ALL of:
//   1. its dark flag is the exact string "true" in the `settings` KV (DEFAULT OFF — unset ⇒ OFF),
//   2. BOTH `SONAR_BASE_URL` and `SONAR_SECRET` are provisioned in the Worker env, AND
//   3. sonar actually answers OK, in time, with a well-formed body.
// If ANY of those is false/absent/slow/malformed, {@link searchSonar} returns `null` and the
// caller FALLS BACK to the existing Turso scan, returning exactly what it returns today. The flag
// being unset is the steady state, so the feature ships as a pure no-op and stays dark until an
// operator deliberately writes "true". This mirrors the anchor slice's dark flag
// (./anchor-spotify-search.ts) and rides the same one flag store (./settings.ts) every kill
// switch uses — never a second flag mechanism.

import { readOptionalEnv } from "./env";
import { getSetting, setSetting } from "./settings";

// ── The dark flags — one key per surface, DEFAULT OFF ─────────────────────────────────────────
//
// Each is read default-DENY like the clip-drip/anchor switches: ONLY the literal "true" enables
// the surface's sonar route. An unset key, an empty database, a fresh preview, or any other value
// all read OFF, so the surface keeps running its existing Turso scan until an operator flips it.

/** Sonic search (`sounds like <track>` / `sounds like these artists`) → sonar `tracks` index. */
export const SONAR_SONIC_ENABLED_KEY = "sonar_sonic_enabled";
/** `/artists?like=` (sounds-like-these-artists) → sonar `centroids` index. */
export const SONAR_ARTISTS_ENABLED_KEY = "sonar_artists_enabled";
/** `/log` "more like this" neighbours → sonar `tracks` index (certified-only). */
export const SONAR_LOG_ENABLED_KEY = "sonar_log_enabled";

/** Whether sonic search routes to sonar — THE DARK FLAG. DEFAULT FALSE; only "true" enables it. */
export async function isSonarSonicEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_SONIC_ENABLED_KEY)) === "true";
}

/** Whether `/artists?like=` routes to sonar — THE DARK FLAG. DEFAULT FALSE; only "true" enables it. */
export async function isSonarArtistsEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_ARTISTS_ENABLED_KEY)) === "true";
}

/** Whether `/log` neighbours route to sonar — THE DARK FLAG. DEFAULT FALSE; only "true" enables it. */
export async function isSonarLogEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_LOG_ENABLED_KEY)) === "true";
}

/** Flip the sonic-search dark flag (operator). Writing anything but `true` leaves it OFF. */
export async function setSonarSonicEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_SONIC_ENABLED_KEY, enabled ? "true" : "false");
}

/** Flip the `/artists?like=` dark flag (operator). Writing anything but `true` leaves it OFF. */
export async function setSonarArtistsEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_ARTISTS_ENABLED_KEY, enabled ? "true" : "false");
}

/** Flip the `/log`-neighbours dark flag (operator). Writing anything but `true` leaves it OFF. */
export async function setSonarLogEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_LOG_ENABLED_KEY, enabled ? "true" : "false");
}

// ── The client ────────────────────────────────────────────────────────────────────────────────

/**
 * THE DEADLINE. sonar answers a single probe in tens of ms; anything past this is a hung or
 * unreachable sidecar, and a slow sonar must NEVER become a slow page — it must fall back. Kept
 * short on purpose: the Turso scan behind the fallback is itself the acceptable-latency floor.
 */
export const SONAR_TIMEOUT_MS = 800;

/** Which in-memory index to scan — `tracks` (per-track vectors) or `centroids` (per-artist). */
export type SonarIndex = "centroids" | "tracks";

/**
 * The metadata pre-filter sonar applies before the scan. Every field is optional; a set field
 * constrains, and a metadata constraint excludes entries that lack that metadata (so any metadata
 * filter naturally excludes centroids). Field names are sonar's wire names (snake_case).
 */
export type SonarFilter = {
  anchored?: boolean;
  bpm_max?: number;
  bpm_min?: number;
  certified?: boolean;
  key_in?: string[];
};

/** A `POST /search` request in the Worker's shape; {@link searchSonar} maps it to sonar's wire body. */
export type SonarSearchRequest = {
  /** Ids to omit from the candidate set (e.g. the anchor itself, or the selected artists). */
  excludeIds?: string[];
  /** The metadata pre-filter; omit for none. */
  filter?: SonarFilter;
  index: SonarIndex;
  /** One or more 1024-d probes. Scored by MAX dot over probes (nearest-probe), never averaged. */
  probes: number[][];
  /** How many matches to return. */
  topK: number;
};

/** One sonar match: an id and its cosine similarity (higher = nearer). */
export type SonarMatch = {
  id: string;
  score: number;
};

/**
 * Ask sonar for the nearest ids to `request.probes`, or `null` when sonar cannot be used and the
 * caller must fall back to the Turso scan.
 *
 * NULL IS A SUPPORTED ANSWER, not an error path — it is the fallback signal. It happens on: an
 * unprovisioned Worker (no `SONAR_BASE_URL`/`SONAR_SECRET`, the local-dev steady state), a non-2xx
 * status, a timeout past {@link SONAR_TIMEOUT_MS}, a DNS/transport failure, or a body that does not
 * parse to `{ matches: [{id, score}] }`. Every one of them means the same thing to the caller: use
 * the existing path. A well-formed EMPTY result is returned as `[]` (a real "no matches"), distinct
 * from `null`; surfaces treat an empty result as a fallback too, since a reached surface always has
 * a real probe over a populated corpus, so zero matches is a sonar hiccup rather than a true empty
 * neighbourhood — and falling back can only restore today's behaviour, never worsen it.
 */
export async function searchSonar(request: SonarSearchRequest): Promise<SonarMatch[] | null> {
  const baseUrl = await readOptionalEnv("SONAR_BASE_URL");
  const secret = await readOptionalEnv("SONAR_SECRET");

  // Triple-gate step 2: both env present, or there is no sonar to call — fall back.
  if (!baseUrl || !secret) {
    return null;
  }

  try {
    const response = await fetch(new URL("/search", baseUrl), {
      body: JSON.stringify({
        exclude_ids: request.excludeIds ?? [],
        filter: request.filter,
        index: request.index,
        probes: request.probes,
        top_k: request.topK,
      }),
      headers: {
        "Content-Type": "application/json",
        "x-sonar-secret": secret,
      },
      method: "POST",
      // The deadline. `AbortSignal.timeout` is Web-Standard and workerd implements it.
      signal: AbortSignal.timeout(SONAR_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as unknown;

    return parseMatches(payload);
  } catch {
    // A timeout, a DNS failure, a 5xx that threw, a malformed base URL — every one of them means
    // the same thing to the caller, and none of them may take a page down with them.
    return null;
  }
}

/**
 * Validate sonar's reply as `{ matches: [{ id: string, score: number }] }`. Returns the matches, or
 * `null` when the body is not that shape — an untrusted-input gate, so a garbled response degrades
 * to the Turso fallback rather than a throw. A present-but-empty `matches` array is a valid `[]`.
 */
function parseMatches(payload: unknown): SonarMatch[] | null {
  if (typeof payload !== "object" || payload === null || !("matches" in payload)) {
    return null;
  }

  const raw = (payload as { matches: unknown }).matches;

  if (!Array.isArray(raw)) {
    return null;
  }

  const matches: SonarMatch[] = [];

  for (const entry of raw) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { id?: unknown }).id !== "string" ||
      typeof (entry as { score?: unknown }).score !== "number"
    ) {
      return null;
    }

    matches.push({ id: (entry as { id: string }).id, score: (entry as { score: number }).score });
  }

  return matches;
}
