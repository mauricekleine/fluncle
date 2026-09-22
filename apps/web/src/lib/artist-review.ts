// The CLIENT-SAFE half of the artist-review queue: the shapes the `/admin/artists` board renders
// and the pure predicates it folds over them.
//
// It sits here rather than in `lib/server/artists.ts` for the same reason `lib/catalogue.ts` and
// `lib/galaxies.ts` do (docs/client-bundle.md, Rule 1). The board calls `partitionFreshLinks` and
// `artistNeedsLook` in its COMPONENT — client code — and a live client reference into
// `lib/server/artists.ts` pins that module in the browser bundle, which pins everything it
// imports: `getDb` → `lib/server/database-request-scope.ts`, whose module-level
// `new AsyncLocalStorage()` the tree-shaker cannot prove pure. In the client build `node:*`
// resolves to Vite's externalized stub, so that constructor throws during module evaluation and
// the route renders the root error boundary instead of the board. Sorting an array does not need
// a database behind it.
//
// `lib/server/artists.ts` re-exports everything here, so every server caller and its tests keep
// reading these from where they always did.

import { type ArtistSocialPlatform } from "./artist-socials";

export type ArtistSocialStatus = "auto" | "candidate" | "confirmed";
export type ArtistSocialSource = "musicbrainz" | "firecrawl" | "operator";

/** One `artist_socials` row, in the shape the admin surfaces read. */
export type ArtistSocial = {
  id: string;
  artistId: string;
  platform: ArtistSocialPlatform;
  url: string;
  source: ArtistSocialSource;
  status: ArtistSocialStatus;
  /** ISO stamp of when this link was discovered/added — the fresh-links queue's oldest-first anchor. */
  createdAt: string;
  /** ISO stamp of when the operator last acknowledged THIS link, or null when it hasn't been
   *  reviewed yet (a fresh insert, or a machine re-resolve that changed its URL). Null = fresh. */
  reviewedAt: string | null;
};

/** One artist in the review queue, carrying all of its socials for the operator's glance. */
export type ArtistSocialsQueueItem = {
  id: string;
  name: string;
  slug: string;
  spotifyUrl: string | null;
  socials: ArtistSocial[];
};

export type ArtistOverviewItem = ArtistSocialsQueueItem & {
  /** Coordinate-bearing findings featuring this artist (the canonical track_artists join). */
  findingCount: number;
};

/** Whether an artist has any link the operator hasn't reviewed yet — the single needs-a-look
 *  predicate, shared by the overview UI and the /admin attention count. Review now lands on the
 *  LINK (docs/artist-relationship.md): a link is fresh iff its `reviewedAt` is null. */
export function artistNeedsLook(socials: readonly { reviewedAt: string | null }[]): boolean {
  return socials.some((social) => social.reviewedAt === null);
}

/** An artist's still-unreviewed links (`reviewedAt === null`), oldest-first — the fresh-links
 *  section's per-artist group. Shared by the board's fresh-links section so the "what's fresh"
 *  rule lives in one place. */
export function unreviewedSocials<T extends { createdAt: string; reviewedAt: string | null }>(
  socials: readonly T[],
): T[] {
  return socials
    .filter((social) => social.reviewedAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// The two platforms a finding's caption tags today (lib/server/mentions.ts weaves a mention line
// ONLY for `tiktok` + `youtube`, and ONLY from `auto`/`confirmed` handles). So a fresh link on one
// of these — once approved — feeds the caption mention loop the moment a finding's video posts.
// Kept in lockstep with `MentionPlatform` in mentions.ts; these lead the high-priority section.
const MENTION_LOOP_PLATFORMS = new Set<ArtistSocialPlatform>(["tiktok", "youtube"]);

/** One fresh (unreviewed) link paired with the artist it belongs to — a row in the fresh-links queue. */
export type FreshLinkEntry = {
  artist: ArtistOverviewItem;
  social: ArtistSocial;
};

/** The fresh-links review queue split by mention-loop impact (docs/artist-relationship.md §review queue). */
export type FreshLinksPartition = {
  /**
   * Fresh links whose artist has at least one finding — these GATE the caption mention loop, so
   * they lead the board. Mention-loop platforms (tiktok, youtube) sort first, then the rest; then
   * by artist name, then oldest-first.
   */
  highPriority: FreshLinkEntry[];
  /**
   * Every other fresh link (catalogue-only artists, no posting implication yet) — in the queue's
   * prior order: artist name (the loader's order), then oldest-first within an artist.
   */
  everythingElse: FreshLinkEntry[];
};

/** Order a HIGH-PRIORITY fresh link: mention-loop platforms first, then artist name, then oldest. */
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

/**
 * Partition every fresh (unreviewed) artist-social link into the two review sections the board
 * renders. A link is HIGH PRIORITY when its artist has at least one finding (`findingCount > 0`,
 * the canonical coordinate-bearing count that the whole codebase means by "finding"): an approved
 * handle for a findings-bearing artist immediately feeds the caption mention loop
 * (lib/server/mentions.ts tags only `auto`/`confirmed` handles when a finding's video posts), while
 * a catalogue-only artist's link carries no posting implication yet.
 *
 * SERVER-AUTHORED so the split never depends on what a page happens to load: each input item already
 * carries its server-computed `findingCount`, and the board's fetch (`listAllArtistsWithSocials`) is
 * unbounded, so the high-priority section is COMPLETE and leads regardless of row order. Within it,
 * the two mention-loop platforms (tiktok, youtube) sort first — the links that gate a caption today
 * read at the top. `everythingElse` preserves the queue's prior order (the loader is name-sorted and
 * `unreviewedSocials` is oldest-first, so pushing in iteration order yields name-then-oldest, exactly
 * as the section read before the split). The row SET is unchanged — this is a partition + ordering
 * change, not a filter: every link `unreviewedSocials` surfaced still surfaces.
 */
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
