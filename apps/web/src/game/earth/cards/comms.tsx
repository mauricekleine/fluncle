import { instagramUrl, telegramUrl, youtubeUrl } from "@/lib/fluncle-links";
import { CardShell, GatedBody, LinkBody } from "./_chrome";
import { type CardEntry } from "./_types";

// The Comms region's custom cards — the social channels and gated surfaces
// @fluncle/registry doesn't carry. The newsletter mailbox door reads the
// registry directly via SurfaceCard, so it needs no card here.

function TelegramCard() {
  return (
    <CardShell label="the Telegram channel">
      <LinkBody
        blurb="one banger a day, dropped under the saucer."
        cta={{ href: telegramUrl, label: "open Telegram" }}
        title="The Telegram channel"
      />
    </CardShell>
  );
}

function VideoCard() {
  return (
    <CardShell label="the video channels">
      <LinkBody
        blurb="the findings as video, on YouTube and TikTok."
        cta={{ href: youtubeUrl, label: "open YouTube" }}
        title="Shorts and mixes"
      />
    </CardShell>
  );
}

function InstagramCard() {
  return (
    <CardShell label="Instagram">
      <LinkBody
        blurb="the covers and clips, posted by hand."
        cta={{ href: instagramUrl, label: "open Instagram" }}
        title="Instagram"
      />
    </CardShell>
  );
}

function DiscordCard() {
  return (
    <CardShell label="the crew on Discord">
      <GatedBody
        blurb="Fluncle keeps a presence on Discord. the open server is coming."
        title="The crew on Discord"
      />
    </CardShell>
  );
}

export const cards: CardEntry[] = [
  { Card: TelegramCard, id: "telegram" },
  { Card: VideoCard, id: "video" },
  { Card: InstagramCard, id: "instagram" },
  { Card: DiscordCard, id: "discord" },
];
