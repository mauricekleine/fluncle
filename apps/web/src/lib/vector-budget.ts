// THE ONE NUMBER A VECTOR-CAPABLE READ IS ALLOWED TO COST, and the one place it is written.
//
// It lives here — a pure, dependency-free module — rather than beside the fallback executor
// because two very different readers have to agree on it and neither may restate it:
//   - `lib/server/vector-fallback.ts`, which races a request-time Turso vector scan against it
//     (libSQL cannot cancel remote work, so the deadline is the only stop there is), and
//   - `scripts/post-deploy-probe.ts`, a standalone Bun script with no Worker runtime, which must
//     wait AT LEAST this long before calling a vector-capable endpoint dead.
//
// A probe that gives up sooner than the deadline the server is allowed to spend reports a
// failure the server never committed. Deriving the probe's budget from this constant is what
// makes that drift impossible rather than merely unlikely.

/** A fallback may occupy a request for at most this long. libSQL cannot cancel the remote work. */
export const VECTOR_FALLBACK_DEADLINE_MS = 12_000;

/**
 * The headroom an out-of-process caller adds on top of the deadline before it may call a
 * vector-capable endpoint dead: TLS, the edge hop, and the Worker's own serialization of heavy
 * reads all sit outside the budget the deadline governs. It is deliberately generous — a probe's
 * job is to catch a route that stopped resolving, and the SLOW warning below is what catches a
 * route that merely got slower.
 */
export const VECTOR_ENDPOINT_PROBE_MARGIN_MS = 5_000;

/** What an out-of-process caller waits for a vector-capable endpoint before declaring it dead. */
export const VECTOR_ENDPOINT_PROBE_TIMEOUT_MS =
  VECTOR_FALLBACK_DEADLINE_MS + VECTOR_ENDPOINT_PROBE_MARGIN_MS;
