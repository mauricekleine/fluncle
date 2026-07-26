import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { docsHead } from "./-docs-head";
import { DocsPage } from "./-docs-page";

// Every /docs/<slug...> human page. The MDX is compiled at build time; the
// server fn resolves the slug to a content path (404 on a miss) and the client
// loader renders the compiled body. /docs/api is its own route (the Scalar
// reference) and wins over this catch-all.
//
// Route options follow TanStack's canonical order (loader before head), which is not
// alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat ? params._splat.split("/") : [];
    const page = await resolvePage({ data: slugs });
    const { path } = page;
    // Warm the compiled MDX before render so the page swaps in synchronously —
    // the shared DocsLayout stays mounted, no content blank, no flicker.
    //
    // `-docs-loader` is reached by a DYNAMIC import, never a static one. A route's
    // `loader` lives in the route's CRITICAL half (only the `component` is
    // auto-split out), so a static import here put the whole Fumadocs UI —
    // measured 99 KB of rendered fumadocs-ui modules — into the eager entry chunk
    // every page downloads before first paint, homepage included. The loader
    // already awaits this work, so deferring the module costs the docs page
    // nothing and buys every other page the weight back.
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

    // The front matter rides back with the content path so the route's `head` can carry the
    // doc's own title + description (see ./-docs-head.ts). Without it every doc page inherited
    // __root's homepage title and description.
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
