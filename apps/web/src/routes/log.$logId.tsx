import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siMixcloud, siSoundcloud, siSpotify, siTiktok, siYoutube } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { LogFootage } from "@/components/log/log-footage";
import { LogObservation } from "@/components/log/log-observation";
import { MixtapeVideoPlayer } from "@/components/mixtape-video-player";
import { SaveFindingButton } from "@/components/save-finding-button";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { Button } from "@fluncle/ui/components/button";
import { siteUrl } from "@/lib/fluncle-links";
import { formatAlbumDuration, formatDateLong, formatDuration } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { isLogPageParam } from "@/lib/log-page-param";
import {
  artistTitleLine,
  definitionalProseSegments,
  definitionalSentences,
  GALAXY_CLAUSE_LEAD,
  GALAXY_CLAUSE_TAIL,
  galaxyClauseLinkText,
  splitLogId,
} from "@/lib/log-prose";
import {
  breadcrumbsJsonLd,
  logPageUrl,
  mixtapeAlbumJsonLd,
  mixtapeVideoObjectJsonLd,
  musicRecordingJsonLd,
  videoObjectJsonLd,
} from "@/lib/log-schema";
import { mixtapeSetVideoUrl, spotifyAlbumImageAtSize, trackMedia } from "@/lib/media";
import { type MixtapeDTO, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { resolveLogPageTarget } from "@/lib/server/log-resolver";
import {
  getSimilarFindings,
  getTrackNeighbors,
  type TrackListItem,
  type TrackNeighbor,
} from "@/lib/server/tracks";
import { isGalaxyMapFullyNamed } from "@/lib/server/galaxies-map";
import { getArtistSlugMap } from "@/lib/server/artists";
import { fold } from "@/lib/server/track-match";
import { TrackArtwork } from "@/components/track-artwork";

// The standalone log page: one finding's permanent, readable, indexable record
// (the archival-plate register). The cinematic full-bleed register is the
// Stories dialog over the home feed — same data, different presentation.
// This page is what a crawler, an AI agent, or
// a shared link sees at the coordinate.

// The measured BPM/key values link to the "how Fluncle measures" methodology on
// /about — every finding's tempo + key is first-party DSP over the captured full
// song, graded by the operator's Rekordbox (the measurement moat). This slug is
// the anchor of that FAQ entry; about.tsx derives the same slug from the question,
// and a test in -about-schema.test.ts pins the two together (exported for it).
export const MEASURED_FAQ_ANCHOR = "how-does-fluncle-measure-bpm-and-key";

type LogPageData =
  | {
      status: "found";
      // Name → slug for the finding's resolved artists — the artist-name links +
      // the `@id` stamped on the byArtist JSON-LD node (Unit 3).
      artistSlugs: Record<string, string>;
      // The public launch gate (browse-by-feel RFC): the galaxy clause + its
      // `/galaxies/<slug>` link render ONLY once the whole map is named. A partial or
      // unnamed map keeps the clause dark (its pre-launch state), even for a placed
      // finding whose own galaxy happens to be named.
      galaxyReady: boolean;
      newer?: TrackNeighbor;
      older?: TrackNeighbor;
      similar: TrackListItem[];
      track: TrackListItem;
    }
  | {
      mixtape: MixtapeDTO;
      status: "found-mixtape";
    }
  | { status: "missing" }
  | { status: "moved"; logId: string };

const fetchLogPage = createServerFn({ method: "GET" })
  .validator((data: { logId: string }) => data)
  .handler(async ({ data: { logId } }): Promise<LogPageData> => {
    const target = await resolveLogPageTarget(logId);

    // No Log ID → no log page: a finding without a coordinate isn't a log
    // entry yet (the feed shows its bare #NN until it's backfilled).
    if (!target) {
      return { status: "missing" };
    }

    if (target.kind === "mixtape") {
      return { mixtape: target.mixtape, status: "found-mixtape" };
    }

    const { track } = target;

    if (!track.logId) {
      return { status: "missing" };
    }

    // Normalize ONCE, here: a trackId deep link 301s to the coordinate.
    if (track.logId !== logId) {
      return { logId: track.logId, status: "moved" };
    }

    const [neighbors, similar, artistSlugs, galaxyReady] = await Promise.all([
      getTrackNeighbors(track),
      getSimilarFindings(track.logId),
      getArtistSlugMap(track.trackId),
      isGalaxyMapFullyNamed(),
    ]);

    return { ...neighbors, artistSlugs, galaxyReady, similar, status: "found", track };
  });

// Typed helper outside the route options: an inline head() that reads
// loaderData makes the route's own type inference circular (same pattern as
// the old stories route).
function logHead(loaderData: LogPageData | undefined) {
  if (loaderData?.status !== "found" && loaderData?.status !== "found-mixtape") {
    return {};
  }

  if (loaderData.status === "found-mixtape") {
    const { mixtape } = loaderData;
    const logId = mixtape.logId as string;
    const pageUrl = logPageUrl(logId);
    const title = `${logId} · ${mixtape.title} · Fluncle`;
    const description = mixtape.note ?? "A checkpoint in Fluncle's Findings.";
    // The per-mixtape 1200×630 link-preview, rendered on the fly by the cover
    // endpoint (Satori). Falls back to an operator-set cover, then the site
    // default — matching the finding branch's graceful degrade.
    const ogImageUrl = mixtape.logId
      ? mixtapeCoverUrl(logId, "og")
      : (mixtape.coverImageUrl ?? `${siteUrl}/fluncle-cover.png`);
    // The set video's VideoObject + og:video — parity with the finding video, so
    // the mixtape's set recording is crawled/indexed like the rendered clips.
    // Emitted only once the set video is uploaded (setVideoAt); the video file is
    // the bare R2 set.mp4 (range-streamed, not a Media Transformation).
    const setVideoSchema = mixtape.setVideoAt
      ? mixtapeVideoObjectJsonLd(mixtape, {
          contentUrl: mixtapeSetVideoUrl(logId),
          thumbnailUrl: mixtapeCoverUrl(logId, "card"),
          uploadDate: mixtape.setVideoAt,
        })
      : undefined;

    return {
      links: [
        { href: pageUrl, rel: "canonical" },
        // oEmbed discovery: a consumer that pastes this mixtape's link fetches the
        // provider (a `rich` card iframing /embed/<logId>). See routes/oembed.ts.
        {
          href: `${siteUrl}/oembed?url=${encodeURIComponent(pageUrl)}&format=json`,
          rel: "alternate",
          title: `${mixtape.title} · Fluncle`,
          type: "application/json+oembed",
        },
      ],
      meta: [
        { title },
        { content: description, name: "description" },
        { content: title, property: "og:title" },
        { content: description, property: "og:description" },
        { content: ogImageUrl, property: "og:image" },
        { content: "1200", property: "og:image:width" },
        { content: "630", property: "og:image:height" },
        { content: "image/png", property: "og:image:type" },
        { content: pageUrl, property: "og:url" },
        { content: "music.album", property: "og:type" },
        ...(mixtape.setVideoAt
          ? [
              { content: mixtapeSetVideoUrl(logId), property: "og:video" },
              { content: "video/mp4", property: "og:video:type" },
            ]
          : []),
        { content: "summary_large_image", name: "twitter:card" },
        { content: title, name: "twitter:title" },
        { content: description, name: "twitter:description" },
        { content: ogImageUrl, name: "twitter:image" },
      ],
      // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
      // payload before it reaches the inline <script>'s `children` (rendered raw
      // via dangerouslySetInnerHTML), so a `</script>` in mixtape.title / .note /
      // member titles can't break out of the <script> (stored-XSS sink,
      // security review).
      scripts: [
        jsonLdScript(mixtapeAlbumJsonLd(mixtape)),
        jsonLdScript(breadcrumbsJsonLd(logId)),
        ...(setVideoSchema ? [jsonLdScript(setVideoSchema)] : []),
      ],
    };
  }

  const { artistSlugs, galaxyReady, track } = loaderData;
  const logId = track.logId as string;
  const media = trackMedia(logId);
  const pageUrl = logPageUrl(logId);
  const title = `${logId} · ${artistTitleLine(track)} · Fluncle`;
  // The galaxy clause rides the prose + JSON-LD only behind the launch gate (browse-by-
  // feel RFC): `galaxy` is the real `{ name, slug }` when the whole map is named, else
  // undefined (dark, the pre-launch state). definitionalSentences ignores it; the richer
  // definitionalProse the JSON-LD mirrors weaves it in.
  const galaxy = galaxyReady ? track.galaxy : undefined;
  const description = definitionalSentences({ ...track, logId });
  const imageUrl = spotifyAlbumImageAtSize(track.albumImageUrl, "large") ?? media.coverUrl;
  const recording = musicRecordingJsonLd({ ...track, artistSlugs, galaxy, logId }, imageUrl);
  // The social card: the per-finding OG image (the poster frame + treatment),
  // versioned by `updatedAt` so a re-enriched finding re-renders (the /api/og
  // response is CDN-cached long but not immutable — OG_CACHE_CONTROL in
  // lib/server/satori-render.ts). The JSON-LD `image` above stays the
  // square album cover — the right shape for a MusicRecording.
  const ogVersion = track.updatedAt ? Date.parse(track.updatedAt) : Number.NaN;
  const ogQuery = Number.isFinite(ogVersion) ? `?v=${ogVersion}` : "";
  const ogImage = `${siteUrl}/api/og/${encodeURIComponent(logId)}${ogQuery}`;
  const breadcrumbs = breadcrumbsJsonLd(logId);
  // The VideoObject — the richer crawl signal on top of og:video, emitted only
  // when the finding has a rendered video. uploadDate is the finding's freshest
  // real timestamp (a fresh square crop counts as the upload moment).
  const videoSchema = track.videoUrl
    ? videoObjectJsonLd(
        { ...track, galaxy, logId },
        {
          contentUrl: media.videoUrl,
          thumbnailUrl: imageUrl,
          uploadDate: track.videoSquaredAt ?? track.updatedAt ?? track.addedAt,
        },
      )
    : undefined;

  return {
    links: [
      { href: pageUrl, rel: "canonical" },
      // oEmbed discovery: a consumer that pastes this finding's link fetches the
      // provider (a `rich` card iframing /embed/<logId>). See routes/oembed.ts.
      {
        href: `${siteUrl}/oembed?url=${encodeURIComponent(pageUrl)}&format=json`,
        rel: "alternate",
        title: `${artistTitleLine(track)} · Fluncle`,
        type: "application/json+oembed",
      },
    ],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: ogImage, property: "og:image" },
      { content: "1200", property: "og:image:width" },
      { content: "630", property: "og:image:height" },
      { content: "image/png", property: "og:image:type" },
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
      { content: ogImage, name: "twitter:image" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw
    // via dangerouslySetInnerHTML), so a `</script>` in the (Spotify-sourced)
    // title/artist/album or the operator `note` (woven into definitionalProse,
    // the JSON-LD description) can't break out of the <script> (stored-XSS sink,
    // security review).
    scripts: [
      jsonLdScript(recording),
      jsonLdScript(breadcrumbs),
      ...(videoSchema ? [jsonLdScript(videoSchema)] : []),
    ],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/log/$logId")({
  // Shape-guard BEFORE the loader: anything that is neither a coordinate nor a
  // Spotify track id (the legacy deep-link form) is a 404, no DB roundtrip.
  beforeLoad: ({ params }) => {
    if (!isLogPageParam(params.logId)) {
      throw notFound();
    }
  },
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
  head: ({ loaderData }: { loaderData?: LogPageData }) => logHead(loaderData),
  component: LogPage,
  notFoundComponent: StoryNotFoundState,
});

function LogPage() {
  const data = Route.useLoaderData();

  if (data.status !== "found") {
    if (data.status === "found-mixtape") {
      return <MixtapeLogPage mixtape={data.mixtape} />;
    }

    return null;
  }

  const { artistSlugs, galaxyReady, newer, older, similar, track } = data;
  const logId = track.logId as string;
  const { sector, tail } = splitLogId(logId);
  // The galaxy clause links into the lens only behind the launch gate (browse-by-feel
  // RFC): the real `{ name, slug }` when the whole map is named, else undefined (dark).
  const galaxy = galaxyReady ? track.galaxy : undefined;
  const proseSegments = definitionalProseSegments({ ...track, galaxy, logId });

  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate">{logId}</h1>
          <p className="log-coordinate-uri">fluncle://{logId}</p>
        </header>

        <LogFootage track={track} />

        {track.observationAudioUrl ? (
          <LogObservation
            audioUrl={track.observationAudioUrl}
            durationMs={track.observationDurationMs}
          />
        ) : undefined}

        <section aria-label="The finding" className="log-definition">
          <h2 className="log-track-title">{track.title}</h2>
          <p className="log-track-artist">
            {track.artists.map((artist, index) => {
              const slug = artistSlugs[fold(artist)];

              return (
                <Fragment key={artist}>
                  {index > 0 ? ", " : null}
                  {slug ? (
                    <Link className="log-artist-link" params={{ slug }} to="/artist/$slug">
                      {artist}
                    </Link>
                  ) : (
                    artist
                  )}
                </Fragment>
              );
            })}
          </p>
          {/*
            The definitional prose, rendered from ordered segments so the galaxy clause
            links its name to `/galaxies/<slug>` (browse-by-feel RFC) while the JSON-LD
            description reads the same text plain (log-schema's `definitionalProse`, the
            mirror). Segments join with a single space, matching that string.
          */}
          <p className="log-definition-prose">
            {proseSegments.map((segment, index) => (
              <Fragment
                key={segment.kind === "galaxy" ? `galaxy-${segment.slug}` : `text-${index}`}
              >
                {index > 0 ? " " : null}
                {segment.kind === "galaxy" ? (
                  <>
                    {GALAXY_CLAUSE_LEAD}
                    <Link
                      className="log-galaxy-link"
                      params={{ slug: segment.slug }}
                      to="/galaxies/$slug"
                    >
                      {galaxyClauseLinkText(segment.name)}
                    </Link>
                    {GALAXY_CLAUSE_TAIL}
                  </>
                ) : (
                  segment.text
                )}
              </Fragment>
            ))}
          </p>
        </section>

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
              <dt>
                <Link
                  aria-label="How Fluncle measures BPM"
                  className="log-galaxy-link"
                  hash={MEASURED_FAQ_ANCHOR}
                  to="/about"
                >
                  BPM
                </Link>
              </dt>
              <dd>{Math.round(track.bpm)}</dd>
            </div>
          ) : undefined}
          {track.key ? (
            <div className="log-field">
              <dt>
                <Link
                  aria-label="How Fluncle measures key"
                  className="log-galaxy-link"
                  hash={MEASURED_FAQ_ANCHOR}
                  to="/about"
                >
                  Key
                </Link>
              </dt>
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

        <div className="log-actions">
          <Button
            nativeButton={false}
            render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
            size="lg"
          >
            <BrandIcon icon={siSpotify} />
            Listen on Spotify
          </Button>
          <SaveFindingButton logId={logId} trackId={track.trackId} />
          {track.tiktokUrl ? (
            <Button
              nativeButton={false}
              render={<a href={track.tiktokUrl} rel="noreferrer" target="_blank" />}
              size="lg"
              variant="outline"
            >
              <BrandIcon icon={siTiktok} />
              Watch on TikTok
            </Button>
          ) : undefined}
          {track.youtubeUrl ? (
            <Button
              nativeButton={false}
              render={<a href={track.youtubeUrl} rel="noreferrer" target="_blank" />}
              size="lg"
              variant="outline"
            >
              <BrandIcon icon={siYoutube} />
              Watch on YouTube
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

        {similar.length > 0 ? (
          <section aria-label="Close in sound" className="log-similar">
            <h2>Close in sound</h2>
            <ul className="log-similar-list">
              {similar.map((finding) =>
                finding.logId ? (
                  <li key={finding.trackId}>
                    <Link params={{ logId: finding.logId }} to="/log/$logId">
                      <TrackArtwork
                        alt=""
                        className="log-similar-cover"
                        src={spotifyAlbumImageAtSize(finding.albumImageUrl, "small")}
                      />
                      <span className="log-similar-line">{artistTitleLine(finding)}</span>
                    </Link>
                  </li>
                ) : null,
              )}
            </ul>
          </section>
        ) : undefined}

        {/*
          The old "More in the {galaxy} galaxy" related row is removed (browse-by-feel
          RFC, Slice 4): its members duplicated "Close in sound" above, and the way into
          the galaxy now rides the linked prose clause. Register differentiation stays
          clean — "Close in sound" = these specific tracks; the prose clause = the region.
        */}
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

function MixtapeLogPage({ mixtape }: { mixtape: MixtapeDTO }) {
  const logId = mixtape.logId as string;
  const { sector, tail } = splitLogId(logId);
  // Drop the " | <coordinate>" suffix (the coordinate is the h1 right above); the
  // full canonical title still rides into <title>, og:title, and the JSON-LD.
  // Same helper across the feed row + /mixtapes index, so the title never drifts.
  const displayTitle = mixtapeDisplayTitle(mixtape.title);

  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        {mixtape.setVideoAt ? undefined : (
          <img
            alt={mixtape.title}
            className="log-mixtape-cover"
            height={640}
            src={mixtapeCoverUrl(logId, "card")}
            width={640}
          />
        )}

        <header className="log-masthead">
          <p className="log-nameplate">Mixtape No. {mixtape.sequenceNumber ?? 1}</p>
          <h1 className="log-coordinate">{logId}</h1>
          <p className="log-coordinate-uri">fluncle://{logId}</p>
        </header>

        {mixtape.setVideoAt ? <MixtapeVideoPlayer logId={logId} title={displayTitle} /> : undefined}

        <section aria-label="The checkpoint" className="log-definition">
          <h2 className="log-track-title">{displayTitle}</h2>
          <p className="log-track-artist">Fluncle</p>
          <p className="log-definition-prose">
            {mixtape.note ??
              "A checkpoint in the archive: I mixed these findings into one long dream."}
          </p>
        </section>

        <dl className="log-fields">
          {mixtape.recordedAt ? (
            <div className="log-field">
              <dt>Recorded</dt>
              <dd>
                <time dateTime={mixtape.recordedAt}>{formatDateLong(mixtape.recordedAt)}</time>
              </dd>
            </div>
          ) : undefined}
          {mixtape.durationMs ? (
            <div className="log-field">
              <dt>Runtime</dt>
              <dd>{formatAlbumDuration(mixtape.durationMs)}</dd>
            </div>
          ) : undefined}
          <div className="log-field">
            <dt>Bangers</dt>
            <dd>{mixtape.memberCount}</dd>
          </div>
        </dl>

        <section aria-label="Mixtape tracklist" className="log-related">
          <h2>Tracklist</h2>
          <ol className="log-related-list log-tracklist">
            {mixtape.members.map((member, index) =>
              member.logId ? (
                <li key={member.trackId}>
                  <Link params={{ logId: member.logId }} to="/log/$logId">
                    <span className="log-related-coordinate">
                      {String(index + 1).padStart(2, "0")} · {member.logId}
                    </span>
                    <span className="log-related-line">{artistTitleLine(member)}</span>
                    {member.startMs !== undefined ? (
                      <span className="log-mixtape-cue">{formatDuration(member.startMs)}</span>
                    ) : undefined}
                  </Link>
                </li>
              ) : null,
            )}
          </ol>
        </section>

        <div className="log-actions">
          {mixtape.externalUrls.mixcloud ? (
            <Button
              nativeButton={false}
              render={<a href={mixtape.externalUrls.mixcloud} rel="noreferrer" target="_blank" />}
              size="lg"
            >
              <BrandIcon icon={siMixcloud} />
              Listen on Mixcloud
            </Button>
          ) : undefined}
          {mixtape.externalUrls.youtube ? (
            <Button
              nativeButton={false}
              render={<a href={mixtape.externalUrls.youtube} rel="noreferrer" target="_blank" />}
              size="lg"
              variant="outline"
            >
              <BrandIcon icon={siYoutube} />
              Watch on YouTube
            </Button>
          ) : undefined}
          {mixtape.externalUrls.soundcloud ? (
            <Button
              nativeButton={false}
              render={<a href={mixtape.externalUrls.soundcloud} rel="noreferrer" target="_blank" />}
              size="lg"
              variant="outline"
            >
              <BrandIcon icon={siSoundcloud} />
              Listen on SoundCloud
            </Button>
          ) : undefined}
        </div>

        <section aria-label="How to read a Log ID" className="log-decode">
          <h2>How to read the coordinate</h2>
          <p>
            <span className="log-decode-part">{sector}</span> is the sector: the days between the
            epoch, 2026-05-30, and the day this set was recorded.{" "}
            <span className="log-decode-part">F</span> marks a mixtape.{" "}
            <span className="log-decode-part">{tail}</span> is its checkpoint number, minted once
            and never changed. <Link to="/about">More on Log IDs and the Galaxy</Link>.
          </p>
        </section>

        <footer className="log-plate-footer">
          <Link to="/mixtapes">Mixtapes</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
