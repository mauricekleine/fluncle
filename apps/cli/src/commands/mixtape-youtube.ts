// YouTube distribution (mixtape video). STUB — implemented in Phase 1.
//
// Contract the orchestrator (commands/mixtapes.ts) and CLI wiring (cli.ts) depend
// on — Phase 1 fills these in WITHOUT changing the exported signatures:
//
//   distributeYoutube(mixtapeId, videoPath, onProgress?) →
//     POST /api/admin/mixtapes/:mixtapeId/youtube/initiate (Worker builds the
//     snippet/description/chapters server-side from the committed coordinate and
//     returns { sessionUri, accessToken }) → resumable PUT of Bun.file(videoPath)
//     to sessionUri with `Authorization: Bearer <accessToken>` (run OUTSIDE the
//     bash sandbox; handle 308 resume / 401 re-mint / 410 re-init) → POST
//     /api/admin/mixtapes/:mixtapeId/youtube/finalize { videoId } → { url, videoId }.
//
//   publishYoutubeCommand(idOrLogId) → the unlisted→public flip (videos.update via
//     a Worker route that holds the refresh token) → { url }.
//
//   authYoutubeCommand() → mirror authSpotifyCommand: GET the auth-start route,
//     print the consent URL.

import { CliError } from "../output";

export type YoutubeDistributeResult = { url: string; videoId: string };

const notImplemented = (): never => {
  throw new CliError("not_implemented", "YouTube distribution lands in Phase 1 of the RFC");
};

export async function distributeYoutube(
  _mixtapeId: string,
  _videoPath: string,
  _onProgress?: (message: string) => void,
): Promise<YoutubeDistributeResult> {
  return notImplemented();
}

export async function publishYoutubeCommand(_idOrLogId: string): Promise<{ url: string }> {
  return notImplemented();
}

export async function authYoutubeCommand(): Promise<void> {
  notImplemented();
}
