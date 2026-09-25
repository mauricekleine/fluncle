import { decodeTrackCursor, listTracks, toPublicTrackListItem } from "../tracks";
import { apiFault, type Implementer, parseLimit } from "./_shared";

const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

export function storiesHandlers(os: Implementer) {
  const listStoriesHandler = os.list_stories.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const cursor = decodeTrackCursor(input.cursor ?? null);

      const page = await listTracks({ cursor, hasVideo: true, lean: true, limit });

      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { list_stories: listStoriesHandler };
}
