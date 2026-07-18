import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";
import { useEffect, useRef } from "react";

// Fluncle's /pipeline — a wide, draggable infographic of a finding's whole life, from the
// CMD+F add through the enrichment crons and dispatch to the launch into the Galaxy. A
// client-only DOM/SVG/canvas toy (the whole map is a chunk loaded in useEffect so the
// archive's bundle stays light). noindex: a for-the-nerds internal-machinery view, not a
// search surface.

const title = "Fluncle's galaxy factory";
const description =
  "Follow a banger through every machine Fluncle built, from the first CMD+F to the launch into the Galaxy.";

export const Route = createFileRoute("/pipeline")({
  component: PipelinePage,
  head: () => ({
    links: [{ href: `${siteUrl}/pipeline`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: "noindex", name: "robots" },
    ],
  }),
});

function PipelinePage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    let handle: { destroy: () => void } | undefined;

    void import("@/pipeline/create-pipeline").then((module) => {
      if (!cancelled) {
        handle = module.createPipeline(container);
      }
    });

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-background">
      <h1 className="sr-only">Fluncle's galaxy factory</h1>
      <p className="sr-only">
        A guided map of the machinery Fluncle built for his findings: he hits CMD+F when he hears a
        banger, his machines pull it apart and analyze it, he sends it out to wherever you are, it
        waits on every surface, and it launches into the Galaxy as a star, where he dreams in
        mixtapes. Drag to pan, scroll or use the arrow keys to move, and hold ⌘ while scrolling to
        zoom.
      </p>
      <div
        aria-label="Fluncle's pipeline"
        className="h-full w-full select-none"
        ref={containerRef}
        role="application"
      />
      <noscript>
        <p className="p-6 text-center text-sm text-muted-foreground">
          The map needs JavaScript. The findings are still at{" "}
          <a className="text-primary" href="/">
            fluncle.com
          </a>
          .
        </p>
      </noscript>
    </main>
  );
}
