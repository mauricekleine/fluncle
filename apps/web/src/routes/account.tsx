import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { AuthForms, ClaimUsernameDialog } from "@/components/account/auth-forms";
import { GalaxyDoor, GalaxyDoorSkeleton } from "@/components/account/galaxy-door";
import { SavesDoor, SavesDoorSkeleton } from "@/components/account/saves-door";
import { SettingsDoor } from "@/components/account/settings-door";
import {
  type AccountIdentity,
  type AccountTab,
  type DoorData,
  parseAccountTab,
} from "@/components/account/shared";
import { siteUrl } from "@/lib/fluncle-links";
import {
  getGalaxyProgress,
  listGalaxyCollection,
  listSavedFindings,
  listSavedSets,
  listUserSubmissions,
  meResponse,
} from "@/lib/server/account-data";
import { createCsrfToken, getPublicSession } from "@/lib/server/public-auth";

// The account area, redesigned as a per-door surface (docs/planning/account-redesign-brief.md,
// Phase A). The route owns the loader, the two `createServerFn`s the loader calls, the
// page shell + per-door masthead, and the door switch; each door's contents live in
// its own module under components/account. Loading is SSR-first (real content on first
// paint, no blank→pop) with a react-query hybrid seeded from the loader; per-door
// skeletons appear only on a client-side door switch.

/**
 * The identity read: the `/me` session shape + a mutation token for the signed-in
 * user. Runs with the request (via `getRequest`) so `meResponse`/`getPublicSession`
 * resolve the caller's own session. Always fetched — signed-out gets identity only.
 */
const getAccountIdentity = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountIdentity> => {
    const me = await meResponse(getRequest());

    return { csrfToken: me.user ? createCsrfToken(me.user) : "", me };
  },
);

/**
 * The active door's data, and ONLY that door's — the loader passes the current tab so
 * a signed-in read never fetches the two doors the user isn't looking at. Settings
 * rides on `me`, so it carries nothing extra.
 */
const getAccountDoorData = createServerFn({ method: "GET" })
  .validator((data: { tab: AccountTab }) => data)
  .handler(async ({ data }): Promise<DoorData> => {
    const user = await getPublicSession(getRequest());

    if (!user || data.tab === "settings") {
      return { tab: "settings" };
    }

    if (data.tab === "saves") {
      const [saved, sets, submissions] = await Promise.all([
        listSavedFindings(user),
        listSavedSets(user),
        listUserSubmissions(user),
      ]);

      return {
        saved: saved.savedFindings,
        sets: sets.savedSets,
        submissions: submissions.submissions,
        tab: "saves",
      };
    }

    const [progress, collection] = await Promise.all([
      getGalaxyProgress(user),
      listGalaxyCollection(user),
    ]);

    return {
      collection: { collection: collection.collection, galaxies: collection.galaxies },
      progress: {
        collectedLogIds: progress.collectedLogIds,
        deaths: progress.deaths,
        wins: progress.wins,
      },
      tab: "galaxy",
    };
  });

