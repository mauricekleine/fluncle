import { existsSync, readFileSync } from "node:fs";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";

export type PromptVersionItem = {
  body: string;
  createdAt: string;
  createdBy: "agent" | "operator";
  id: string;

  note: string | null;
  version: number;
};

export type PromptDetail = {
  activeBody: string;

  activeVersion: number;
  defaultBody: string;
  description: string;
  slug: string;
  source: "default" | "override";

  surface: "box" | "worker";
  title: string;
  variables: string[];

  versions: PromptVersionItem[];
};

export type ResolvedPrompt = {
  body: string;
  ok: true;
  slug: string;
  source: "default" | "override";
  version: number;
};

type AppendedVersion = { ok: true; version: number };

export async function promptsListCommand(): Promise<PromptDetail[]> {
  const response = await adminApiGet<{ ok: true; prompts: PromptDetail[] }>(
    "/api/v1/admin/prompts",
  );

  return response.prompts;
}

export async function promptGetCommand(slug: string): Promise<ResolvedPrompt> {
  return adminApiGet<ResolvedPrompt>(`/api/v1/admin/prompts/${encodeURIComponent(slug)}`);
}

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

export type PromptUpdateOptions = {
  bodyFile?: string;
  note?: string;
};

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
  from: number;

  skipped: boolean;
  slug: string;

  version: number;
};

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

export async function promptResetCommand(slug: string): Promise<PromptRestoreResult> {
  const detail = await promptDetailCommand(slug);

  return restore(detail, {
    body: detail.defaultBody,
    from: 0,
    note: "reset to the repo's baked default",
  });
}

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

export type DiffAgainst = { kind: "default" } | { kind: "version"; version: number };

export type DiffLine = { kind: "add" | "context" | "remove"; text: string };

export type PromptDiffResult = {
  added: number;

  against: { label: string; version: number };
  lines: DiffLine[];
  live: { source: "default" | "override"; version: number };
  removed: number;
  slug: string;
};

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

export function parseVersion(value: string): number | undefined {
  const digits = /^v?(\d+)$/.exec(value.trim());
  const parsed = digits?.[1];

  if (parsed === undefined) {
    return undefined;
  }

  const version = Number.parseInt(parsed, 10);

  return Number.isFinite(version) && version > 0 ? version : undefined;
}

export function bodyLines(body: string): string[] {
  return body.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

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

export function renderDiff(lines: DiffLine[]): string[] {
  return lines.map((line) => {
    const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";

    return `${marker} ${line.text}`;
  });
}

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

export function promptRows(prompts: PromptDetail[]): string[] {
  const slugWidth = prompts.reduce((width, prompt) => Math.max(width, prompt.slug.length), 0);
  const surfaceWidth = prompts.reduce((width, prompt) => Math.max(width, prompt.surface.length), 0);

  return prompts.map((prompt) => {
    const live = prompt.source === "override" ? `v${prompt.activeVersion}` : "default";

    return `${prompt.slug.padEnd(slugWidth)}  ${prompt.surface.padEnd(surfaceWidth)}  ${live.padEnd(7)}  ${prompt.title}`;
  });
}

export function historyRows(versions: PromptVersionItem[]): string[] {
  return versions.map((version) => {
    const when = version.createdAt.slice(0, 10);
    const note = version.note?.trim();

    return `v${version.version}  ${when}  ${version.createdBy.padEnd(8)}  ${note && note.length > 0 ? note : "(no note)"}`;
  });
}
