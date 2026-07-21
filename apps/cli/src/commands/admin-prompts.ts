// The `fluncle admin prompts` commands — the prompt registry's thin HTTP client.
//
// Every prompt Fluncle feeds a model lives in the database now, versioned, editable with
// no deploy (apps/web/src/lib/server/prompts.ts). The repo keeps a baked default at
// version 0; a DB row overrides it; the history only ever grows.
//
// THE API IS TWO READS AND ONE WRITE. That is the whole surface:
//   - `list_prompts`  (GET /admin/prompts, OPERATOR) — every prompt, its baked default,
//     the body running now, and its complete history. One call feeds every read command
//     here, so `list`, `history`, and `diff` all ride it and never round-trip twice.
//   - `get_prompt`    (GET /admin/prompts/{slug}, agent tier) — the lean resolve the
//     on-box sweeps make each tick: the body, its version, where it came from.
//   - `update_prompt` (POST /admin/prompts/{slug}, OPERATOR) — appends a version.
//
// SO `rollback` AND `reset` ADD NO VERB. They are client-side compositions: read the
// history, take a body out of it (an old version, or the repo's default), and append it
// through the same one write. That is what an append-only history buys — a rollback is
// itself rollback-able, because nothing rewinds and nothing is destroyed. The CLI holds
// no prompt logic beyond picking WHICH body to send back.

import { existsSync, readFileSync } from "node:fs";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";

// The wire shapes, mirroring `packages/contracts/src/orpc/admin-prompts.ts`. Declared
// here (the `admin-catalogue` precedent) because the contract's detail schemas are
// module-local; the field names are the contract's, verbatim.

/** One appended version — never mutated, never deleted. */
export type PromptVersionItem = {
  body: string;
  createdAt: string;
  createdBy: "agent" | "operator";
  id: string;
  /** The operator's WHY for the edit. */
  note: string | null;
  version: number;
};

/** One registered prompt, whole: the repo's default, the live body, the full history. */
export type PromptDetail = {
  /** The body running right now: the newest override, else `defaultBody`. */
  activeBody: string;
  /** 0 when the baked default is live; else the live override's version. */
  activeVersion: number;
  defaultBody: string;
  description: string;
  slug: string;
  source: "default" | "override";
  /** `box` — live on the next sweep tick. `worker` — live on the next request. */
  surface: "box" | "worker";
  title: string;
  variables: string[];
  /** Newest first; empty when the prompt has never been overridden. */
  versions: PromptVersionItem[];
};

/** The lean resolve (`get_prompt`) — what a sweep reads each tick. */
export type ResolvedPrompt = {
  body: string;
  ok: true;
  slug: string;
  source: "default" | "override";
  version: number;
};

/** The one write's result: the version it minted. */
export type AppendedVersion = { ok: true; version: number };

// ── The two reads ───────────────────────────────────────────────────────────

/** Every registered prompt with its live body and full history (`list_prompts`). */
export async function promptsListCommand(): Promise<PromptDetail[]> {
  const response = await adminApiGet<{ ok: true; prompts: PromptDetail[] }>(
    "/api/v1/admin/prompts",
  );

  return response.prompts;
}

/** The body running right now, plus its version and source (`get_prompt`). */
export async function promptGetCommand(slug: string): Promise<ResolvedPrompt> {
  return adminApiGet<ResolvedPrompt>(`/api/v1/admin/prompts/${encodeURIComponent(slug)}`);
}

/**
 * One prompt, whole — the read `history`, `diff`, `rollback`, and `reset` all start from,
 * because each of them needs a body the lean resolve does not carry (an old version's, or
 * the repo's default). An unknown slug is caught here rather than at the server, so the
 * error can name the ones that do exist.
 */
export async function promptDetailCommand(slug: string): Promise<PromptDetail> {
  const prompts = await promptsListCommand();
  const detail = prompts.find((prompt) => prompt.slug === slug);

  if (!detail) {
    throw new CliError(
      "unknown_prompt",
      `No prompt goes by "${slug}". The registered ones: ${prompts.map((prompt) => prompt.slug).join(", ")}`,
    );
  }

  return detail;
}

// ── The one write, and the three shapes it takes ────────────────────────────

export type PromptUpdateOptions = {
  bodyFile?: string;
  note?: string;
};

/** Read the new body off `--body-file`. A prompt is prose; it travels as a file. */
function resolveBody(options: PromptUpdateOptions): string {
  if (options.bodyFile === undefined) {
    throw new CliError(
      "missing_body",
      "An edit needs a body via --body-file <prompt.txt>. Start from `fluncle admin prompts get <slug> --json | jq -r .body`.",
    );
  }

  if (!existsSync(options.bodyFile)) {
    throw new CliError("file_not_found", `Body file not found: ${options.bodyFile}`);
  }

  const body = readFileSync(options.bodyFile, "utf-8");

  if (body.trim().length === 0) {
    throw new CliError("empty_body", "A prompt body cannot be empty. Nothing was appended.");
  }

  return body;
}

