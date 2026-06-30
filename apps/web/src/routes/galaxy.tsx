import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { siteUrl } from "@/lib/fluncle-links";

// Fluncle's Galaxy — the game. The whole game is a
// client-only canvas app, loaded as its own chunk inside useEffect so the
// archive's bundle stays light and the server never touches browser APIs.

const title = "Fluncle's Galaxy";
const description = "Every banger out there is a star. Fly the Galaxy, log them all.";

export const Route = createFileRoute("/galaxy")({
  component: GalaxyPage,
  head: () => ({
    links: [
      {
        href: `${siteUrl}/galaxy`,
        rel: "canonical",
      },
    ],
    meta: [
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
        content: `${siteUrl}/galaxy`,
        property: "og:url",
      },
      {
        content: `${siteUrl}/galaxy/og.png`,
        property: "og:image",
      },
      {
        content: "1200",
        property: "og:image:width",
      },
      {
        content: "630",
        property: "og:image:height",
      },
      {
        content: "Fluncle's Galaxy — every banger out there is a star.",
        property: "og:image:alt",
      },
      {
        content: "summary_large_image",
        name: "twitter:card",
      },
    ],
  }),
});

function GalaxyPage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let cancelled = false;
    let game: { destroy: () => void } | undefined;

    void import("@/game/game").then((module) => {
      if (!cancelled) {
        game = module.createGame(container);
      }
    });

    return () => {
      cancelled = true;
      game?.destroy();
    };
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#090a0b]">
      <h1 className="sr-only">Fluncle's Galaxy</h1>
      <p className="sr-only">
        A flight through Fluncle's Findings: every banger is a star at its Log ID coordinate. Steer
        with the arrow keys, hold space to boost, fly to a star to log it and refuel.
      </p>
      <div
        aria-label="Fluncle's Galaxy"
        className="h-full w-full select-none"
        ref={containerRef}
        role="application"
      />
      <noscript>
        <p className="p-6 text-center text-sm" style={{ color: "#b7ab95" }}>
          The cockpit needs JavaScript. The findings are still at{" "}
          <a href="/" style={{ color: "#f5b800" }}>
            fluncle.com
          </a>
          .
        </p>
      </noscript>
    </main>
  );
}
