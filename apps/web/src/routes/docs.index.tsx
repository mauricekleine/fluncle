import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { DocsPage } from "./-docs-page";

// The /docs landing page — renders content/docs/index.mdx through the same
// pipeline as every other doc.
export const Route = createFileRoute("/docs/")({
  component: Page,
  loader: async () => resolveIndex(),
});

const resolveIndex = createServerFn({ method: "GET" }).handler(async () => {
  const { docsSource } = await import("@/lib/docs-source");
  const page = docsSource.getPage([]);
  if (!page) {
    throw notFound();
  }

  return { path: page.path };
});

function Page() {
  const { path } = Route.useLoaderData();
  return <DocsPage path={path} />;
}
