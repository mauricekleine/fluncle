/// <reference types="vite/client" />

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { siteUrl } from "../lib/fluncle-links";
import { fluncleDescription } from "../lib/identity";
import appCss from "../styles.css?url";

const title = "Fluncle: drum & bass bangers from another dimension";
const description = fluncleDescription;
const coverUrl = `${siteUrl}/fluncle-cover.png`;

export const Route = createRootRoute({
  component: RootLayout,
  head: () => ({
    links: [
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
});

function RootLayout(): ReactNode {
  // One QueryClient per app instance (created once via useState so it survives
  // re-renders). Admin boards read through it so they refetch on window focus —
  // handy when the operator tabs back from TikTok/YouTube.
  const [queryClient] = useState(() => new QueryClient());

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
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
