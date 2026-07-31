// The replica credential's LIFECYCLE, kept pure (no oRPC client, no kv-store, no RN tree) so
// every branch of "is this token still good, and what does this failure mean" is pinned by a
// test rather than discovered on a device.
//
// The Worker's `get_replica_token` mints a 24-hour read-only Turso credential
// (`{ url, token, expiresAt }`) and never proxies replica data; the device syncs Turso
// directly. Three rules follow, and all three are here:
//
//   REFRESH EARLY. A token is replaced at 80% of its own lifetime, measured from when this
//   device received it — not from a lifetime constant. The server owns the duration and may
//   change it; reading `expiresAt` minus `fetchedAt` means this side never has to be told.
//
//   AN AUTH FAILURE IS WORTH ONE RE-FETCH. A sync that fails on the credential (rather than
//   on the network) may simply have raced a revocation, so the caller drops the cache and
//   asks once more. `isAuthShapedSyncFailure` is deliberately generous: guessing "auth" for
//   a network blip costs one wasted request, while missing a real one strands the replica
//   until the next launch.
//
//   `replica_unavailable` IS NOT AN ERROR TO RETRY. The endpoint ships dark — an unwired
//   deployment answers a typed 503 forever, so retrying it is a loop that reaches nothing.
//   The caller stays dark until the next foreground or launch.
//
// The token is a READ-ONLY credential to the shared public-catalogue replica: the same rows
// the public API already serves. Caching it on the device buys the cold offline open (a file
// cannot be opened in libSQL mode without a url + token, even when the sync that follows is
// going to fail), and an expired copy grants nothing.

/** What the Worker mints: where the replica lives, the credential, and when it dies. */
export type ReplicaToken = {
  expiresAt: string;
  token: string;
  url: string;
};

/** A minted token plus the instant THIS device received it, which is what dates the refresh. */
export type CachedReplicaToken = ReplicaToken & { fetchedAt: number };

/** Replace the token once this much of its own lifetime has burned. */
export const TOKEN_REFRESH_FRACTION = 0.8;

/** The kv-store key the cached credential lives under. */
export const REPLICA_TOKEN_STORAGE_KEY = "fluncle.replica.token.v1";

/**
 * Is it time to ask for a new token? Every uncertain answer is `true`: no token, an
 * unparsable or already-passed expiry, a lifetime that makes no sense, or a clock that has
 * moved backwards past the fetch. Fetching one token too many costs a request; using a dead
 * one costs the sync.
 */
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

  // A clock that jumped backwards reads as "fetched in the future"; treat it as due rather
  // than trusting an interval measured across the jump.
  if (now < cached.fetchedAt) {
    return true;
  }

  return now >= cached.fetchedAt + lifetimeMs * TOKEN_REFRESH_FRACTION;
}

/** Serialize for kv-store. The envelope is the object itself — one version, one shape. */
export function serializeCachedToken(cached: CachedReplicaToken): string {
  return JSON.stringify(cached);
}

/**
 * Read a cached token back, tolerant of anything: absent, invalid JSON, a wrong shape, or a
 * field of the wrong type all answer `undefined`. A device with a corrupt cache fetches a
 * fresh token; it never throws on a cold start.
 */
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

// Walk an unknown error for a field, without assuming a class or a depth.
function readField(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

/**
 * Is this the endpoint's typed "the replica is unavailable" 503? Recognised by the
 * `apiCode` the Worker puts in the fault's data, with the transport's own 503 / oRPC code as
 * the fallback for a client that surfaced the status without the body.
 */
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

/**
 * Does this sync failure look like the CREDENTIAL rather than the network? Read off the
 * message, because the native libSQL layer surfaces a string rather than a typed status.
 * Generous on purpose — see the header on why the two mistakes cost different amounts.
 */
export function isAuthShapedSyncFailure(error: unknown): boolean {
  const message = readField(error, "message");
  const text = (typeof message === "string" ? message : String(error)).toLowerCase();
  return AUTH_SHAPED_MARKERS.some((marker) => text.includes(marker));
}
