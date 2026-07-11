import { isEditionLogId, isMixtapeLogId } from "../log-id";
import { getEditionByLogId } from "./editions";
import { getMixtapeByLogId } from "./mixtapes";
import { getTrackByIdOrLogId } from "./tracks";

/**
 * The MUSIC resolver: one coordinate (or a legacy Spotify track id) → the finding or
 * the mixtape it names. The music-shaped surfaces read through this — the `get_track`
 * API op, the oEmbed provider, the `/embed` card — because each of them can only speak
 * about music. A coordinate that names something else (a letter) resolves to nothing
 * here, and those surfaces 404 rather than inventing a card for an object they have no
 * shape for.
 */
export async function resolveMusicTarget(idOrLogId: string) {
  if (isMixtapeLogId(idOrLogId)) {
    const mixtape = await getMixtapeByLogId(idOrLogId);

    return mixtape ? ({ kind: "mixtape", mixtape } as const) : undefined;
  }

  const track = await getTrackByIdOrLogId(idOrLogId);

  return track ? ({ kind: "track", track } as const) : undefined;
}

/**
 * The `/log/<id>` resolver: one coordinate in, one KIND of object out, across the three
 * that share the spine — a finding, an `F`-marked mixtape, an `L`-marked letter.
 *
 * THE RAIL: a visitor is never shown the wrong kind of object. The three grammars are
 * disjoint by the marker slot alone (a digit / `F` / `L`), and the canonical grammar's
 * test vectors assert that exclusivity, so a coordinate can never fall down two
 * branches. When the object behind a well-shaped coordinate is missing, this returns
 * undefined and the page 404s — it never degrades into a neighbouring kind.
 */
export async function resolveLogPageTarget(idOrLogId: string) {
  if (isEditionLogId(idOrLogId)) {
    const edition = await getEditionByLogId(idOrLogId);

    return edition ? ({ edition, kind: "edition" } as const) : undefined;
  }

  return resolveMusicTarget(idOrLogId);
}
