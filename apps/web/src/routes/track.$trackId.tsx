import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { FrontDoorSection } from "@/components/front-door/section";
import { StoryNotFoundState } from "@/components/stories/stories-states";
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
import { trackPageUrl } from "@/lib/track-page";
import { type TrackPageData } from "./-track-page-data";

// `/track/<trackId>` — THE ARCHIVE TRACK DESTINATION.
//
// Fluncle holds far more recordings than he has certified. A certified one is a FINDING and lives
// at `/log/<coordinate>`; that URL, that identifier and that page are untouched here, and a
// `/track/<id>` that resolves to one is a permanent 301 home to it. What this route adds is a
// destination for everything else: the rows the crawler and the freshness tap put in the archive,
// which until now were quiet lines on an entity page whose only way out was a streaming service.
//
// The address is the row's PRIMARY KEY, and `lib/track-page.ts` carries the four reasons in full.
// The short version: it is the only identifier on the row that exists for every track, never moves
// when metadata is corrected, and does not change the day an ISRC backfill lands.
//
// A CATALOGUE page in the Three Areas (VOICE.md): reference register, no nameplate, no first
// person. It says what the recording is, plainly, and never introduces or names the tier it
// belongs to — that tier has no public name (docs/album-entity.md), and its distinction is carried
// here the way it is carried everywhere else, by placement and light.
//
// The bands take the FRONT DOOR's section grammar (`components/front-door/section.tsx`): a
// heading, at most one line of intro, at most one link out, then the content. Every band is
// conditional and an empty one renders nothing at all.
//
// The resolver is reached by a DYNAMIC import inside the handler, and its type by `import type`,
// so nothing in this module statically references `lib/server/**` — the client build removes a
// handler body wholesale, which takes the `getDb` → `@libsql/client` → `drizzle-orm` chain out of
// the eager entry chunk every page pays for (docs/client-bundle.md rule 1).
const fetchTrack = createServerFn({ method: "GET" })
  .validator((data: { trackId: string }) => data)
  .handler(async ({ data: { trackId } }): Promise<TrackPageData> => {
    const { resolveTrackPageData } = await import("./-track-page-data");

    return resolveTrackPageData(trackId);
  });

function trackHead(loaderData: TrackPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { track } = loaderData;
  const line = artistTitleLine({
    artists: track.artists.map((artist) => artist.name),
    title: track.title,
  });
  const pageUrl = trackPageUrl(track.trackId);
  // Honestly-plain third-person for the machine-facing strings (VOICE.md's Narrator rule): the
  // page is DESCRIBED here, never spoken, and no faked warmth is injected.
  const title = `${line} · Fluncle`;
  // The description is built ONLY from facts this row actually carries, in the order a reader
  // needs them, and it never claims a certification: no Found date, no coordinate, nothing that
  // says Fluncle stands behind the recording. It also never names the tier, so "catalogue" cannot
  // leak into a SERP snippet.
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
  const description = [
    releaseClause ? `${line}, ${releaseClause}.` : `${line}, a drum & bass track.`,
    tempoClause ? `${tempoClause}.` : undefined,
    "In Fluncle's archive, with where to hear it and what sits close to it in sound.",
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const imageUrl = albumCoverAtSize(track.albumImageUrl, "large") ?? `${siteUrl}/fluncle-cover.png`;
  // THE LEAD IMAGE — the cover in the masthead, this page's LCP candidate, preloaded at the exact
  // rung the masthead asks for so it is a cache hit rather than a second fetch (the /album and
  // /artist precedent).
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
      // THE EVIDENCE GATE, and it is the DATABASE's verdict rather than a second rule written
      // here: `indexable` is `TRACK_PAGE_INDEXABLE_WHERE` evaluated as a column of the same select
      // that loaded this row, and the sitemap puts that identical expression in its `where`. A
      // low-evidence page still serves 200 and stays fully crawlable and citable (`follow`); it is
      // simply not submitted for indexing, and it is not in the sitemap either — the two cannot
      // disagree, because there is only one expression.
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
          listenUrls: track.listen.map((destination) => destination.href),
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

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/track/$trackId")({
  loader: async ({ params }): Promise<TrackPageData> => {
    const data = await fetchTrack({ data: { trackId: params.trackId } });

    // THE TWO PERMANENT REDIRECTS. A certified track's destination is its coordinate and always
    // was, so `/track/<id>` for one is a 301 to `/log/<logId>` — this route never mints a second
    // URL for a finding, and `/log` is untouched by its existence. A stamped duplicate goes to the
    // principal the operator ruled is the real row; the twin's own id keeps resolving, to the page
    // that exists.
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
  notFoundComponent: StoryNotFoundState,
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
          {/* Cover-led, like every other detail page in the archive. The eclipse fallback stands in
              when the record carries no art, so a missing or failed cover degrades to the mark
              rather than a broken-image glyph (components/track-artwork.tsx). */}
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

        {/* "Close in sound" — the way on. Rendered only when the scan came back with something, so
            an un-embedded track, an empty corpus, and a dark sonar all read as no band at all. */}
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