// oxlint-disable-next-line sort-keys -- TanStack's canonical option order (validateSearch feeds the rest).
export const Route = createFileRoute("/account")({
  validateSearch: (search: Record<string, unknown>): { tab?: AccountTab } => ({
    tab: parseAccountTab(search.tab),
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: async ({ deps }): Promise<{ door: DoorData | undefined; identity: AccountIdentity }> => {
    const identity = await getAccountIdentity();
    // Fetch the active door on the SERVER only: SSR paints real content on first
    // paint, while a client-side door switch skips it so react-query can show the
    // per-door skeleton before its data lands. Signed-out fetches no door.
    const door =
      import.meta.env.SSR && identity.me.user
        ? await getAccountDoorData({ data: { tab: deps.tab ?? "galaxy" } })
        : undefined;

    return { door, identity };
  },
  head: () => ({
    links: [{ href: `${siteUrl}/account`, rel: "canonical" }],
    meta: [
      { title: "Your place in the Galaxy" },
      {
        content:
          "Private Fluncle account settings, Galaxy progress, saved findings, and submissions.",
        name: "description",
      },
    ],
  }),
  component: AccountPage,
});

// The per-door masthead: the title names the room now that the in-page tab strip is
// gone (the crew-slot menu is the switcher). Sentence-case taglines, no exclamation
// marks, no em dashes.
const DOOR_MASTHEAD: Record<AccountTab, { tagline: string; title: string }> = {
  galaxy: { tagline: "Your logs, your runs, and the stars you've reached.", title: "The Galaxy" },
  saves: { tagline: "The findings and sets you kept.", title: "Saves" },
  settings: { tagline: "Your profile, preferences, and account.", title: "Settings" },
};

const SIGNED_OUT_MASTHEAD = {
  tagline: "Private progress, saved findings, and submissions.",
  title: "Your place in the Galaxy",
};

function AccountPage() {
  const { tab } = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const activeTab: AccountTab = tab ?? "galaxy";

  // Identity is seeded from the loader (SSR) and never refetches on focus — the
  // session rarely changes under the user's feet. Mutations invalidate it explicitly.
  const identityQuery = useQuery({
    initialData: loaderData.identity,
    queryFn: () => getAccountIdentity(),
    queryKey: ["account", "identity"],
    refetchOnWindowFocus: false,
  });
  const { csrfToken, me } = identityQuery.data;
  const signedIn = !!me.user;

  // The active door's data, seeded from the loader and keyed by tab so each door has
  // its own cache entry; focus-refetch keeps the live doors fresh (off for settings,
  // which rides on `me`). On a client-side switch the initial data is absent, so the
  // per-door skeleton shows until the fetch lands.
  const doorQuery = useQuery({
    enabled: signedIn,
    initialData: loaderData.door,
    queryFn: () => getAccountDoorData({ data: { tab: activeTab } }),
    queryKey: ["account", activeTab],
    refetchOnWindowFocus: activeTab !== "settings",
  });

  // The doors' mutations call refresh() after a write; repointed onto react-query so a
  // profile/save/delete re-reads both identity and the active door.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["account"] });

  const masthead = signedIn ? DOOR_MASTHEAD[activeTab] : SIGNED_OUT_MASTHEAD;
  const door = doorQuery.data;

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-4xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">{masthead.title}</h1>
            <p className="home-tagline">{masthead.tagline}</p>
          </div>
        </header>

        {signedIn && me.user ? (
          <>
            <ClaimUsernameDialog csrfToken={csrfToken} refresh={refresh} user={me.user} />
            {activeTab === "settings" ? (
              <SettingsDoor
                csrfToken={csrfToken}
                message={message}
                refresh={refresh}
                setMessage={setMessage}
                user={me.user}
              />
            ) : doorQuery.isError && !door ? (
              <LoadFailed onRetry={() => void doorQuery.refetch()} />
            ) : activeTab === "galaxy" ? (
              door?.tab === "galaxy" ? (
                <GalaxyDoor data={door} />
              ) : (
                <GalaxyDoorSkeleton />
              )
            ) : door?.tab === "saves" ? (
              <SavesDoor csrfToken={csrfToken} data={door} refresh={refresh} />
            ) : (
              <SavesDoorSkeleton />
            )}
          </>
        ) : (
          <AuthForms
            googleEnabled={me.googleEnabled}
            message={message}
            refresh={refresh}
            setMessage={setMessage}
          />
        )}
      </article>
    </main>
  );
}

/** The load-failure path (kept from the monolith): surface it, offer the retry. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="account-section">
      <p className="account-muted">Could not load that door. Check your connection.</p>
      <Button onClick={onRetry} type="button" variant="outline">
        Try again
      </Button>
    </div>
  );
}
