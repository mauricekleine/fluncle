import {
  DocsBody,
  DocsDescription,
  DocsPage as FumaDocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { getDocsMdxComponents } from "@/components/docs-mdx";
import { DocsPageActions } from "@/components/docs-page-actions";
// The generated browser collection: lazy MDX modules keyed by content path.
import browserCollections from "../../.source/browser";

// One client loader for the whole docs hub (shared id so TanStack's code
// splitting doesn't duplicate the cache). It renders each compiled MDX file
// inside Fumadocs' DocsPage chrome — title, description, TOC, and the styled
// body.
const clientLoader = browserCollections.docs.createClientLoader({
  component({ frontmatter, toc, default: MDX }) {
    return (
      <FumaDocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        {frontmatter.description ? (
          <DocsDescription>{frontmatter.description}</DocsDescription>
        ) : null}
        <DocsPageActions />
        <DocsBody>
          <MDX components={getDocsMdxComponents()} />
        </DocsBody>
      </FumaDocsPage>
    );
  },
  // Shared cache id so TanStack's code splitting doesn't duplicate the loader.
  id: "fluncle-docs",
});

// Warm the compiled MDX for a path into the loader's preloaded cache. Called
// from each doc route's `loader` (alongside the server path resolution) so the
// module is already resolved by the time the component renders: the per-path
// renderer's `use()` reads it synchronously instead of suspending, so the
// content column never blanks on navigation. Without this the page chrome
// (#nd-page, the TOC) flashes out and back on every sidebar click. The layout
// (DocsLayout sidebar + header) is a stable parent in docs.tsx and never
// remounts; only the body swaps.
export async function preloadDocsPage(path: string): Promise<void> {
  await clientLoader.preload(path);
}

// Shared by /docs (index) and /docs/$ (catch-all): both resolve a content path
// on the server and preload it, then render it here. The Suspense boundary is a
// safety net (e.g. a hard reload that bypasses the loader preload) — the content
// resolves synchronously on a preloaded navigation, so it stays mounted.
export function DocsPage({ path }: { path: string }) {
  return <Suspense>{clientLoader.useContent(path)}</Suspense>;
}
