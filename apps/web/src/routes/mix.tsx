import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type MixTrack } from "@fluncle/contracts";
import { KeyNotationToggle } from "@/components/key-notation-toggle";
import { MixBuilder } from "@/components/mix/mix-builder";
import { SaveSetDialog } from "@/components/mix/save-set-dialog";
import { ShareSetButton } from "@/components/mix/share-set-button";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import {
  mixPlaylistJsonLd,
  parseSetParam,
  parseTasteParam,
  serializeSet,
  serializeTaste,
  setToken,
} from "@/lib/mix-set";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getMixChainDepth, getMixTracksByTokens } from "@/lib/server/tracks";

// `/mix` — the set-builder, and the one surface built for a stranger rather than for the
// crew. A free drum & bass mixing tool: name a few artists you like, pick something to open
// with, and the engine ranks what mixes in clean after it. No account, no sign-up; the set
// and the taste behind it live in the URL (`?set=` + `?taste=`), so a set is its link.
//
// ── THE GATE ────────────────────────────────────────────────────────────────────────────
// It used to be admin-only behind a ~250-FINDING FLOOR: a number nobody could defend,
// standing in for the real question ("is there enough here to chain a set?"). That question
// is now asked directly, of the archive, on every load — `getMixChainDepth` measures whether
// the MEDIAN track can reach one of Fluncle's own sets' worth of tracks (17) plus a full rail
// (12) by a NAMED harmonic move. Neither number is invented; see `MIX_PUBLIC_FLOOR`.
//
// So the gate is self-lifting. There is no flag to remember to flip and no deploy to time: as
// the catalogue crawler lands keyed tracks, the median track's neighbourhood grows, and the
// day it crosses the floor `/mix` opens to the world on its own. Which is exactly the
// roadmap's claim — the catalogue IS depth — made executable instead of asserted.
//
// While it is CLOSED the tool is real but private: the operator still gets in (he needs to
// dogfood the thing he is filling the archive for), and a stranger is sent home rather than
// shown a beautiful mixing tool with sixty tracks in it, which would undersell the whole idea.

/** The route's server-side verdict: may this reader use the tool, and is the set hydrated? */
type MixLoaderData = { chain: MixTrack[] };

// One server call: the gate, then the chain. The gate is checked SERVER-SIDE and before any
// hydration, so a closed gate never renders a row — and never leaks the archive's shape to
// someone it is not open to.
//
// THE LOADER DEPENDS ON `set` ALONE, never on `taste`. Taste is CLIENT state: the builder
// reads the live `?taste=` search param and fetches openers/rail off it, so a taste change
// must not re-run this loader (it would blank `useLoaderData` mid-navigation and, with the
// gate re-checked, flicker the whole page). The loader's only job is to gate the reader and
// hydrate a shared `?set=` link on a cold load.
const loadMix = createServerFn({ method: "GET" })
  .validator((data: { set: string }) => data)
  .handler(async ({ data }): Promise<MixLoaderData> => {
    const [depth, admin] = await Promise.all([getMixChainDepth(), isAdminRequest()]);

    if (!depth.open && !admin) {
      // Home, not the login page: a stranger who lands on a URL the archive cannot yet honour
      // is a reader, not a locked-out operator, and the archive is what he came for anyway.
      throw redirect({ to: "/" });
    }

    const tokens = parseSetParam(data.set);

    return { chain: tokens.length > 0 ? await getMixTracksByTokens(tokens) : [] };
  });

// `from`/`fromName` carry the STABLE REFERENCE when a saved set is opened from /account — its
// id + name, so the builder can PATCH that set on save and prefill the dialog. They are read
// ONCE into component state and then stripped from the URL (see MixPage), so they never reach
// the canonical/share links (both built from the chain alone) and a refresh drops the reference
// (web = session-scoped: the reference holds until refresh/navigate-away).
type MixSearch = {
  from?: string;
  fromName?: string;
  set: string;
  taste: string;
  view: "build" | "play";
};

