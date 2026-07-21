// Fluncle Studio — the recording admin commands (RFC recording-primitive, Design B). A
// recording is a captured DJ set that is NOT (yet) a published mixtape: clip it without
// minting a coordinate, then `promote` it to a full published mixtape later (reusing the
// already-staged video, no re-upload). The CLI stays a thin HTTP client over the admin
// oRPC ops; `recordingGet` is the non-printing resolver the clip cut reads.

import {
  type RecordingDTO,
  type RecordingResponse,
  type RecordingsResponse,
} from "@fluncle/contracts";
import { existsSync, readFileSync } from "node:fs";
import { adminApiDelete, adminApiGet, adminApiPatch, adminApiPost, adminApiPut } from "../api";
import { CliError, printJson } from "../output";
import { uploadRenditionMultipart } from "./mixtape-set-video";

export type { RecordingDTO };

export type RecordingCreateOptions = {
  json?: boolean;
  // A PLAN — a videoless recording (RFC plan→recording→mixtape §1): no video, the server
  // mints a Galaxy-vocab handle. Mutually exclusive with --video/--title.
  plan?: boolean;
  recordedAt?: string;
  title?: string;
  video?: string;
};

export type RecordingListOptions = {
  json?: boolean;
  // Narrow to plans (videoless) or takes (with video). RFC plan→recording→mixtape §7.
  kind?: string;
  // The plan whose takes to list.
  parentId?: string;
};

export type RecordingUpdateOptions = {
  json?: boolean;
  // Attach this take to its plan (a recording id) — assigns the take's version.
  parentId?: string;
  recordedAt?: string;
  title?: string;
  // A JSON file holding the whole cue tracklist array (`[{ id?, artists, title, startMs? }]`).
  tracklistFile?: string;
};

export type RecordingReplaceCuesOptions = {
  // A JSON file holding the ordered cue array
  // (`[{ findingId?, artistsText, titleText, position, startMs? }]`).
  cuesFile?: string;
  json?: boolean;
};

type JsonOptions = { json?: boolean };

/** Resolve one recording by id — the non-printing getter the clip cut reads. */
export async function recordingGet(id: string): Promise<RecordingDTO> {
  const response = await adminApiGet<RecordingResponse>(
    `/api/v1/admin/recordings/${encodeURIComponent(id)}`,
  );

  return response.recording;
}

function formatRecordingSummary(recording: RecordingDTO): string {
  // A PLAN has no video; a TAKE has one (and a version label among its plan's takes).
  const kind = recording.hasVideo ? `take v${recording.version}` : "plan";
  const promoted = recording.logId ? ` → fluncle://${recording.logId}` : " (un-promoted)";
  const cues = recording.tracklist.length;

  return `${recording.id}  [${kind}]  ${recording.title}${promoted}  [${cues} cue${cues === 1 ? "" : "s"}]`;
}

export async function recordingsListCommand(options: RecordingListOptions = {}): Promise<void> {
  const query = new URLSearchParams();

  if (options.kind) {
    query.set("kind", options.kind);
  }

  if (options.parentId) {
    query.set("parentId", options.parentId);
  }

  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await adminApiGet<RecordingsResponse>(`/api/v1/admin/recordings${suffix}`);

  if (options.json) {
    printJson({ ok: true, recordings: response.recordings });
    return;
  }

  if (response.recordings.length === 0) {
    console.log("No recordings yet.");
    return;
  }

  console.log(response.recordings.map(formatRecordingSummary).join("\n"));
}

export async function recordingGetCommand(
  id: string | undefined,
  options: JsonOptions = {},
): Promise<void> {
  if (!id) {
    throw new CliError("missing_id", "Missing recording id for: get");
  }

  const recording = await recordingGet(id);

  if (options.json) {
    printJson({ ok: true, recording });
    return;
  }

  console.log(formatRecordingSummary(recording));
  // A PLAN (no video yet) owns no key — print the honest absence.
  console.log(`  r2Key: ${recording.r2Key ?? "— (no set video)"}`);

  for (const cue of recording.tracklist) {
    const at = cue.startMs === undefined ? "—" : `${(cue.startMs / 1000).toFixed(1)}s`;
    console.log(`  ${at}  ${cue.artists.join(", ")} — ${cue.title}`);
  }
}

