import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/docs.md/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const splat = params._splat ?? "";
        const slugs = splat ? splat.split("/") : [];

        const { docsSource } = await import("@/lib/docs-source");
        const page = docsSource.getPage(slugs);

        if (!page) {
          return new Response("Not found", { status: 404 });
        }

        const title = page.data.title ?? "";
        const description = page.data.description ?? "";
        const body = await page.data.getText("processed");

        const markdown = [`# ${title}`, description, body]
          .filter((part) => part.length > 0)
          .join("\n\n");

        return new Response(markdown, {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "content-type": "text/markdown; charset=utf-8",
          },
        });
      },
    },
  },
});
