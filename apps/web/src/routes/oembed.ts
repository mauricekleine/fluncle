import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";
import { artistTitleLine } from "@/lib/log-prose";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import {
  buildLinkResponse,
  buildRichEmbed,
  type OembedResponse,
  parseOembedTarget,
} from "@/lib/oembed";
import { getArtistBySlug } from "@/lib/server/artists";
import { resolveMusicTarget } from "@/lib/server/log-resolver";
import { getFindingsByArtist } from "@/lib/server/tracks";

// The oEmbed 1.0 provider endpoint (https://oembed.com). A consumer that found a
// page's `<link rel="alternate" type="application/json+oembed" href="…/oembed?url=…">`
// fetches this and gets a provider envelope it can unfurl — a `rich` iframe card for
// a finding/mixtape, a `link` for an artist page or the mixtapes index.
//
// This is a root-level document emitter at the spec's fixed path `/oembed` (the
// discovery link and every consumer hardcode it), taking an external query-string
// contract (`url`, `format`, `maxwidth`, `maxheight`) and emitting either JSON or a
// 501 on an unsupported format — a discovery surface exactly like the feeds
// (/rss.xml) and the sitemap, none of which are oRPC operations. It lives outside
// /api/v1, so the orpc-coverage net (which enumerates only that tree) never sees it,
// same as the feeds; no carve-out entry is needed.

const JSON_HEADERS = {
  // A finding/mixtape/artist page is publish-then-immutable; let a consumer cache
  // the envelope for an hour (parity with the other discovery documents).
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

// The OG card the /log page already points og:image at, versioned so a re-enriched
// finding re-renders (parity with log.$logId.tsx).
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
    const resolved = await resolveMusicTarget(target.logId);

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
    const artist = await getArtistBySlug(target.slug);

    if (!artist) {
      return undefined;
    }

    const findings = await getFindingsByArtist(artist.id, artist.name);
    const cover = findings[0];
    const thumbnailUrl =
      (cover ? spotifyAlbumImageAtSize(cover.albumImageUrl, "large") : undefined) ??
      `${siteUrl}/fluncle-cover.png`;

    return buildLinkResponse({
      authorName: artist.name,
      thumbnailUrl,
      title: `${artist.name} · Fluncle's Findings`,
    });
  }

  // The mixtapes index — a collection page, no per-item card.
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

        // The spec: a provider that can't return the requested format returns 501.
        // We serve JSON only (XML is legacy); absent format defaults to JSON.
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
          return errorResponse(404, "No Fluncle finding, mixtape, or artist at that URL.");
        }

        const maxwidth = parseDimension(url.searchParams.get("maxwidth"));
        const maxheight = parseDimension(url.searchParams.get("maxheight"));
        const payload = await resolveOembed(target, maxwidth, maxheight);

        if (!payload) {
          return errorResponse(404, "No Fluncle finding, mixtape, or artist at that URL.");
        }

        return jsonResponse(payload);
      },
    },
  },
});
