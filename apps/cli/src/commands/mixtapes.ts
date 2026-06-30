import {
  type CueEntry,
  type MixtapeCreateResponse,
  type MixtapeDeleteResponse,
  type MixtapeDTO,
  type MixtapeMember,
  type MixtapeMembersRequest,
  type MixtapePublishResponse,
  type MixtapeRequestBody,
  type MixtapeUpdateResponse,
  type MixtapesResponse,
} from "@fluncle/contracts";
import { parseDuration } from "@fluncle/contracts/util";
import { existsSync, readFileSync } from "node:fs";
import {
  adminApiDelete,
  adminApiGet,
  adminApiPost,
  adminApiPut,
  adminApiPatch,
  publicApiGet,
} from "../api";
import { CliError } from "../output";

export type MixtapeListItem = MixtapeDTO;
export type MixtapeMemberItem = MixtapeMember;

export type MixtapeCreateOptions = {
  durationMs?: string;
  json: boolean;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
};

export type MixtapeUpdateOptions = {
  durationMs?: string;
  json: boolean;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
};

export type MixtapeMembersOptions = {
  from?: string;
  json: boolean;
};

export async function mixtapesCommand(): Promise<MixtapeListItem[]> {
  const response = await publicApiGet<MixtapesResponse>("/api/mixtapes");

  return response.mixtapes;
}

export async function mixtapeCreateCommand(
  options: MixtapeCreateOptions,
): Promise<MixtapeCreateResponse> {
  return adminApiPost<MixtapeCreateResponse>("/api/admin/mixtapes", buildBody(options));
}

export async function mixtapeUpdateCommand(
  id: string,
  options: MixtapeUpdateOptions,
): Promise<MixtapeUpdateResponse> {
  return adminApiPatch<MixtapeUpdateResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(id)}`,
    buildBody(options),
  );
}

export async function mixtapeMembersCommand(
  id: string,
  refs: string[],
  options: MixtapeMembersOptions,
): Promise<MixtapeUpdateResponse> {
  const members: CueEntry[] = refs.map((ref) => ({ ref }));

  if (options.from) {
    members.push(...parseCueFile(options.from));
  }

  return adminApiPut<MixtapeUpdateResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(id)}/members`,
    { members } satisfies MixtapeMembersRequest,
  );
}

export async function mixtapePublishCommand(id: string): Promise<MixtapePublishResponse> {
  return adminApiPost<MixtapePublishResponse>(
    `/api/admin/mixtapes/${encodeURIComponent(id)}/publish`,
  );
}

export async function mixtapeDeleteCommand(id: string): Promise<MixtapeDeleteResponse> {
  return adminApiDelete<MixtapeDeleteResponse>(`/api/admin/mixtapes/${encodeURIComponent(id)}`);
}

