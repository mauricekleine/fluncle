import { RadioIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  siBluesky,
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
import { Button } from "@fluncle/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fluncle/ui/components/tooltip";
import {
  blueskyUrl,
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

const socialLinks = [
  { href: blueskyUrl, icon: siBluesky, label: "Fluncle on Bluesky" },
  { href: instagramUrl, icon: siInstagram, label: "Fluncle on Instagram" },
  { href: mixcloudUrl, icon: siMixcloud, label: "Fluncle on Mixcloud" },
  { href: soundcloudUrl, icon: siSoundcloud, label: "Fluncle on SoundCloud" },
  { href: telegramUrl, icon: siTelegram, label: "Fluncle on Telegram" },
  { href: tiktokUrl, icon: siTiktok, label: "Fluncle on TikTok" },
  { href: twitchUrl, icon: siTwitch, label: "Fluncle on Twitch" },
  { href: xUrl, icon: siX, label: "DM me on X" },
  { href: youtubeUrl, icon: siYoutube, label: "Fluncle on YouTube" },
];

const linkClassName =
  "font-semibold text-muted-foreground transition-colors hover:text-accent-foreground";

function Dot() {
  return (
    <span aria-hidden="true" className="text-muted-foreground/55">
      ·
    </span>
  );
}

function SectionHeader({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`flex w-full items-center gap-3 ${className}`}>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span className="text-sm font-semibold tracking-wide text-muted-foreground">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

export function FindingsLinkHub({ galaxiesLive = false }: { galaxiesLive?: boolean }) {
  return (
    <div className="mt-3 flex flex-1 flex-col">
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

        <div className="flex items-center gap-2">
          <SubscribeDialog className="flex-1" label="Newsletter" />
          <SubmitTrackDialog className="flex-1" />
        </div>
      </div>

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
        {galaxiesLive ? (
          <>
            <Dot />
            <Link className={linkClassName} to="/galaxies">
              Galaxies
            </Link>
          </>
        ) : undefined}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-3 pt-8">
        <SectionHeader>Follow Fluncle</SectionHeader>

        <nav
          aria-label="Fluncle on other platforms"
          className="flex flex-wrap items-center justify-center gap-px"
        >
          {socialLinks.map((social) => (
            <Tooltip key={social.label}>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={social.label}
                    className="text-muted-foreground size-7"
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
                <BrandIcon className="size-4" icon={social.icon} />
              </TooltipTrigger>
              <TooltipContent>{social.label}</TooltipContent>
            </Tooltip>
          ))}
        </nav>

        <SectionHeader className="mt-3">For the nerds</SectionHeader>
        <nav
          aria-label="Developer tools and connections"
          className="flex items-center justify-center gap-3 text-[13px] font-mono"
        >
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

        <HomeStatusPill />
      </div>
    </div>
  );
}
