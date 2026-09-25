import { type EditionResponse, type EditionsResponse } from "@fluncle/contracts";
import { existsSync, readFileSync } from "node:fs";
import { adminApiDelete, adminApiGet, adminApiPatch, adminApiPost } from "../api";
import { CliError } from "../output";

export type EditionListItem = EditionsResponse["editions"][number];

export type NewsletterDraftOptions = {
  contentFile?: string;
  json: boolean;

  promptVersion?: number;
  subject?: string;
  windowSince?: string;
  windowUntil?: string;
};

export type NewsletterUpdateOptions = NewsletterDraftOptions;

function buildBody(
  options: NewsletterDraftOptions,
  { requireContent }: { requireContent: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (options.contentFile !== undefined) {
    body.contentJson = readContentFile(options.contentFile);
  } else if (requireContent) {
    throw new CliError(
      "missing_content",
      "A draft needs the structured content payload via --content-file <edition.json>",
    );
  }

  if (requireContent && typeof options.promptVersion === "number") {
    body.promptVersion = options.promptVersion;
  }

  if (options.subject !== undefined) {
    body.subject = options.subject;
  }
  if (options.windowSince !== undefined) {
    body.windowSince = options.windowSince;
  }
  if (options.windowUntil !== undefined) {
    body.windowUntil = options.windowUntil;
  }

  return body;
}

function readContentFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new CliError("file_not_found", `Edition payload file not found: ${filePath}`);
  }

  const text = readFileSync(filePath, "utf-8");

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(
      "invalid_content_json",
      `Edition payload JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function newsletterDraftCommand(
  options: NewsletterDraftOptions,
): Promise<EditionResponse> {
  return adminApiPost<EditionResponse>(
    "/api/v1/admin/newsletter/editions",
    buildBody(options, { requireContent: true }),
  );
}

export async function newsletterUpdateCommand(
  id: string,
  options: NewsletterUpdateOptions,
): Promise<EditionResponse> {
  return adminApiPatch<EditionResponse>(
    `/api/v1/admin/newsletter/editions/${encodeURIComponent(id)}`,
    buildBody(options, { requireContent: false }),
  );
}

export async function newsletterSendCommand(id: string): Promise<EditionResponse> {
  return adminApiPost<EditionResponse>(
    `/api/v1/admin/newsletter/editions/${encodeURIComponent(id)}/send`,
  );
}

export async function newsletterListCommand(): Promise<EditionListItem[]> {
  const response = await adminApiGet<EditionsResponse>("/api/v1/admin/newsletter/editions");

  return response.editions;
}

export async function newsletterDeleteCommand(id: string): Promise<{ id: string }> {
  return adminApiDelete<{ id: string }>(
    `/api/v1/admin/newsletter/editions/${encodeURIComponent(id)}`,
  );
}
