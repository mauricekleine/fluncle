import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  siApplemusic,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTiktok,
  siYoutube,
} from "simple-icons";
import { VideoBehindTheScenes } from "@/components/behind-the-scenes";
import { BrandIcon } from "@/components/brand-icon";
import { firstPaintFootagePoster, LogFootage } from "@/components/log/log-footage";
import { LogObservation } from "@/components/log/log-observation";
import { MixtapeVideoPlayer } from "@/components/mixtape-video-player";
import { SaveFindingButton } from "@/components/save-finding-button";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { SubscribeDialog } from "@/components/subscribe-dialog";
import { Button } from "@fluncle/ui/components/button";
import { siteUrl, spotifyPlaylistUrl } from "@/lib/fluncle-links";
import { formatAlbumDuration, formatDateLong, formatDuration } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { isLogPageParam } from "@/lib/log-page-param";
import { useSocialArrival } from "@/lib/social-referrer";
import { GraphLink } from "@/components/graph-link";
import {
  artistTitleLine,
  definitionalProseSegments,
  definitionalSentences,
  GALAXY_CLAUSE_LEAD,
  GALAXY_CLAUSE_TAIL,
  galaxyClauseLinkText,
  LABEL_CLAUSE_LEAD,
  splitLogId,
} from "@/lib/log-prose";
import {
  breadcrumbsJsonLd,
  logPageUrl,
  mixtapeAlbumJsonLd,
  mixtapeVideoObjectJsonLd,
  musicRecordingJsonLd,
  observationAudioObjectJsonLd,
  videoObjectJsonLd,
} from "@/lib/log-schema";
import { mixtapeSetVideoUrl, albumCoverAtSize, trackMedia } from "@/lib/media";
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
import { FindingsGridList } from "@/components/graph-sections";

export const MEASURED_FAQ_ANCHOR = "how-does-fluncle-measure-bpm-and-key";