export async function mixtapeListCommand(): Promise<MixtapeListItem[]> {
  const response = await adminApiGet<MixtapesResponse>("/api/admin/mixtapes");

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

export type MixtapeDistributeOptions = {
  audio?: string;
  json: boolean;
  mixcloud?: boolean;
  setVideo?: boolean;
  unlisted?: boolean;
  video?: string;
  youtube?: boolean;
};

export type MixtapeDistributeResult = {
  logId: string;
  mixtapeId: string;
  results: { platform: string; url: string }[];
};

/**
 * Distribute a mixtape end to end: mint the coordinate if it's still a draft, then
 * move the local bytes to each requested platform (video→YouTube, audio→Mixcloud).
 * With no platform selector at all, does YouTube + Mixcloud. The first successful
 * platform link flips the mixtape `distributing → published` (server-side, in each
 * finalize). `--set-video` is an ADDITIONAL leg (Fluncle Studio Unit A): it derives a
 * 1080p rendition of the set and stages it to R2 at `<logId>/set.mp4`, flipping
 * `setVideoAt` so the `/log` player + video SEO light up. It is opt-in (never part of
 * the no-selector default — it needs a video master + ffmpeg) and runs ONLY-set-video
 * when it is the sole selector (the backfill case). Idempotent: re-running resumes a
 * `distributing` mixtape, reusing its Log ID, and re-stages the set video.
 */
export async function mixtapeDistributeCommand(
  idOrLogId: string,
  options: MixtapeDistributeOptions,
  onProgress: (message: string) => void = () => {},
): Promise<MixtapeDistributeResult> {
  const mixtape = await mixtapeGetCommand(idOrLogId);

  if (!mixtape.id) {
    throw new CliError("mixtape_not_found", `No mixtape with id or log id ${idOrLogId}`);
  }

  // No platform selector → the legacy default (YouTube + Mixcloud). `--set-video` is
  // an additional, opt-in leg, so it never triggers the default; running it alone (the
  // backfill case) stages only the set video.
  const both = !options.youtube && !options.mixcloud && !options.setVideo;
  const doYoutube = both || Boolean(options.youtube);
  const doMixcloud = both || Boolean(options.mixcloud);
  const doSetVideo = Boolean(options.setVideo);

  if (doYoutube && !options.video) {
    throw new CliError("missing_video", "YouTube distribution needs --video <mp4>");
  }
  if (doMixcloud && !options.audio) {
    throw new CliError("missing_audio", "Mixcloud distribution needs --audio <file>");
  }
  if (doSetVideo && !options.video) {
    throw new CliError("missing_video", "--set-video needs --video <master.mp4>");
  }

  const mixtapeId = mixtape.id;
  let logId = mixtape.logId;

  // Derive the run-time from the upload if the draft has no duration — a draft is
  // just the tracklist, so duration isn't an input. Display-only, best-effort
  // (skipped if ffprobe isn't on PATH).
  if (!mixtape.durationMs) {
    const source = options.audio ?? options.video;
    const durationMs = source ? await probeDurationMs(source) : undefined;

    if (durationMs) {
      await mixtapeUpdateCommand(mixtapeId, { durationMs: String(durationMs), json: false });
      onProgress(`Duration: ${Math.round(durationMs / 60_000)} min (from the upload).`);
    }
  }

  // Mint first: the cover endpoint and the uploaded assets must embed the real Log
  // ID, so it has to exist BEFORE upload. A draft mints to `distributing`; an
  // already-minted mixtape reuses its committed coordinate.
  if (mixtape.status === "draft") {
    onProgress("Minting the coordinate…");
    const published = await mixtapePublishCommand(mixtapeId);
    logId = published.mixtape.logId;
    onProgress(`Minted ${logId}.`);
  } else if (mixtape.status === "published") {
    onProgress(`Already published (${logId}); re-distributing.`);
  } else {
    onProgress(`Resuming distribution for ${logId}.`);
  }

  if (!logId) {
    throw new CliError("mint_failed", "The mixtape has no Log ID after minting");
  }

  const results: { platform: string; url: string }[] = [];

  if (doYoutube) {
    if (!options.video) {
      throw new CliError("missing_video", "YouTube distribution needs --video <mp4>");
    }
    onProgress("YouTube: uploading video…");
    const { distributeYoutube } = await import("./mixtape-youtube");
    const result = await distributeYoutube(mixtapeId, options.video, onProgress);
    results.push({ platform: "youtube", url: result.url });
    onProgress(`YouTube: ${result.url}`);
  }

  if (doMixcloud) {
    if (!options.audio) {
      throw new CliError("missing_audio", "Mixcloud distribution needs --audio <file>");
    }
    onProgress("Mixcloud: uploading audio…");
    const { distributeMixcloud } = await import("./mixtape-mixcloud");
    const result = await distributeMixcloud(mixtapeId, options.audio, onProgress, options.unlisted);
    results.push({ platform: "mixcloud", url: result.url });
    onProgress(`Mixcloud: ${result.url}`);
  }

  if (doSetVideo) {
    if (!options.video) {
      throw new CliError("missing_video", "--set-video needs --video <master.mp4>");
    }
    onProgress("Set video: staging the 1080p rendition…");
    const { stageSetVideo } = await import("./mixtape-set-video");
    const result = await stageSetVideo(mixtapeId, options.video, onProgress);
    results.push({ platform: "set-video", url: result.url });
    onProgress(`Set video: ${result.url}`);
  }

  return { logId, mixtapeId, results };
}

// The media run-time in ms via ffprobe, or undefined if it isn't available/parseable.
async function probeDurationMs(filePath: string): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { stderr: "ignore", stdout: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const seconds = Number.parseFloat(out.trim());

    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

function buildBody(options: MixtapeCreateOptions | MixtapeUpdateOptions): MixtapeRequestBody {
  const body: MixtapeRequestBody = {};

  if (options.note !== undefined) {
    body.note = options.note;
  }
  if (options.recordedAt !== undefined) {
    body.recordedAt = options.recordedAt;
  }
  if (options.soundcloudUrl !== undefined) {
    body.soundcloudUrl = options.soundcloudUrl;
  }
  if (options.durationMs !== undefined) {
    const parsed = parseDuration(options.durationMs);
    if (parsed === null) {
      throw new CliError(
        "invalid_duration",
        "Duration must be mm:ss or h:mm:ss, or a millisecond count",
      );
    }
    body.durationMs = parsed;
  }

  return body;
}

function parseCueFile(filePath: string): CueEntry[] {
  if (!existsSync(filePath)) {
    throw new CliError("file_not_found", `Cue file not found: ${filePath}`);
  }

  const text = readFileSync(filePath, "utf-8");
  const trimmed = text.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("not an array");
      }
      return (parsed as unknown[]).map((entry, index) => {
        if (typeof entry === "string") {
          return { ref: entry.trim() };
        }
        const obj = entry as Record<string, unknown>;
        if (typeof obj?.ref !== "string") {
          throw new CliError("invalid_cue_json", `Entry ${index + 1} missing "ref" string`);
        }
        const cue: CueEntry = { ref: obj.ref.trim() };
        if (typeof obj.startMs === "number" && Number.isInteger(obj.startMs) && obj.startMs >= 0) {
          cue.startMs = obj.startMs;
        }
        return cue;
      });
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      throw new CliError(
        "invalid_cue_json",
        `Cue JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return parseCueSheet(text);
}

function parseCueSheet(text: string): CueEntry[] {
  const entries: CueEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
    if (match) {
      const [, time, ref] = match;
      if (time === undefined || ref === undefined) {
        continue;
      }
      const startMs = parseDuration(time);
      if (startMs === null) {
        continue;
      }
      entries.push({ ref: ref.trim(), startMs });
    } else {
      entries.push({ ref: trimmed });
    }
  }

  return entries;
}
