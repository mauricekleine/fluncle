import {
  DocsBody,
  DocsDescription,
  DocsPage as FumaDocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { getDocsMdxComponents } from "@/components/docs-mdx";
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
        <DocsBody>
          <MDX components={getDocsMdxComponents()} />
        </DocsBody>
      </FumaDocsPage>
    );
  },
  // Shared cache id so TanStack's code splitting doesn't duplicate the loader.
  id: "fluncle-docs",
});

// Shared by /docs (index) and /docs/$ (catch-all): both resolve a content path
// on the server, then render it here.
export function DocsPage({ path }: { path: string }) {
  return clientLoader.useContent(path);
}
