import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { docsHead } from "./-docs-head";
import { DocsPage } from "./-docs-page";

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/docs/")({
  component: Page,
  loader: async () => {
    const page = await resolveIndex();
    const { path } = page;

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
