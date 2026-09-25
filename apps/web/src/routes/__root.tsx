import { colors } from "@fluncle/tokens";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useLoaderData,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useEffect, useState } from "react";
import { NotFoundBlackHole } from "@/components/not-found-black-hole";
import { RootErrorState } from "@/components/root-error-state";
import { DiscoveryListener } from "@/components/discovery-listener";
import { PublicChrome } from "@/components/nav/public-chrome";
import { isGalaxyMapFullyNamed } from "@/lib/server/galaxies-map";
import { isStaleBuildError, recoverFromStaleBuild } from "@/lib/stale-build-recovery";
import { siteUrl } from "../lib/fluncle-links";
import { fluncleMetaDescription } from "../lib/identity";
import appCss from "../styles.css?url";

const title = "Fluncle: drum & bass bangers from another dimension";

const description = fluncleMetaDescription;
const coverUrl = `${siteUrl}/fluncle-cover.png`;

const fetchGalaxiesLive = createServerFn({ method: "GET" }).handler(() => isGalaxyMapFullyNamed());

// oxlint-disable-next-line sort-keys
export const Route = createRootRoute({
  component: RootLayout,
  loader: async () => ({ galaxiesLive: await fetchGalaxiesLive() }),

  staleTime: 10 * 60_000,
  head: () => ({
    links: [
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
      {
        href: "/fresh.xml",
        rel: "alternate",
        title: "New drum & bass releases",
        type: "application/rss+xml",
      },
      {
        href: "/fresh.json",
        rel: "alternate",
        title: "New drum & bass releases",
        type: "application/feed+json",
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
        content: colors.deepField,
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
    ],
    scripts: [
      {
        async: true,
        src: "https://scripts.simpleanalyticscdn.com/latest.js",
      },
    ],
  }),

  errorComponent: RootErrorBoundary,

  notFoundComponent: NotFoundBlackHole,
});

function RootErrorBoundary(props: ErrorComponentProps): ReactNode {
  const { error } = props;

  useEffect(() => {
    if (isStaleBuildError(error)) {
      recoverFromStaleBuild();
    }
  }, [error]);

  return <RootErrorState {...props} />;
}

function RootLayout(): ReactNode {
  const [queryClient] = useState(() => new QueryClient());
  const { galaxiesLive } = useLoaderData({ from: Route.id });

  useEffect(() => {
    const onPreloadError = (event: Event): void => {
      event.preventDefault();
      recoverFromStaleBuild();
    };

    window.addEventListener("vite:preloadError", onPreloadError);

    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div aria-hidden="true" className="sun-bloom" />
        <QueryClientProvider client={queryClient}>
          <DiscoveryListener />

          <PublicChrome galaxiesLive={galaxiesLive}>
            <Outlet />
          </PublicChrome>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
