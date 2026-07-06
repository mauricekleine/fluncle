import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CARD_REGISTRY } from "@/game/earth/cards/registry";
import { findSurface, SurfaceCard } from "@/game/earth/cards/surface-card";
import { earthPalette as p } from "@/game/earth/palette";
import { type PlacedDoor } from "@/game/earth/registry";
import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";

// Earth — the top-down overworld. "We have the sky
// but not the ground": the galaxy game is first-person among the stars; this is
// the ground Fluncle left from. A client-only Canvas walker (apps/web/src/game/
// earth/*) where every device is a door into a real Fluncle surface — owned
// surfaces read from @fluncle/registry, the rest from custom cards. Walk up,
// press E, the door opens. The rocket (north) launches the Galaxy.

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

type EarthGameHandle = {
  destroy: () => void;
  launch: (tx: number, ty: number, onDone: () => void) => void;
  resume: () => void;
};

function EarthPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<EarthGameHandle | undefined>(undefined);
  const navigate = useNavigate();
  const [door, setDoor] = useState<PlacedDoor | undefined>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    void import("@/game/earth/game").then((module) => {
      if (!cancelled) {
        gameRef.current = module.createEarth(container, { onEnterDoor: setDoor });
      }
    });

    return () => {
      cancelled = true;
      gameRef.current?.destroy();
      gameRef.current = undefined;
    };
  }, []);

  function close() {
    setDoor(undefined);
    gameRef.current?.resume();
  }

  function launch(target: PlacedDoor) {
    setDoor(undefined);
    gameRef.current?.launch(target.tx, target.ty, () => {
      void navigate({ to: "/galaxy" });
    });
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
        arrow keys / WASD to walk · E to open
      </p>
      {door ? <DoorOverlay door={door} onClose={close} onLaunch={() => launch(door)} /> : null}
      <noscript>
        <NoscriptFallback />
      </noscript>
    </main>
  );
}

function DoorOverlay({
  door,
  onClose,
  onLaunch,
}: {
  door: PlacedDoor;
  onClose: () => void;
  onLaunch: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
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
      <DoorCard door={door} onClose={onClose} onLaunch={onLaunch} />
      <button
        className="absolute bottom-6 right-6 text-xs tracking-widest"
        onClick={onClose}
        ref={closeRef}
        style={{ color: p.creamMuted }}
        type="button"
      >
        esc · back to Earth
      </button>
    </div>
  );
}

function DoorCard({
  door,
  onClose,
  onLaunch,
}: {
  door: PlacedDoor;
  onClose: () => void;
  onLaunch: () => void;
}) {
  if (door.card) {
    const Card = CARD_REGISTRY[door.card];
    return Card ? <Card onClose={onClose} onLaunch={onLaunch} /> : null;
  }
  if (door.surface) {
    const surface = findSurface(door.surface);
    return surface ? <SurfaceCard label={door.label} surface={surface} /> : null;
  }
  return null;
}

// No-JS / crawler fallback — the overworld is a canvas, but the doors map to real
// surfaces, so degrade to a plain link list that still reaches them.
function NoscriptFallback() {
  const links: Array<{ href: string; label: string }> = [
    { href: siteUrl, label: "the archive" },
    { href: `${siteUrl}/log`, label: "the log" },
    { href: `${siteUrl}/galaxy`, label: "the Galaxy" },
    { href: `${siteUrl}/radio`, label: "the radio" },
    { href: `${siteUrl}/mixtapes`, label: "the mixtapes" },
    { href: spotifyPlaylistUrl, label: "Fluncle's Findings on Spotify" },
    { href: telegramUrl, label: "the Telegram channel" },
  ];

  return (
    <div className="p-6 text-center text-sm" style={{ color: p.creamMuted }}>
      <p>The overworld needs JavaScript. The surfaces are still out there:</p>
      <ul className="mt-3 space-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href} style={{ color: p.gold }}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
