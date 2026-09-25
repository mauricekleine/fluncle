import { type LogbookEntryResponse, type LogbookGapsResponse } from "@fluncle/contracts";
import { existsSync, readFileSync } from "node:fs";
import { adminApiGet, adminApiPatch, adminApiPost } from "../api";
import { CliError } from "../output";

export type LogbookGap = LogbookGapsResponse["gaps"][number];
export type LogbookSpentEntry = LogbookGapsResponse["spent"][number];

export async function logbookGapsCommand(
  limit?: number,
): Promise<{ gaps: LogbookGap[]; spent: LogbookSpentEntry[] }> {
  const query = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const response = await adminApiGet<LogbookGapsResponse>(`/api/v1/admin/logbook/gaps${query}`);

  return { gaps: response.gaps, spent: response.spent };
}

export type LogbookWriteOptions = {
  body?: string;
  bodyFile?: string;

  promptVersion?: number;
  title?: string;
};

function resolveBody(options: LogbookWriteOptions): string {
  if (options.body !== undefined) {
    return options.body;
  }

  if (options.bodyFile !== undefined) {
    if (!existsSync(options.bodyFile)) {
      throw new CliError("file_not_found", `Body file not found: ${options.bodyFile}`);
    }

    return readFileSync(options.bodyFile, "utf-8");
  }

  throw new CliError(
    "missing_body",
    "An entry needs a body via --body <text> or --body-file <entry.md>",
  );
}

function requireTitle(options: LogbookWriteOptions): string {
  if (options.title === undefined || !options.title.trim()) {
    throw new CliError("missing_title", "An entry needs a title via --title <text>");
  }

  return options.title;
}

export async function logbookCreateCommand(
  sector: string,
  options: LogbookWriteOptions,
): Promise<LogbookEntryResponse> {
  return adminApiPost<LogbookEntryResponse>(`/api/v1/admin/logbook/${encodeURIComponent(sector)}`, {
    body: resolveBody(options),

    ...(typeof options.promptVersion === "number" ? { promptVersion: options.promptVersion } : {}),
    title: requireTitle(options),
  });
}

export async function logbookUpdateCommand(
  sector: string,
  options: LogbookWriteOptions,
): Promise<LogbookEntryResponse> {
  return adminApiPatch<LogbookEntryResponse>(
    `/api/v1/admin/logbook/${encodeURIComponent(sector)}`,
    {
      body: resolveBody(options),
      title: requireTitle(options),
    },
  );
}
