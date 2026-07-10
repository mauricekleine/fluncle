import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { MixBuilder } from "@/components/mix/mix-builder";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { mixPlaylistJsonLd, parseSetParam, serializeSet } from "@/lib/mix-set";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getTracksByLogIds } from "@/lib/server/tracks";

// `/mix` — Product A: the set-builder plate (RFC mixability-engine). ADMIN-GATED at
// launch (Decision 1): the full surface is built, but a route-level admin gate keeps
// it operator-only while the archive grows to the ~250-finding floor; going public is
// lifting this gate + the registry weight + an announcement (the `list_mixable_tracks`
// op already ships at its final public tier, so no rebuild). Copy PENDING the morning
// review (Decision 5) — this PR is HELD for canon + copy.

// Cold-load hydration ONLY: resolve the `?set=` coordinates to ordered findings in one
// query (the loader re-orders the unordered `getTracksByLogIds` Record to the URL;
// vanished coordinates drop silently). Chain edits after mount are client state — the
// URL syncs via a masked replace navigation, and `shouldReload: false` keeps this from
// re-running on every reorder.
const hydrateMixSet = createServerFn({ method: "GET" })
  .validator((data: { logIds: string[] }) => data)
  .handler(async ({ data }): Promise<TrackListItem[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    if (data.logIds.length === 0) {
      return [];
    }

    const byLogId = await getTracksByLogIds(data.logIds);

    return data.logIds.flatMap((logId) => {
      const finding = byLogId[logId];

      return finding ? [finding] : [];
    });
  });

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

type MixSearch = { set: string; view: "build" | "play" };
type MixLoaderData = { chain: TrackListItem[] };

// TanStack canonical option order (validateSearch → loaderDeps → beforeLoad → loader →
// head → component), each step feeding the next step's type inference; the disable
// keeps `eslint/sort-keys` off THIS definition (it would alphabetize + break inference).
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/mix")({
  validateSearch: (search: Record<string, unknown>): MixSearch => ({
    set: typeof search.set === "string" ? search.set : "",
    view: search.view === "play" ? "play" : "build",
  }),
  loaderDeps: ({ search }: { search: MixSearch }) => ({ set: search.set }),
  beforeLoad: () => ensureAdmin(),
  loader: async ({ deps }: { deps: { set: string } }): Promise<MixLoaderData> => {
    const logIds = parseSetParam(deps.set);

    return { chain: await hydrateMixSet({ data: { logIds } }) };
  },
  head: ({ loaderData }: { loaderData?: MixLoaderData }) => {
    const chain = loaderData?.chain ?? [];
    const coords = serializeSet(chain.map((finding) => finding.logId ?? ""));
    const canonical = chain.length > 0 ? `${siteUrl}/mix?set=${coords}` : `${siteUrl}/mix`;
    const title = "Chain a set — Fluncle";
    const description = "Take the decks with Fluncle's findings: chain a set that mixes clean.";

    return {
      links: [{ href: canonical, rel: "canonical" }],
      meta: [
        { title },
        { content: description, name: "description" },
        { content: title, property: "og:title" },
        { content: description, property: "og:description" },
        { content: canonical, property: "og:url" },
        { content: `${siteUrl}/api/og/set?set=${coords}`, property: "og:image" },
        { content: "1200", property: "og:image:width" },
        { content: "630", property: "og:image:height" },
      ],
      scripts: chain.length > 0 ? [jsonLdScript(mixPlaylistJsonLd(chain, canonical))] : [],
    };
  },
  component: MixPage,
  shouldReload: false,
});

function MixPage() {
  const { chain } = Route.useLoaderData();
  const { view } = Route.useSearch();
  const navigate = useNavigate();

  // Sync the ordered chain to `?set=` in place: a replace navigation with the loader
  // held (shouldReload: false), so a reorder click never re-fetches. Masked so a raw
  // replaceState can't wipe TanStack's routing state.
  const onSetChange = useCallback(
    (logIds: string[]) => {
      void navigate({
        replace: true,
        resetScroll: false,
        search: (prev: MixSearch) => ({ ...prev, set: serializeSet(logIds) }),
        to: "/mix",
      });
    },
    [navigate],
  );

  // "Chain your own set from here" — drop `view=play` to unlock the builder controls.
  const onPromote = useCallback(() => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (prev: MixSearch) => ({ ...prev, view: "build" as const }),
      to: "/mix",
    });
  }, [navigate]);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <header className="mb-6 text-center">
        <h1 className="text-lg font-semibold">Chain a set</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          His findings, your order. The archive says what mixes clean.
        </p>
      </header>
      <MixBuilder
        initialChain={chain}
        key={view}
        onPromote={onPromote}
        onSetChange={onSetChange}
        readOnly={view === "play"}
      />
    </main>
  );
}
