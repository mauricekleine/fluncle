import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { StoriesEmptyState } from "@/components/stories/stories-states";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { StoriesSkeleton } from "@/components/stories/stories-skeleton";
import { siteUrl } from "@/lib/fluncle-links";
import { listTracks } from "@/lib/server/tracks";

// Stories: the findings with footage, newest first, one full screen at a time.
const storiesPageSize = 48;

const fetchStories = createServerFn({ method: "GET" }).handler(() =>
  listTracks({ hasVideo: true, limit: storiesPageSize }),
);

export const Route = createFileRoute("/stories/")({
  component: StoriesIndexPage,
  head: () => ({
    links: [{ href: `${siteUrl}/stories`, rel: "canonical" }],
    meta: [
      { title: "Fluncle: stories" },
      { content: "The latest findings, one clip at a time.", name: "description" },
      { content: "Fluncle: stories", property: "og:title" },
      { content: "The latest findings, one clip at a time.", property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/stories`, property: "og:url" },
    ],
  }),
  loader: () => fetchStories(),
  pendingComponent: StoriesSkeleton,
});

function StoriesIndexPage() {
  const page = Route.useLoaderData();

  if (page.tracks.length === 0) {
    return <StoriesEmptyState />;
  }

  return <StoriesPlayer tracks={page.tracks} />;
}
