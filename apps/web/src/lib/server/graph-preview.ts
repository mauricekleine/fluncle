import {
  firstFoundAt,
  type GraphEntityKind,
  type GraphPreview,
  graphSignatureLine,
} from "../graph-prose";
import { albumCoverAtSize } from "../media";
import { getAlbumBySlug } from "./albums";
import { getPublicArtistBySlug } from "./artists";
import { getPublicGalaxyBySlug } from "./galaxies-map";
import { hasPublicGraphTracks } from "./hub-counts";
import { getLabelBySlug } from "./labels";
import { getFindingsByAlbum, getFindingsByArtist, getFindingsByLabel } from "./tracks";
import { type TrackListItem } from "./tracks";

export class GraphEntityNotFoundError extends Error {}

const PREVIEW_COVER_CAP = 4;

function coversOf(findings: TrackListItem[], leadCover?: string): string[] {
  const covers = findings.flatMap((finding) => {
    const cover = albumCoverAtSize(finding.albumImageUrl, "small");

    return cover ? [cover] : [];
  });

  const lead = albumCoverAtSize(leadCover, "small");
  const ordered = lead ? [lead, ...covers.filter((cover) => cover !== lead)] : covers;

  return ordered.slice(0, PREVIEW_COVER_CAP);
}

export async function getGraphPreview(kind: GraphEntityKind, slug: string): Promise<GraphPreview> {
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

  const findings = entity.findings.filter((finding) => finding.logId);

  return {
    bio: entity.bio,

    covers: coversOf(findings, entity.leadCover),
    findingCount: findings.length,
    kind,
    line: graphSignatureLine(kind, entity.name, findings.length, firstFoundAt(findings)),
    name: entity.name,
    slug: entity.slug,
  };
}

async function resolveEntity(
  kind: Exclude<GraphEntityKind, "galaxy">,
  slug: string,
): Promise<
  | { bio?: string; findings: TrackListItem[]; leadCover?: string; name: string; slug: string }
  | undefined
> {
  if (kind === "artist") {
    const artist = await getPublicArtistBySlug(slug);

    return artist
      ? {
          bio: artist.bio,
          findings: await getFindingsByArtist(artist.id, artist.name),
          name: artist.name,
          slug: artist.slug,
        }
      : undefined;
  }

  if (kind === "album") {
    const album = await getAlbumBySlug(slug);

    return album && (await hasPublicGraphTracks("albums", album.id))
      ? {
          bio: album.bio,
          findings: await getFindingsByAlbum(album.id),
          name: album.name,
          slug: album.slug,
        }
      : undefined;
  }

  const label = await getLabelBySlug(slug);

  return label && (await hasPublicGraphTracks("labels", label.id))
    ? {
        bio: label.bio,
        findings: await getFindingsByLabel(label.id),
        leadCover: label.logoImageUrl,
        name: label.name,
        slug: label.slug,
      }
    : undefined;
}
