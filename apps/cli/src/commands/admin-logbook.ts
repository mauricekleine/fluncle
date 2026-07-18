import { type LogbookEntryResponse, type LogbookGapsResponse } from "@fluncle/contracts";
import { existsSync, readFileSync } from "node:fs";
import { adminApiGet, adminApiPatch, adminApiPost } from "../api";
import { CliError } from "../output";

// The CLI relay for Fluncle's Logbook (the on-box `fluncle-logbook` sweep's hands).
// Convention B `verb_noun`:
//   - `admin logbook gaps`   → list_logbook_gaps (GET /admin/logbook/gaps) — admin tier.
//   - `admin logbook create` → create_logbook_entry (POST /admin/logbook/{sector}) — admin tier (fill-empty-only).
//   - `admin logbook update` → update_logbook_entry (PATCH /admin/logbook/{sector}) — OPERATOR tier (agent → 403).
//
// The Worker owns the store + the voice gate; the CLI stays a thin HTTP client — it
// authors nothing (the sweep's `claude -p` step does), it only relays the authored
// title + body to the fill-empty-only endpoint.

export type LogbookGap = LogbookGapsResponse["gaps"][number];
export type LogbookSpentEntry = LogbookGapsResponse["spent"][number];

/**
 * The sweep's queue + material: sector-days with findings but no entry (oldest first) AND
 * `spent` — the recent authored entries' titles + opener/closer moves, the anti-sameness
 * fuel the author writes against. Passes both through so the sweep sees the full response.
 */
export async function logbookGapsCommand(
  limit?: number,
): Promise<{ gaps: LogbookGap[]; spent: LogbookSpentEntry[] }> {
  const query = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const response = await adminApiGet<LogbookGapsResponse>(`/api/admin/logbook/gaps${query}`);

  return { gaps: response.gaps, spent: response.spent };
}

export type LogbookWriteOptions = {
  body?: string;
  bodyFile?: string;
  /**
   * PROVENANCE — the prompt-registry version the `fluncle-logbook` sweep authored this
   * entry under (0 = the baked default, N = override N). Sent only by the agent CREATE;
   * the operator overwrite ignores it, because no prompt wrote a hand-typed entry.
   * See docs/agents/prompt-registry.md.
   */
  promptVersion?: number;
  title?: string;
};

/** Read the body: the inline `--body` wins, else the `--body-file` (the sweep's path). */
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

/**
 * Author a sector's entry — the FILL-EMPTY-ONLY create (admin tier). A sector that
 * already has an entry is a no-op (`skipped: true` in the response); the sweep treats
 * that as done, never a failure.
 */
export async function logbookCreateCommand(
  sector: string,
  options: LogbookWriteOptions,
): Promise<LogbookEntryResponse> {
  return adminApiPost<LogbookEntryResponse>(`/api/admin/logbook/${encodeURIComponent(sector)}`, {
    body: resolveBody(options),
    // PROVENANCE — omitted when the sweep fell back to its baked-in prompt, so the column
    // stays NULL (docs/agents/prompt-registry.md).
    ...(typeof options.promptVersion === "number" ? { promptVersion: options.promptVersion } : {}),
    title: requireTitle(options),
  });
}

/**
 * Create-or-overwrite a sector's entry — the OPERATOR path (agent token → 403). It
 * CAN replace a cron-authored entry and stamps it operator-authored (sacred).
 */
export async function logbookUpdateCommand(
  sector: string,
  options: LogbookWriteOptions,
): Promise<LogbookEntryResponse> {
  return adminApiPatch<LogbookEntryResponse>(`/api/admin/logbook/${encodeURIComponent(sector)}`, {
    body: resolveBody(options),
    title: requireTitle(options),
  });
}
