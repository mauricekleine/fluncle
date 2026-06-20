// Mixcloud distribution (mixtape audio). The BYTES are CLI-direct (the Worker can't
// proxy a multi-GB master), but the CREDENTIAL is not: the token lives server-side
// (mixcloud_auth) and the CLI fetches it just-in-time from the Worker for the upload
// — the CLI stays a thin client, mirroring YouTube. The Worker owns authority: it
// runs the OAuth exchange and records the result via the finalize route.
//
//   distributeMixcloud(mixtapeId, audioPath, onProgress?) → fetch the mixtape,
//     build the multipart body (mp3 + name + description + picture + tags +
//     sections), POST /upload/, read the cloudcast key back via /<user>/cloudcasts/,
//     then POST the resolved URL to /api/admin/mixtapes/:id/mixcloud/finalize.
//
//   authMixcloudCommand() → a thin trigger (like auth youtube): GET the admin
//     start route and print the consent URL. The OAuth code exchange + token
//     storage happen server-side; the CLI never holds the durable credential.

import { type MixcloudAuthStartResponse, type MixcloudTokenResponse } from "@fluncle/contracts";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";
import { type MixtapeListItem, mixtapeGetCommand } from "./mixtapes";

export type MixcloudDistributeResult = { url: string };

const MIXCLOUD_API = "https://api.mixcloud.com";
// Mixcloud's documented description cap; the fluncle:// breadcrumb adds ~25 chars.
const DESCRIPTION_MAX = 1000;
// Mixcloud caps the cover at 10MB; the 1500² square PNG may exceed it.
const PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const COVER_BASE = "https://www.fluncle.com/api/mixtape-cover";

// ── Distribute ───────────────────────────────────────────────────────────────

export async function distributeMixcloud(
  mixtapeId: string,
  audioPath: string,
  onProgress?: (message: string) => void,
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
  for (const [index, section] of sections.entries()) {
    form.append(`sections-${index}-artist`, section.artist);
    form.append(`sections-${index}-song`, section.song);
    form.append(`sections-${index}-start_time`, String(section.start_time));
  }

  const cuelessCount = mixtape.members.length - sections.length;
  if (cuelessCount > 0) {
    onProgress?.(
      `Mixcloud: ${cuelessCount} of ${mixtape.members.length} members have no cue (omitted from sections).`,
    );
  }

  // The upload is a single large multipart POST. fetch streams Bun.file() so the
  // master is never buffered into memory; the token rides as a query param
  // (Mixcloud diverges from Bearer auth — note it).
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

  // The success body is undocumented and carries no URL/key. Read the authoritative
  // key back from the account's cloudcasts feed (the freshest cast is this upload).
  onProgress?.("Mixcloud: reading back the cloudcast key…");
  const url = await resolveCloudcastUrl(token, mixtape.title);
  const externalId = cloudcastKeyFromUrl(url);

  onProgress?.("Mixcloud: recording the link…");
  await adminApiPost(`/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/mixcloud/finalize`, {
    externalId,
    url,
  });

  return { url };
}

// ── Auth (thin trigger) ──────────────────────────────────────────────────────

export async function authMixcloudCommand(): Promise<void> {
  const response = await adminApiGet<MixcloudAuthStartResponse>("/api/admin/mixcloud/auth/start");

  console.log(`Open this Mixcloud authorization URL:

${response.authUrl}

After approving access, Mixcloud returns to the Fluncle admin callback and stores the access token server-side.`);
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * The platform description: the dream note + the `fluncle://<logId>` breadcrumb.
 * Built inline (CLI-side) so apps/web isn't imported. The breadcrumb is never
 * stored in the note column — it rides along only on the external platform.
 * Clamped to Mixcloud's description cap, trimming the note (never the breadcrumb).
 */
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

/** Mixcloud `sections[]` from cued members: filter out un-cued, sort by offset. */
export function mixcloudSections(
  members: MixtapeListItem["members"],
): { artist: string; song: string; start_time: number }[] {
  return members
    .filter(
      (member): member is typeof member & { startMs: number } => typeof member.startMs === "number",
    )
    .sort((a, b) => a.startMs - b.startMs)
    .map((member) => ({
      artist: member.artists.join(", "),
      song: member.title,
      start_time: Math.floor(member.startMs / 1000),
    }));
}

// Up to 5 tags. Fluncle's archive is drum & bass; lead with the genre tag.
function mixtapeTags(_mixtape: MixtapeListItem): string[] {
  return ["Drum & Bass", "Fluncle"];
}

// ── Internal IO helpers ──────────────────────────────────────────────────────

// The Mixcloud token lives server-side (mixcloud_auth); the CLI fetches it just-in-
// time for the direct upload. A 400 means Mixcloud isn't connected yet.
async function fetchMixcloudToken(): Promise<string> {
  try {
    const response = await adminApiPost<MixcloudTokenResponse>("/api/admin/mixcloud/token");

    return response.accessToken;
  } catch {
    throw new CliError(
      "mixcloud_not_connected",
      "Mixcloud is not connected. Run `fluncle admin auth mixcloud` to authorize it.",
    );
  }
}

// Fetch the square cover; if it's over Mixcloud's 10MB picture cap, fall back to
// the smaller `og` variant. Returns undefined (skip the picture) if both fail.
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

// The Mixcloud account that owns the access token, e.g. "fluncle".
async function fetchUsername(token: string): Promise<string> {
  const response = await fetch(`${MIXCLOUD_API}/me/?access_token=${encodeURIComponent(token)}`);
  const text = await response.text();

  if (!response.ok) {
    throwMixcloudError(response.status, text);
  }

  const username = (JSON.parse(text) as { username?: string }).username;

  if (!username) {
    throw new CliError("mixcloud_no_username", "Mixcloud /me/ returned no username");
  }

  return username;
}

// Read the authoritative cloudcast URL back from the account feed. The just-uploaded
// cast is the freshest; match on the title's slug as a guard, else take the newest.
async function resolveCloudcastUrl(token: string, name: string): Promise<string> {
  const username = await fetchUsername(token);
  const response = await fetch(
    `${MIXCLOUD_API}/${encodeURIComponent(username)}/cloudcasts/?access_token=${encodeURIComponent(token)}`,
  );
  const text = await response.text();

  if (!response.ok) {
    throwMixcloudError(response.status, text);
  }

  const data = JSON.parse(text) as { data?: { slug?: string; url?: string }[] };
  const casts = data.data ?? [];

  if (casts.length === 0) {
    throw new CliError("mixcloud_no_cloudcast", "Mixcloud returned no cloudcasts after the upload");
  }

  const wantSlug = slugify(name);
  const match = casts.find((cast) => cast.slug === wantSlug) ?? casts[0];

  if (!match.url) {
    throw new CliError("mixcloud_no_url", "Mixcloud cloudcast has no url");
  }

  return match.url;
}

// "https://www.mixcloud.com/fluncle/<slug>/" → the API key "/fluncle/<slug>/".
function cloudcastKeyFromUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname || undefined;
  } catch {
    return undefined;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
