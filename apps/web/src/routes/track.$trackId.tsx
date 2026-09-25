import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FrontDoorSection } from "@/components/front-door/section";
import { TrackNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import {
  SonicNeighbours,
  TrackArtistCredits,
  TrackFacts,
  TrackListenBand,
} from "@/components/track-destination";
import { artistTitleLine } from "@/lib/log-prose";
import { archiveTrackJsonLd, trackBreadcrumbsJsonLd } from "@/lib/log-schema";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize } from "@/lib/media";
import { siteUrl } from "@/lib/fluncle-links";
import { sameAsUrls, trackPageUrl } from "@/lib/track-page";
import { type TrackPageData } from "./-track-page-data";

const fetchTrack = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data: { trackId } }): Promise<TrackPageData> => {
    const { resolveTrackPageData } = await import("./-track-page-data");

    return resolveTrackPageData(trackId);
  });

const META_DESCRIPTION_BUDGET = 155;

function trackHead(loaderData: TrackPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { neighbours, track } = loaderData;
  const line = artistTitleLine({
    artists: track.artists.map((artist) => artist.name),
    title: track.title,
  });
  const pageUrl = trackPageUrl(track.trackId);

  const title = `${line} · Fluncle`;

  const year = track.releaseDate?.slice(0, 4);
  const releaseClause = [
    year === undefined ? undefined : `a ${year} drum & bass release`,
    track.label === undefined ? undefined : `on ${track.label.name}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const tempoClause =
    track.bpm && track.key
      ? `${Math.round(track.bpm)} BPM in ${track.key}`
      : track.bpm
        ? `${Math.round(track.bpm)} BPM`
        : track.key
          ? `in ${track.key}`
          : undefined;
  const facts = [
    releaseClause ? `${line}, ${releaseClause}.` : `${line}, a drum & bass track.`,
    tempoClause === undefined ? undefined : `${tempoClause}.`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

  const hasListen = track.previewable || track.listen.length > 0;
  const hasNeighbours = neighbours.length > 0;
  const tail =
    hasListen && hasNeighbours
      ? " Where to hear it, and the tracks closest to it in sound."
      : hasListen
        ? " Where to hear it."
        : hasNeighbours
          ? " The tracks closest to it in sound."
          : "";
  const withTail = `${facts}${tail}`;
  const description = withTail.length <= META_DESCRIPTION_BUDGET ? withTail : facts;
  const imageUrl = albumCoverAtSize(track.albumImageUrl, "large") ?? `${siteUrl}/fluncle-cover.png`;

  const leadImageUrl = albumCoverAtSize(track.albumImageUrl, "medium");

  return {
    links: [
      { href: pageUrl, rel: "canonical" },
      ...(leadImageUrl
        ? [{ as: "image", fetchPriority: "high" as const, href: leadImageUrl, rel: "preload" }]
        : []),
    ],
    meta: [
      { title },
      { content: description, name: "description" },

      ...(track.indexable ? [] : [{ content: "noindex, follow", name: "robots" }]),
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "music.song", property: "og:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],
    scripts: [
      jsonLdScript(
        archiveTrackJsonLd({
          album: track.album ? { name: track.album.name, slug: track.album.slug } : undefined,
          artistSlugs: Object.fromEntries(
            track.artists.flatMap((artist) =>
              artist.slug ? [[artist.name.trim().toLowerCase(), artist.slug]] : [],
            ),
          ),
          artists: track.artists.map((artist) => artist.name),
          bpm: track.bpm,
          discogsReleaseUrl: track.discogsReleaseUrl,
          durationMs: track.durationMs,
          imageUrl: albumCoverAtSize(track.albumImageUrl, "large"),
          isrc: track.isrc,
          key: track.key,
          label: track.label ? { name: track.label.name, slug: track.label.slug } : undefined,

          listenUrls: sameAsUrls(track.listen),
          mbRecordingId: track.mbRecordingId,
          releaseDate: track.releaseDate,
          title: track.title,
          trackId: track.trackId,
        }),
      ),
      jsonLdScript(trackBreadcrumbsJsonLd(line)),
    ],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/track/$trackId")({
  loader: async ({ params }): Promise<TrackPageData> => {
    const data = await fetchTrack({ data: { trackId: params.trackId } });

    if (data.status === "redirect") {
      if (data.logId) {
        throw redirect({ params: { logId: data.logId }, statusCode: 301, to: "/log/$logId" });
      }

      if (data.trackId) {
        throw redirect({
          params: { trackId: data.trackId },
          statusCode: 301,
          to: "/track/$trackId",
        });
      }
    }

    if (data.status !== "found") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: TrackPageData }) => trackHead(loaderData),
  component: TrackPage,
  notFoundComponent: TrackNotFoundState,
});

function TrackPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    return null;
  }

  const { neighbours, track } = data;

  return (
    <main className="log-plate-stage">
      <article className="log-plate track-plate">
        <header className="log-masthead track-masthead">
          <TrackArtwork
            alt=""
            className="track-masthead-cover"
            priority
            src={albumCoverAtSize(track.albumImageUrl, "medium")}
          />
          <div className="track-masthead-titling">
            <h1 className="log-coordinate log-index-title artist-name">{track.title}</h1>
            <TrackArtistCredits track={track} />
          </div>
        </header>

        <TrackFacts track={track} />

        <TrackListenBand track={track} />

        {neighbours.length > 0 ? (
          <FrontDoorSection id="track-neighbours" title="Close in sound">
            <SonicNeighbours neighbours={neighbours} />
          </FrontDoorSection>
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/tracks">All tracks</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}
