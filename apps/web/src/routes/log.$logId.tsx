import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siMixcloud, siSoundcloud, siSpotify, siTiktok, siYoutube } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { LogFootage } from "@/components/log/log-footage";
import { SaveFindingButton } from "@/components/save-finding-button";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { Button } from "@/components/ui/button";
import { siteUrl } from "@/lib/fluncle-links";
import { formatAlbumDuration, formatDateLong, formatDuration } from "@/lib/format";
import { isLogPageParam } from "@/lib/log-page-param";
import {
  artistTitleLine,
  definitionalProse,
  definitionalSentences,
  splitLogId,
} from "@/lib/log-prose";
import {
  breadcrumbsJsonLd,
  logPageUrl,
  mixtapeAlbumJsonLd,
  musicRecordingJsonLd,
} from "@/lib/log-schema";
import { trackMedia } from "@/lib/media";
import { hasExternalUrl, type MixtapeDTO } from "@/lib/mixtapes";
import { resolveLogPageTarget } from "@/lib/server/log-resolver";
import {
  getRelatedTracks,
  getTrackNeighbors,
  type TrackListItem,
  type TrackNeighbor,
} from "@/lib/server/tracks";

// The standalone log page: one finding's permanent, readable, indexable record
// (the archival-plate register). The cinematic full-bleed register is the
// Stories dialog over the home feed — same data, different presentation
// (docs/track-lifecycle.md). This page is what a crawler, an AI agent, or
// a shared link sees at the coordinate.

type LogPageData =
  | {
      status: "found";
      newer?: TrackNeighbor;
      older?: TrackNeighbor;
      related: TrackNeighbor[];
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

    const [neighbors, related] = await Promise.all([
      getTrackNeighbors(track),
      getRelatedTracks(track),
    ]);

    return { ...neighbors, related, status: "found", track };
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

    return {
      links: [{ href: pageUrl, rel: "canonical" }],
      meta: [
        { title },
        { content: description, name: "description" },
        { content: title, property: "og:title" },
        { content: description, property: "og:description" },
        { content: mixtape.coverImageUrl ?? `${siteUrl}/fluncle-cover.png`, property: "og:image" },
        { content: pageUrl, property: "og:url" },
        { content: "music.album", property: "og:type" },
      ],
      scripts: [
        { children: JSON.stringify(mixtapeAlbumJsonLd(mixtape)), type: "application/ld+json" },
        { children: JSON.stringify(breadcrumbsJsonLd(logId)), type: "application/ld+json" },
      ],
    };
  }

  const { track } = loaderData;
  const logId = track.logId as string;
  const media = trackMedia(logId);
  const pageUrl = logPageUrl(logId);
  const title = `${logId} · ${artistTitleLine(track)} · Fluncle`;
  const description = definitionalSentences({ ...track, logId });
  const imageUrl = track.albumImageUrl ?? media.coverUrl;
  const recording = musicRecordingJsonLd({ ...track, logId }, imageUrl);
  // The social card: the per-finding OG image (the poster frame + treatment),
  // versioned by `updatedAt` so a re-enriched finding re-renders (the /api/og
  // response is immutable + edge-cached). The JSON-LD `image` above stays the
  // square album cover — the right shape for a MusicRecording.
  const ogVersion = track.updatedAt ? Date.parse(track.updatedAt) : Number.NaN;
  const ogQuery = Number.isFinite(ogVersion) ? `?v=${ogVersion}` : "";
  const ogImage = `${siteUrl}/api/og/${encodeURIComponent(logId)}${ogQuery}`;
  const breadcrumbs = breadcrumbsJsonLd(logId);

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
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
      { children: JSON.stringify(recording), type: "application/ld+json" },
      { children: JSON.stringify(breadcrumbs), type: "application/ld+json" },
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

  const { newer, older, related, track } = data;
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
          <p className="log-definition-prose">{definitionalProse({ ...track, logId })}</p>
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

        {track.galaxy && related.length > 0 ? (
          <section aria-label={`More in the ${track.galaxy.name} galaxy`} className="log-related">
            <h2>More in the {track.galaxy.name} galaxy</h2>
            <ul className="log-related-list">
              {related.map((finding) => (
                <li key={finding.logId}>
                  <Link params={{ logId: finding.logId }} to="/log/$logId">
                    <span className="log-related-coordinate">{finding.logId}</span>
                    <span className="log-related-line">{artistTitleLine(finding)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : undefined}

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
  const hasAudioLink = hasExternalUrl(mixtape.externalUrls);

  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">Mixtape No. {mixtape.sequenceNumber ?? 1}</p>
          <h1 className="log-coordinate">{logId}</h1>
          <p className="log-coordinate-uri">fluncle://{logId}</p>
        </header>

        <section aria-label="The checkpoint" className="log-definition">
          <h2 className="log-track-title">{mixtape.title}</h2>
          <p className="log-track-artist">Fluncle</p>
          <p className="log-definition-prose">
            {mixtape.note ?? "A checkpoint in the archive. The longer dream made from findings."}
          </p>
        </section>

        <section aria-label="Mixtape audio" className="empty-scanlines log-mixtape-embed">
          {hasAudioLink
            ? "Audio recovered. Pick a deck below."
            : "Audio lands when this checkpoint publishes."}
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
            <dt>Findings</dt>
            <dd>{mixtape.memberCount}</dd>
          </div>
        </dl>

        <section aria-label="Mixtape tracklist" className="log-related">
          <h2>Tracklist</h2>
          <ol className="log-related-list">
            {mixtape.members.map((member, index) =>
              member.logId ? (
                <li key={member.trackId}>
                  <Link params={{ logId: member.logId }} to="/log/$logId">
                    <span className="log-related-coordinate">
                      {String(index + 1).padStart(2, "0")} · {member.logId}
                    </span>
                    <span className="log-related-line">{artistTitleLine(member)}</span>
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
