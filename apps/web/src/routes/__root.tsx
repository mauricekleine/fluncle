/// <reference types="vite/client" />

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useLoaderData,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { PublicChrome } from "@/components/nav/public-chrome";
import { isGalaxyMapFullyNamed } from "@/lib/server/galaxies-map";
import { siteUrl } from "../lib/fluncle-links";
import { fluncleMetaDescription } from "../lib/identity";
import appCss from "../styles.css?url";

const title = "Fluncle: drum & bass bangers from another dimension";
// The site-wide <meta>/og/twitter description (every page inherits it unless it
// sets its own, e.g. the log pages). Kept ≤155 chars for the SERP snippet.
const description = fluncleMetaDescription;
const coverUrl = `${siteUrl}/fluncle-cover.png`;

// The nav's Galaxies gate, resolved on the SERVER. `/galaxies` 404s until the whole
// sonic map is named, so the nav must not link it before then — but the check has to
// happen server-side, or the link never lands in the SSR HTML and a crawler (which
// is the whole point of banking the nav in a footer) never sees the map at all.
const fetchGalaxiesLive = createServerFn({ method: "GET" }).handler(() => isGalaxyMapFullyNamed());

// oxlint-disable-next-line sort-keys -- TanStack's canonical option order (loader
// feeds the next step's inference); see AGENTS.md.
export const Route = createRootRoute({
  component: RootLayout,
  head: () => ({
    links: [
      // The body face. Preloaded ahead of the display face because it now sets nearly
      // every line of text on the page; a late swap would reflow the lot.
      {
        as: "font",
        crossOrigin: "anonymous",
        href: "/fonts/space-grotesk-latin.woff2",
        rel: "preload",
        type: "font/woff2",
      },
      {
        as: "font",
        crossOrigin: "anonymous",
        href: "/fonts/oxanium-latin.woff2",
        rel: "preload",
        type: "font/woff2",
      },
      {
        href: appCss,
        rel: "stylesheet",
      },
      {
        href: "/favicon.ico",
        rel: "icon",
        sizes: "32x32",
      },
      {
        href: "/favicon.png",
        rel: "icon",
        sizes: "96x96",
        type: "image/png",
      },
      {
        href: "/apple-touch-icon.png",
        rel: "apple-touch-icon",
      },
      {
        href: "/manifest.webmanifest",
        rel: "manifest",
      },
      {
        href: "/humans.txt",
        rel: "author",
      },
      {
        href: "/rss.xml",
        rel: "alternate",
        title: "Fluncle's Findings",
        type: "application/rss+xml",
      },
      {
        href: "/feed.json",
        rel: "alternate",
        title: "Fluncle's Findings",
        type: "application/feed+json",
      },
      {
        href: "/atom.xml",
        rel: "alternate",
        title: "Fluncle's Findings",
        type: "application/atom+xml",
      },
      {
        href: "/podcast.xml",
        rel: "alternate",
        title: "Fluncle's Mixtapes",
        type: "application/rss+xml",
      },
    ],
    meta: [
      {
        charSet: "utf-8",
      },
      {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      },
      {
        content: "#090a0b",
        name: "theme-color",
      },
      {
        title,
      },
      {
        content: description,
        name: "description",
      },
      {
        content: title,
        property: "og:title",
      },
      {
        content: description,
        property: "og:description",
      },
      {
        content: coverUrl,
        property: "og:image",
      },
      {
        content: "512",
        property: "og:image:width",
      },
      {
        content: "512",
        property: "og:image:height",
      },
      {
        content: "Fluncle cover art",
        property: "og:image:alt",
      },
      {
        content: `${siteUrl}/`,
        property: "og:url",
      },
      {
        content: "website",
        property: "og:type",
      },
      {
        content: "Fluncle",
        property: "og:site_name",
      },
      {
        content: "summary",
        name: "twitter:card",
      },
      {
        content: title,
        name: "twitter:title",
      },
      {
        content: description,
        name: "twitter:description",
      },
      {
        content: coverUrl,
        name: "twitter:image",
      },
    ],
    scripts: [
      {
        async: true,
        src: "https://scripts.simpleanalyticscdn.com/latest.js",
      },
    ],
  }),
  loader: async () => ({ galaxiesLive: await fetchGalaxiesLive() }),
});

function RootLayout(): ReactNode {
  // One QueryClient per app instance (created once via useState so it survives
  // re-renders). Admin boards read through it so they refetch on window focus —
  // handy when the operator tabs back from TikTok/YouTube.
  const [queryClient] = useState(() => new QueryClient());
  const { galaxiesLive } = useLoaderData({ from: Route.id });

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* The one directional Eclipse-Gold bloom under every pane (gold as
            ignition; breath gated to no-preference in CSS). */}
        <div aria-hidden="true" className="sun-bloom" />
        <QueryClientProvider client={queryClient}>
          {/* The single mount point for the public navigation (the logbook colophon):
              the wordmark + breadcrumb top bar, and the liner-notes footer that
              carries the whole nav. Skips /admin + the full-bleed surfaces. */}
          <PublicChrome galaxiesLive={galaxiesLive}>
            <Outlet />
          </PublicChrome>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
