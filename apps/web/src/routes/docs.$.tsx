import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { DocsPage } from "./-docs-page";

// Every /docs/<slug...> human page. The MDX is compiled at build time; the
// server fn resolves the slug to a content path (404 on a miss) and the client
// loader renders the compiled body. /docs/api is its own route (the Scalar
// reference) and wins over this catch-all.
export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat ? params._splat.split("/") : [];
    return resolvePage({ data: slugs });
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
