import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize } from "@/lib/media";
import { mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import {
  buildLinkResponse,
  buildRichEmbed,
  type OembedResponse,
  parseOembedTarget,
} from "@/lib/oembed";
import { getAlbumBySlug } from "@/lib/server/albums";
import { getPublicArtistBySlug } from "@/lib/server/artists";
import { hasPublicGraphTracks } from "@/lib/server/hub-counts";
import { getLabelBySlug } from "@/lib/server/labels";
import { resolveLogPageTarget } from "@/lib/server/log-resolver";
import { getFindingsByAlbum, getFindingsByArtist, getFindingsByLabel } from "@/lib/server/tracks";

const JSON_HEADERS = {
  "Cache-Control": "public, max-age=3600",
  "Content-Type": "application/json; charset=utf-8",
} as const;

function jsonResponse(payload: OembedResponse): Response {
  return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status,
  });
}

function findingThumbnailUrl(logId: string, updatedAt: string | undefined): string {
  const version = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const query = Number.isFinite(version) ? `?v=${version}` : "";

  return `${siteUrl}/api/og/${encodeURIComponent(logId)}${query}`;
}

function parseDimension(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function resolveOembed(
  target: NonNullable<ReturnType<typeof parseOembedTarget>>,
  maxwidth: number | undefined,
  maxheight: number | undefined,
): Promise<OembedResponse | undefined> {
  if (target.kind === "log") {
    const resolved = await resolveLogPageTarget(target.logId);

    if (!resolved) {
      return undefined;
    }

    if (resolved.kind === "mixtape") {
      const { mixtape } = resolved;
      const logId = mixtape.logId ?? target.logId;

      return buildRichEmbed({
        authorName: "Fluncle",
        logId,
        maxheight,
        maxwidth,
        thumbnailUrl: mixtapeCoverUrl(logId, "og"),
        title: mixtapeDisplayTitle(mixtape.title),
      });
    }

    const { track } = resolved;
    const logId = track.logId ?? target.logId;

    return buildRichEmbed({
      authorName: track.artists.join(", "),
      logId,
      maxheight,
      maxwidth,
      thumbnailUrl: findingThumbnailUrl(logId, track.updatedAt),
      title: artistTitleLine(track),
    });
  }

  if (target.kind === "artist") {
    const artist = await getPublicArtistBySlug(target.slug);

    if (!artist) {
      return undefined;
    }

    const findings = await getFindingsByArtist(artist.id, artist.name);
    const cover = findings[0];

    const thumbnailUrl =
      artist.imageUrl ??
      (cover ? albumCoverAtSize(cover.albumImageUrl, "large") : undefined) ??
      `${siteUrl}/fluncle-cover.png`;

    return buildLinkResponse({
      authorName: artist.name,
      thumbnailUrl,
      title: `${artist.name} · Fluncle`,
    });
  }

  if (target.kind === "label") {
    const label = await getLabelBySlug(target.slug);

    if (!label || !(await hasPublicGraphTracks("labels", label.id))) {
      return undefined;
    }

    const cover = (await getFindingsByLabel(label.id))[0];
    const thumbnailUrl =
      (cover ? albumCoverAtSize(cover.albumImageUrl, "large") : undefined) ??
      label.logoImageUrl ??
      `${siteUrl}/fluncle-cover.png`;

    return buildLinkResponse({
      authorName: label.name,
      thumbnailUrl,
      title: `${label.name} · Fluncle`,
    });
  }

  if (target.kind === "album") {
    const album = await getAlbumBySlug(target.slug);

    if (!album || !(await hasPublicGraphTracks("albums", album.id))) {
      return undefined;
    }

    const cover = (await getFindingsByAlbum(album.id))[0];
    const thumbnailUrl =
      (cover ? albumCoverAtSize(cover.albumImageUrl, "large") : undefined) ??
      `${siteUrl}/fluncle-cover.png`;

    const authorName = cover && cover.artists.length > 0 ? cover.artists.join(", ") : undefined;

    return buildLinkResponse({
      thumbnailUrl,
      title: `${album.name} · Fluncle`,
      ...(authorName ? { authorName } : {}),
    });
  }

  return buildLinkResponse({
    thumbnailUrl: `${siteUrl}/fluncle-cover.png`,
    title: "Fluncle: mixtapes",
  });
}

export const Route = createFileRoute("/oembed")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const format = url.searchParams.get("format");

        if (format !== null && format !== "json") {
          return errorResponse(
            501,
            `Fluncle's oEmbed provider serves JSON only; "${format}" is not implemented.`,
          );
        }

        const rawUrl = url.searchParams.get("url");

        if (!rawUrl) {
          return errorResponse(400, "Missing required `url` query parameter.");
        }

        const target = parseOembedTarget(rawUrl);

        if (!target) {
          return errorResponse(
            404,
            "No Fluncle finding, mixtape, artist, label, or album at that URL.",
          );
        }

        const maxwidth = parseDimension(url.searchParams.get("maxwidth"));
        const maxheight = parseDimension(url.searchParams.get("maxheight"));
        const payload = await resolveOembed(target, maxwidth, maxheight);

        if (!payload) {
          return errorResponse(
            404,
            "No Fluncle finding, mixtape, artist, label, or album at that URL.",
          );
        }

        return jsonResponse(payload);
      },
    },
  },
});
