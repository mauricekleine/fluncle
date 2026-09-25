import { type ArtistSocialPlatform } from "./artist-socials";

export type ArtistSocialStatus = "auto" | "candidate" | "confirmed";
export type ArtistSocialSource = "musicbrainz" | "firecrawl" | "operator";

export type ArtistSocial = {
  id: string;
  artistId: string;
  platform: ArtistSocialPlatform;
  url: string;
  source: ArtistSocialSource;
  status: ArtistSocialStatus;

  createdAt: string;

  reviewedAt: string | null;
};

export type ArtistSocialsQueueItem = {
  id: string;
  name: string;
  slug: string;
  spotifyUrl: string | null;
  socials: ArtistSocial[];
};

export type ArtistOverviewItem = ArtistSocialsQueueItem & {
  findingCount: number;
};

export function artistNeedsLook(socials: readonly { reviewedAt: string | null }[]): boolean {
  return socials.some((social) => social.reviewedAt === null);
}

export function unreviewedSocials<T extends { createdAt: string; reviewedAt: string | null }>(
  socials: readonly T[],
): T[] {
  return socials
    .filter((social) => social.reviewedAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const MENTION_LOOP_PLATFORMS = new Set<ArtistSocialPlatform>(["tiktok", "youtube"]);

export type FreshLinkEntry = {
  artist: ArtistOverviewItem;
  social: ArtistSocial;
};

export type FreshLinksPartition = {
  highPriority: FreshLinkEntry[];

  everythingElse: FreshLinkEntry[];
};

function compareHighPriorityLink(left: FreshLinkEntry, right: FreshLinkEntry): number {
  const leftMention = MENTION_LOOP_PLATFORMS.has(left.social.platform) ? 0 : 1;
  const rightMention = MENTION_LOOP_PLATFORMS.has(right.social.platform) ? 0 : 1;

  if (leftMention !== rightMention) {
    return leftMention - rightMention;
  }

  const byName = left.artist.name.localeCompare(right.artist.name);

  if (byName !== 0) {
    return byName;
  }

  return left.social.createdAt.localeCompare(right.social.createdAt);
}

export function partitionFreshLinks(artists: readonly ArtistOverviewItem[]): FreshLinksPartition {
  const highPriority: FreshLinkEntry[] = [];
  const everythingElse: FreshLinkEntry[] = [];

  for (const artist of artists) {
    const fresh = unreviewedSocials(artist.socials);

    if (fresh.length === 0) {
      continue;
    }

    const bucket = artist.findingCount > 0 ? highPriority : everythingElse;

    for (const social of fresh) {
      bucket.push({ artist, social });
    }
  }

  highPriority.sort(compareHighPriorityLink);

  return { everythingElse, highPriority };
}
