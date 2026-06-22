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
  const result = await adminApiPost<AddCommandResult>("/api/admin/tracks", {
    dryRun: options.dryRun,
    note: options.note,
    spotifyUrl,
  });

  if (!options.json) {
    console.log(result.message);

    // The success message ("Banger logged") omits the coordinate; surface it so
    // the operator always leaves with the finding's Log ID. The dry-run message
    // already carries its own `Log ID:` line, so don't double-print.
    if (result.track.logId && !result.message.includes("Log ID:")) {
      console.log(`Log ID: fluncle://${result.track.logId}`);
    }

    // The finding's permanent home, alongside the coordinate.
    if (result.track.logPageUrl) {
      console.log(`Log: ${result.track.logPageUrl}`);
    }
  }

  return result;
}