// TanStack canonical option order (validateSearch → loaderDeps → loader → head → component),
// each step feeding the next step's type inference; the disable keeps `eslint/sort-keys` off
// THIS definition (it would alphabetize + break inference).
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/mix")({
  validateSearch: (search: Record<string, unknown>): MixSearch => ({
    from: typeof search.from === "string" ? search.from : undefined,
    fromName: typeof search.fromName === "string" ? search.fromName : undefined,
    set: typeof search.set === "string" ? search.set : "",
    taste: typeof search.taste === "string" ? search.taste : "",
    view: search.view === "play" ? "play" : "build",
  }),
  loaderDeps: ({ search }: { search: MixSearch }) => ({ set: search.set }),
  loader: async ({ deps }: { deps: { set: string } }): Promise<MixLoaderData> =>
    loadMix({ data: deps }),
  head: ({ loaderData }: { loaderData?: MixLoaderData }) => {
    const chain = loaderData?.chain ?? [];
    const coords = serializeSet(chain.map((track) => track.logId ?? track.trackId));
    const canonical = chain.length > 0 ? `${siteUrl}/mix?set=${coords}` : `${siteUrl}/mix`;
    const title = "Chain a set · Fluncle";
    // Machine-facing, so honestly-plain third person (VOICE.md, Narrator): what the tool is
    // and what it does, in the words a stranger would search for.
    const description =
      "A free drum & bass mixing tool. Name the artists you like, and Fluncle ranks what mixes in clean next by key, tempo, and feel.";

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
  const { chain: initialChain } = Route.useLoaderData();
  const { from, fromName, taste: tasteParam, view } = Route.useSearch();
  const navigate = useNavigate();

  // The LIVE CHAIN is component state, seeded once from the loader's hydrated `?set=`. It is
  // the single source of truth the builder edits AND the save dialog reads — the ruling's
  // "save reads the live chain, never the URL param". The URL `?set=` is kept as a mirror (for
  // sharing + a cold reload), but it is downstream of this state, never the source.
  const [chain, setChain] = useState<MixTrack[]>(initialChain);

  // The STABLE REFERENCE: the saved set this chain was opened from, or last saved to. Seeded
  // once from `?from=`/`?fromName=` (see below), then updated in place as saves adopt an id.
  const [reference, setReference] = useState<{ id: string; name: string } | undefined>(
    from ? { id: from, name: fromName ?? "" } : undefined,
  );

  // Taste is the LIVE search param, parsed on the client (pure + client-safe), not loader
  // data — so seeding tilts the rail with no loader round-trip and no page flicker. Memoized
  // so the array keeps a stable identity while `?taste=` is unchanged.
  const taste = useMemo(() => parseTasteParam(tasteParam), [tasteParam]);

  // The live chain, serialized to its `?set=` tokens — the save + share payload, derived from
  // state (never the URL param).
  const serializedSet = useMemo(() => serializeSet(chain.map(setToken)), [chain]);

  // Strip `from`/`fromName` from the URL once seeded into component state above: the reference
  // now lives in state, so a refresh (which re-reads the URL) MUST lose it — web is session-
  // scoped. Also keeps them out of every subsequent share/canonical URL. Masked replace so a
  // raw replaceState can't wipe TanStack's routing state; runs once on mount.
  useEffect(() => {
    if (from === undefined && fromName === undefined) {
      return;
    }

    void navigate({
      replace: true,
      resetScroll: false,
      search: ({ from: _from, fromName: _fromName, ...rest }: MixSearch) => rest,
      to: "/mix",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount, off the initial params
  }, []);

  // Commit a chain edit: set the live state AND mirror it to `?set=` in place — a replace
  // navigation with the loader held (shouldReload: false), so a reorder click never re-fetches.
  // Masked so a raw replaceState can't wipe TanStack's routing state.
  const onChainChange = useCallback(
    (next: MixTrack[]) => {
      setChain(next);
      void navigate({
        replace: true,
        resetScroll: false,
        search: (prev: MixSearch) => ({ ...prev, set: serializeSet(next.map(setToken)) }),
        to: "/mix",
      });
    },
    [navigate],
  );

  const onTasteChange = useCallback(
    (slugs: string[]) => {
      void navigate({
        replace: true,
        resetScroll: false,
        search: (prev: MixSearch) => ({ ...prev, taste: serializeTaste(slugs) }),
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

  // The page as ONE logbook plate (DESIGN.md §5 — the home-plate grammar): a real masthead
  // over a dimming, grained plate that holds AA against the sun-bloom (The Legible Sky Rule),
  // with the chain + rail mounted as flat plate-field panes (One Pane — the plate is the pane).
  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:flex lg:flex-col lg:p-8">
      <article className="home-plate mx-auto my-6 w-full max-w-2xl sm:my-8 lg:my-auto">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Chain a set</h1>
            <p className="home-tagline">
              Name a few artists you like. I rank what mixes in clean next, by key, tempo, and feel.
              Chain a set, then share it with the crew.
            </p>
          </div>
          <div className="home-masthead-actions">
            <KeyNotationToggle />
            {view !== "play" && chain.length > 0 ? (
              <>
                {/* Save (quiet outline) sits BEFORE Copy set link (the gold primary),
                    so the terminal, gold action reads last. A signed-out visitor sees
                    only Copy — SaveSetDialog renders nothing without a session. Both read
                    the LIVE serialized chain, never the `?set=` URL param. */}
                <SaveSetDialog
                  chainLength={chain.length}
                  onAdopt={setReference}
                  reference={reference}
                  serializedSet={serializedSet}
                  serializedTaste={tasteParam}
                />
                <ShareSetButton serializedSet={serializedSet} serializedTaste={tasteParam} />
              </>
            ) : undefined}
          </div>
        </header>
        <MixBuilder
          chain={chain}
          key={view}
          onChainChange={onChainChange}
          onPromote={onPromote}
          onTasteChange={onTasteChange}
          readOnly={view === "play"}
          taste={taste}
        />
        {/* THE CONVERSION MOMENT. A stranger came for a free mixing tool and is now three
            tracks deep in an archive they have never heard of. This is the one line that
            tells them whose archive it is, and why it gets better the longer they stay. It
            sits at the FOOT of the plate, after the tool has already proved itself — an
            invitation earned, not a banner served. */}
        <footer className="mix-colophon">
          <p>
            I'm Fluncle. I dig drum &amp; bass out of the far sectors and log every banger I bring
            back. This runs on that logbook, and it gets sharper every time I find another one.
          </p>
          <a href="/">See the findings</a>
        </footer>
      </article>
    </main>
  );
}
