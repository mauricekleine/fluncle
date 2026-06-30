import { createFileRoute } from "@tanstack/react-router";
import { escapeXml } from "../lib/feed-xml";
import { mixtapeDisplayTitle } from "../lib/mixtapes";
import { mixtapeAudioUrl } from "../lib/media";
import { listMixtapes } from "../lib/server/mixtapes";

// A podcast-format RSS 2.0 feed where each published mixtape is one episode.
//
// A mixtape is Fluncle dreaming — a long recording that consolidates many
// findings into one checkpoint. This feed hands those recordings to any podcast
// app (Apple Podcasts, Overcast, …) as enclosures. The audio lives in R2 by the
// same `<log-id>/<name>` convention the rest of the Galaxy uses (see
// lib/media.ts): the episode audio is `<logId>/mixtape.m4a` on found.fluncle.com.
// Future mixtapes must have that object uploaded for their episode to play.

const SITE_URL = "https://www.fluncle.com";
const SHOW_IMAGE = `${SITE_URL}/fluncle-cover.png`;
const ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd";

// In Fluncle's voice: the uncle who's been logging what he finds out there,
// now and then settling those findings into one long dream you can play end to
// end. Machine-facing channel copy stays honestly plain; the warmth rides the
// per-episode notes.
const SHOW_DESCRIPTION =
  "Fluncle's own DJ mixtapes — long drum & bass recordings where he settles a stretch of findings into one continuous dream. Each episode is a checkpoint from the archive, recorded across the Galaxy. fluncle.com is home base.";

/**
 * The enclosure byte length in bytes, read from the R2 object's Content-Length
 * via a HEAD request. Returns null when there is no real audio behind the URL —
 * a failed HEAD (object not uploaded yet, edge error), a non-2xx response, or a
 * zero/absent length — so the caller can drop that episode rather than emit a
 * broken enclosure a podcast app can't play.
 */
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

/** Format a duration in milliseconds as the itunes:duration HH:MM:SS form. */
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

            // No real audio behind the enclosure (object not uploaded yet, or a
            // zero-length object): drop the episode rather than hand a podcast
            // app a broken file it can't play.
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

        // Keep only the episodes that have real audio (audioLength returned a
        // size). An empty feed is still valid — better than broken enclosures.
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
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      },
    },
  },
});
