import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { docsBaseOptions } from "@/lib/docs-layout.shared";
import docsCss from "../docs.css?url";

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/docs")({
  component: DocsRoute,
  loader: async () => loadDocsTree(),
  head: () => ({
    links: [
      {
        href: docsCss,
        rel: "stylesheet",
      },
    ],
  }),
});

const loadDocsTree = createServerFn({ method: "GET" }).handler(async () => {
  const { docsSource } = await import("@/lib/docs-source");
  return { tree: await docsSource.serializePageTree(docsSource.getPageTree()) };
});

function DocsRoute() {
  const { tree } = useFumadocsLoader(Route.useLoaderData());

  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout
        {...docsBaseOptions()}

        containerProps={{ className: "dark" }}
        tree={tree}
      >
        <Outlet />
      </DocsLayout>
    </RootProvider>
  );
}
