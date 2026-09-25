import {
  DocsBody,
  DocsDescription,
  DocsPage as FumaDocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { getDocsMdxComponents } from "@/components/docs-mdx";
import { DocsPageActions } from "@/components/docs-page-actions";
import { DocsPageContainer } from "@/components/docs-page-container";

import browserCollections from "../../.source/browser";

export const clientLoader = browserCollections.docs.createClientLoader({
  component({ frontmatter, toc, default: MDX }) {
    return (
      <FumaDocsPage slots={{ container: DocsPageContainer }} toc={toc}>
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

  id: "fluncle-docs",
});

export async function preloadDocsPage(path: string): Promise<void> {
  await clientLoader.preload(path);
}
