import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { preloadDocsPage } from "./-docs-loader";
import { DocsPage } from "./-docs-page";

// Every /docs/<slug...> human page. The MDX is compiled at build time; the
// server fn resolves the slug to a content path (404 on a miss) and the client
// loader renders the compiled body. /docs/api is its own route (the Scalar
// reference) and wins over this catch-all.
export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat ? params._splat.split("/") : [];
    const { path } = await resolvePage({ data: slugs });
    // Warm the compiled MDX before render so the page swaps in synchronously —
    // the shared DocsLayout stays mounted, no content blank, no flicker.
    await preloadDocsPage(path);
    return { path };
  },
});

const resolvePage = createServerFn({ method: "GET" })
  .inputValidator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(slugs);
    if (!page) {
      throw notFound();
    }

    return { path: page.path };
  });

function Page() {
  const { path } = Route.useLoaderData();
  return <DocsPage path={path} />;
}