type LogPageData =
  | {
      status: "found";

      artistSlugs: Record<string, string>;

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

    if (track.logId !== logId) {
      return { logId: track.logId, status: "moved" };
    }

    const [neighbors, similar, artistSlugs, galaxyReady] = await Promise.all([
      getTrackNeighbors(track),
      getSimilarFindings(track.logId).catch(() => []),
      getArtistSlugMap(track.trackId),
      isGalaxyMapFullyNamed(),
    ]);

    return { ...neighbors, artistSlugs, galaxyReady, similar, status: "found", track };
  });

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

    const ogImageUrl = mixtape.logId
      ? mixtapeCoverUrl(logId, "og")
      : (mixtape.coverImageUrl ?? `${siteUrl}/fluncle-cover.png`);

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

  const galaxy = galaxyReady ? track.galaxy : undefined;
  const description = definitionalSentences({ ...track, logId });
  const imageUrl = albumCoverAtSize(track.albumImageUrl, "large") ?? media.coverUrl;
  const recording = musicRecordingJsonLd({ ...track, artistSlugs, galaxy, logId }, imageUrl);

  const ogVersion = track.updatedAt ? Date.parse(track.updatedAt) : Number.NaN;
  const ogQuery = Number.isFinite(ogVersion) ? `?v=${ogVersion}` : "";
  const ogImage = `${siteUrl}/api/og/${encodeURIComponent(logId)}${ogQuery}`;
  const breadcrumbs = breadcrumbsJsonLd(logId);

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

  const observationSchema = track.observationAudioUrl
    ? observationAudioObjectJsonLd({ ...track, galaxy, logId })
    : undefined;

  const footagePoster = firstPaintFootagePoster(track);

  return {
    links: [
      { href: pageUrl, rel: "canonical" },
      ...(footagePoster
        ? [{ as: "image", fetchPriority: "high" as const, href: footagePoster, rel: "preload" }]
        : []),

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

    scripts: [
      jsonLdScript(recording),
      jsonLdScript(breadcrumbs),
      ...(videoSchema ? [jsonLdScript(videoSchema)] : []),
      ...(observationSchema ? [jsonLdScript(observationSchema)] : []),
    ],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/log/$logId")({
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

  const { notation } = useKeyNotation();

  const arrivedFrom = useSocialArrival();

  if (data.status !== "found") {
    if (data.status === "found-mixtape") {
      return <MixtapeLogPage mixtape={data.mixtape} />;
    }

    return null;
  }

  const { artistSlugs, galaxyReady, newer, older, similar, track } = data;
  const logId = track.logId as string;
  const { sector, tail } = splitLogId(logId);

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

        <VideoBehindTheScenes track={track} />

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
                    <GraphLink kind="artist" slug={slug}>
                      {artist}
                    </GraphLink>
                  ) : (
                    artist
                  )}
                </Fragment>
              );
            })}
          </p>

          <p className="log-definition-prose">
            {proseSegments.map((segment, index) => (
              <Fragment
                key={segment.kind === "text" ? `text-${index}` : `${segment.kind}-${segment.slug}`}
              >
                {index > 0 ? " " : null}
                {segment.kind === "galaxy" ? (
                  <>
                    {GALAXY_CLAUSE_LEAD}
                    <GraphLink kind="galaxy" slug={segment.slug}>
                      {galaxyClauseLinkText(segment.name)}
                    </GraphLink>
                    {GALAXY_CLAUSE_TAIL}
                  </>
                ) : segment.kind === "label" ? (
                  <>
                    {LABEL_CLAUSE_LEAD}
                    <GraphLink kind="label" slug={segment.slug}>
                      {segment.name}
                    </GraphLink>
                    {segment.tail}
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
                  className="log-method-link"
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
                  className="log-method-link"
                  hash={MEASURED_FAQ_ANCHOR}
                  to="/about"
                >
                  Key
                </Link>
              </dt>
              <dd>{formatKey(track.key, notation)}</dd>
            </div>
          ) : undefined}

          {track.album ? (
            <div className="log-field">
              <dt>Album</dt>
              <dd>
                {track.albumSlug ? (
                  <GraphLink kind="album" slug={track.albumSlug}>
                    {track.album}
                  </GraphLink>
                ) : (
                  track.album
                )}
              </dd>
            </div>
          ) : undefined}
          {track.label ? (
            <div className="log-field">
              <dt>Label</dt>
              <dd>
                {track.labelSlug ? (
                  <GraphLink kind="label" slug={track.labelSlug}>
                    {track.label}
                  </GraphLink>
                ) : (
                  track.label
                )}
              </dd>
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
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
            render={<a href={track.spotifyUrl} rel="noreferrer" target="_blank" />}
            size="lg"
          >
            <BrandIcon icon={siSpotify} />
            Listen on Spotify
          </Button>
          {track.appleMusicUrl ? (
            <Button
              nativeButton={false}
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
              render={<a href={track.appleMusicUrl} rel="noreferrer" target="_blank" />}
              size="lg"
              variant="outline"
            >
              <BrandIcon icon={siApplemusic} />
              Listen on Apple Music
            </Button>
          ) : undefined}
          <SaveFindingButton
            track={{
              artists: track.artists,
              coverUrl: track.albumImageUrl,
              href: `/log/${logId}`,
              logId,
              spotifyUrl: track.spotifyUrl,
              title: track.title,
              trackId: track.trackId,
            }}
          />
          {track.tiktokUrl ? (
            <Button
              nativeButton={false}
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
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
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
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
            <span className="log-decode-part">{sector}</span> counts the days from the start of my
            log, May 30, 2026, to the day I found this one.{" "}
            <span className="log-decode-part">{tail}</span> comes from the recording itself, so this
            track keeps the same code forever. Found, not numbered. Stamped once, never changed.{" "}
            <Link to="/about">More on Log IDs and the Galaxy</Link>.
          </p>
        </section>

        {similar.length > 0 ? (
          <section aria-label="Close in sound" className="log-similar" data-discovery="similar">
            <h2>Close in sound</h2>
            <FindingsGridList
              className="log-similar-list"
              coverClassName="log-similar-cover"
              findings={similar}
              lineClassName="log-similar-line"
              priorityFirst={false}
              size="small"
            />
          </section>
        ) : undefined}

        <section
          aria-label="Follow along"
          className={arrivedFrom ? "log-trail log-trail--arrived" : "log-trail"}
        >
          {arrivedFrom ? <p className="log-trail-arrival">Glad you made it over.</p> : null}
          <p className="log-trail-lede">
            Hi, I&rsquo;m Fluncle. I collect drum &amp; bass bangers. Follow the playlist, or join
            the newsletter and I&rsquo;ll send you fresh ones every Friday.
          </p>
          <div className="log-actions">
            <Button
              nativeButton={false}
              render={
                <a
                  aria-label="Fluncle playlist on Spotify"
                  href={spotifyPlaylistUrl}
                  rel="noreferrer"
                  target="_blank"
                />
              }
              size="lg"
              variant="outline"
            >
              <BrandIcon icon={siSpotify} />
              Playlist
            </Button>
            <SubscribeDialog label="Newsletter" />
          </div>
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
          <Link to="/findings">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}

function MixtapeLogPage({ mixtape }: { mixtape: MixtapeDTO }) {
  const logId = mixtape.logId as string;
  const { sector, tail } = splitLogId(logId);

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
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
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
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
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
              // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's children onto this anchor, so it ships with its label.
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
            <span className="log-decode-part">{tail}</span> is its checkpoint number, stamped once
            and never changed. <Link to="/about">More on Log IDs and the Galaxy</Link>.
          </p>
        </section>

        <footer className="log-plate-footer">
          <Link to="/mixtapes">Mixtapes</Link>
          <Link to="/findings">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
