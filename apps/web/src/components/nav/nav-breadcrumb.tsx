import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { siteUrl } from "@/lib/fluncle-links";
import { serializeJsonLd } from "@/lib/json-ld";

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
  search: { label: "Search" },
  status: { label: "Status" },
  stories: { label: "Stories" },
  terms: { label: "Terms" },
  tracks: { label: "Tracks" },
};

export type Crumb = { label: string; to?: string };

function humanizeSlug(slug: string): string {
  if (/^[\d.]+[\dA-Za-z.]*$/.test(slug)) {
    return slug;
  }

  return slug
    .split("-")
    .map((word) => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
    .join(" ");
}

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

  tail?: string;
}): ReactNode {
  const crumbs = resolveCrumbs(pathname, leafLabel, tail);

  if (crumbs.length === 0) {
    return undefined;
  }

  const breadcrumbList =
    crumbs.length > 1
      ? undefined
      : {
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
            <CaretRightIcon aria-hidden="true" className="nav-breadcrumb-sep" weight="bold" />
            {crumb.to ? (
              <Link to={crumb.to as never}>{crumb.label}</Link>
            ) : (
              <span aria-current="page" className="nav-breadcrumb-tail">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>

      {breadcrumbList ? (
        <script
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbList) }}
          type="application/ld+json"
        />
      ) : undefined}
    </nav>
  );
}
