import { publicTrackWhere } from "../../db/public-track-visibility";
import { catalogueTrackPublicWhere, LONG_FORM_MS } from "../catalogue-eligibility";
import { getDb, typedRows } from "./db";
import { searchSonar, type SonarMatch, type SonarSearchRequest } from "./sonar";

export const SONAR_PUBLIC_CATALOGUE_TOP_K_CEILING = 1000;

type HiddenIdsReader = (ids: readonly string[]) => Promise<Set<string>>;

function hiddenIdsWhere(hiddenWhere: string): HiddenIdsReader {
  return async (ids) => {
    if (ids.length === 0) {
      return new Set();
    }

    const db = await getDb();
    const result = await db.execute({
      args: [...ids],
      sql: `select tracks.track_id as hidden_track_id from tracks
            where tracks.track_id in (${ids.map(() => "?").join(", ")})
              and not ${hiddenWhere}`,
    });

    return new Set(
      typedRows<{ hidden_track_id?: unknown }>(result.rows).flatMap((row) =>
        typeof row.hidden_track_id === "string" ? [row.hidden_track_id] : [],
      ),
    );
  };
}

const hiddenCatalogueIds = hiddenIdsWhere(catalogueTrackPublicWhere("tracks"));

const hiddenTrackIds = hiddenIdsWhere(publicTrackWhere("tracks"));

async function searchSonarBackfilled(
  request: SonarSearchRequest,
  readHiddenIds: HiddenIdsReader,
): Promise<SonarMatch[] | null> {
  const wanted = request.topK;
  let topK = wanted;

  while (true) {
    const matches = await searchSonar({ ...request, topK });

    if (matches === null) {
      return null;
    }

    const hidden = await readHiddenIds(matches.map((match) => match.id));
    const visible = hidden.size === 0 ? matches : matches.filter((match) => !hidden.has(match.id));

    if (
      visible.length >= wanted ||
      matches.length < topK ||
      topK >= SONAR_PUBLIC_CATALOGUE_TOP_K_CEILING
    ) {
      return visible.slice(0, wanted);
    }

    topK = Math.min(topK + hidden.size * 2, SONAR_PUBLIC_CATALOGUE_TOP_K_CEILING);
  }
}

export function searchSonarPublicCatalogue(
  request: SonarSearchRequest,
): Promise<SonarMatch[] | null> {
  return searchSonarBackfilled(
    {
      ...request,
      filter: { ...request.filter, duration_ms_max: LONG_FORM_MS, has_finding: false },
    },
    hiddenCatalogueIds,
  );
}

export function searchSonarPublicTracks(request: SonarSearchRequest): Promise<SonarMatch[] | null> {
  return searchSonarBackfilled(request, hiddenTrackIds);
}
