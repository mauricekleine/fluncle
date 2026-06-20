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
import { SubmitTrackDialog } from "@/components/submit-track-dialog";
import { SubscribeDialog } from "@/components/subscribe-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  galaxyUrl,
  instagramUrl,
  mixcloudUrl,
  repoUrl,
  soundcloudUrl,
  spotifyPlaylistUrl,
  telegramUrl,
  tiktokUrl,
  twitchUrl,
  xUrl,
  youtubeUrl,
} from "@/lib/fluncle-links";

// The cover column's link hub: the gold Galaxy CTA + quiet companions at the top,
// then a spacer (mt-auto) that sinks the tertiary links to the BOTTOM of the
// column. Rendered as a direct flex child of the <aside> (which stretches to the
// grid row height on desktop), so flex-1 + mt-auto actually push the links down.
// The Galaxy CTA is the ONE gold primary (One Sun); everything else is quiet.

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
// Docs, Join the Crew — and the developer row: CLI, GIT, MCP, SSH).
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

export function HomeLinkHub() {
  return (
    <div className="mt-3 flex flex-1 flex-col">
      {/* The actions: the gold Galaxy CTA (One Sun), Playlist + Newsletter, and
          the contribute button. */}
      <div className="flex flex-col gap-2.5">
        <Button className="w-full" nativeButton={false} render={<a href={galaxyUrl} />} size="lg">
          <img
            alt=""
            aria-hidden="true"
            className="size-5 [image-rendering:pixelated]"
            src="/galaxy/earth.png"
          />
          Enter Fluncle's Galaxy
        </Button>
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            nativeButton={false}
            render={<a href={spotifyPlaylistUrl} rel="noreferrer" target="_blank" />}
            size="lg"
            variant="outline"
          >
            <BrandIcon icon={siSpotify} />
            Playlist
          </Button>
          <SubscribeDialog className="flex-1" label="Newsletter" />
        </div>
        <SubmitTrackDialog className="w-full" />

        <div className="mt-1 flex items-center gap-3">
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
          <span className="text-sm font-semibold tracking-wide text-muted-foreground">
            Follow Fluncle
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
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
                    render={<a href={social.href} rel="noreferrer" target="_blank" />}
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
      </div>

      {/* The quiet links sink to the bottom of the column (mt-auto): site links,
          the developer/connection links as plain text, then the social strip. */}
      <div className="mt-auto flex flex-col items-center gap-3 pt-8">
        {/* About · Logs · Docs stay an inline row; Docs is the new /docs entry.
            "Join the Crew" gets its own quiet button below: the four-item inline
            row wraps "Join the Crew" onto a second line in the narrow cover
            column (240–280px desktop aside), so it sits on its own instead. */}
        <nav
          aria-label="More from Fluncle"
          className="flex items-center justify-center gap-3 text-sm"
        >
          <Link className={linkClassName} to="/about">
            About
          </Link>
          <Dot />
          <Link className={linkClassName} to="/log">
            Logs
          </Link>
          <Dot />
          <Link className={linkClassName} to="/docs">
            Docs
          </Link>
        </nav>
        <Button
          className="w-full"
          nativeButton={false}
          render={<Link to="/account" />}
          size="sm"
          variant="outline"
        >
          Join the Crew
        </Button>

        <nav
          aria-label="Developer tools and connections"
          className="flex items-center justify-center gap-3 text-[13px] font-mono border-t pt-4"
        >
          {/* CLI/MCP/SSH are docs pages served by the /docs/$ catch-all, so
              they navigate via the splat param (exact URLs /docs/cli etc.). */}
          <Link className={linkClassName} params={{ _splat: "cli" }} to="/docs/$">
            CLI
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
      </div>
    </div>
  );
}
