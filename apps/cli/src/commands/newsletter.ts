import { type EditionResponse, type EditionsResponse } from "@fluncle/contracts";
import { existsSync, readFileSync } from "node:fs";
import { adminApiDelete, adminApiGet, adminApiPatch, adminApiPost } from "../api";
import { CliError } from "../output";

// The CLI relay for the newsletter edition control plane (the Hermes Friday cron's
// hands). Convention B `verb_noun`:
//   - `admin newsletter draft`  → create_edition (POST /admin/newsletter/editions) — admin tier.
//   - `admin newsletter update` → update_edition (PATCH /admin/newsletter/editions/{id}) — admin tier.
//   - `admin newsletter send`   → send_edition (POST /admin/newsletter/editions/{id}/send) — OPERATOR tier (agent → 403).
//   - `admin newsletter list`   → list_editions_admin (GET /admin/newsletter/editions, drafts inclusive) — admin tier.
//
// The Worker holds RESEND_API_KEY + the segment id; the send creates + sends the
// Resend broadcast and mints the edition number server-side. The CLI stays a thin
// HTTP client — it never touches Resend directly.

export type EditionListItem = EditionsResponse["editions"][number];

export type NewsletterDraftOptions = {
  contentFile?: string;
  json: boolean;
  /**
   * PROVENANCE — the prompt-registry version the `fluncle-newsletter` sweep authored this
   * edition under (0 = the baked default, N = override N). Set on the DRAFT (create) only:
   * a later edit does not change who drafted it. See docs/agents/prompt-registry.md.
   */
  promptVersion?: number;
  subject?: string;
  windowSince?: string;
  windowUntil?: string;
};

export type NewsletterUpdateOptions = NewsletterDraftOptions;

/** The body shared by draft (create) + update — content is required on create only. */
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

  // PROVENANCE — only on the CREATE, and only when the sweep actually ran a registry
  // prompt (omitted ⇒ the column stays NULL, the honest record).
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

// The agent authors the structured `content` payload (intro / galaxies / mixtapeRef
// / tidbits — the single source the archive page + the email HTML both render from)
// and hands it in as a JSON file. Parse it here so a malformed payload fails the CLI
// with a clear message rather than a server `invalid_content`.
function readContentFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new CliError("file_not_found", `Content file not found: ${filePath}`);
  }

  const text = readFileSync(filePath, "utf-8");

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(
      "invalid_content_json",
      `Content JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Persist the authored draft (no number yet) — the durable artifact, persist-first. */
export async function newsletterDraftCommand(
  options: NewsletterDraftOptions,
): Promise<EditionResponse> {
  return adminApiPost<EditionResponse>(
    "/api/v1/admin/newsletter/editions",
    buildBody(options, { requireContent: true }),
  );
}

/** Update a draft's payload/subject/window before send (sent editions are frozen). */
export async function newsletterUpdateCommand(
  id: string,
  options: NewsletterUpdateOptions,
): Promise<EditionResponse> {
  return adminApiPatch<EditionResponse>(
    `/api/v1/admin/newsletter/editions/${encodeURIComponent(id)}`,
    buildBody(options, { requireContent: false }),
  );
}

/**
 * Send the edition (OPERATOR tier — the human gate). The Worker renders the HTML,
 * creates + sends the Resend broadcast, and mints the number. A valid AGENT token
 * gets a 403 here, by design: the cron offers the Discord button, the operator sends.
 */
export async function newsletterSendCommand(id: string): Promise<EditionResponse> {
  return adminApiPost<EditionResponse>(
    `/api/v1/admin/newsletter/editions/${encodeURIComponent(id)}/send`,
  );
}

/**
 * The full edition list INCLUDING drafts (admin tier) — distinct from the public
 * sent-only archive. The Friday cron reads this from a fresh session to find an
 * unsent draft to re-offer (the miss-recovery) before authoring a new one, and to
 * read the last sent edition's `windowUntil` cutoff for the self-healing window.
 */
export async function newsletterListCommand(): Promise<EditionListItem[]> {
  const response = await adminApiGet<EditionsResponse>("/api/v1/admin/newsletter/editions");

  return response.editions;
}

/**
 * HARD-delete an edition at ANY status (OPERATOR tier — the same gate as send).
 * Drafts and sent back-issues alike: a hollow edition that already mailed is exactly
 * what the operator pulls from the public archive, which reopens the self-healing send
 * window so the dropped finds re-enter the next edition. A valid AGENT token gets a 403.
 */
export async function newsletterDeleteCommand(id: string): Promise<{ id: string }> {
  return adminApiDelete<{ id: string }>(
    `/api/v1/admin/newsletter/editions/${encodeURIComponent(id)}`,
  );
}
