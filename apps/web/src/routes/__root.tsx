/// <reference types="vite/client" />

import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { siteUrl } from "../lib/fluncle-links";
import appCss from "../styles.css?url";

const title = "Fluncle: drum & bass bangers from another dimension";
const description = "Drum & bass bangers from another dimension.";
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
        href: "/favicon.png",
        rel: "icon",
        type: "image/png",
      },
      {
        href: "/apple-touch-icon.png",
        rel: "apple-touch-icon",
      },
      {
        href: `${siteUrl}/`,
        rel: "canonical",
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
        content: "Drum & bass bangers from another dimension.",
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
        content: "Drum & bass bangers from another dimension.",
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
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
