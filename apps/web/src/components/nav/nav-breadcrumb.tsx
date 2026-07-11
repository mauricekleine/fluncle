// Breadcrumbs for the honest hierarchies of the graph — a leaf page sitting under a
// known index (a finding under /log, an artist under /artists, a galaxy under
// /galaxies, a sector under /logbook, an edition under /newsletter). Emits BOTH the
// visible crawlable trail (real `<a>` back to the index — a ≤2-hop path from any
// leaf to its index) AND a JSON-LD BreadcrumbList, so the graph's shape is legible
// to humans and search engines alike. Nothing renders on flat pages (home, indexes).

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { siteUrl } from "@/lib/fluncle-links";
import { serializeJsonLd } from "@/lib/json-ld";

// First path segment → the index it hangs under. Only these leaves get a trail; a
// segment absent here (or a flat/index path) renders nothing.
const CRUMB_PARENTS: Record<string, { label: string; to: string }> = {
  artist: { label: "Artists", to: "/artists" },
  galaxies: { label: "Galaxies", to: "/galaxies" },
  log: { label: "Log", to: "/log" },
  logbook: { label: "Logbook", to: "/logbook" },
  newsletter: { label: "Newsletter", to: "/newsletter" },
};

type Crumb = { label: string; parent: { label: string; to: string }; pathname: string };

/** Resolve the breadcrumb for a pathname, or null when there is no honest trail. */
export function resolveCrumb(pathname: string): Crumb | null {
  const segments = pathname.split("/").filter(Boolean);

  // Exactly a two-level leaf: /<index>/<leaf>. Deeper or shallower paths don't map.
  if (segments.length !== 2) {
    return null;
  }

  const parent = CRUMB_PARENTS[segments[0] ?? ""];

  if (!parent) {
    return null;
  }

  const raw = decodeURIComponent(segments[1] ?? "");
  // A numeric newsletter edition reads as "#3", not "3".
  const label = segments[0] === "newsletter" && /^\d+$/.test(raw) ? `#${raw}` : raw;

  return { label, parent, pathname };
}

export function NavBreadcrumb({ pathname }: { pathname: string }): ReactNode {
  const crumb = resolveCrumb(pathname);

  if (!crumb) {
    return undefined;
  }

  const breadcrumbList = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Home", position: 1 },
      {
        "@type": "ListItem",
        item: `${siteUrl}${crumb.parent.to}`,
        name: crumb.parent.label,
        position: 2,
      },
      { "@type": "ListItem", name: crumb.label, position: 3 },
    ],
  };

  return (
    <nav aria-label="Breadcrumb" className="nav-breadcrumb">
      <ol>
        <li>
          <Link to="/">Home</Link>
        </li>
        <li aria-hidden="true" className="nav-breadcrumb-sep">
          ›
        </li>
        <li>
          <Link to={crumb.parent.to as never}>{crumb.parent.label}</Link>
        </li>
        <li aria-hidden="true" className="nav-breadcrumb-sep">
          ›
        </li>
        <li>
          <span aria-current="page">{crumb.label}</span>
        </li>
      </ol>
      {/* JSON-LD through serializeJsonLd (HTML-escaped) so a `</script>` in a
          Spotify-sourced slug can't break out of the inline block (stored-XSS sink). */}
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbList) }}
        type="application/ld+json"
      />
    </nav>
  );
}