/** Append an operator's edit as a new version (`update_prompt`). */
export async function promptUpdateCommand(
  slug: string,
  options: PromptUpdateOptions,
): Promise<{ slug: string; version: number }> {
  const body = resolveBody(options);
  const note = options.note?.trim();
  const response = await adminApiPost<AppendedVersion>(
    `/api/v1/admin/prompts/${encodeURIComponent(slug)}`,
    note ? { body, note } : { body },
  );

  return { slug, version: response.version };
}

export type PromptRestoreResult = {
  /** The version the body came from: an old version's number, or 0 for the repo default. */
  from: number;
  /** True when that body is already the one running — nothing was appended. */
  skipped: boolean;
  slug: string;
  /** The version now live: the one this minted, or the standing one when skipped. */
  version: number;
};

/**
 * ROLL BACK to version N — the safety net. It re-appends N's body as a NEW version rather
 * than rewinding to it, so the history stays a complete record and this move is itself
 * undoable. A no-op when N's body is already the one running.
 */
export async function promptRollbackCommand(
  slug: string,
  version: number,
): Promise<PromptRestoreResult> {
  const detail = await promptDetailCommand(slug);
  const target = detail.versions.find((candidate) => candidate.version === version);

  if (!target) {
    const known = detail.versions.map((candidate) => `v${candidate.version}`).join(", ");
    throw new CliError(
      "unknown_version",
      known.length > 0
        ? `${slug} has no v${version}. On file: ${known}. For the repo's baked default, run \`fluncle admin prompts reset ${slug}\`.`
        : `${slug} has no history yet: the repo's baked default is what runs. There is nothing to roll back to.`,
    );
  }

  return restore(detail, { body: target.body, from: version, note: `rolled back to v${version}` });
}

/**
 * RESET to the repo's baked default — the floor every failure path already falls back to,
 * put back on purpose. Same append, body taken from the repo instead of the history. A
 * no-op when the default is already what runs.
 */
export async function promptResetCommand(slug: string): Promise<PromptRestoreResult> {
  const detail = await promptDetailCommand(slug);

  return restore(detail, {
    body: detail.defaultBody,
    from: 0,
    note: "reset to the repo's baked default",
  });
}

/** The shared tail of `rollback` and `reset`: append the body, unless it is already live. */
async function restore(
  detail: PromptDetail,
  input: { body: string; from: number; note: string },
): Promise<PromptRestoreResult> {
  if (input.body.trim() === detail.activeBody.trim()) {
    return { from: input.from, skipped: true, slug: detail.slug, version: detail.activeVersion };
  }

  const response = await adminApiPost<AppendedVersion>(
    `/api/v1/admin/prompts/${encodeURIComponent(detail.slug)}`,
    { body: input.body, note: input.note },
  );

  return { from: input.from, skipped: false, slug: detail.slug, version: response.version };
}

// ── The diff (dependency-free, line-level) ──────────────────────────────────

/** What the live body is measured against: the repo's default, or one stored version. */
export type DiffAgainst = { kind: "default" } | { kind: "version"; version: number };

/** One line of the diff. `remove` came out of the against-body, `add` is in the live one. */
export type DiffLine = { kind: "add" | "context" | "remove"; text: string };

export type PromptDiffResult = {
  added: number;
  /** Version 0 is the repo's baked default. */
  against: { label: string; version: number };
  lines: DiffLine[];
  live: { source: "default" | "override"; version: number };
  removed: number;
  slug: string;
};

/** `--against <version|default>`: `default` (the default), `3`, or `v3`. */
export function parseAgainst(value: string | undefined): DiffAgainst {
  if (value === undefined || value.trim().toLowerCase() === "default") {
    return { kind: "default" };
  }

  const version = parseVersion(value);

  if (version === undefined) {
    throw new CliError(
      "invalid_against",
      `--against takes a version (3, or v3) or the word default. Got "${value}".`,
    );
  }

  return { kind: "version", version };
}

/** A version argument: `3` or `v3`. Undefined when it is neither. */
export function parseVersion(value: string): number | undefined {
  const digits = /^v?(\d+)$/.exec(value.trim());
  const parsed = digits?.[1];

  if (parsed === undefined) {
    return undefined;
  }

  const version = Number.parseInt(parsed, 10);

  return Number.isFinite(version) && version > 0 ? version : undefined;
}

