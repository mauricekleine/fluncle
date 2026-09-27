import { catalogueTrackPublicWhere, LONG_FORM_MS } from "../catalogue-eligibility";
import { getDb, typedRows } from "./db";
import { searchSonar, type SonarMatch, type SonarSearchRequest } from "./sonar";

export const SONAR_PUBLIC_CATALOGUE_TOP_K_CEILING = 1000;

async function hiddenCatalogueIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...ids],
    sql: `select tracks.track_id as hidden_track_id from tracks
          where tracks.track_id in (${ids.map(() => "?").join(", ")})
            and not ${catalogueTrackPublicWhere("tracks")}`,
  });

  return new Set(
    typedRows<{ hidden_track_id?: unknown }>(result.rows).flatMap((row) =>
      typeof row.hidden_track_id === "string" ? [row.hidden_track_id] : [],
    ),
  );
}

export async function searchSonarPublicCatalogue(
  request: SonarSearchRequest,
): Promise<SonarMatch[] | null> {
  const wanted = request.topK;
  const filter = { ...request.filter, duration_ms_max: LONG_FORM_MS, has_finding: false };
  let topK = wanted;

  while (true) {
    const matches = await searchSonar({ ...request, filter, topK });

    if (matches === null) {
      return null;
    }

    const hidden = await hiddenCatalogueIds(matches.map((match) => match.id));
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
