import { createServerFn } from "@tanstack/react-start";
import { listTracks } from "@/lib/server/tracks";

// The Stories feed: the findings with footage, newest first. Shared by the
// in-app Stories dialog (fetched on open, so the home payload stays lean).
const storiesPageSize = 48;

export const fetchStories = createServerFn({ method: "GET" }).handler(() =>
  listTracks({ hasVideo: true, limit: storiesPageSize }),
);
