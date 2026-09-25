import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  siBandcamp,
  siBeatport,
  siBluesky,
  siFacebook,
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import { ArtistAvatar } from "@/components/artist-avatar";
import { BrandIcon } from "@/components/brand-icon";
import { type ChatCatalogueTrack, CatalogueList } from "@/components/chat/catalogue-card";
import { type ChatFinding } from "@/components/chat/finding-card";
import { FindingList } from "@/components/chat/finding-list";
import { type ArtistSocialPlatform } from "@/lib/artist-socials";
import { findingsCount } from "@/lib/format";
import { type KeyNotation } from "@/lib/key-notation";

export type ChatArtist = {
  avatarUrl?: string;

  bio?: string;

  catalogue?: ChatCatalogueTrack[];
  findingCount?: number;
  findings?: ChatFinding[];
  name?: string;
  slug?: string;
  socials?: { platform: string; url: string }[];
  spotifyUrl?: string;
};

const SOCIAL_META: Record<
  Exclude<ArtistSocialPlatform, "homepage">,
  { path: string; title: string }
> = {
  bandcamp: siBandcamp,
  beatport: siBeatport,
  bluesky: siBluesky,
  facebook: siFacebook,
  instagram: siInstagram,
  mixcloud: siMixcloud,
  soundcloud: siSoundcloud,
  spotify: siSpotify,
  tiktok: siTiktok,
  twitch: siTwitch,
  twitter: siX,
  youtube: siYoutube,
};

const SOCIAL_LABEL: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  beatport: "Beatport",
  bluesky: "Bluesky",
  facebook: "Facebook",
  homepage: "Website",
  instagram: "Instagram",
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  tiktok: "TikTok",
  twitch: "Twitch",
  twitter: "X",
  youtube: "YouTube",
};

function isKnownPlatform(platform: string): platform is ArtistSocialPlatform {
  return platform in SOCIAL_LABEL;
}

function SocialLink({ platform, url }: { platform: string; url: string }) {
  if (!isKnownPlatform(platform)) {
    return null;
  }

  const label = SOCIAL_LABEL[platform];

  return (
    <a className="artist-social" href={url} rel="noreferrer" target="_blank" title={label}>
      {platform === "homepage" ? (
        <GlobeSimpleIcon aria-hidden="true" weight="bold" />
      ) : (
        <BrandIcon icon={SOCIAL_META[platform]} />
      )}
      <span>{label}</span>
    </a>
  );
}

export function ArtistCard({ artist, notation }: { artist: ChatArtist; notation: KeyNotation }) {
  const name = artist.name ?? "";
  const slug = artist.slug;
  const socials = artist.socials ?? [];
  const findings = artist.findings ?? [];
  const catalogue = artist.catalogue ?? [];
  const count = artist.findingCount ?? findings.length;
  const bio = artist.bio;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <ArtistAvatar className="size-[3.25rem] shrink-0" name={name} src={artist.avatarUrl} />
        <div className="min-w-0 flex-1">
          <p className="track-title">{name}</p>

          {slug && count > 0 ? (
            <Link
              aria-label={`Open the artist page for ${name}`}
              className="mt-0.5 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              params={{ slug }}
              to="/artist/$slug"
            >
              {findingsCount(count)}
            </Link>
          ) : count > 0 ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{findingsCount(count)}</p>
          ) : null}
        </div>
      </div>

      {socials.length > 0 ? (
        <nav aria-label={`Follow ${name}`} className="artist-socials !mt-0">
          {socials.map((social) => (
            <SocialLink key={social.platform} platform={social.platform} url={social.url} />
          ))}
        </nav>
      ) : null}

      {bio ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{bio}</p>
      ) : null}

      {findings.length > 0 ? <FindingList findings={findings} notation={notation} /> : null}

      {catalogue.length > 0 ? <CatalogueList catalogue={catalogue} /> : null}
    </div>
  );
}
