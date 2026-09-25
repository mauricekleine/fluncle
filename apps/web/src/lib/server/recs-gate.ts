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
