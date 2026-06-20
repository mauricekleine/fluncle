import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { docsBaseOptions } from "@/lib/docs-layout.shared";
import docsCss from "../docs.css?url";

// The layout route for the whole /docs hub. Fumadocs UI needs its RootProvider
// (theme + search + sidebar context) and the framework provider for TanStack
// Router; the public app's __root keeps its own chrome, so the provider is
// scoped HERE, around the docs subtree only — never the whole site.
//
// The sidebar's page tree is built server-side and serialized: the generated
// .source/server module reaches for node:path, so it must never enter the
// client bundle. The server fn serializes the tree (Fumadocs' own
// serializePageTree); useFumadocsLoader rehydrates it on the client.
export const Route = createFileRoute("/docs")({
  component: DocsRoute,
  head: () => ({
    links: [
      {
        href: docsCss,
        rel: "stylesheet",
      },
    ],
  }),
  loader: async () => loadDocsTree(),
});

const loadDocsTree = createServerFn({ method: "GET" }).handler(async () => {
  const { docsSource } = await import("@/lib/docs-source");
  return { tree: await docsSource.serializePageTree(docsSource.getPageTree()) };
});

function DocsRoute() {
  const { tree } = useFumadocsLoader(Route.useLoaderData());

  return (
    <RootProvider
      // Dark-only, like the rest of Fluncle: pin Fumadocs' theme to dark and
      // drop its light/dark toggle so the Nostalgic Cosmos never flips.
      theme={{ defaultTheme: "dark", enabled: false }}
    >
      <DocsLayout {...docsBaseOptions()} tree={tree}>
        <Outlet />
      </DocsLayout>
    </RootProvider>
  );
}
