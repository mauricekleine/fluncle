import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { docsHead } from "./-docs-head";
import { DocsPage } from "./-docs-page";

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat ? params._splat.split("/") : [];
    const page = await resolvePage({ data: slugs });
    const { path } = page;

    const { preloadDocsPage } = await import("./-docs-loader");

    await preloadDocsPage(path);

    return page;
  },
  head: ({ loaderData }) => docsHead(loaderData),
});

const resolvePage = createServerFn({ method: "GET" })
  .inputValidator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(slugs);
    if (!page) {
      throw notFound();
    }

    return {
      description: page.data.description,
      path: page.path,
      title: page.data.title,
      url: page.url,
    };
  });

function Page() {
  const { path } = Route.useLoaderData();
  return <DocsPage path={path} />;
}
