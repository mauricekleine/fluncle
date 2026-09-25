import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
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

type MixLoaderData = { chain: MixTrack[] };

const loadMix = createServerFn({ method: "GET" })
  .validator((data: { set: string }) => data)
  .handler(async ({ data }): Promise<MixLoaderData> => {
    const [depth, admin] = await Promise.all([getMixChainDepth(), isAdminRequest()]);

    if (!depth.open && !admin) {
      throw redirect({ to: "/" });
    }

    const tokens = parseSetParam(data.set);

    return { chain: tokens.length > 0 ? await getMixTracksByTokens(tokens) : [] };
  });

type MixSearch = {
  from?: string;
  fromName?: string;
  set: string;
  taste: string;
  view: "build" | "play";
};

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

  const [chain, setChain] = useState<MixTrack[]>(initialChain);

  const [reference, setReference] = useState<{ id: string; name: string } | undefined>(
    from ? { id: from, name: fromName ?? "" } : undefined,
  );

  const taste = useMemo(() => parseTasteParam(tasteParam), [tasteParam]);

  const serializedSet = useMemo(() => serializeSet(chain.map(setToken)), [chain]);

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

  const onPromote = useCallback(() => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (prev: MixSearch) => ({ ...prev, view: "build" as const }),
      to: "/mix",
    });
  }, [navigate]);

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

        <footer className="mix-colophon">
          <p>
            I'm Fluncle. I dig drum &amp; bass out of the far sectors and log every banger I bring
            back. This runs on that logbook, and it gets sharper every time I find another one.
          </p>
          <Link to="/findings">See the findings</Link>
        </footer>
      </article>
    </main>
  );
}
