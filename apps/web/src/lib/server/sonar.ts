import { readOptionalEnv } from "./env";
import { getSetting, setSetting } from "./settings";

export const SONAR_SONIC_ENABLED_KEY = "sonar_sonic_enabled";

export const SONAR_ARTISTS_ENABLED_KEY = "sonar_artists_enabled";

export const SONAR_LOG_ENABLED_KEY = "sonar_log_enabled";

export const SONAR_RECS_ENABLED_KEY = "sonar_recs_enabled";

export const SONAR_RECS_CATALOGUE_ENABLED_KEY = "sonar_recs_catalogue_enabled";

export const SONAR_MIX_ENABLED_KEY = "sonar_mix_enabled";

export const SONAR_TRACK_ENABLED_KEY = "sonar_track_enabled";

export async function isSonarTrackEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_TRACK_ENABLED_KEY)) === "true";
}

export async function isSonarSonicEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_SONIC_ENABLED_KEY)) === "true";
}

export async function isSonarArtistsEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_ARTISTS_ENABLED_KEY)) === "true";
}

export async function isSonarLogEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_LOG_ENABLED_KEY)) === "true";
}

export async function isSonarRecsEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_RECS_ENABLED_KEY)) === "true";
}

export async function isSonarRecsCatalogueEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_RECS_CATALOGUE_ENABLED_KEY)) === "true";
}

export async function isSonarMixEnabled(): Promise<boolean> {
  return (await getSetting(SONAR_MIX_ENABLED_KEY)) === "true";
}

export async function setSonarSonicEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_SONIC_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarArtistsEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_ARTISTS_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarLogEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_LOG_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarRecsEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_RECS_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarRecsCatalogueEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_RECS_CATALOGUE_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarMixEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_MIX_ENABLED_KEY, enabled ? "true" : "false");
}

export async function setSonarTrackEnabled(enabled: boolean): Promise<void> {
  await setSetting(SONAR_TRACK_ENABLED_KEY, enabled ? "true" : "false");
}

export const SONAR_TIMEOUT_MS = 800;
export const SONAR_DELTA_CADENCE_SECS = 30;
export const SONAR_RECONCILE_CADENCE_SECS = 3600;

export const SONAR_MAX_TOP_K = 1000;

export const SONAR_MAX_PROBES = 32;

export type SonarIndex = "centroids" | "tracks";

export type SonarFilter = {
  anchored?: boolean;
  bpm_max?: number;
  bpm_min?: number;

  certified?: boolean;

  dismissed?: boolean;

  duration_ms_max?: number;

  has_finding?: boolean;

  is_duplicate?: boolean;
  key_in?: string[];

  nearest_finding_score_max?: number;
};

export type SonarSearchRequest = {
  excludeIds?: string[];

  filter?: SonarFilter;
  index: SonarIndex;

  probes: number[][];

  topK: number;
};

export type SonarMatch = {
  id: string;
  score: number;
};

export type SonarHealth = {
  artifactVersion: string;
  checkpoint: number;
  commit: string;
  consumerId: string;
  deltaAgeSeconds: number;
  deltaBacklog: number;
  headSeq: number;
  ok: boolean;
  pendingAck: boolean;
  replicaLagSeconds: number;
  tracks: number;
  validation: "last_attempt_failed" | "valid";
};

export async function readSonarHealth(): Promise<SonarHealth | null> {
  const baseUrl = await readOptionalEnv("SONAR_BASE_URL");
  const secret = await readOptionalEnv("SONAR_SECRET");

  if (!baseUrl || !secret) {
    return null;
  }

  try {
    const response = await fetch(new URL("/health", baseUrl), {
      headers: { "x-sonar-secret": secret },
      signal: AbortSignal.timeout(SONAR_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    return parseHealth(await response.json());
  } catch {
    return null;
  }
}

function parseHealth(payload: unknown): SonarHealth | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const nonnegativeInteger = (field: string) => {
    const candidate = value[field];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : null;
  };
  const checkpoint = nonnegativeInteger("checkpoint");
  const deltaAgeSeconds = nonnegativeInteger("delta_age_seconds");
  const deltaBacklog = nonnegativeInteger("delta_backlog");
  const headSeq = nonnegativeInteger("head_seq");
  const tracks = nonnegativeInteger("tracks");

  if (
    checkpoint === null ||
    deltaAgeSeconds === null ||
    deltaBacklog === null ||
    headSeq === null ||
    tracks === null ||
    typeof value.artifact_version !== "string" ||
    typeof value.commit !== "string" ||
    typeof value.consumer_id !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value.consumer_id) ||
    typeof value.ok !== "boolean" ||
    typeof value.pending_ack !== "boolean" ||
    (value.validation !== "valid" && value.validation !== "last_attempt_failed") ||
    typeof value.replica_lag_seconds !== "number" ||
    !Number.isSafeInteger(value.replica_lag_seconds)
  ) {
    return null;
  }

  return {
    artifactVersion: value.artifact_version,
    checkpoint,
    commit: value.commit,
    consumerId: value.consumer_id,
    deltaAgeSeconds,
    deltaBacklog,
    headSeq,
    ok: value.ok,
    pendingAck: value.pending_ack,
    replicaLagSeconds: value.replica_lag_seconds,
    tracks,
    validation: value.validation,
  };
}

export async function searchSonar(request: SonarSearchRequest): Promise<SonarMatch[] | null> {
  if (request.topK > SONAR_MAX_TOP_K || request.probes.length > SONAR_MAX_PROBES) {
    return null;
  }

  const baseUrl = await readOptionalEnv("SONAR_BASE_URL");
  const secret = await readOptionalEnv("SONAR_SECRET");

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

      signal: AbortSignal.timeout(SONAR_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as unknown;

    return parseMatches(payload);
  } catch {
    return null;
  }
}

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
