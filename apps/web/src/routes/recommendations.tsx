import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { type ReactNode } from "react";
import { Button } from "@fluncle/ui/components/button";
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
import { createCsrfToken, getPublicSession } from "@/lib/server/public-auth";
import {
  listRecommendations,
  listRecSeeds,
  type RecommendationsResult,
  type RecSeedItem,
} from "@/lib/server/recommendations";

// ── /recommendations — the per-listener telescope, the crew door ──────────────────────
//
// A signed-in listener points Fluncle at ~10 tracks they love, and the Ear's anchored
// max-similarity scan (E1's server core) lines up the catalogue against THEIR seeds, plus the
// findings nearest that seed set as full-voice slots (the register split). Fluncle mints the
// result into a playlist on his own Spotify, refreshed weekly. This route is the door.
//
// The never-gates law holds through three states off the session (the /chat crew-door
// precedent): anonymous (a quiet pitch + join link), signed-in-but-unverified (the verify
// pointer — the learning cohort), and verified (the working surface). The server re-checks the
// session and the verification on every op; the gate here is wayfinding, and the SSR loader
// seeds the verified surface's react-query with real content on first paint.

/**
 * The gate, resolved from the requester's own session. The verified state ALSO carries the
 * SSR-computed seed set + first recommendations (react-query seeds off them) and the mutation
 * token (the account/chat loader-mint pattern — one token, reused for the seed + playlist
 * writes). A read failure on the engine degrades to empty rather than blocking the door.
 */
const getRecsGate = createServerFn({ method: "GET" }).handler(async (): Promise<RecsGate> => {
  const user = await getPublicSession(getRequest());

  if (!user) {
    return { state: "anonymous" };
  }

  if (!user.emailVerified) {
    return { state: "unverified" };
  }

  const [seedsResult, recsResult, editions] = await Promise.all([
    listRecSeeds(user),
    listRecommendations(user),
    getFrontierEditions(user.id),
  ]);

  return {
    csrfToken: createCsrfToken(user),
    editions,
    recommendations: recsResult instanceof Response ? EMPTY_RECS : recsResult,
    seeds: seedsResult.seeds,
    state: "verified",
  };
});

/** A user's past editions on their own — the react-query refetch after a real refresh. */
const loadFrontierEditions = createServerFn({ method: "GET" }).handler(
  async (): Promise<FrontierEditionSummary[]> => {
    const user = await getPublicSession(getRequest());

    if (!user || !user.emailVerified) {
      return [];
    }

    return getFrontierEditions(user.id);
  },
);

/** One past edition's frozen tracklist, lazy-loaded when the dialog opens (null = no edition
 *  at that number for this user). Scoped to the requester's own session on every call. */
const loadFrontierEdition = createServerFn({ method: "GET" })
  .validator((data: { number: number }) => data)
  .handler(async ({ data: { number } }): Promise<FrontierEditionDetail | null> => {
    const user = await getPublicSession(getRequest());

    if (!user || !user.emailVerified) {
      return null;
    }

    return (await getFrontierEdition(user.id, number)) ?? null;
  });

/** The seed set on its own — the react-query refetch after a seed write. */
const getRecSeeds = createServerFn({ method: "GET" }).handler(async (): Promise<RecSeedItem[]> => {
  const user = await getPublicSession(getRequest());

  if (!user) {
    return [];
  }

  return (await listRecSeeds(user)).seeds;
});

/** The computed recommendations on their own — the react-query refetch after a seed write. */
const getRecommendations = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecommendationsResult> => {
    const user = await getPublicSession(getRequest());

    if (!user || !user.emailVerified) {
      return EMPTY_RECS;
    }

    const result = await listRecommendations(user);

    return result instanceof Response ? EMPTY_RECS : result;
  },
);

// oxlint-disable-next-line sort-keys -- TanStack's canonical option order (loader feeds head/component).
export const Route = createFileRoute("/recommendations")({
  loader: () => getRecsGate(),
  head: () => ({
    links: [{ href: `${siteUrl}/recommendations`, rel: "canonical" }],
    meta: [
      { title: "Recommendations" },
      {
        content:
          "Point Fluncle at the tracks you love and he digs the far side of the archive for more.",
        name: "description",
      },
      // Unlisted while the door is gated (ROADMAP § the recommendation machine): it exists for
      // the crew who sign in, but it is not announced, not in the registry, and not indexed.
      { content: "noindex", name: "robots" },
    ],
  }),
  component: RecommendationsPage,
});

const MASTHEAD: Record<RecsGate["state"], string> = {
  anonymous: "The crate Fluncle digs from the far side of the archive, pointed at your taste.",
  unverified: "The crate Fluncle digs from the far side of the archive, pointed at your taste.",
  // The verified door shows no tagline — the playlist header carries the meaning.
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
            {/* The verified door carries its own meaning — the tagline speaks only where
                the gate still has to make the pitch. */}
            {gate.state === "verified" ? null : (
              <p className="home-tagline">{MASTHEAD[gate.state]}</p>
            )}
          </div>
          {/* The archive-browse control sits top-right, verified only (the mix.tsx masthead
              pattern); it renders nothing until there is a past edition to reach back to. */}
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
            initialRecommendations={gate.recommendations}
            initialSeeds={gate.seeds}
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
            body="Join the crew to point him at your taste, and he lines up bangers that sit close to it."
            lede="Fluncle digs the far side of the archive for you."
          />
        )}
      </article>
    </main>
  );
}

/**
 * The quiet gate notice (the /chat crew-door grammar): a lede, one line of context, and the
 * single literal control that opens the way (the Chrome Rule — the prose carries the voice, the
 * button names the action). An outline control, never a gold fill (One Sun).
 */
function GateNotice({ action, body, lede }: { action: ReactNode; body: string; lede: string }) {
  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <div className="space-y-1.5">
        <p className="text-base text-foreground">{lede}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}
