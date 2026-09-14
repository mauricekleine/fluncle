import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { docsBreadcrumbsJsonLd } from "@/lib/log-schema";

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
// (docs/client-bundle.md Rule 1), so this module reaches for no `lib/server/**` or `db/**`
// module — the front matter arrives as plain loader data. `lib/log-schema` is already an
// eager-chunk resident (every entity route's `head` builds its JSON-LD from it), so taking
// the breadcrumb builder from there adds nothing to the entry chunk.

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
  /** A `/docs/<slug>` page rather than the `/docs` hub — the two differ in head twice, below. */
  const isLeaf = data.url !== "/docs";
  // The Markdown twin of this page, advertised the standard way so an agent that would rather
  // read Markdown than parse the HTML finds it without guessing. The page-actions affordance
  // ("View as Markdown", "Open in ChatGPT/Claude/Cursor") already points at this URL; this is
  // the machine-readable half of the same pointer.
  //
  // Only for a `/docs/<slug>` page: `/docs.md/$` is a pure splat, so `/docs.md/<slug>` is
  // certain to resolve. The hub's own twin would be the bare `/docs.md` (the empty splat), and
  // whether the splat route answers its own parent path is not something the repo states — so
  // the hub advertises no alternate rather than a link that might 404.
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
    // Fluncle → Docs → the doc's own name. Only for a `/docs/<slug>` page: the hub is a single
    // crumb and the chrome's own trail marks that one up (components/nav/nav-breadcrumb.tsx —
    // the route owns a LEAF trail because only the route knows the real name; `/docs/log-id`
    // reads "Log ID" from the front matter, where the slug alone could only say "Log Id").
    scripts: isLeaf ? [jsonLdScript(docsBreadcrumbsJsonLd(data.title))] : [],
  };
}
