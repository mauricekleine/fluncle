// Self-running checks for the replica credential's lifecycle — no framework (see
// replica-identity.test.ts on the style). No network: nothing here fetches, and the two error
// classifiers are fed hand-built shapes rather than live faults.
//
// These pin the three rules the wiring depends on: refresh at 80% of the token's OWN measured
// lifetime, recognise a credential failure generously, and recognise the endpoint's dark 503
// exactly — because that one must never be retried.

import {
  type CachedReplicaToken,
  TOKEN_REFRESH_FRACTION,
  isAuthShapedSyncFailure,
  isReplicaUnavailableFault,
  parseCachedToken,
  serializeCachedToken,
  tokenNeedsRefresh,
} from "@/lib/replica-token";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const FETCHED_AT = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const token = (overrides: Partial<CachedReplicaToken> = {}): CachedReplicaToken => ({
  expiresAt: new Date(FETCHED_AT + DAY_MS).toISOString(),
  fetchedAt: FETCHED_AT,
  token: "a-read-only-jwt",
  url: "libsql://device-replica.example.turso.io",
  ...overrides,
});

// 1. The refresh window is measured off the token itself, not off a constant this side holds.
assertEqual(tokenNeedsRefresh(token(), FETCHED_AT), false, "fresh at issue");
assertEqual(
  tokenNeedsRefresh(token(), FETCHED_AT + DAY_MS * TOKEN_REFRESH_FRACTION - 1),
  false,
  "still fresh one millisecond before the threshold",
);
assertEqual(
  tokenNeedsRefresh(token(), FETCHED_AT + DAY_MS * TOKEN_REFRESH_FRACTION),
  true,
  "due exactly at 80% of its lifetime",
);
assertEqual(tokenNeedsRefresh(token(), FETCHED_AT + DAY_MS * 2), true, "long past expiry");

// 2. A server that changes the lease length needs no change here: the fraction rides whatever
//    lifetime the token declares.
const shortLease = token({ expiresAt: new Date(FETCHED_AT + 60_000).toISOString() });
assertEqual(tokenNeedsRefresh(shortLease, FETCHED_AT + 47_000), false, "a one-minute lease, 47s");
assertEqual(tokenNeedsRefresh(shortLease, FETCHED_AT + 48_000), true, "a one-minute lease, 48s");

// 3. Every uncertain answer is "refresh": no token, an unreadable expiry, a lifetime that never
//    was, and a clock that moved backwards past the fetch.
assertEqual(tokenNeedsRefresh(undefined, FETCHED_AT), true, "no token at all");
assertEqual(tokenNeedsRefresh(token({ expiresAt: "whenever" }), FETCHED_AT), true, "unparsable");
assertEqual(
  tokenNeedsRefresh(token({ expiresAt: new Date(FETCHED_AT - 1).toISOString() }), FETCHED_AT),
  true,
  "expiry before the fetch is nonsense",
);
assertEqual(tokenNeedsRefresh(token(), FETCHED_AT - 5_000), true, "clock moved backwards");

// 4. The storage round trip, and a parse that tolerates everything a corrupt cache can hold.
const roundTripped = parseCachedToken(serializeCachedToken(token()));
assertEqual(roundTripped?.token, "a-read-only-jwt", "round trips the credential");
assertEqual(roundTripped?.fetchedAt, FETCHED_AT, "round trips the fetch instant");
assertEqual(parseCachedToken(null), undefined, "absent");
assertEqual(parseCachedToken(""), undefined, "empty");
assertEqual(parseCachedToken("{not json"), undefined, "invalid JSON");
assertEqual(parseCachedToken("[]"), undefined, "an array is not the envelope");
assertEqual(parseCachedToken('{"token":"t","url":"u"}'), undefined, "no fetchedAt");
assertEqual(
  parseCachedToken('{"token":"","url":"u","expiresAt":"x","fetchedAt":1}'),
  undefined,
  "an empty credential is no credential",
);
assertEqual(
  parseCachedToken('{"token":"t","url":"u","expiresAt":"x","fetchedAt":"1"}'),
  undefined,
  "a fetchedAt of the wrong type is rejected, never coerced",
);

// 5. The dark 503 is recognised by the Worker's own apiCode, and by the bare status or oRPC
//    code when a client surfaced one without the body.
assertEqual(
  isReplicaUnavailableFault({ data: { apiCode: "replica_unavailable" }, status: 503 }),
  true,
  "the typed fault",
);
assertEqual(isReplicaUnavailableFault({ status: 503 }), true, "the bare status");
assertEqual(isReplicaUnavailableFault({ code: "SERVICE_UNAVAILABLE" }), true, "the oRPC code");
assertEqual(isReplicaUnavailableFault({ status: 500 }), false, "a real server error is not dark");
assertEqual(isReplicaUnavailableFault(new Error("network request failed")), false, "a blip");
assertEqual(isReplicaUnavailableFault(undefined), false, "nothing is not dark");

// 6. A credential-shaped sync failure. Generous by design: one wasted re-fetch costs a request,
//    while missing a real revocation strands the replica until the next launch.
assertEqual(isAuthShapedSyncFailure(new Error("Unauthorized")), true, "401 by name");
assertEqual(isAuthShapedSyncFailure(new Error("HTTP status 403")), true, "403 by number");
assertEqual(isAuthShapedSyncFailure(new Error("the auth token has expired")), true, "expiry");
assertEqual(isAuthShapedSyncFailure({ message: "invalid JWT" }), true, "a plain object message");
assertEqual(isAuthShapedSyncFailure("permission denied"), true, "a thrown string");
assertEqual(isAuthShapedSyncFailure(new Error("Network request failed")), false, "a tunnel");
assertEqual(isAuthShapedSyncFailure(new Error("no such table: findings")), false, "a bad file");

console.log("replica-token.test.ts: all assertions passed");