/** A body as diffable lines; a trailing newline is not a line. */
export function bodyLines(body: string): string[] {
  return body.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

/**
 * The line diff. A textbook LCS — no dependency, and a prompt is a page of prose, so the
 * quadratic table is a few thousand cells. The table is a flat `Int32Array` read through
 * `lcs()`, which floors an out-of-range cell at 0 rather than reaching for a `!`.
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const rows = before.length;
  const cols = after.length;
  const width = cols + 1;
  const lengths = new Int32Array((rows + 1) * width);
  const lcs = (row: number, col: number): number => lengths[row * width + col] ?? 0;

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      lengths[row * width + col] =
        before[row] === after[col]
          ? lcs(row + 1, col + 1) + 1
          : Math.max(lcs(row + 1, col), lcs(row, col + 1));
    }
  }

  const lines: DiffLine[] = [];
  let row = 0;
  let col = 0;

  while (row < rows && col < cols) {
    if (before[row] === after[col]) {
      lines.push({ kind: "context", text: before[row] ?? "" });
      row += 1;
      col += 1;
      continue;
    }

    if (lcs(row + 1, col) >= lcs(row, col + 1)) {
      lines.push({ kind: "remove", text: before[row] ?? "" });
      row += 1;
      continue;
    }

    lines.push({ kind: "add", text: after[col] ?? "" });
    col += 1;
  }

  while (row < rows) {
    lines.push({ kind: "remove", text: before[row] ?? "" });
    row += 1;
  }

  while (col < cols) {
    lines.push({ kind: "add", text: after[col] ?? "" });
    col += 1;
  }

  return lines;
}

/**
 * Render the diff for a terminal: `-` came out, `+` went in, two spaces carried over. No
 * colour, because the CLI has no colour helper to borrow and a diff that only reads in a
 * colour terminal is a diff that does not read in a pipe.
 */
export function renderDiff(lines: DiffLine[]): string[] {
  return lines.map((line) => {
    const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";

    return `${marker} ${line.text}`;
  });
}

/** The live body against the repo's default (or against one stored version). */
export async function promptDiffCommand(
  slug: string,
  against: DiffAgainst,
): Promise<PromptDiffResult> {
  const detail = await promptDetailCommand(slug);

  const from =
    against.kind === "default"
      ? { body: detail.defaultBody, label: "the repo's baked default", version: 0 }
      : resolveAgainstVersion(detail, against.version);

  const lines = diffLines(bodyLines(from.body), bodyLines(detail.activeBody));

  return {
    added: lines.filter((line) => line.kind === "add").length,
    against: { label: from.label, version: from.version },
    lines,
    live: { source: detail.source, version: detail.activeVersion },
    removed: lines.filter((line) => line.kind === "remove").length,
    slug: detail.slug,
  };
}

function resolveAgainstVersion(
  detail: PromptDetail,
  version: number,
): { body: string; label: string; version: number } {
  const target = detail.versions.find((candidate) => candidate.version === version);

  if (!target) {
    const known = detail.versions.map((candidate) => `v${candidate.version}`).join(", ");
    throw new CliError(
      "unknown_version",
      known.length > 0
        ? `${detail.slug} has no v${version}. On file: ${known}.`
        : `${detail.slug} has no history yet. Diff against the repo's default instead: drop --against.`,
    );
  }

  return { body: target.body, label: `v${version}`, version };
}

// ── The rows the terminal prints ────────────────────────────────────────────

/**
 * The registry, one prompt per line:
 *   note_author         box     v3        Finding note
 * The live column says what is actually running: `default` (the repo's body) or `vN`.
 */
export function promptRows(prompts: PromptDetail[]): string[] {
  const slugWidth = prompts.reduce((width, prompt) => Math.max(width, prompt.slug.length), 0);
  const surfaceWidth = prompts.reduce((width, prompt) => Math.max(width, prompt.surface.length), 0);

  return prompts.map((prompt) => {
    const live = prompt.source === "override" ? `v${prompt.activeVersion}` : "default";

    return `${prompt.slug.padEnd(slugWidth)}  ${prompt.surface.padEnd(surfaceWidth)}  ${live.padEnd(7)}  ${prompt.title}`;
  });
}

/**
 * The history, newest first:
 *   v3  2026-07-11  operator  shortened the neighbour block
 * A version with no note reads as an em-dashless blank, because the note is the operator's
 * WHY and an invented one would be a lie.
 */
export function historyRows(versions: PromptVersionItem[]): string[] {
  return versions.map((version) => {
    const when = version.createdAt.slice(0, 10);
    const note = version.note?.trim();

    return `v${version.version}  ${when}  ${version.createdBy.padEnd(8)}  ${note && note.length > 0 ? note : "(no note)"}`;
  });
}
