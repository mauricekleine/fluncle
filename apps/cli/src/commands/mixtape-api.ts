// The shared mixtape read helpers, split out of `mixtapes.ts` so the value imports
// `mixtape-mixcloud.ts` needs (`mixtapeGetCommand` + the `MixtapeListItem` type) live in
// a leaf module. `mixtapes.ts` dynamically imports `mixtape-mixcloud.ts` for distribution;
// keeping these here breaks the static value-import cycle between the two.

import { type MixtapeDTO, type MixtapesResponse } from "@fluncle/contracts";
import { adminApiGet } from "../api";
import { CliError } from "../output";

export type MixtapeListItem = MixtapeDTO;

export async function mixtapeListCommand(): Promise<MixtapeListItem[]> {
  const response = await adminApiGet<MixtapesResponse>("/api/v1/admin/mixtapes");

  return response.mixtapes;
}

export async function mixtapeGetCommand(idOrLogId: string): Promise<MixtapeListItem> {
  const mixtapes = await mixtapeListCommand();
  const match = mixtapes.find((mixtape) => mixtape.id === idOrLogId || mixtape.logId === idOrLogId);

  if (!match) {
    throw new CliError("mixtape_not_found", `No mixtape with id or log id ${idOrLogId}`);
  }

  return match;
}
