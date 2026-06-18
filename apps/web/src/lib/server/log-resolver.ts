import { isMixtapeLogId } from "../log-id";
import { getMixtapeByLogId } from "./mixtapes";
import { getTrackByIdOrLogId } from "./tracks";

export async function resolveLogPageTarget(idOrLogId: string) {
  if (isMixtapeLogId(idOrLogId)) {
    const mixtape = await getMixtapeByLogId(idOrLogId);

    return mixtape ? ({ kind: "mixtape", mixtape } as const) : undefined;
  }

  const track = await getTrackByIdOrLogId(idOrLogId);

  return track ? ({ kind: "track", track } as const) : undefined;
}
