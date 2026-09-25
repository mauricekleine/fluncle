type ReplicaToken = {
  expiresAt: string;
  token: string;
  url: string;
};

export type CachedReplicaToken = ReplicaToken & { fetchedAt: number };

export const TOKEN_REFRESH_FRACTION = 0.8;

export const REPLICA_TOKEN_STORAGE_KEY = "fluncle.replica.token.v1";

export function tokenNeedsRefresh(cached: CachedReplicaToken | undefined, now: number): boolean {
  if (!cached) {
    return true;
  }

  const expiresAt = Date.parse(cached.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return true;
  }

  const lifetimeMs = expiresAt - cached.fetchedAt;
  if (lifetimeMs <= 0) {
    return true;
  }

  if (now < cached.fetchedAt) {
    return true;
  }

  return now >= cached.fetchedAt + lifetimeMs * TOKEN_REFRESH_FRACTION;
}

export function serializeCachedToken(cached: CachedReplicaToken): string {
  return JSON.stringify(cached);
}

export function parseCachedToken(raw: string | null | undefined): CachedReplicaToken | undefined {
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const row = parsed as Record<string, unknown>;
  if (
    typeof row.expiresAt !== "string" ||
    typeof row.token !== "string" ||
    typeof row.url !== "string" ||
    typeof row.fetchedAt !== "number" ||
    row.token.length === 0 ||
    row.url.length === 0
  ) {
    return undefined;
  }

  return {
    expiresAt: row.expiresAt,
    fetchedAt: row.fetchedAt,
    token: row.token,
    url: row.url,
  };
}

function readField(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

export function isReplicaUnavailableFault(error: unknown): boolean {
  const data = readField(error, "data");
  if (readField(data, "apiCode") === "replica_unavailable") {
    return true;
  }

  return readField(error, "status") === 503 || readField(error, "code") === "SERVICE_UNAVAILABLE";
}

const AUTH_SHAPED_MARKERS = [
  "401",
  "403",
  "auth",
  "credential",
  "expired",
  "forbidden",
  "jwt",
  "permission",
  "token",
  "unauthorized",
];

export function isAuthShapedSyncFailure(error: unknown): boolean {
  const message = readField(error, "message");
  const text = (typeof message === "string" ? message : String(error)).toLowerCase();
  return AUTH_SHAPED_MARKERS.some((marker) => text.includes(marker));
}
