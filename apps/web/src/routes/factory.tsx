import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { type FactoryGame } from "@/game/factory/game";
import { type FactoryFinding } from "@/game/factory/sim";
import { LAUNCH_INDEX, STATIONS, stationOf } from "@/game/factory/stations";
import { siteUrl, spotifyPlaylistUrl, telegramUrl } from "@/lib/fluncle-links";
import { fetchTracks } from "@/lib/tracks";
import { listTracks } from "@/lib/server/tracks";
import { factoryPalette as p } from "@/game/factory/palette";

// The factory — a finding's life, made playable.
// A client-only Canvas conveyor that renders the REAL pipeline state every finding
// is in (the same fields /api/tracks already carries), polled near-realtime. A
// finding rides the belt to the furthest step it has reached, piles in front of
// the slow render bay, and a finished finding launches up to the Galaxy. The page
// boots the game via a dynamic import (the server never touches browser APIs) and
// feeds it the live finding list; the canvas is the whole show.

const title = "Factory — Fluncle";
const description = "Where a find is made. Watch it ride the line, then launch.";

const FEED_LIMIT = 48; // the /api/tracks cap — the newest findings are the in-flight ones

const fetchFactoryFeed = createServerFn({ method: "GET" }).handler(() =>
  listTracks({ includeMixtapes: false, limit: FEED_LIMIT }),
);

export const Route = createFileRoute("/factory")({
  component: FactoryPage,
  head: () => ({
    meta: [
      { title },
      { content: description, name: "description" },
      { content: "noindex", name: "robots" },
    ],
  }),
  loader: () => fetchFactoryFeed(),
});

/** A finding the line can carry — keyed by Log ID, with its cover and what it shows. */
function toFactoryFinding(track: {
  addedToSpotify: boolean;
  albumImageUrl?: string;
  artists: string[];
  enrichmentStatus: string;
  galaxy?: { name: string };
  logId?: string;
  logPageUrl?: string;
  note?: string;
  observationAudioUrl?: string;
  postedToTelegram: boolean;
  spotifyUrl: string;
  tiktokUrl?: string;
  title: string;
  videoUrl?: string;
  youtubeUrl?: string;
}): FactoryFinding | undefined {
  if (!track.logId) {
    return undefined; // a straggler with no coordinate can't ride the line yet
  }
  return {
    addedToSpotify: track.addedToSpotify,
    albumImageUrl: track.albumImageUrl,
    artistLine: track.artists.join(", "),
    enrichmentStatus: track.enrichmentStatus,
    galaxyName: track.galaxy?.name,
    logId: track.logId,
    logPageUrl: track.logPageUrl,
    note: track.note,
    observationAudioUrl: track.observationAudioUrl,
    postedToTelegram: track.postedToTelegram,
    spotifyUrl: track.spotifyUrl,
    tiktokUrl: track.tiktokUrl,
    title: track.title,
    videoUrl: track.videoUrl,
    youtubeUrl: track.youtubeUrl,
  };
}

function FactoryPage() {
  const initial = Route.useLoaderData();
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<FactoryGame | undefined>(undefined);
  const navigate = useNavigate();
  const [selected, setSelected] = useState<FactoryFinding | undefined>();

  // Poll the newest findings — near-realtime, zero new infra. SSR-seeded so the
  // first paint (and crawlers) get a populated line.
  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchTracks({ limit: FEED_LIMIT }),
    queryKey: ["factory-feed"],
    refetchInterval: 15_000,
  });

  const findings = useMemo(() => {
    const out: FactoryFinding[] = [];
    for (const item of data.tracks) {
      if (item.type !== "finding") {
        continue;
      }
      const finding = toFactoryFinding(item);
      if (finding) {
        out.push(finding);
      }
    }
    return out;
  }, [data]);

  // The latest findings, read by the boot effect so it can seed the line the
  // moment the game is ready without listing `findings` as a boot dependency.
  const findingsRef = useRef(findings);
  findingsRef.current = findings;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    void import("@/game/factory/game").then((module) => {
      if (cancelled) {
        return;
      }
      const game = module.createFactory(container, {
        onInspect: setSelected,
        onLaunch: () => void navigate({ to: "/galaxy" }),
      });
      game.setFindings(findingsRef.current);
      gameRef.current = game;
    });
    return () => {
      cancelled = true;
      gameRef.current?.destroy();
      gameRef.current = undefined;
    };
  }, [navigate]);

  // Keep the line fed as new findings arrive from the poll.
  useEffect(() => {
    gameRef.current?.setFindings(findings);
  }, [findings]);

  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden bg-[#090a0b]">
      <h1 className="sr-only">The Fluncle factory — a finding on the line</h1>
      <div
        aria-label="The Fluncle factory line"
        className="flex h-full w-full select-none items-center justify-center"
        ref={containerRef}
        role="application"
      />
      <p
        className="pointer-events-none absolute bottom-6 left-0 right-0 text-center text-xs tracking-wide"
        style={{ color: p.creamMuted }}
      >
        drag or arrow keys to pan · tap a find to read it · the pad launches the Galaxy
      </p>
      {selected ? (
        <InspectOverlay finding={selected} onClose={() => setSelected(undefined)} />
      ) : null}
      <noscript>
        <NoscriptFallback />
      </noscript>
    </main>
  );
}

