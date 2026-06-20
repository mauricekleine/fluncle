import { createFileRoute } from "@tanstack/react-router";
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
 * The enclosure byte length, read from the R2 object's Content-Length via a
 * HEAD request. Podcast clients want the size; if the HEAD fails (object not
 * uploaded yet, edge error) we fall back to "0", which clients tolerate.
 */
async function audioLength(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const length = res.ok ? res.headers.get("content-length") : null;
    return length ?? "0";
  } catch {
    return "0";
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

        const items = await Promise.all(
          mixtapes.map(async (mixtape) => {
            const logId = mixtape.logId as string;
            const title = mixtapeDisplayTitle(mixtape.title);
            const note = mixtape.note?.trim() ?? "";
            const link = `${SITE_URL}/log/${encodeURIComponent(logId)}`;
            const audioUrl = mixtapeAudioUrl(logId);
            const length = await audioLength(audioUrl);
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
