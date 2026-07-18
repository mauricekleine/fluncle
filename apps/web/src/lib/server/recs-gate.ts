// THE /recommendations READ GATE — resolves the door's SSR payload from the requester's own
// session, and encodes the ONE invariant the shelf-from-editions move exists for: a COMMITTED
// user's page view reads a stored edition and NEVER runs the vector engine
// (frontier-shelf-from-editions-rfc.md D3). Only the DRAFT phase (no edition yet) runs the
// live scan, and that is the single bounded cohort where a live per-seed recompute is the
// desired behaviour.
//
// The engine, the reads, the token mint, and the seed read are all INJECTED (`RecsGateDeps`)
// so the invariant is unit-testable off the database: a test pins that the committed branch
// never calls `runDraftEngine`, and that the draft branch does. The route (recommendations.tsx)
// wires the real implementations in.

import {
  EMPTY_RECS,
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  isEditionStale,
  type RecommendationsResult,
  type RecsGate,
  type RecSeedItem,
} from "@/components/recommendations/shared";
import { type PublicUser } from "@/lib/server/public-auth";

/**
 * The gate's collaborators, injected so the "committed never touches the engine" invariant
 * pins as a plain unit. `runDraftEngine` is the rate-limited draft read (already degraded to
 * `EMPTY_RECS` on a limit/fault — the gate never sees a `Response`); `getFrontierEdition`
 * returns `undefined` when the number resolves to no edition (a race a defensive read tolerates).
 */
export type RecsGateDeps = {
  createCsrfToken: (user: PublicUser) => string;
  getFrontierEdition: (
    userId: string,
    number: number,
  ) => Promise<FrontierEditionDetail | undefined>;
  getFrontierEditions: (userId: string) => Promise<FrontierEditionSummary[]>;
  listRecSeeds: (user: PublicUser) => Promise<{ ok: true; seeds: RecSeedItem[] }>;
  runDraftEngine: (user: PublicUser) => Promise<RecommendationsResult>;
};

/**
 * Resolve the /recommendations gate. Anonymous and unverified fall through to their wayfinding
 * states; a verified user gets the full payload, branched by PHASE:
 *
 *   - COMMITTED (≥1 edition): load the latest edition (the list is newest-first, so its head
 *     names the latest by number), compute staleness from the seeds, and return `EMPTY_RECS` —
 *     the engine is NOT called on a read.
 *   - DRAFT (0 editions): run the injected (rate-limited) draft engine.
 */
export async function buildRecsGate(
  user: PublicUser | null | undefined,
  deps: RecsGateDeps,
): Promise<RecsGate> {
  if (!user) {
    return { state: "anonymous" };
  }

  if (!user.emailVerified) {
    return { state: "unverified" };
  }

  const [seedsResult, editions] = await Promise.all([
    deps.listRecSeeds(user),
    deps.getFrontierEditions(user.id),
  ]);

  const csrfToken = deps.createCsrfToken(user);
  const seeds = seedsResult.seeds;
  const latestSummary = editions[0];

  if (latestSummary) {
    const latest = (await deps.getFrontierEdition(user.id, latestSummary.number)) ?? null;

    return {
      csrfToken,
      editions,
      latest,
      recommendations: EMPTY_RECS,
      seeds,
      stale: latest ? isEditionStale(latest, seeds) : false,
      state: "verified",
    };
  }

  const recommendations = await deps.runDraftEngine(user);

  return {
    csrfToken,
    editions,
    latest: null,
    recommendations,
    seeds,
    stale: false,
    state: "verified",
  };
}
