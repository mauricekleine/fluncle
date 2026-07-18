// The breadcrumb — and, in the colophon architecture, the ONLY nav in the top bar.
// It sits inline with the wordmark, so the trail reads FLUNCLE › Log › 038.6.1J and
// the wordmark IS the home crumb (no redundant "Home" link).
//
// WHY THIS CARRIES SEO WEIGHT. With the nav banked in the footer, the site-wide links
// are boilerplate — and Google discounts boilerplate links when distributing internal
// authority. The breadcrumb is the antidote: it is DIFFERENT on every page, so it
// reads as a contextual link to the hub rather than chrome. That is the same signal a
// header nav would have carried, without the visual weight. The JSON-LD
// BreadcrumbList alongside it is what puts the trail (rather than a raw URL) in the
// search snippet.
//
// Rendered on every page EXCEPT home, where the trail would be a single dead crumb.

import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { siteUrl } from "@/lib/fluncle-links";
import { serializeJsonLd } from "@/lib/json-ld";

/**
 * The first path segment → how it reads, and the index its leaves hang under.
 *
 * `index` is set only when a leaf's hub lives at a DIFFERENT path than the segment
 * (an artist page is `/artist/<slug>` but its hub is `/artists`). Everywhere else the
 * segment is its own hub (`/log/<id>` → `/log`), so `index` stays undefined.
 *
 * A segment absent from this map renders NO trail — an unmapped page shows nothing
 * rather than something wrong.
 */
const SEGMENTS: Record<string, { index?: string; label: string }> = {
  about: { label: "About" },
  account: { label: "Your account" },
  album: { index: "/albums", label: "Albums" },
  albums: { label: "Albums" },
  artist: { index: "/artists", label: "Artists" },
  artists: { label: "Artists" },
  chat: { label: "ChatDnB" },
  docs: { label: "Docs" },
  fresh: { label: "Fresh" },
  galaxies: { label: "Galaxies" },
  label: { index: "/labels", label: "Labels" },
  labels: { label: "Labels" },
  log: { label: "Log" },
  logbook: { label: "Logbook" },
  mixtapes: { label: "Mixtapes" },
  newsletter: { label: "Newsletter" },
  privacy: { label: "Privacy" },
  recommendations: { label: "Recommendations" },
  status: { label: "Status" },
  stories: { label: "Stories" },
};

/** One rendered crumb. No `to` ⇒ it is the current page (the bold tail). */
export type Crumb = { label: string; to?: string };

/**
 * A leaf slug read as a human label. A coordinate or a sector number is already the
 * shape we want ("038.6.1J", "038"); a hyphenated slug gets title-cased so a raw URL
 * never leaks into the chrome. A page whose real title differs from its slug (an
 * artist's "Nu:Tone" vs `nu-tone`) passes `leafLabel` explicitly and skips this.
 */
function humanizeSlug(slug: string): string {
  if (/^[\d.]+[\dA-Za-z.]*$/.test(slug)) {
    return slug;
  }

  return slug
    .split("-")
    .map((word) => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
    .join(" ");
}

/**
 * A pathname → its trail, WITHOUT the wordmark root crumb (the top bar renders that
 * itself). Home, and any unmapped segment, yields an empty trail.
 */
export function resolveCrumbs(pathname: string, leafLabel?: string, tail?: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const root = segments[0];

  if (!root) {
    return [];
  }

  const known = SEGMENTS[root];

  if (!known) {
    return [];
  }

  // An index page (/log, /artists) IS the tail: one crumb, unlinked — unless a
  // search-param sub-page (`tail`, the /account tabs) hangs under it, in which case
  // the page crumb links back to its bare self and the tab reads as the tail:
  // FLUNCLE › Your account › Saves.
  if (segments.length === 1) {
    return tail
      ? [{ label: known.label, to: `/${root}` }, { label: tail }]
      : [{ label: known.label }];
  }

  const raw = decodeURIComponent(segments.slice(1).join("/"));
  const numbered = root === "newsletter" && /^\d+$/.test(raw);

  return [
    { label: known.label, to: known.index ?? `/${root}` },
    { label: leafLabel ?? (numbered ? `#${raw}` : humanizeSlug(raw)) },
  ];
}

export function NavBreadcrumb({
  leafLabel,
  pathname,
  tail,
}: {
  leafLabel?: string;
  pathname: string;
  /** A search-param sub-page (the /account tabs) rendered as the trail's tail. */
  tail?: string;
}): ReactNode {
  const crumbs = resolveCrumbs(pathname, leafLabel, tail);

  if (crumbs.length === 0) {
    return undefined;
  }

  const breadcrumbList = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      ...crumbs.map((crumb, index) => ({
        "@type": "ListItem",
        name: crumb.label,
        position: index + 2,
        ...(crumb.to ? { item: `${siteUrl}${crumb.to}` } : {}),
      })),
    ],
  };

  return (
    <nav aria-label="Breadcrumb" className="nav-breadcrumb">
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.label}>
            {/* The Phosphor caret, not a "›" character: a text separator is at the mercy
                of whatever face it lands in (it changed shape when the body font did), and
                DESIGN.md draws every interface icon from Phosphor. */}
            <CaretRightIcon aria-hidden="true" className="nav-breadcrumb-sep" weight="bold" />
            {crumb.to ? (
              <Link to={crumb.to as never}>{crumb.label}</Link>
            ) : (
              // The tail is the page you are on, so the emphasis lands here and never
              // on the hub behind it: the coordinate is the subject, not "Log".
              // The class carries the styling, NOT the aria-current attribute: TanStack
              // marks the hub Link aria-current too (a finding IS under /log), so an
              // attribute selector would truncate "Log" as well and clip its descender.
              <span aria-current="page" className="nav-breadcrumb-tail">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
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
