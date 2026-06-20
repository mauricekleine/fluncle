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
      // Dark-only, like the rest of Fluncle — but next-themes is DISABLED here, so
      // it never touches <html>. `forcedTheme` would pin `.dark` onto <html>, and
      // in the TanStack Start SPA that class PERSISTS after navigating away from
      // /docs — flipping the public app's `dark:` utilities on (the stock shadcn
      // outline button swaps to `dark:bg-input/30`, etc.) and restyling the
      // homepage. Instead `.dark` is scoped to the docs container below, and the
      // `--color-fd-*` token bridge in styles.css (with docs.css re-bridging the
      // `.dark #nd-sidebar` tokens) maps Fumadocs onto Fluncle's canon palette, so
      // the cosmos paints on the very first SSR pass with no theme JS and nothing
      // to flip. The sun/moon toggle is already off via `themeSwitch.enabled: false`.
      theme={{ enabled: false }}
    >
      <DocsLayout
        {...docsBaseOptions()}
        // Scope the dark theme to the docs subtree: `.dark` lands on
        // #nd-docs-layout (not <html>), so Fumadocs' `.dark`-keyed rules (Shiki
        // syntax colors, the sidebar pane) resolve inside /docs only, and the
        // public app's single intended theme is never disturbed.
        containerProps={{ className: "dark" }}
        tree={tree}
      >
        <Outlet />
      </DocsLayout>
    </RootProvider>
  );
}
