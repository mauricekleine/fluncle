import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { StoriesSkeleton } from "@/components/stories/stories-skeleton";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { trackMedia } from "@/lib/media";
import { getTrackByIdOrLogId, listTracks, type TrackListItem } from "@/lib/server/tracks";

// A shareable story: the same player, opened at one finding's coordinate,
// with per-story OG tags rendered on the server for link previews.
const storiesPageSize = 48;

type StoryPageData = { logId: string; tracks: TrackListItem[] };

const fetchStory = createServerFn({ method: "GET" })
  .inputValidator((data: { logId: string }) => data)
  .handler(async ({ data: { logId } }): Promise<StoryPageData> => {
    const page = await listTracks({ hasVideo: true, limit: storiesPageSize });
    const tracks = [...page.tracks];

    if (tracks.some((track) => track.logId === logId)) {
      return { logId, tracks };
    }

    // A straggler beyond the first page (or a direct trackId link): resolve
    // it individually and append so the deep link still plays, normalizing
    // the requested id to the finding's canonical Log ID.
    const track = await getTrackByIdOrLogId(logId);

    if (!track?.videoUrl || !track.logId) {
      throw notFound();
    }

    if (!tracks.some((candidate) => candidate.logId === track.logId)) {
      tracks.push(track);
    }

    return { logId: track.logId, tracks };
  });

// Typed helper outside the route options: an inline head() body that reads
// loaderData makes the route's own type inference circular (loaderData
// collapses to undefined), so the callback stays trivial and the work lives
// here.
function storyHead(loaderData: StoryPageData | undefined) {
  const track = loaderData?.tracks.find((candidate) => candidate.logId === loaderData.logId);

  if (!track?.logId) {
    return {};
  }

  const media = trackMedia(track.logId);
  const title = `${track.artists.join(", ")} — ${track.title} · Fluncle`;
  const description = track.note ?? "A banger from another dimension.";
  const storyUrl = `${siteUrl}/stories/${encodeURIComponent(track.logId)}`;
  // Album art for the link preview: it exists for every finding, where the R2
  // cover.jpg only exists for bundles rendered after the convention landed.
  const imageUrl = track.albumImageUrl ?? media.coverUrl;

  return {
    links: [{ href: storyUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: storyUrl, property: "og:url" },
      { content: "video.other", property: "og:type" },
      { content: media.videoUrl, property: "og:video" },
      { content: "video/mp4", property: "og:video:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],
  };
}

export const Route = createFileRoute("/stories/$logId")({
  component: StoryPage,
  // The explicit param type matters: letting head() infer loaderData from the
  // route makes the route's own type inference circular.
  head: ({ loaderData }: { loaderData?: StoryPageData }) => storyHead(loaderData),
  loader: ({ params }): Promise<StoryPageData> => fetchStory({ data: { logId: params.logId } }),
  notFoundComponent: StoryNotFoundState,
  pendingComponent: StoriesSkeleton,
});

function StoryPage() {
  const { logId, tracks } = Route.useLoaderData();

  return <StoriesPlayer initialLogId={logId} tracks={tracks} />;
}
