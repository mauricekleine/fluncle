import { RadioIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTelegram,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { HomeStatusPill } from "@/components/home/status-pill";
import { SubmitTrackDialog } from "@/components/submit-track-dialog";
import { SubscribeDialog } from "@/components/subscribe-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  galaxyUrl,
  instagramUrl,
  mixcloudUrl,
  radioUrl,
  repoUrl,
  soundcloudUrl,
  spotifyPlaylistUrl,
  telegramUrl,
  tiktokUrl,
  twitchUrl,
  xUrl,
  youtubeUrl,
} from "@/lib/fluncle-links";

// The cover column's link hub. Top to bottom: the gold Galaxy CTA (the ONE sun),
// the two listen + contribute button rows, the Join-the-Crew button (its own
// glowing moving border), then the quiet sections sunk to the BOTTOM (mt-auto) —
// "Follow Fluncle" and its socials, the About/Logs/Mixtapes/Docs row, the "For the
// nerds" dev-surface row, and the live status pill at the very bottom. Rendered as
// a direct flex child of the <aside> (which stretches to the grid row height on
// desktop), so flex-1 + mt-auto actually push the lower group down.

// Fluncle off-site, alphabetical (docs/socials/). Spotify stays the Playlist
// button above, so it isn't duplicated in the icon strip.
const socialLinks = [
  { href: instagramUrl, icon: siInstagram, label: "Fluncle on Instagram" },
  { href: mixcloudUrl, icon: siMixcloud, label: "Fluncle on Mixcloud" },
  { href: soundcloudUrl, icon: siSoundcloud, label: "Fluncle on SoundCloud" },
  { href: telegramUrl, icon: siTelegram, label: "Fluncle on Telegram" },
  { href: tiktokUrl, icon: siTiktok, label: "Fluncle on TikTok" },
  { href: twitchUrl, icon: siTwitch, label: "Fluncle on Twitch" },
  { href: xUrl, icon: siX, label: "DM me on X" },
  { href: youtubeUrl, icon: siYoutube, label: "Fluncle on YouTube" },
];

// The shared treatment for every quiet text link at the bottom (About, Logs,
// Mixtapes, Docs — and the developer row: CLI, DIG, GIT, MCP, SSH).
const linkClassName =
  "font-semibold text-muted-foreground transition-colors hover:text-accent-foreground";

/** A muted dot separator between inline links. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-muted-foreground/55">
      ·
    </span>
  );
}

/** A quiet centered section header — a muted label between two divider lines.
    Shared by "Follow Fluncle" and "For the nerds" so they read identically. */
function SectionHeader({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`flex w-full items-center gap-3 ${className}`}>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span className="text-sm font-semibold tracking-wide text-muted-foreground">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

export function HomeLinkHub() {
  return (
    <div className="mt-3 flex flex-1 flex-col">
      {/* The actions: the gold Galaxy CTA (One Sun), the listen pair (Playlist +
          Radio), and the contribute pair (Newsletter + Submit a track). Join the
          Crew lives in the masthead's top-right now (the sign-up convention). */}
      <div className="flex flex-col gap-2.5">
        <Button
          className="w-full"
          nativeButton={false}
          render={<a aria-label="Enter Fluncle's Galaxy" href={galaxyUrl} />}
          size="lg"
        >
          <img
            alt=""
            aria-hidden="true"
            className="size-5 object-contain [image-rendering:pixelated]"
            src="/galaxy/ship.png"
          />
          Enter Fluncle's Galaxy
        </Button>

        {/* The listen pair: Playlist (Spotify) + Radio (radio.fluncle.com). Both
            outline/secondary — neither is a second sun. */}
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            nativeButton={false}
            render={
              <a
                aria-label="Fluncle playlist on Spotify"
                href={spotifyPlaylistUrl}
                rel="noreferrer"
                target="_blank"
              />
            }
            size="lg"
            variant="outline"
          >
            <BrandIcon icon={siSpotify} />
            Playlist
          </Button>
          <Button
            className="flex-1"
            nativeButton={false}
            render={<a aria-label="Listen on Fluncle radio" href={radioUrl} />}
            size="lg"
            variant="outline"
          >
            <RadioIcon aria-hidden="true" weight="bold" />
            Radio
          </Button>
        </div>

        {/* The contribute pair: the newsletter sign-up + the track submission. */}
        <div className="flex items-center gap-2">
          <SubscribeDialog className="flex-1" label="Newsletter" />
          <SubmitTrackDialog className="flex-1" />
        </div>
      </div>

      {/* The site links sit directly under Join the Crew — About · Logs · Mixtapes ·
          Docs. Radio left this row (it's a Listen-pair button now). */}
      <nav
        aria-label="More from Fluncle"
        className="mt-4 flex items-center justify-center gap-3 text-sm"
      >
        <Link className={linkClassName} to="/about">
          About
        </Link>
        <Dot />
        <Link className={linkClassName} to="/log">
          Logs
        </Link>
        <Dot />
        <Link className={linkClassName} to="/mixtapes">
          Mixtapes
        </Link>
        <Dot />
        <Link className={linkClassName} to="/docs">
          Docs
        </Link>
      </nav>

      {/* The quiet sections sink to the bottom of the column (mt-auto): the socials,
          the dev-surface row, and the live status pill. */}
      <div className="mt-auto flex flex-col items-center gap-3 pt-8">
        <SectionHeader>Follow Fluncle</SectionHeader>
        <nav
          aria-label="Fluncle on other platforms"
          className="flex items-center justify-center gap-0.5"
        >
          {socialLinks.map((social) => (
            <Tooltip key={social.label}>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={social.label}
                    className="text-muted-foreground size-8"
                    nativeButton={false}
                    render={
                      <a
                        aria-label={social.label}
                        href={social.href}
                        rel="noreferrer"
                        target="_blank"
                      />
                    }
                    size="icon"
                    variant="ghost"
                  />
                }
              >
                <BrandIcon className="size-4 md:size-4.5" icon={social.icon} />
              </TooltipTrigger>
              <TooltipContent>{social.label}</TooltipContent>
            </Tooltip>
          ))}
        </nav>

        {/* The dev-surface section: its own header (matching "Follow Fluncle")
            over the terminal-voiced CLI/DIG/GIT/MCP/SSH row. */}
        <SectionHeader className="mt-3">For the nerds</SectionHeader>
        <nav
          aria-label="Developer tools and connections"
          className="flex items-center justify-center gap-3 text-[13px] font-mono"
        >
          {/* CLI/DIG/MCP/SSH are docs pages served by the /docs/$ catch-all, so
              they navigate via the splat param (exact URLs /docs/cli etc.). */}
          <Link className={linkClassName} params={{ _splat: "cli" }} to="/docs/$">
            CLI
          </Link>
          <Dot />
          <Link className={linkClassName} params={{ _splat: "dig" }} to="/docs/$">
            DIG
          </Link>
          <Dot />
          <a className={linkClassName} href={repoUrl} rel="noreferrer" target="_blank">
            GIT
          </a>
          <Dot />
          <Link className={linkClassName} params={{ _splat: "mcp" }} to="/docs/$">
            MCP
          </Link>
          <Dot />
          <Link className={linkClassName} params={{ _splat: "ssh" }} to="/docs/$">
            SSH
          </Link>
        </nav>

        {/* The live heartbeat: a ping-dot pill that fetches /api/status on mount. */}
        <HomeStatusPill />
      </div>
    </div>
  );
}
