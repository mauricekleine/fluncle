// THE GRAPH-LINK HOVER CARD'S ONE READ.
//
// `GraphLink` names an entity (artist, label, album, galaxy) wherever it is mentioned; hovering
// or focusing one reveals a card previewing it. This resolves that card.
//
// TWO GUARANTEES HOLD IT HONEST, and both come from reusing what the entity's own page uses
// rather than writing a second, parallel truth:
//
//   1. THE LINE IS THE PAGE'S LINE. Not a paraphrase, not a clamped prose excerpt — the same
//      `graphSignatureLine` the page masthead calls, over the same inputs. One function, two
//      readers (lib/graph-prose.ts).
//   2. THE COUNT IS THE PAGE'S COUNT. It drives through the same `getFindingsBy*` reads, which
//      run through the `findings` inner join — so it counts FINDINGS and can never include an
//      uncertified catalogue row. A card that said "4" over a page that says "3" would be a
//      bug with a very long tail; this makes the two the same number by construction.
//
// The per-entity finding lists are bounded by the archive (a label carries single-digit
// findings), and the card is fetched lazily — on card OPEN, once per entity per session,
// shared across every link that names it (see the contract's note on why this is not an N+1).

import { type GraphEntityKind, type GraphPreview, graphSignatureLine } from "../graph-prose";
import { spotifyAlbumImageAtSize } from "../media";
import { getAlbumBySlug } from "./albums";
import { getArtistBySlug } from "./artists";
import { getPublicGalaxyBySlug } from "./galaxies-map";
import { getLabelBySlug } from "./labels";
import { getFindingsByAlbum, getFindingsByArtist, getFindingsByLabel } from "./tracks";
import { type TrackListItem } from "./tracks";

/** Thrown when a slug names no entity of that kind — the router maps it to a 404. */
export class GraphEntityNotFoundError extends Error {}

/** How many covers the card shows. Four fills its row without turning it into a grid. */
const PREVIEW_COVER_CAP = 4;

/** The findings' covers, freshest first, capped — the card's visual proof. */
function coversOf(findings: TrackListItem[]): string[] {
  return findings
    .flatMap((finding) => {
      const cover = spotifyAlbumImageAtSize(finding.albumImageUrl, "small");

      return cover ? [cover] : [];
    })
    .slice(0, PREVIEW_COVER_CAP);
}

/** The earliest `addedAt` across the findings — the date the signature lines open on. */
function firstFoundAt(findings: TrackListItem[]): string | undefined {
  return findings
    .map((finding) => finding.addedAt)
    .filter((addedAt): addedAt is string => Boolean(addedAt))
    .sort()[0];
}

/**
 * Resolve one graph entity's hover-card preview. Throws `GraphEntityNotFoundError` when the
 * slug names no entity of that kind — including EVERY galaxy slug while the browse-by-feel
 * launch gate is closed, which is exactly what `get_galaxy` already answers.
 */
export async function getGraphPreview(kind: GraphEntityKind, slug: string): Promise<GraphPreview> {
  // The galaxy is the one entity whose count is not a list length: the lens read hands back a
  // derived `memberCount` over the whole cluster, and its own page opens on that number (its
  // line takes no first-found date at all). Take its covers off the core-first head.
  if (kind === "galaxy") {
    const { findings, galaxy } = await getPublicGalaxyBySlug(slug, PREVIEW_COVER_CAP, 0).catch(
      () => {
        throw new GraphEntityNotFoundError(`No galaxy with slug "${slug}"`);
      },
    );

    return {
      covers: coversOf(findings),
      findingCount: galaxy.memberCount,
      kind,
      line: graphSignatureLine(kind, galaxy.name, galaxy.memberCount, undefined),
      name: galaxy.name,
      slug: galaxy.slug,
    };
  }

  const entity = await resolveEntity(kind, slug);

  if (!entity) {
    throw new GraphEntityNotFoundError(`No ${kind} with slug "${slug}"`);
  }

  // Coordinate-bearing findings only — the same filter each entity page applies before it
  // counts, so the card's number is the page's number.
  const findings = entity.findings.filter((finding) => finding.logId);

  return {
    covers: coversOf(findings),
    findingCount: findings.length,
    kind,
    line: graphSignatureLine(kind, entity.name, findings.length, firstFoundAt(findings)),
    name: entity.name,
    slug: entity.slug,
  };
}

/** The by-slug read for the three findings-counted entities. */
async function resolveEntity(
  kind: Exclude<GraphEntityKind, "galaxy">,
  slug: string,
): Promise<{ findings: TrackListItem[]; name: string; slug: string } | undefined> {
  if (kind === "artist") {
    const artist = await getArtistBySlug(slug);

    return artist
      ? {
          findings: await getFindingsByArtist(artist.id, artist.name),
          name: artist.name,
          slug: artist.slug,
        }
      : undefined;
  }

  if (kind === "album") {
    const album = await getAlbumBySlug(slug);

    return album
      ? { findings: await getFindingsByAlbum(album.id), name: album.name, slug: album.slug }
      : undefined;
  }

  const label = await getLabelBySlug(slug);

  return label
    ? { findings: await getFindingsByLabel(label.id), name: label.name, slug: label.slug }
    : undefined;
}
