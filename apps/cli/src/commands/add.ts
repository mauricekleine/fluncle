import { adminApiPost } from "../api";

type AddOptions = {
  note?: string;
  dryRun?: boolean;
  json?: boolean;
};

export type AddCommandResult = {
  track: {
    trackId: string;
    spotifyUrl: string;
    title: string;
    artists: string[];
    album?: string;
    albumImageUrl?: string;
    durationMs: number;
  };
  dryRun: boolean;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
  message: string;
};

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
  }

  return result;
}
