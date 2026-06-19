// Mixcloud distribution (mixtape audio). STUB — implemented in Phase 2.
//
// Contract the orchestrator (commands/mixtapes.ts) and CLI wiring (cli.ts) depend
// on — Phase 2 fills these in WITHOUT changing the exported signatures:
//
//   distributeMixcloud(mixtapeId, audioPath, onProgress?) → CLI-DIRECT (no Worker
//     proxy): load MIXCLOUD_ACCESS_TOKEN via loadEnv; fetch the mixtape (admin GET)
//     for note/logId/title/members; build the multipart body (mp3=Bun.file(audio),
//     name, description=mixtapeDescription(note,logId), picture=the square cover,
//     tags, sections-N-* from the chapter helper); POST
//     https://api.mixcloud.com/upload/?access_token=… (run OUTSIDE the bash
//     sandbox); read back the cloudcast key via GET /fluncle/cloudcasts/; POST
//     /api/admin/mixtapes/:mixtapeId/mixcloud/finalize { url } → { url }.
//
//   authMixcloudCommand() → the paste helper: if MIXCLOUD_ACCESS_TOKEN is unset for
//     the active --env, print the /oauth/authorize URL (redirect
//     http://localhost:8910/mixcloud/callback), prompt for the pasted token,
//     exchange via /oauth/access_token using MIXCLOUD_CLIENT_ID/SECRET, and write
//     MIXCLOUD_ACCESS_TOKEN into getEnvFilePath().

import { CliError } from "../output";

export type MixcloudDistributeResult = { url: string };

const notImplemented = (): never => {
  throw new CliError("not_implemented", "Mixcloud distribution lands in Phase 2 of the RFC");
};

export async function distributeMixcloud(
  _mixtapeId: string,
  _audioPath: string,
  _onProgress?: (message: string) => void,
): Promise<MixcloudDistributeResult> {
  return notImplemented();
}

export async function authMixcloudCommand(): Promise<void> {
  notImplemented();
}
