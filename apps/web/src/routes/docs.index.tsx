import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { docsHead } from "./-docs-head";
import { DocsPage } from "./-docs-page";

// The /docs landing page — renders the landing `index.mdx` through the same
// pipeline as every other doc.
//
// Route options follow TanStack's canonical order (loader before head), which is not
// alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/docs/")({
  component: Page,
  loader: async () => {
    const page = await resolveIndex();
    const { path } = page;
    // Warm the compiled MDX before render (same as /docs/$) so navigating back
    // to the index swaps in synchronously without blanking the content column.
    //
    // DYNAMIC, for the reason `docs.$.tsx` spells out: a `loader` is in the route's eagerly
    // bundled half, so a static import here put all of Fumadocs' UI in the entry chunk that
    // the homepage downloads before first paint.
    const { preloadDocsPage } = await import("./-docs-loader");

    await preloadDocsPage(path);

    return page;
  },
  head: ({ loaderData }) => docsHead(loaderData),
});

const resolveIndex = createServerFn({ method: "GET" }).handler(async () => {
  const { docsSource } = await import("@/lib/docs-source");
  const page = docsSource.getPage([]);
  if (!page) {
    throw notFound();
  }

  // The front matter rides back with the content path — see ./-docs-head.ts.
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
