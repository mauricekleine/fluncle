import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  siBandcamp,
  siBeatport,
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
import { type ChatFinding } from "@/components/chat/finding-card";
import { FindingList } from "@/components/chat/finding-list";
import { type ArtistSocialPlatform } from "@/lib/artist-socials";
import { findingsCount } from "@/lib/format";
import { type KeyNotation } from "@/lib/key-notation";

// THE ARTIST CARD — WHO Fluncle has logged, rendered (ChatDnB Phase 2).
//
// When the chat's get_artist tool resolves an artist, the workbench shows a dossier instead of a
// raw JSON marker: the artist's representative image (their freshest finding's cover, degrading to
// a monogram tile), the name as the loud line, a quiet finding count, their confirmed socials as
// the same brand-mark chips the /artist page wears, a link to the full page, and the artist's
// findings beneath as the real Finding Cards (reusing Phase 1's FindingList). Quiet, dark, and
// restrained — an admin station, not a streaming clone (PRODUCT.md); it mirrors the /artist page's
// visual language so ChatDnB reads like the rest of the archive.

/** The artist shape get_artist emits — every field optional (the tool output rides `dropEmpty`). */
export type ChatArtist = {
  /** The freshest finding's cover, the representative image (no avatar rides on the record). */
  avatarUrl?: string;
  /** The voiced entity bio — a short intro paragraph, present only once one is authored. */
  bio?: string;
  findingCount?: number;
  findings?: ChatFinding[];
  name?: string;
  slug?: string;
  socials?: { platform: string; url: string }[];
  spotifyUrl?: string;
};

// A confirmed/auto social's brand mark, from simple-icons (never a Phosphor glyph for a brand);
// `homepage` is not a brand, so it takes the Phosphor globe (an interface icon) — DESIGN.md
// "Iconography". Mirrors the /artist page's SOCIAL_META (route-local there; the same rule here).
const SOCIAL_META: Record<
  Exclude<ArtistSocialPlatform, "homepage">,
  { path: string; title: string }
> = {
  bandcamp: siBandcamp,
  beatport: siBeatport,
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
  const count = artist.findingCount ?? findings.length;
  const bio = artist.bio;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <ArtistAvatar className="size-[3.25rem] shrink-0" name={name} src={artist.avatarUrl} />
        <div className="min-w-0 flex-1">
          {/* The ratified loud register (.track-title, DESIGN.md §3), same as the sibling Finding
              Card — the entity is the loudest text on the card, never a quiet caption. */}
          <p className="track-title">{name}</p>
          {/* The count doubles as the quiet link to the full page (the graph-card idiom): one
              affordance, its label its purpose. Plain muted text when there is no slug to link. */}
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

      {/* The voiced bio introduces the entity before its findings back it up — a quiet paragraph,
          the same muted body register the archive uses for prose, never a hero block. */}
      {bio ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{bio}</p>
      ) : null}

      {findings.length > 0 ? <FindingList findings={findings} notation={notation} /> : null}
    </div>
  );
}
