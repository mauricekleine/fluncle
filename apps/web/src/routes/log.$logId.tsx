import {
  CaretLeftIcon,
  CaretRightIcon,
  SpotifyLogoIcon,
  TiktokLogoIcon,
} from "@phosphor-icons/react";
import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { LogFootage } from "@/components/log/log-footage";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong, formatDuration, formatIsoDuration } from "@/lib/format";
import { isLogId } from "@/lib/log-id";
import { artistTitleLine, definitionalSentences, splitLogId } from "@/lib/log-prose";
import { trackMedia } from "@/lib/media";
import {
  getTrackByIdOrLogId,
  getTrackNeighbors,
  type TrackListItem,
  type TrackNeighbor,
} from "@/lib/server/tracks";

// The standalone log page: one finding's permanent, readable, indexable record
// (the archival-plate register). The cinematic full-bleed register is the
// Stories dialog over the home feed — same data, different presentation
// (docs/web-overhaul-rfc.md §3). This page is what a crawler, an AI agent, or
// a shared link sees at the coordinate.

const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;

type LogPageData =
  | { status: "found"; newer?: TrackNeighbor; older?: TrackNeighbor; track: TrackListItem }
  | { status: "missing" }
  | { status: "moved"; logId: string };

const fetchLogPage = createServerFn({ method: "GET" })
  .inputValidator((data: { logId: string }) => data)
  .handler(async ({ data: { logId } }): Promise<LogPageData> => {
    const track = await getTrackByIdOrLogId(logId);

    // No Log ID → no log page: a finding without a coordinate isn't a log
    // entry yet (the feed shows its bare #NN until it's backfilled).
    if (!track?.logId) {
      return { status: "missing" };
    }

    // Normalize ONCE, here: a trackId deep link 301s to the coordinate.
    if (track.logId !== logId) {
      return { logId: track.logId, status: "moved" };
    }

    const neighbors = await getTrackNeighbors(track);

    return { ...neighbors, status: "found", track };
  });

// Typed helper outside the route options: an inline head() that reads
// loaderData makes the route's own type inference circular (same pattern as
// the old stories route).
function logHead(loaderData: LogPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { track } = loaderData;
  const logId = track.logId as string;
  const media = trackMedia(logId);
  const pageUrl = `${siteUrl}/log/${encodeURIComponent(logId)}`;
  const title = `${logId} · ${artistTitleLine(track)} · Fluncle`;
  const description = definitionalSentences({ ...track, logId });
  const imageUrl = track.albumImageUrl ?? media.coverUrl;
  const recording = {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    byArtist: track.artists.map((artist) => ({ "@type": "MusicGroup", name: artist })),
    datePublished: track.addedAt.slice(0, 10),
    description,
    duration: formatIsoDuration(track.durationMs),
    genre: "Drum and Bass",
    // The Log ID in BOTH forms as identifiers (not alternateName): the bare
    // coordinate and the fluncle:// URI are the retrieval tokens.
    identifier: [
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: logId },
      { "@type": "PropertyValue", propertyID: "fluncle-log-id", value: `fluncle://${logId}` },
    ],
    image: imageUrl,
    ...(track.isrc ? { isrcCode: track.isrc } : {}),
    ...(track.album ? { inAlbum: { "@type": "MusicAlbum", name: track.album } } : {}),
    name: track.title,
    sameAs: [track.spotifyUrl, ...(track.tiktokUrl ? [track.tiktokUrl] : [])],
    url: pageUrl,
  };
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", item: `${siteUrl}/`, name: "Fluncle", position: 1 },
      { "@type": "ListItem", item: `${siteUrl}/log`, name: "The log", position: 2 },
      { "@type": "ListItem", name: logId, position: 3 },
    ],
  };

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: track.videoUrl ? "video.other" : "music.song", property: "og:type" },
      ...(track.videoUrl
        ? [
            { content: media.videoUrl, property: "og:video" },
            { content: "video/mp4", property: "og:video:type" },
          ]
        : []),
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],
    scripts: [
      { children: JSON.stringify(recording), type: "application/ld+json" },
      { children: JSON.stringify(breadcrumbs), type: "application/ld+json" },
    ],
  };
}

export const Route = createFileRoute("/log/$logId")({
  // Shape-guard BEFORE the loader: anything that is neither a coordinate nor a
  // Spotify track id (the legacy deep-link form) is a 404, no DB roundtrip.
  beforeLoad: ({ params }) => {
    if (!isLogId(params.logId) && !SPOTIFY_TRACK_ID.test(params.logId)) {
      throw notFound();
    }
  },
  component: LogPage,
  head: ({ loaderData }: { loaderData?: LogPageData }) => logHead(loaderData),
  loader: async ({ params }): Promise<LogPageData> => {
    const data = await fetchLogPage({ data: { logId: params.logId } });

    if (data.status === "missing") {
      throw notFound();
    }

    if (data.status === "moved") {
      throw redirect({
        params: { logId: data.logId },
        statusCode: 301,
        to: "/log/$logId",
      });
    }

    return data;
  },
  notFoundComponent: StoryNotFoundState,
});

function LogPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { newer, older, track } = data;
  const logId = track.logId as string;
  const { sector, tail } = splitLogId(logId);

  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate">{logId}</h1>
          <p className="log-coordinate-uri">fluncle://{logId}</p>
        </header>

        <LogFootage track={track} />

        <section aria-label="The finding" className="log-definition">
          <h2 className="log-track-title">{track.title}</h2>
          <p className="log-track-artist">{track.artists.join(", ")}</p>
          <p className="log-definition-prose">{definitionalSentences({ ...track, logId })}</p>
        </section>

        {track.note ? (
          <section aria-label="Log note" className="log-note">
            <p>{track.note}</p>
          </section>
        ) : undefined}

        <dl className="log-fields">
          <div className="log-field">
            <dt>Found</dt>
            <dd>
              <time dateTime={track.addedAt}>{formatDateLong(track.addedAt)}</time>
            </dd>
          </div>
          <div className="log-field">
            <dt>Length</dt>
            <dd>{formatDuration(track.durationMs)}</dd>
          </div>
          {track.bpm ? (
            <div className="log-field">
              <dt>BPM</dt>
              <dd>{Math.round(track.bpm)}</dd>
            </div>
          ) : undefined}
          {track.key ? (
            <div className="log-field">
              <dt>Key</dt>
              <dd>{track.key}</dd>
            </div>
          ) : undefined}
          {track.album ? (
            <div className="log-field">
              <dt>Album</dt>
              <dd>{track.album}</dd>
            </div>
          ) : undefined}
          {track.label ? (
            <div className="log-field">
              <dt>Label</dt>
              <dd>{track.label}</dd>
            </div>
          ) : undefined}
          {track.isrc ? (
            <div className="log-field">
              <dt>ISRC</dt>
              <dd>{track.isrc}</dd>
            </div>
          ) : undefined}
        </dl>

        {track.tags && track.tags.length > 0 ? (
          <ul aria-label="Tags" className="log-tags">
            {track.tags.map((tag) => (
              <li key={tag}>
                <Badge className="track-chip" variant="outline">
                  {tag}
                </Badge>
              </li>
            ))}
          </ul>
        ) : undefined}

        <div className="log-actions">
          <Button
            nativeButton={false}
            render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
            size="lg"
          >
            <SpotifyLogoIcon aria-hidden="true" weight="fill" />
            Open on Spotify
          </Button>
          {track.tiktokUrl ? (
            <Button
              nativeButton={false}
              render={<a href={track.tiktokUrl} rel="noreferrer" target="_blank" />}
              size="lg"
              variant="outline"
            >
              <TiktokLogoIcon aria-hidden="true" weight="fill" />
              Watch on TikTok
            </Button>
          ) : undefined}
        </div>

        <section aria-label="How to read a Log ID" className="log-decode">
          <h2>How to read the coordinate</h2>
          <p>
            <span className="log-decode-part">{sector}</span> is the sector: the days between the
            epoch, 2026-05-30, and the day this one was found.{" "}
            <span className="log-decode-part">{tail}</span> is the tail: a stable signature of the
            recording itself, so a coordinate reads found, not numbered. Minted once, never changed.{" "}
            <Link to="/about">More on Log IDs and the Galaxy</Link>.
          </p>
        </section>

        <nav aria-label="Adjacent findings" className="log-neighbors">
          {newer ? (
            <Link className="log-neighbor" params={{ logId: newer.logId }} to="/log/$logId">
              <CaretLeftIcon aria-hidden="true" weight="bold" />
              <span>
                <span className="log-neighbor-label">Newer</span>
                <span className="log-neighbor-line">{artistTitleLine(newer)}</span>
              </span>
            </Link>
          ) : (
            <span />
          )}
          {older ? (
            <Link
              className="log-neighbor log-neighbor-older"
              params={{ logId: older.logId }}
              to="/log/$logId"
            >
              <span>
                <span className="log-neighbor-label">Older</span>
                <span className="log-neighbor-line">{artistTitleLine(older)}</span>
              </span>
              <CaretRightIcon aria-hidden="true" weight="bold" />
            </Link>
          ) : (
            <span />
          )}
        </nav>

        <footer className="log-plate-footer">
          <Link to="/log">The full log</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
