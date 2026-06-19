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
  mixcloudUrl?: string;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
  youtubeUrl?: string;
};

export type MixtapeUpdateOptions = {
  durationMs?: string;
  json: boolean;
  mixcloudUrl?: string;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
  youtubeUrl?: string;
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

function buildBody(options: MixtapeCreateOptions | MixtapeUpdateOptions): MixtapeRequestBody {
  const body: MixtapeRequestBody = {};

  if (options.note !== undefined) {
    body.note = options.note;
  }
  if (options.recordedAt !== undefined) {
    body.recordedAt = options.recordedAt;
  }
  if (options.mixcloudUrl !== undefined) {
    body.mixcloudUrl = options.mixcloudUrl;
  }
  if (options.youtubeUrl !== undefined) {
    body.youtubeUrl = options.youtubeUrl;
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
      const startMs = parseDuration(match[1]);
      if (startMs === null) {
        continue;
      }
      entries.push({ ref: match[2].trim(), startMs });
    } else {
      entries.push({ ref: trimmed });
    }
  }

  return entries;
}

function parseDuration(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
      return null;
    }
    const nums = parts.map((part) => Number(part));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      return null;
    }
    if (parts.length === 3) {
      const [hours, minutes, seconds] = nums;
      if (minutes >= 60 || seconds >= 60) {
        return null;
      }
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
    const [minutes, seconds] = nums;
    if (seconds >= 60) {
      return null;
    }
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