export async function recordingCreateCommand(options: RecordingCreateOptions = {}): Promise<void> {
  // A PLAN is a videoless recording: no --video, no --title — the server mints the
  // Galaxy-vocab handle. RFC plan→recording→mixtape §1.
  if (options.plan) {
    const created = await adminApiPost<RecordingResponse>("/api/v1/admin/recordings", {
      kind: "plan",
      recordedAt: options.recordedAt,
    });
    const recording = created.recording;

    if (options.json) {
      printJson({ ok: true, recording });
      return;
    }

    console.log(`Plan ${recording.id} created, handle "${recording.title}"`);
    return;
  }

  const title = options.title?.trim();

  if (!title) {
    throw new CliError(
      "missing_title",
      "A recording needs a --title (or --plan for a videoless plan)",
    );
  }

  if (!options.video) {
    throw new CliError("missing_video", "A recording needs a --video <file> to stage");
  }

  if (!existsSync(options.video)) {
    throw new CliError("file_not_found", `Set-video master not found: ${options.video}`);
  }

  const created = await adminApiPost<RecordingResponse>("/api/v1/admin/recordings", {
    recordedAt: options.recordedAt,
    title,
  });
  const recording = created.recording;
  const log = (message: string): void => {
    if (!options.json) {
      console.log(message);
    }
  };

  log(`Recording ${recording.id} created, staging the set video…`);

  const upload = await uploadRenditionMultipart(
    options.video,
    `/api/v1/admin/recordings/${encodeURIComponent(recording.id)}/set-video/presign`,
    log,
  );

  if (options.json) {
    printJson({ key: upload.key, ok: true, recording, url: upload.url });
    return;
  }

  console.log(`Recording ${recording.id} staged → ${upload.url}`);
}

export async function recordingUpdateCommand(
  id: string | undefined,
  options: RecordingUpdateOptions = {},
): Promise<void> {
  if (!id) {
    throw new CliError("missing_id", "Missing recording id for: update");
  }

  const body: { parentId?: string; recordedAt?: string; title?: string; tracklistJson?: unknown } =
    {};

  if (options.title !== undefined) {
    body.title = options.title;
  }

  if (options.recordedAt !== undefined) {
    body.recordedAt = options.recordedAt;
  }

  // Attach this take to its plan — the server assigns the take's version atomically.
  if (options.parentId !== undefined) {
    body.parentId = options.parentId;
  }

  if (options.tracklistFile !== undefined) {
    if (!existsSync(options.tracklistFile)) {
      throw new CliError("file_not_found", `Tracklist file not found: ${options.tracklistFile}`);
    }

    try {
      body.tracklistJson = JSON.parse(readFileSync(options.tracklistFile, "utf8"));
    } catch {
      throw new CliError(
        "invalid_tracklist",
        `Tracklist file is not valid JSON: ${options.tracklistFile}`,
      );
    }
  }

  if (Object.keys(body).length === 0) {
    throw new CliError(
      "no_fields",
      "Nothing to update. Pass --title, --recorded-at, --parent-id, or --tracklist-file",
    );
  }

  const response = await adminApiPatch<RecordingResponse>(
    `/api/v1/admin/recordings/${encodeURIComponent(id)}`,
    body,
  );

  if (options.json) {
    printJson({ ok: true, recording: response.recording });
    return;
  }

  console.log(`Updated ${formatRecordingSummary(response.recording)}`);
}

export async function recordingDeleteCommand(
  id: string | undefined,
  options: JsonOptions = {},
): Promise<void> {
  if (!id) {
    throw new CliError("missing_id", "Missing recording id for: delete");
  }

  await adminApiDelete(`/api/v1/admin/recordings/${encodeURIComponent(id)}`);

  if (options.json) {
    printJson({ ok: true });
    return;
  }

  console.log(`Deleted recording ${id} (and its clips).`);
}

export async function recordingPromoteCommand(
  id: string | undefined,
  options: JsonOptions = {},
): Promise<void> {
  if (!id) {
    throw new CliError("missing_id", "Missing recording id for: promote");
  }

  const response = await adminApiPost<RecordingResponse>(
    `/api/v1/admin/recordings/${encodeURIComponent(id)}/promote`,
  );
  const recording = response.recording;

  if (options.json) {
    printJson({ ok: true, recording });
    return;
  }

  console.log(
    recording.logId
      ? `Promoted recording ${id} → mixtape fluncle://${recording.logId}`
      : `Promoted recording ${id}`,
  );
}

export async function recordingReplaceCuesCommand(
  id: string | undefined,
  options: RecordingReplaceCuesOptions = {},
): Promise<void> {
  if (!id) {
    throw new CliError("missing_id", "Missing recording id for: replace-cues");
  }

  if (!options.cuesFile) {
    throw new CliError(
      "missing_cues_file",
      "replace-cues needs a --cues-file <file> (the ordered cue array)",
    );
  }

  if (!existsSync(options.cuesFile)) {
    throw new CliError("file_not_found", `Cues file not found: ${options.cuesFile}`);
  }

  let cues: unknown;

  try {
    cues = JSON.parse(readFileSync(options.cuesFile, "utf8"));
  } catch {
    throw new CliError("invalid_cues", `Cues file is not valid JSON: ${options.cuesFile}`);
  }

  const response = await adminApiPut<RecordingResponse>(
    `/api/v1/admin/recordings/${encodeURIComponent(id)}/cues`,
    { cues },
  );

  if (options.json) {
    printJson({ ok: true, recording: response.recording });
    return;
  }

  console.log(`Replaced cues for ${formatRecordingSummary(response.recording)}`);
}
