import { siteUrl } from "@/lib/fluncle-links";

// The `<head>` for every /docs page — shared by the index (`docs.index.tsx`) and the
// catch-all (`docs.$.tsx`), because both resolve one Fumadocs page and both owe it the
// same three things.
//
// WHY IT EXISTS: neither route carried a `head` at all, so all nine doc pages inherited
// __root's site-wide `<title>` ("Fluncle: drum & bass bangers from another dimension") and
// the homepage's meta description, and none of them was self-canonical. Every doc already
// has a hand-written `title` + `description` in its MDX front matter (the same two strings
// the page prints through Fumadocs' DocsTitle/DocsDescription) — they simply never reached
// the head. This carries them there.
//
// CLIENT-SAFE by construction: a route's `head` is in its eagerly-bundled half
// (docs/client-bundle.md Rule 1), so this module imports only `lib/fluncle-links` and
// never `lib/server/**` — the front matter arrives as plain loader data.

/** The front matter + resolved URL one doc page's head needs. */
export type DocsHeadData = {
  /** The page's MDX `description` front matter; absent on a doc that omits it. */
  description?: string;
  /** The page's MDX `title` front matter. */
  title: string;
  /** The page's own path, as Fumadocs resolved it: `/docs` or `/docs/<slug>`. */
  url: string;
};

/** `<title>` for one doc page — the doc's own name, then the site, as `/artist/<slug>` reads. */
function docsTitle(title: string): string {
  return `${title} · Fluncle docs`;
}

export function docsHead(data: DocsHeadData | undefined) {
  if (!data) {
    return {};
  }

  const canonical = `${siteUrl}${data.url}`;
  const title = docsTitle(data.title);
  // The Markdown twin of this page, advertised the standard way so an agent that would rather
  // read Markdown than parse the HTML finds it without guessing. The page-actions affordance
  // ("View as Markdown", "Open in ChatGPT/Claude/Cursor") already points at this URL; this is
  // the machine-readable half of the same pointer.
  //
  // Only for a `/docs/<slug>` page: `/docs.md/$` is a pure splat, so `/docs.md/<slug>` is
  // certain to resolve. The hub's own twin would be the bare `/docs.md` (the empty splat), and
  // whether the splat route answers its own parent path is not something the repo states — so
  // the hub advertises no alternate rather than a link that might 404.
  const markdownTwin =
    data.url === "/docs" ? undefined : `${siteUrl}/docs.md${data.url.slice("/docs".length)}`;

  return {
    links: [
      { href: canonical, rel: "canonical" },
      ...(markdownTwin
        ? [{ href: markdownTwin, rel: "alternate", title, type: "text/markdown" }]
        : []),
    ],
    meta: [
      { title },
      // A doc without a `description` keeps __root's site-wide one rather than inheriting an
      // empty string — the front matter is the upgrade, never a downgrade.
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
  };
}
