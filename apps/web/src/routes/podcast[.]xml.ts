import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { mixtapeDisplayTitle } from "../lib/mixtapes";
import { mixtapeAudioUrl } from "../lib/media";
import { listMixtapes } from "../lib/server/mixtapes";

const SITE_URL = "https://www.fluncle.com";
const SHOW_IMAGE = `${SITE_URL}/fluncle-cover.png`;
const ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd";

const SHOW_DESCRIPTION =
  "Fluncle's own DJ mixtapes: long drum & bass recordings where he settles a stretch of findings into one continuous dream. Each episode is a checkpoint from the archive, recorded across the Galaxy. fluncle.com is home base.";

async function audioLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });

    if (!res.ok) {
      return null;
    }

    const header = res.headers.get("content-length");
    const length = header ? Number.parseInt(header, 10) : NaN;

    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export const Route = createFileRoute("/podcast.xml")({
  server: {
    handlers: {
      GET: async () => {
        const mixtapes = (await listMixtapes({ limit: 54 })).filter(
          (mixtape) => mixtape.logId && (mixtape.recordedAt || mixtape.addedAt),
        );

        const maybeItems = await Promise.all(
          mixtapes.map(async (mixtape) => {
            const logId = mixtape.logId as string;
            const title = mixtapeDisplayTitle(mixtape.title);
            const note = mixtape.note?.trim() ?? "";
            const link = `${SITE_URL}/log/${encodeURIComponent(logId)}`;
            const audioUrl = mixtapeAudioUrl(logId);
            const length = await audioLength(audioUrl);

            if (length === null) {
              return undefined;
            }

            const pubDate = new Date(
              mixtape.recordedAt ?? (mixtape.addedAt as string),
            ).toUTCString();
            const cover = mixtape.coverImageUrl;

            return `<item>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <guid isPermaLink="false">${escapeXml(logId)}</guid>
  <pubDate>${pubDate}</pubDate>
  <enclosure url="${escapeXml(audioUrl)}" type="audio/mp4" length="${length}"/>
  <itunes:episodeType>full</itunes:episodeType>${
    typeof mixtape.sequenceNumber === "number"
      ? `\n  <itunes:episode>${mixtape.sequenceNumber}</itunes:episode>`
      : ""
  }${
    typeof mixtape.durationMs === "number"
      ? `\n  <itunes:duration>${formatDuration(mixtape.durationMs)}</itunes:duration>`
      : ""
  }${cover ? `\n  <itunes:image href="${escapeXml(cover)}"/>` : ""}
  <itunes:explicit>no</itunes:explicit>${
    note
      ? `\n  <description>${escapeXml(note)}</description>\n  <itunes:summary>${escapeXml(note)}</itunes:summary>`
      : `\n  <description>${escapeXml(title)}</description>`
  }
</item>`;
          }),
        );

        const items = maybeItems.filter((item): item is string => item !== undefined);

        const newest = mixtapes[0];
        const lastBuildDate = newest
          ? new Date(newest.recordedAt ?? (newest.addedAt as string)).toUTCString()
          : new Date().toUTCString();

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="${ITUNES_NS}">
<channel>
  <title>Fluncle's Mixtapes</title>
  <link>${SITE_URL}/mixtapes</link>
  <language>en-us</language>
  <description>${escapeXml(SHOW_DESCRIPTION)}</description>
  <lastBuildDate>${lastBuildDate}</lastBuildDate>
  <image>
    <url>${SHOW_IMAGE}</url>
    <link>${SITE_URL}/mixtapes</link>
    <title>Fluncle's Mixtapes</title>
  </image>
  <itunes:author>Fluncle</itunes:author>
  <itunes:type>episodic</itunes:type>
  <itunes:summary>${escapeXml(SHOW_DESCRIPTION)}</itunes:summary>
  <itunes:explicit>no</itunes:explicit>
  <itunes:image href="${SHOW_IMAGE}"/>
  <itunes:category text="Music"/>
${items.join("\n")}
</channel>
</rss>`;

        return new Response(xml, {
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
