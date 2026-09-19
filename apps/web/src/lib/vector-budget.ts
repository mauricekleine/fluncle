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

// ── `/mix`'s own, tighter ceilings ────────────────────────────────────────────
//
// `VECTOR_FALLBACK_DEADLINE_MS` is a DIAGNOSTIC ceiling: the outer bound on a bounded analytical
// scan, chosen so a slow answer still beats no answer. `/mix` is not that. It is an interactive
// public page where a reader is waiting on a rail to pick the next tune, and a correct answer that
// arrives after twenty seconds is not a better answer than an honest empty one — it is a page that
// looked broken and then changed its mind. So the rail takes ceilings of its own, below the
// generic one, and degrades inside them.

/** The rail's candidate scan may occupy the database for at most this long. */
export const MIX_RAIL_SCAN_DEADLINE_MS = 6_000;

/**
 * The whole rail — every round trip, not just the scan — may occupy a request for at most this
 * long. It sits above the scan deadline by the handful of small reads around it (target row, key
 * spellings, engine flag, hydrate), so a scan that was going to land inside its own budget is
 * never pre-empted by this one; this is the backstop for time spent ANYWHERE, including a
 * statement that has no deadline of its own yet.
 */
export const MIX_RAIL_DEADLINE_MS = 8_000;
