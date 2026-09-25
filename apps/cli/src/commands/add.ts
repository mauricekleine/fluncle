import { type PublishTrackResult } from "@fluncle/contracts";
import { adminApiPost } from "../api";

type AddOptions = {
  note?: string;
  dryRun?: boolean;
  json?: boolean;
};

export type AddCommandResult = PublishTrackResult;

export async function addCommand(
  spotifyUrl: string,
  options: AddOptions,
): Promise<AddCommandResult> {
  const result = await adminApiPost<AddCommandResult>("/api/v1/admin/tracks", {
    dryRun: options.dryRun,
    note: options.note,
    spotifyUrl,
  });

  if (!options.json) {
    console.log(result.message);

    if (result.track.logId && !result.message.includes("Log ID:")) {
      console.log(`Log ID: fluncle://${result.track.logId}`);
    }

    if (result.track.logPageUrl) {
      console.log(`Log: ${result.track.logPageUrl}`);
    }
  }

  return result;
}
