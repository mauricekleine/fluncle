import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { docsBreadcrumbsJsonLd } from "@/lib/log-schema";

export type DocsHeadData = {
  description?: string;

  title: string;

  url: string;
};

function docsTitle(title: string): string {
  return `${title} · Fluncle docs`;
}

export function docsHead(data: DocsHeadData | undefined) {
  if (!data) {
    return {};
  }

  const canonical = `${siteUrl}${data.url}`;
  const title = docsTitle(data.title);

  const isLeaf = data.url !== "/docs";

  const markdownTwin = isLeaf ? `${siteUrl}/docs.md${data.url.slice("/docs".length)}` : undefined;

  return {
    links: [
      { href: canonical, rel: "canonical" },
      ...(markdownTwin
        ? [{ href: markdownTwin, rel: "alternate", title, type: "text/markdown" }]
        : []),
    ],
    meta: [
      { title },

      ...(data.description
        ? [
            { content: data.description, name: "description" },
            { content: data.description, property: "og:description" },
            { content: data.description, name: "twitter:description" },
          ]
        : []),
      { content: title, property: "og:title" },
      { content: canonical, property: "og:url" },
      { content: "article", property: "og:type" },
      { content: title, name: "twitter:title" },
    ],

    scripts: isLeaf ? [jsonLdScript(docsBreadcrumbsJsonLd(data.title))] : [],
  };
}
