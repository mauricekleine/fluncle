// THE SONAR CLIENT — the Worker's thin HTTP door to the `sonar` vector sidecar (apps/sonar),
// plus the seven DARK FLAGS that decide, per surface, whether a vector lookup goes to sonar or
// stays on the existing Turso `vector_distance_cos` scan. The architecture doc is
// docs/vector-serving.md.
//
// WHY SONAR EXISTS. The live discovery surfaces (sonic search, "sounds like these artists", "more
// like this", the /recommendations draft engine) rank by cosine similarity against the whole MuQ
// corpus. On Turso that is a linear `vector_distance_cos` scan that GROWS with the catalogue —
// seconds at scale. `sonar` holds the same corpus in RAM and answers the nearest-neighbour part
// with a flat, SIMD-parallel, exact scan (100% recall, tens of ms). It returns only `{id, score}`;
// the Worker then HYDRATES the full row by primary key (a fast, flat lookup), so the expensive
// scan is gone while every output DTO stays byte-identical to the Turso path.
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
/**
 * The `/recommendations` DRAFT-phase engine's FINDINGS SLOTS → sonar `tracks` index
 * (certified-only, multi-probe over the listener's seed vectors).
 *
 * SCOPE, deliberately narrow: this flag routes the findings slots ONLY. The engine's OTHER scan —
 * the catalogue pool — rides its own flag, {@link SONAR_RECS_CATALOGUE_ENABLED_KEY}.
 */
export const SONAR_RECS_ENABLED_KEY = "sonar_recs_enabled";
/**
 * The `/recommendations` DRAFT-phase engine's CATALOGUE SCAN → sonar `tracks` index
 * (the full `REC_ELIGIBLE_WHERE` predicate as a sonar filter, multi-probe over the seeds).
 *
 * A SEPARATE FLAG FROM {@link SONAR_RECS_ENABLED_KEY}, and the separation is the safety.
 * That one is already ON in production; reusing it would route the catalogue scan the instant
 * this merges — before the box's hourly self-deploy has a binary that CARRIES the
 * `has_finding`/`dismissed`/`is_duplicate`/`nearest_finding_score_max`/`duration_ms_max`
 * filter fields. (A binary without those fields rejects the unknown fields rather than dropping them, so
 * even that skew degrades to the Turso scan rather than a wrong page — but a flag whose
 * pre-condition is "the box has redeployed" must be flippable on its own.) Default OFF; the
 * go-live order is merge → self-deploy → verify `GET /health` reports the commit → flip.
 */
export const SONAR_RECS_CATALOGUE_ENABLED_KEY = "sonar_recs_catalogue_enabled";
/** The `/mix` rail's candidate scan → sonar `tracks` index (key-pre-filtered, both registers). */
export const SONAR_MIX_ENABLED_KEY = "sonar_mix_enabled";
/**
 * The `/track/<trackId>` destination's SONIC NEIGHBOURS → sonar `tracks` index (BOTH registers).
 *
 * A SEPARATE FLAG FROM {@link SONAR_LOG_ENABLED_KEY}, and the separation is the point rather than
 * caution: that one routes `/log`'s "more like this", which is a question about FINDINGS and sends
 * `certified: true`. This surface asks about MUSIC and sends no certification filter at all, so the
 * two ask sonar for different candidate sets and must be flippable independently.
 */
export const SONAR_TRACK_ENABLED_KEY = "sonar_track_enabled";

/** Whether the track destination's neighbours route to sonar — DEFAULT FALSE; only "true" enables it. */
export async function isSonarTrackEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_TRACK_ENABLED_KEY)) === "true";
}

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

/**
 * Whether the `/recommendations` draft engine's findings slots route to sonar — THE DARK FLAG.
 * DEFAULT FALSE; only "true" enables it.
 */
export async function isSonarRecsEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_RECS_ENABLED_KEY)) === "true";
}

/**
 * Whether the `/recommendations` draft engine's CATALOGUE scan routes to sonar — THE DARK FLAG.
 * DEFAULT FALSE; only "true" enables it. Separate from {@link isSonarRecsEnabled} on purpose.
 */
export async function isSonarRecsCatalogueEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_RECS_CATALOGUE_ENABLED_KEY)) === "true";
}

/** Whether the `/mix` rail routes to sonar — THE DARK FLAG. DEFAULT FALSE; only "true" enables it. */
export async function isSonarMixEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_MIX_ENABLED_KEY)) === "true";
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

/** Flip the `/recommendations` dark flag (operator). Writing anything but `true` leaves it OFF. */
export async function setSonarRecsEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_RECS_ENABLED_KEY, enabled ? "true" : "false");
}

/**
 * Flip the `/recommendations` CATALOGUE dark flag (operator). Writing anything but `true` leaves
 * it OFF. Flip it only after `GET /health` on the engine reports a commit that carries the
 * catalogue filter fields — before that the box rejects them and the surface just falls back.
 */
export async function setSonarRecsCatalogueEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_RECS_CATALOGUE_ENABLED_KEY, enabled ? "true" : "false");
}

/** Flip the `/mix`-rail dark flag (operator). Writing anything but `true` leaves it OFF. */
export async function setSonarMixEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_MIX_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarTrackEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_TRACK_ENABLED_KEY, enabled ? "true" : "false");
}

// ── The client ────────────────────────────────────────────────────────────────────────────────

/**
 * THE DEADLINE. sonar answers a single probe in tens of ms; anything past this is a hung or
 * unreachable sidecar, and a slow sonar must NEVER become a slow page — it must fall back. Kept
 * short on purpose: the Turso scan behind the fallback is itself the acceptable-latency floor.
 */
export const SONAR_TIMEOUT_MS = 800;

/**
 * THE REQUEST CAPS, mirrored from the engine (`apps/sonar/src/search.rs`: `MAX_TOP_K`,
 * `MAX_PROBES`). sonar answers an over-cap body with a 400 — a `top_k`-sized top-K heap per
 * rayon worker under `MemoryMax=2G`, and one full dot-product pass per probe, are the two
 * levers one request can pull to cost the whole engine.
 *
 * They are duplicated HERE so the Worker never sends a request it knows the engine will
 * refuse: {@link searchSonar} returns `null` (the ordinary fallback signal) without a fetch,
 * which is exactly what a 400 would have produced, minus a round trip. Every real call site is
 * far inside them — `TASTE_SHORTLIST` = 300 is the largest `topK`, `MAX_REC_SEEDS` = 12 the
 * widest probe set — so this is a guard against a future caller's arithmetic, not a live clamp.
 *
 * NEVER clamp instead of falling back: silently shrinking a caller's `topK` would hand back a
 * short page that looks correct, the one failure mode this whole client refuses.
 */
export const SONAR_MAX_TOP_K = 1000;

/** @see SONAR_MAX_TOP_K */
export const SONAR_MAX_PROBES = 32;

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
  /** A findings row WITH a Log ID. NOT the negation of {@link SonarFilter.has_finding}. */
  certified?: boolean;
  /** `dismissed_at is not null` — set `false` to require a non-dismissed row. */
  dismissed?: boolean;
  /**
   * EXCLUSIVE upper bound on `duration_ms`, mirroring `t.duration_ms < x`. A row whose
   * duration is NULL **FAILS** it — SQL's `NULL < x` is NULL, so the row is excluded. The
   * OPPOSITE null rule to {@link SonarFilter.nearest_finding_score_max}, deliberately.
   */
  duration_ms_max?: number;
  /**
   * Whether ANY findings row exists — the weaker fact `certified` is not. A coordinate-less
   * straggler (a findings row awaiting its Log ID backfill) is `has_finding: true,
   * certified: false`, so a predicate meaning "no findings row at all"
   * (`f.track_id is null`) MUST send `has_finding: false`; `certified: false` would admit it.
   */
  has_finding?: boolean;
  /** `duplicate_of_track_id is not null` — set `false` to require a non-duplicate row. */
  is_duplicate?: boolean;
  key_in?: string[];
  /**
   * EXCLUSIVE upper bound on `nearest_finding_score`, mirroring
   * `(t.nearest_finding_score is null or t.nearest_finding_score < x)`. A row whose score is
   * NULL **PASSES** it. The threshold itself stays here in the Worker
   * (`DUPLICATE_SIMILARITY`), so tuning it never needs a sonar redeploy.
   */
  nearest_finding_score_max?: number;
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
 * unprovisioned Worker (no `SONAR_BASE_URL`/`SONAR_SECRET`, the local-dev steady state), a request
 * past {@link SONAR_MAX_TOP_K}/{@link SONAR_MAX_PROBES} (which the engine would 400), a non-2xx
 * status, a timeout past {@link SONAR_TIMEOUT_MS}, a DNS/transport failure, or a body that does not
 * parse to `{ matches: [{id, score}] }`. Every one of them means the same thing to the caller: use
 * the existing path. A well-formed EMPTY result is returned as `[]` (a real "no matches"), distinct
 * from `null`; surfaces treat an empty result as a fallback too, since a reached surface always has
 * a real probe over a populated corpus, so zero matches is a sonar hiccup rather than a true empty
 * neighbourhood — and falling back can only restore today's behaviour, never worsen it.
 */
export async function searchSonar(request: SonarSearchRequest): Promise<SonarMatch[] | null> {
  // The caps, checked before anything else: an over-cap request is one the engine answers with a
  // 400 (search.rs `cap_violation`), so sending it would only buy a wasted round trip. `null` here
  // is the same fallback the 400 produces — never a clamp (see SONAR_MAX_TOP_K).
  if (request.topK > SONAR_MAX_TOP_K || request.probes.length > SONAR_MAX_PROBES) {
    return null;
  }

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
