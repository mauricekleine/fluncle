import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { KeyNotationToggle } from "@/components/mix/key-notation-toggle";
import { MixBuilder } from "@/components/mix/mix-builder";
import { ShareSetButton } from "@/components/mix/share-set-button";
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
    const title = "Chain a set · Fluncle";
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
  const { set, view } = Route.useSearch();
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

  // The page as ONE logbook plate (DESIGN.md §5 — the home-plate grammar): a real
  // masthead over a dimming, grained plate that holds AA against the sun-bloom (The
  // Legible Sky Rule), with the chain + rail mounted as flat plate-field panes (One
  // Pane — the plate is the pane).
  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:flex lg:flex-col lg:p-8">
      <article className="home-plate mx-auto my-6 w-full max-w-2xl sm:my-8 lg:my-auto">
        {/* The masthead lays its two blocks out as direct flex children (`.home-masthead`
            is `display:flex; justify-content:space-between`): the text block and the
            actions group. An earlier extra wrapper `<div>` was a non-stretching flex item,
            so its right edge — and the button pinned inside it — fell short of the
            full-width border-bottom rule; laying the actions group out directly lets
            space-between pin it to the true right edge the rule reaches. */}
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Chain a set</h1>
            <p className="home-tagline">
              Pick a finding to open with, and I rank what mixes in cleanly next by key, tempo, and
              feel. Reorder the chain, then share it with the crew.
            </p>
          </div>
          <div className="home-masthead-actions">
            <KeyNotationToggle />
            {view !== "play" && set ? <ShareSetButton serializedSet={set} /> : undefined}
          </div>
        </header>
        <MixBuilder
          initialChain={chain}
          key={view}
          onPromote={onPromote}
          onSetChange={onSetChange}
          readOnly={view === "play"}
        />
      </article>
    </main>
  );
}