function InspectOverlay({ finding, onClose }: { finding: FactoryFinding; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const index = stationOf(finding);
  const station = STATIONS[Math.min(index, LAUNCH_INDEX)];

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
      <div
        className="w-full max-w-sm rounded-lg border p-4"
        style={{ background: p.sleeveBlack, borderColor: p.dustLine }}
      >
        <div className="flex gap-3">
          {finding.albumImageUrl ? (
            <img
              alt=""
              className="size-16 shrink-0 rounded"
              src={finding.albumImageUrl}
              style={{ border: `1px solid ${p.dustLine}` }}
            />
          ) : null}
          <div className="min-w-0">
            <div className="text-xs tracking-widest" style={{ color: p.goldBright }}>
              {finding.logId}
            </div>
            <div className="truncate text-sm font-bold" style={{ color: p.cream }}>
              {finding.title}
            </div>
            <div className="truncate text-xs" style={{ color: p.creamMuted }}>
              {finding.artistLine}
            </div>
          </div>
        </div>

        <div className="mt-4 border-t pt-3" style={{ borderColor: p.dustLine }}>
          <div className="text-xs" style={{ color: p.creamMuted }}>
            On the line
          </div>
          <div className="text-sm font-bold" style={{ color: p.cream }}>
            {station?.title}
          </div>
          <div className="mt-1 text-xs" style={{ color: p.creamMuted }}>
            {index >= LAUNCH_INDEX ? station?.blurb : station?.blocked}
          </div>
          {finding.galaxyName ? (
            <div className="mt-1 text-xs" style={{ color: p.creamMuted }}>
              Bound for the {finding.galaxyName} galaxy.
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-3 text-xs">
            <a
              href={finding.logPageUrl ?? `${siteUrl}/log/${finding.logId}`}
              style={{ color: p.goldBright }}
            >
              open the log
            </a>
            <a
              href={finding.spotifyUrl}
              rel="noreferrer"
              style={{ color: p.goldBright }}
              target="_blank"
            >
              play on Spotify
            </a>
          </div>
          <button
            className="text-xs tracking-widest"
            onClick={onClose}
            ref={closeRef}
            style={{ color: p.creamMuted }}
            type="button"
          >
            esc · back
          </button>
        </div>
      </div>
    </div>
  );
}

// No-JS / crawler fallback — the line is a canvas, but it renders real findings, so
// degrade to the surfaces that carry them.
function NoscriptFallback() {
  const links: Array<{ href: string; label: string }> = [
    { href: `${siteUrl}/log`, label: "the log" },
    { href: `${siteUrl}/galaxy`, label: "the Galaxy" },
    { href: `${siteUrl}/`, label: "the archive" },
    { href: spotifyPlaylistUrl, label: "Fluncle's Findings on Spotify" },
    { href: telegramUrl, label: "the Telegram channel" },
  ];
  return (
    <div className="p-6 text-center text-sm" style={{ color: p.creamMuted }}>
      <p>The line needs JavaScript. The findings are still out there:</p>
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
