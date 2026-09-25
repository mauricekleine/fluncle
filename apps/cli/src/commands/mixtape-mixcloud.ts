import {
  type MixcloudAuthStartResponse,
  type MixcloudTokenResponse,
  type MixtapeMixcloudResyncResponse,
} from "@fluncle/contracts";
import { mixcloudSectionFields, mixcloudSections } from "@fluncle/contracts/util";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";
import { type MixtapeListItem, mixtapeGetCommand } from "./mixtape-api";

export type MixcloudDistributeResult = { url: string };
export type MixcloudResyncResult = { url: string };

const MIXCLOUD_API = "https://api.mixcloud.com";

const DESCRIPTION_MAX = 1000;

const PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const COVER_BASE = "https://www.fluncle.com/api/mixtape-cover";

export async function distributeMixcloud(
  mixtapeId: string,
  audioPath: string,
  onProgress?: (message: string) => void,
  unlisted = false,
): Promise<MixcloudDistributeResult> {
  const token = await fetchMixcloudToken();
  const mixtape = await mixtapeGetCommand(mixtapeId);
  const logId = mixtape.logId;

  if (!logId) {
    throw new CliError(
      "mixtape_no_log_id",
      "The mixtape has no Log ID; mint it before distributing",
    );
  }

  const audio = Bun.file(audioPath);

  if (!(await audio.exists())) {
    throw new CliError("audio_not_found", `Audio master not found: ${audioPath}`);
  }

  const form = new FormData();
  form.append("mp3", audio);
  form.append("name", mixtape.title);
  form.append("description", mixtapeDescription(mixtape.note, logId));

  onProgress?.("Mixcloud: fetching the cover…");
  const picture = await fetchCover(logId);
  if (picture) {
    form.append("picture", picture, "cover.png");
  }

  for (const [index, tag] of mixtapeTags(mixtape).entries()) {
    form.append(`tags-${index}-tag`, tag);
  }

  const sections = mixcloudSections(mixtape.members);
  for (const [name, value] of mixcloudSectionFields(sections)) {
    form.append(name, value);
  }

  if (unlisted) {
    form.append("unlisted", "1");
    onProgress?.("Mixcloud: uploading UNLISTED (private).");
  }

  const cuelessCount = mixtape.members.length - sections.length;
  if (cuelessCount > 0) {
    onProgress?.(
      `Mixcloud: ${cuelessCount} of ${mixtape.members.length} members have no cue (omitted from sections).`,
    );
  }

  onProgress?.("Mixcloud: uploading the master…");
  const uploadResponse = await fetch(
    `${MIXCLOUD_API}/upload/?access_token=${encodeURIComponent(token)}`,
    {
      body: form,
      method: "POST",
    },
  );

  const uploadText = await uploadResponse.text();

  if (!uploadResponse.ok) {
    throwMixcloudError(uploadResponse.status, uploadText);
  }

  const result = parseUploadResult(uploadText);

  if (!result.success || !result.key) {
    throw new CliError(
      "mixcloud_upload_rejected",
      `Mixcloud rejected the upload: ${result.message ?? uploadText.slice(0, 300)}`,
    );
  }

  const externalId = result.key;
  const url = `https://www.mixcloud.com${result.key}`;

  onProgress?.("Mixcloud: recording the link…");
  await adminApiPost(`/api/v1/admin/mixtapes/${encodeURIComponent(mixtapeId)}/mixcloud/finalize`, {
    externalId,
    url,
  });

  return { url };
}

export async function resyncMixcloud(mixtapeId: string): Promise<MixcloudResyncResult> {
  const response = await adminApiPost<MixtapeMixcloudResyncResponse>(
    `/api/v1/admin/mixtapes/${encodeURIComponent(mixtapeId)}/mixcloud/resync`,
  );

  return { url: response.url };
}

export async function authMixcloudCommand(): Promise<void> {
  const response = await adminApiGet<MixcloudAuthStartResponse>(
    "/api/v1/admin/mixcloud/auth/start",
  );

  console.log(`Open this link in the browser you're logged into /admin with:

${response.authUrl}

It hands you off to Mixcloud. Signed out? Log in there and it resumes on its own.
The link is good for 10 minutes; run this again if it expires.
After approving access, Mixcloud returns to the Fluncle admin callback and stores the access token server-side.`);
}

export function mixtapeDescription(note: string | undefined, logId: string): string {
  const breadcrumb = `fluncle://${logId}`;
  const body = (note ?? "").trim();
  const full = body ? `${body}\n\n${breadcrumb}` : breadcrumb;

  if (full.length <= DESCRIPTION_MAX) {
    return full;
  }

  const room = DESCRIPTION_MAX - (breadcrumb.length + 2);
  const trimmedNote = body.slice(0, Math.max(room, 0)).trimEnd();

  return trimmedNote ? `${trimmedNote}\n\n${breadcrumb}` : breadcrumb;
}

function mixtapeTags(_mixtape: MixtapeListItem): string[] {
  return ["Drum & Bass", "Fluncle"];
}

async function fetchMixcloudToken(): Promise<string> {
  try {
    const response = await adminApiPost<MixcloudTokenResponse>("/api/v1/admin/mixcloud/token");

    return response.accessToken;
  } catch {
    throw new CliError(
      "mixcloud_not_connected",
      "Mixcloud is not connected. Run `fluncle admin auth mixcloud` to authorize it.",
    );
  }
}

async function fetchCover(logId: string): Promise<Blob | undefined> {
  for (const size of ["square", "og"] as const) {
    const response = await fetch(`${COVER_BASE}/${encodeURIComponent(logId)}?size=${size}`);

    if (!response.ok) {
      continue;
    }

    const blob = await response.blob();

    if (blob.size <= PICTURE_MAX_BYTES) {
      return blob;
    }
  }

  return undefined;
}

function parseUploadResult(body: string): { key?: string; message?: string; success: boolean } {
  try {
    const data = JSON.parse(body) as {
      result?: { key?: string; message?: string; success?: boolean };
    };

    return {
      key: data.result?.key,
      message: data.result?.message,
      success: data.result?.success === true,
    };
  } catch {
    return { message: body.slice(0, 300), success: false };
  }
}

function throwMixcloudError(status: number, body: string): never {
  if (body.includes("An invalid access token was provided")) {
    throw new CliError(
      "mixcloud_invalid_token",
      "Mixcloud rejected the access token. Re-auth with `fluncle admin auth mixcloud`.",
    );
  }

  throw new CliError(
    "mixcloud_request_failed",
    `Mixcloud responded ${status}${body ? `: ${body.slice(0, 300)}` : ""}`,
  );
}
