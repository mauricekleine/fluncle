import {
  type MixtapeMember,
  type MixtapeRequestBody,
  type MixtapeSocialShowResponse,
  type MixtapeUpdateResponse,
  type MixtapesResponse,
} from "@fluncle/contracts";
import { parseDuration } from "@fluncle/contracts/util";
import { adminApiGet, adminApiPatch, publicApiGet } from "../api";
import { type MixtapeListItem, mixtapeGetCommand, mixtapeListCommand } from "./mixtape-api";
import { CliError } from "../output";

export { mixtapeGetCommand, mixtapeListCommand };
export type { MixtapeListItem };

export type MixtapeMemberItem = MixtapeMember;

export type MixtapeUpdateOptions = {
  durationMs?: string;
  json: boolean;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
};

export async function mixtapesCommand(): Promise<MixtapeListItem[]> {
  const response = await publicApiGet<MixtapesResponse>("/api/v1/mixtapes");

  return response.mixtapes;
}

export async function mixtapeUpdateCommand(
  id: string,
  options: MixtapeUpdateOptions,
): Promise<MixtapeUpdateResponse> {
  return adminApiPatch<MixtapeUpdateResponse>(
    `/api/v1/admin/mixtapes/${encodeURIComponent(id)}`,
    buildBody(options),
  );
}

export type MixtapeDistributeOptions = {
  audio?: string;
  json: boolean;
  mixcloud?: boolean;
  unlisted?: boolean;
  video?: string;
  youtube?: boolean;
};

export type MixtapeDistributeResult = {
  logId: string;
  mixtapeId: string;
  results: { platform: string; url: string }[];
};

export async function mixtapeDistributeCommand(
  idOrLogId: string,
  options: MixtapeDistributeOptions,
  onProgress: (message: string) => void = () => {},
): Promise<MixtapeDistributeResult> {
  const mixtape = await mixtapeGetCommand(idOrLogId);

  if (!mixtape.id) {
    throw new CliError("mixtape_not_found", `No mixtape with id or log id ${idOrLogId}`);
  }

  const both = !options.youtube && !options.mixcloud;
  const doYoutube = both || Boolean(options.youtube);
  const doMixcloud = both || Boolean(options.mixcloud);

  if (doYoutube && !options.video) {
    throw new CliError("missing_video", "YouTube distribution needs --video <mp4>");
  }
  if (doMixcloud && !options.audio) {
    throw new CliError("missing_audio", "Mixcloud distribution needs --audio <file>");
  }

  const mixtapeId = mixtape.id;
  const logId = mixtape.logId;

  if (!logId) {
    throw new CliError(
      "mixtape_not_promoted",
      `${mixtapeId} has no coordinate yet. Promote its recording first:\n` +
        "  fluncle admin recordings promote <recordingId>",
    );
  }

  if (!mixtape.durationMs) {
    const source = options.audio ?? options.video;
    const durationMs = source ? await probeDurationMs(source) : undefined;

    if (durationMs) {
      await mixtapeUpdateCommand(mixtapeId, { durationMs: String(durationMs), json: false });
      onProgress(`Duration: ${Math.round(durationMs / 60_000)} min (from the upload).`);
    }
  }

  if (mixtape.status === "published") {
    onProgress(`Already published (${logId}); re-distributing.`);
  } else {
    onProgress(`Distributing ${logId} (promoted, coordinate already minted).`);
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

  return { logId, mixtapeId, results };
}

export type MixtapeResyncOptions = {
  json: boolean;
  mixcloud?: boolean;
  youtube?: boolean;
};

export type MixtapeResyncResult = {
  logId: string;
  mixtapeId: string;
  results: { platform: string; url: string }[];
};

export async function mixtapeResyncCommand(
  idOrLogId: string,
  options: MixtapeResyncOptions,
  onProgress: (message: string) => void = () => {},
): Promise<MixtapeResyncResult> {
  const mixtape = await mixtapeGetCommand(idOrLogId);

  if (!mixtape.id) {
    throw new CliError("mixtape_not_found", `No mixtape with id or log id ${idOrLogId}`);
  }

  if (!mixtape.logId) {
    throw new CliError(
      "mixtape_no_log_id",
      "The mixtape isn't published yet. Distribute it before re-syncing.",
    );
  }

  const mixtapeId = mixtape.id;
  const explicit = Boolean(options.youtube) || Boolean(options.mixcloud);
  let doYoutube = Boolean(options.youtube);
  let doMixcloud = Boolean(options.mixcloud);

  if (!explicit) {
    const social = await adminApiGet<MixtapeSocialShowResponse>(
      `/api/v1/admin/mixtapes/${encodeURIComponent(mixtapeId)}/social`,
    );
    const platforms = new Set(social.posts.map((post) => post.platform));
    doYoutube = platforms.has("youtube");
    doMixcloud = platforms.has("mixcloud");

    if (!doYoutube && !doMixcloud) {
      throw new CliError(
        "mixtape_not_distributed",
        "The mixtape has no YouTube or Mixcloud link to re-sync.",
      );
    }
  }

  const results: { platform: string; url: string }[] = [];

  if (doYoutube) {
    onProgress("YouTube: re-syncing description + chapters…");
    const { resyncYoutube } = await import("./mixtape-youtube");
    const result = await resyncYoutube(mixtapeId);
    results.push({ platform: "youtube", url: result.url });
    onProgress(`YouTube: ${result.url}`);
  }

  if (doMixcloud) {
    onProgress("Mixcloud: re-syncing sections…");
    const { resyncMixcloud } = await import("./mixtape-mixcloud");
    const result = await resyncMixcloud(mixtapeId);
    results.push({ platform: "mixcloud", url: result.url });
    onProgress(`Mixcloud: ${result.url}`);
  }

  return { logId: mixtape.logId, mixtapeId, results };
}

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

function buildBody(options: MixtapeUpdateOptions): MixtapeRequestBody {
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
