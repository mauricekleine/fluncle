import { createServerFn } from "@tanstack/react-start";
import { listTracks } from "@/lib/server/tracks";

const storiesPageSize = 48;

export const fetchStories = createServerFn({ method: "GET" }).handler(() =>
  listTracks({ hasVideo: true, lean: true, limit: storiesPageSize }),
);
