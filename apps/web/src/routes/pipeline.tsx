import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

// Fluncle's /pipeline — a wide, draggable infographic of a finding's whole life, from the
// CMD+F add through the enrichment crons and dispatch to the launch into the Galaxy. A
// client-only DOM/SVG/canvas toy (the whole map is a chunk loaded in useEffect so the
// archive's bundle stays light). noindex: a for-the-nerds internal-machinery view, not a
// search surface — same posture as /earth and /sprites.

const title = "Fluncle's pipeline";
const description =
  "One finding, from the dig to the Galaxy: Fluncle's whole pipeline as a draggable map.";

export const Route = createFileRoute("/pipeline")({
  component: PipelinePage,
  head: () => ({
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
    <main className="fixed inset-0 overflow-hidden bg-[#090a0b]">
      <h1 className="sr-only">Fluncle's pipeline</h1>
      <p className="sr-only">
        The whole journey a banger takes through Fluncle, end to end: the instant find, the
        enrichment factory where background machines pull it apart and learn it, distribution out to
        the world, every surface it lands on, and the launch into the Galaxy where each finding is a
        star and a mixtape is Fluncle dreaming. Drag to pan, scroll or use the arrow keys to move,
        and hold ⌘ while scrolling to zoom.
      </p>
      <div
        aria-label="Fluncle's pipeline"
        className="h-full w-full select-none"
        ref={containerRef}
        role="application"
      />
      <noscript>
        <p className="p-6 text-center text-sm" style={{ color: "#b7ab95" }}>
          The map needs JavaScript. The findings are still at{" "}
          <a href="/" style={{ color: "#f5b800" }}>
            fluncle.com
          </a>
          .
        </p>
      </noscript>
    </main>
  );
}
