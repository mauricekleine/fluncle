/// <reference types="vite/client" />

import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { type ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  component: RootLayout,
  head: () => ({
    links: [
      {
        href: "https://fonts.googleapis.com",
        rel: "preconnect",
      },
      {
        crossOrigin: "anonymous",
        href: "https://fonts.gstatic.com",
        rel: "preconnect",
      },
      {
        href: "https://fonts.googleapis.com/css2?family=Oxanium:wght@400;500;600;700;800&display=swap",
        rel: "stylesheet",
      },
      {
        href: appCss,
        rel: "stylesheet",
      },
      {
        href: "/fluncle-cover.png",
        rel: "icon",
        type: "image/png",
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
        title: "Fluncle",
      },
      {
        content: "Fresh drum & bass transmissions from Fluncle's Finest.",
        name: "description",
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
