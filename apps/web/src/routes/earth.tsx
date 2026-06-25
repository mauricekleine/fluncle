import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { earthPalette as p } from "@/game/earth/palette";
import { type Surface } from "@/game/earth/room";
import { siteUrl } from "@/lib/fluncle-links";

// Earth — the top-down overworld spike (docs/rfcs, the Earth-overworld idea).
// "We have the sky but not the ground": the galaxy game is first-person among
// the stars; this is the ground Fluncle left from. A client-only canvas walker
// (apps/web/src/game/earth/*) where device-landmarks are doors into Fluncle's
// real surfaces. Spike: the CRT → the SSH terminal is the wired showcase.

const title = "Earth — Fluncle";
const description = "The ground Fluncle left from. Walk it; every device is a door.";

export const Route = createFileRoute("/earth")({
  component: EarthPage,
  head: () => ({
    meta: [
      { title },
      { content: description, name: "description" },
      { content: "noindex", name: "robots" },
    ],
  }),
});

function EarthPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<{ destroy: () => void; resume: () => void } | undefined>(undefined);
  const [surface, setSurface] = useState<Surface | undefined>();

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let cancelled = false;

    void import("@/game/earth/game").then((module) => {
      if (!cancelled) {
        gameRef.current = module.createEarth(container, { onEnterSurface: setSurface });
      }
    });

    return () => {
      cancelled = true;
      gameRef.current?.destroy();
      gameRef.current = undefined;
    };
  }, []);

  function close() {
    setSurface(undefined);
    gameRef.current?.resume();
  }

  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden bg-[#090a0b]">
      <h1 className="sr-only">Earth — the Fluncle overworld</h1>
      <div
        aria-label="The Fluncle overworld"
        className="flex h-full w-full select-none items-center justify-center"
        ref={containerRef}
        role="application"
      />
      <p
        className="pointer-events-none absolute bottom-6 left-0 right-0 text-center text-xs tracking-wide"
        style={{ color: p.creamMuted }}
      >
        arrow keys / WASD to walk · E to enter a door
      </p>
      {surface ? <SurfaceScreen onClose={close} surface={surface} /> : null}
      <noscript>
        <p className="p-6 text-center text-sm" style={{ color: p.creamMuted }}>
          The overworld needs JavaScript. The findings are still at{" "}
          <a href="/" style={{ color: p.gold }}>
            fluncle.com
          </a>
          .
        </p>
      </noscript>
    </main>
  );
}

function SurfaceScreen({ onClose, surface }: { onClose: () => void; surface: Surface }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center p-6"
      style={{ background: "rgba(9,10,11,0.86)" }}
    >
      {surface === "terminal" ? <Terminal /> : null}
      {surface === "spotify" ? <SpotifyCard /> : null}
      {surface === "onion" ? <OnionCard /> : null}
      <button
        className="absolute bottom-6 right-6 text-xs uppercase tracking-widest"
        onClick={onClose}
        style={{ color: p.creamMuted }}
        type="button"
      >
        esc — back to Earth
      </button>
    </div>
  );
}

function Terminal() {
  return (
    <div
      className="relative w-full max-w-2xl overflow-hidden rounded-md p-6 font-mono text-sm leading-relaxed shadow-2xl"
      style={{ background: "#060a08", border: `1px solid ${p.phosphorDim}`, color: p.phosphor }}
    >
      {/* scanlines */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 2px, transparent 4px)",
        }}
      />
      <p style={{ color: p.phosphorDim }}>FLUNCLE TERMINAL · recovered shell</p>
      <p>[ ok ] tailnet up</p>
      <p>[ ok ] tor: onion published</p>
      <p>[ ok ] wish: listening</p>
      <p className="mt-3" style={{ color: p.creamMuted }}>
        a terminal at the edge of the map. drop in from your own machine:
      </p>
      <p className="mt-2" style={{ color: p.phosphor }}>
        <span style={{ color: p.goldBright }}>$</span> ssh rave.fluncle.com
        <span className="cursor-blink">▋</span>
      </p>
      <style>{`@keyframes cb { 50% { opacity: 0 } } .cursor-blink { animation: cb 1s steps(1) infinite }`}</style>
    </div>
  );
}

function SpotifyCard() {
  return (
    <div
      className="w-full max-w-md rounded-md p-7 text-center shadow-2xl"
      style={{ background: p.sleeveBlack, border: `1px solid ${p.creamDim}`, color: p.cream }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: p.goldBright }}>
        the boombox
      </p>
      <p className="mt-3 text-lg">Fluncle's Findings</p>
      <p className="mt-2 text-sm" style={{ color: p.creamMuted }}>
        every banger the traveller logged, gathered into one playlist.
      </p>
      <a
        className="mt-5 inline-block rounded-full px-5 py-2 text-sm font-medium"
        href={siteUrl}
        rel="noreferrer"
        style={{ background: p.gold, color: p.inkOnGold }}
        target="_blank"
      >
        open on Spotify
      </a>
    </div>
  );
}

function OnionCard() {
  return (
    <div
      className="w-full max-w-md rounded-md p-7 text-center shadow-2xl"
      style={{ background: p.sleeveBlack, border: `1px solid ${p.coolBlue}`, color: p.cream }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: p.coolBlue }}>
        the giant onion
      </p>
      <p className="mt-3 text-lg">The archive, over Tor</p>
      <p className="mt-2 text-sm" style={{ color: p.creamMuted }}>
        the whole of fluncle.com, reachable as a hidden service — the niche within the niche.
      </p>
      <p className="mt-5 font-mono text-xs" style={{ color: p.coolBlue }}>
        …onion
      </p>
    </div>
  );
}
