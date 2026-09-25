import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Button } from "@fluncle/ui/components/button";
import { GateNotice } from "@/components/gate-notice";
import { FrontierEditions } from "@/components/recommendations/frontier-editions";
import { RecommendationsDoor } from "@/components/recommendations/recommendations-door";
import {
  EMPTY_RECS,
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  type RecsGate,
} from "@/components/recommendations/shared";
import { siteUrl } from "@/lib/fluncle-links";
import { getFrontierEdition, getFrontierEditions } from "@/lib/server/frontier-editions";
import { createCsrfToken, getPublicSession, type PublicUser } from "@/lib/server/public-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import {
  listRecommendations,
  listRecSeeds,
  RECOMMENDATIONS_RATE_LIMIT,
  RECOMMENDATIONS_RATE_WINDOW_MS,
  type RecommendationsResult,
  type RecSeedItem,
} from "@/lib/server/recommendations";
import { buildRecsGate } from "@/lib/server/recs-gate";

async function readDraftRecommendations(
  user: PublicUser,
  request: Request,
): Promise<RecommendationsResult> {
  const limited = await enforceRateLimit({
    action: "account.recs.read",
    limit: RECOMMENDATIONS_RATE_LIMIT,
    request,
    userId: user.id,
    windowMs: RECOMMENDATIONS_RATE_WINDOW_MS,
  });

  if (limited) {
    return EMPTY_RECS;
  }

  const result = await listRecommendations(user);

  return result instanceof Response ? EMPTY_RECS : result;
}

const getRecsGate = createServerFn({ method: "GET" }).handler(async (): Promise<RecsGate> => {
  const request = getRequest();
  const user = await getPublicSession(request);

  return buildRecsGate(user, {
    createCsrfToken,
    getFrontierEdition,
    getFrontierEditions,
    listRecSeeds,
    runDraftEngine: (draftUser) => readDraftRecommendations(draftUser, request),
  });
});

const getLatestEdition = createServerFn({ method: "GET" }).handler(
  async (): Promise<FrontierEditionDetail | null> => {
    const user = await getPublicSession(getRequest());

    if (!user || !user.emailVerified) {
      return null;
    }

    const editions = await getFrontierEditions(user.id);
    const latest = editions[0];

    if (!latest) {
      return null;
    }

    return (await getFrontierEdition(user.id, latest.number)) ?? null;
  },
);

const loadFrontierEditions = createServerFn({ method: "GET" }).handler(
  async (): Promise<FrontierEditionSummary[]> => {
    const user = await getPublicSession(getRequest());

    if (!user || !user.emailVerified) {
      return [];
    }

    return getFrontierEditions(user.id);
  },
);

const loadFrontierEdition = createServerFn({ method: "GET" })
  .validator((data: { number: number }) => data)
  .handler(async ({ data: { number } }): Promise<FrontierEditionDetail | null> => {
    const user = await getPublicSession(getRequest());

    if (!user || !user.emailVerified) {
      return null;
    }

    return (await getFrontierEdition(user.id, number)) ?? null;
  });

const getRecSeeds = createServerFn({ method: "GET" }).handler(async (): Promise<RecSeedItem[]> => {
  const user = await getPublicSession(getRequest());

  if (!user) {
    return [];
  }

  return (await listRecSeeds(user)).seeds;
});

const getRecommendations = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecommendationsResult> => {
    const request = getRequest();
    const user = await getPublicSession(request);

    if (!user || !user.emailVerified) {
      return EMPTY_RECS;
    }

    return readDraftRecommendations(user, request);
  },
);

// oxlint-disable-next-line sort-keys -- TanStack's canonical option order (loader feeds head/component).
export const Route = createFileRoute("/recommendations")({
  loader: () => getRecsGate(),

  staleTime: 0,
  head: () => ({
    links: [{ href: `${siteUrl}/recommendations`, rel: "canonical" }],
    meta: [
      { title: "Recommendations" },
      {
        content: "Point Fluncle at the tracks you love and he digs the archive for more.",
        name: "description",
      },

      { content: "noindex", name: "robots" },
    ],
  }),
  component: RecommendationsPage,
});

const MASTHEAD: Record<RecsGate["state"], string> = {
  anonymous: "The crate Fluncle digs from the archive, pointed at your taste.",
  unverified: "The crate Fluncle digs from the archive, pointed at your taste.",

  verified: "",
};

function RecommendationsPage() {
  const gate = Route.useLoaderData();

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-4xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Recommendations</h1>

            {gate.state === "verified" ? null : (
              <p className="home-tagline">{MASTHEAD[gate.state]}</p>
            )}
          </div>

          {gate.state === "verified" ? (
            <div className="home-masthead-actions">
              <FrontierEditions
                csrfToken={gate.csrfToken}
                initialEditions={gate.editions}
                loadEdition={(number) => loadFrontierEdition({ data: { number } })}
                loadEditions={() => loadFrontierEditions()}
              />
            </div>
          ) : null}
        </header>

        {gate.state === "verified" ? (
          <RecommendationsDoor
            csrfToken={gate.csrfToken}
            initialEditions={gate.editions}
            initialLatest={gate.latest}
            initialRecommendations={gate.recommendations}
            initialSeeds={gate.seeds}
            loadEditions={() => loadFrontierEditions()}
            loadLatestEdition={() => getLatestEdition()}
            loadRecommendations={() => getRecommendations()}
            loadSeeds={() => getRecSeeds()}
          />
        ) : gate.state === "unverified" ? (
          <GateNotice
            action={
              <Button
                nativeButton={false}
                render={<Link search={{ tab: "settings" }} to="/account" />}
                variant="outline"
              >
                Open settings
              </Button>
            }
            body="The verification link is in your inbox. If it slipped between dimensions, resend it from settings."
            lede="Verify your email to open the frontier."
          />
        ) : (
          <GateNotice
            action={
              <Button nativeButton={false} render={<Link to="/account" />} variant="outline">
                Join the crew
              </Button>
            }
            body="Join the crew to point him at your taste, and he lines up bangers to match."
            lede="Fluncle digs the archive for you."
          />
        )}
      </article>
    </main>
  );
}
