import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { AuthForms, ClaimUsernameDialog } from "@/components/account/auth-forms";
import { DeviceSaves } from "@/components/account/device-saves";
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
  listFollows,
  listUserSubmissions,
  meResponse,
} from "@/lib/server/account-data";
import { createCsrfToken, getPublicSession } from "@/lib/server/public-auth";

const getAccountIdentity = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountIdentity> => {
    const me = await meResponse(getRequest());

    return { csrfToken: me.user ? createCsrfToken(me.user) : "", me };
  },
);

const getAccountDoorData = createServerFn({ method: "GET" })
  .validator((data: { tab: AccountTab }) => data)
  .handler(async ({ data }): Promise<DoorData> => {
    const user = await getPublicSession(getRequest());

    if (!user || data.tab === "settings") {
      return { tab: "settings" };
    }

    if (data.tab === "saves") {
      const { isFollowDigestSubscribed } = await import("@/lib/server/follow-digest");
      const { createFollowDigestToken } = await import("@/lib/server/follow-digest-tokens");
      const [saved, sets, submissions, follows, subscribed] = await Promise.all([
        listSavedFindings(user),
        listSavedSets(user),
        listUserSubmissions(user),
        listFollows(user),
        isFollowDigestSubscribed(user.id),
      ]);

      return {
        follows: follows.follows,
        followsEmail: { subscribed, token: await createFollowDigestToken(user.id, "manage") },
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

    const door =
      import.meta.env.SSR && identity.me.user
        ? await getAccountDoorData({ data: { tab: deps.tab ?? "galaxy" } })
        : undefined;

    return { door, identity };
  },

  staleTime: 0,
  head: () => ({
    links: [{ href: `${siteUrl}/account`, rel: "canonical" }],
    meta: [
      { title: "Your place in the Galaxy" },
      {
        content:
          "Private Fluncle account settings, Galaxy progress, saved tracks, and submissions.",
        name: "description",
      },

      { content: "noindex", name: "robots" },
    ],
  }),
  component: AccountPage,
});

const DOOR_MASTHEAD: Record<AccountTab, { tagline: string; title: string }> = {
  galaxy: { tagline: "Your logs, your runs, and the stars you've reached.", title: "The Galaxy" },
  saves: { tagline: "The tracks and sets you kept.", title: "Saves" },
  settings: { tagline: "Your profile, preferences, and account.", title: "Settings" },
};

const SIGNED_OUT_MASTHEAD = {
  tagline: "Private progress, saved tracks, and submissions.",
  title: "Your place in the Galaxy",
};

function AccountPage() {
  const { tab } = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const activeTab: AccountTab = tab ?? "galaxy";

  const identityQuery = useQuery({
    initialData: loaderData.identity,
    queryFn: () => getAccountIdentity(),
    queryKey: ["account", "identity"],
    refetchOnWindowFocus: false,
    staleTime: 10 * 60_000,
  });
  const { csrfToken, me } = identityQuery.data;
  const signedIn = !!me.user;

  const doorQuery = useQuery({
    enabled: signedIn,
    initialData: loaderData.door,
    queryFn: () => getAccountDoorData({ data: { tab: activeTab } }),
    queryKey: ["account", activeTab],
    refetchOnWindowFocus: activeTab !== "settings",
    staleTime: 30_000,
  });

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
          <>
            <AuthForms
              googleEnabled={me.googleEnabled}
              message={message}
              refresh={refresh}
              setMessage={setMessage}
            />
            <DeviceSaves />
          </>
        )}
      </article>
    </main>
  );
}

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
