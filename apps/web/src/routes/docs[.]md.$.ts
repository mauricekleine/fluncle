import { createFileRoute } from "@tanstack/react-router";

// Per-page Markdown for the /docs hub, at `/docs.md/<slug>` — a clean sibling
// of /docs that can never shadow a doc page (the `/docs/$` page route owns the
// HTML; this owns the Markdown). It's the endpoint behind the page-actions
// affordance: "View as Markdown" opens it, "Copy page" fetches it, and the
// "Open in ChatGPT / Claude / Cursor" links carry this URL so the assistant can
// pull the clean Markdown.
//
// The content is precompiled (`includeProcessedMarkdown` in source.config.ts),
// exposed through page.data.getText("processed"). A pure splat captures the
// whole slug path; the Getting started page is "/docs.md" (empty splat).
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

        // A clean Markdown document: front-matter-free, the title as the H1, the
        // description as the lede, then the processed body — the shape an LLM
        // expects when handed a doc page.
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
