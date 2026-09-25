import { liveSurfaces } from "@fluncle/registry";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { BANNED_WORDS } from "./voice-words";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const SCAN_ROOTS = [
  "apps/web/src/routes",
  "apps/web/src/components",
  "apps/mobile/src",

  "apps/mobile/app",
  "apps/extension/src",
  "apps/cli/src",

  "apps/cli/scripts",

  "apps/web/src/game",

  "apps/web/src/lib/tool-specs.ts",

  "apps/web/src/lib/server/agent-discovery.ts",

  "apps/web/src/lib/identity.ts",

  "apps/web/src/lib/log-prose.ts",

  "apps/web/src/lib/server/telegram.ts",
  "apps/web/src/lib/server/bluesky.ts",
  "apps/web/src/lib/server/push.ts",

  "apps/web/src/lib/server/edition-email.ts",
];

const SKIPPED_DIRECTORIES = [
  "apps/web/src/components/admin",
  "apps/web/src/routes/admin",
  "apps/web/src/routes/api/admin",
  "apps/web/src/routes/api/v1/admin",
];

const EM_DASH_EXEMPT_PREFIXES = ["apps/cli/src/cli.ts", "apps/cli/src/commands/admin-"];

const COPY_KEYS = new Set([
  "alt",
  "aria-label",
  "ariaLabel",
  "body",
  "description",
  "label",
  "message",
  "placeholder",
  "title",
]);

const SCANNED_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

const TRACKLIST_SEPARATOR = /^\s*—\s*$/;

const KEY_VALUE_PREFIX = /^[A-Za-z][\w-]*(?: [\w-]+)?: /;

const COPY_MODULE = /(?:^|\/)(?:copy|[\w-]+-copy)\.tsx?$/;
const COPY_IDENTIFIER = /copy$/i;

const BANNED_WORD_MATCHERS = BANNED_WORDS.map((word) => new RegExp(`\\b${word}\\b`, "i"));

type Rail = "banned-word" | "exclamation" | "prose-em-dash";

type Violation = { file: string; line: number; rail: Rail; text: string };

type Literal = { isCopy: boolean; isJsxText: boolean; line: number; text: string };

function emDashApplies(file: string): boolean {
  return !EM_DASH_EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function collectFiles(root: string, files: string[]): void {
  if (statSync(join(REPO_ROOT, root)).isFile()) {
    files.push(root);
    return;
  }

  for (const entry of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
    const child = `${root}/${entry.name}`;

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.includes(child)) {
        collectFiles(child, files);
      }
      continue;
    }

    if (entry.name.endsWith(".d.ts") || /\.test\./.test(entry.name)) {
      continue;
    }

    if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(child);
    }
  }
}

function sourceLineAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function literalFromRecord(
  record: Record<string, unknown>,
  line: number,
  isCopy: boolean,
  inCopyModule: boolean,
): Literal | undefined {
  if (record.type === "JSXText" && typeof record.value === "string") {
    const text = record.value.replace(/\s+/g, " ").trim();
    return text.length > 0 ? { isCopy: true, isJsxText: true, line, text } : undefined;
  }
  if (record.type === "Literal" && typeof record.value === "string") {
    return { isCopy: isCopy || inCopyModule, isJsxText: false, line, text: record.value };
  }
  if (record.type !== "TemplateElement") {
    return undefined;
  }
  const cooked = (record.value as { cooked?: unknown } | undefined)?.cooked;
  return typeof cooked === "string" && cooked.trim().length > 0
    ? { isCopy: isCopy || inCopyModule, isJsxText: false, line, text: cooked }
    : undefined;
}

function collectLiterals(file: string, source: string): Literal[] {
  const parsed = parseSync(file, source);

  if (parsed.errors.length > 0) {
    throw new Error(
      `voice lint could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const lineStarts = sourceLineStarts(source);

  const inCopyModule = COPY_MODULE.test(file);
  const literals: Literal[] = [];

  const visit = (node: unknown, isCopy: boolean): void => {
    if (node === null || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child, isCopy);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    const line = sourceLineAt(lineStarts, typeof record.start === "number" ? record.start : 0);

    const literal = literalFromRecord(record, line, isCopy, inCopyModule);
    if (literal) {
      literals.push(literal);
    }

    if (record.type === "VariableDeclarator") {
      const id = record.id as Record<string, unknown> | undefined;
      if (typeof id?.name === "string" && COPY_IDENTIFIER.test(id.name)) {
        visit(record.init, true);
        return;
      }
    }

    if (record.type === "Property" || record.type === "PropertyDefinition") {
      const key = record.key as Record<string, unknown> | undefined;
      const name =
        typeof key?.name === "string" ? key.name : typeof key?.value === "string" ? key.value : "";
      visit(record.value, isCopy || COPY_KEYS.has(name));
      visit(record.key, false);
      return;
    }

    if (record.type === "JSXAttribute") {
      const name = record.name as Record<string, unknown> | undefined;
      visit(record.value, typeof name?.name === "string" && COPY_KEYS.has(name.name));
      return;
    }

    for (const key of Object.keys(record)) {
      if (key !== "type" && key !== "start" && key !== "end") {
        visit(record[key], isCopy);
      }
    }
  };

  visit(parsed.program as unknown, false);
  return literals;
}

function isProse(literal: Literal): boolean {
  if (literal.isJsxText) {
    return true;
  }

  if (/[<>{};=]/.test(literal.text) || KEY_VALUE_PREFIX.test(literal.text)) {
    return false;
  }

  if (literal.text.includes("//")) {
    return false;
  }

  if (literal.isCopy) {
    return true;
  }

  return literal.text.trim().split(/\s+/).filter(Boolean).length >= 4;
}

function isExcused(file: string, rail: Rail, literal: Literal): boolean {
  return (
    file === "apps/cli/src/commands/recordings.ts" &&
    rail === "prose-em-dash" &&
    literal.text === "— (no set video)"
  );
}

function scanSource(file: string, source: string, options: { emDash: boolean }): Violation[] {
  const violations: Violation[] = [];

  const report = (rail: Rail, literal: Literal): void => {
    if (!isExcused(file, rail, literal)) {
      violations.push({ file, line: literal.line, rail, text: literal.text });
    }
  };

  for (const literal of collectLiterals(file, source)) {
    if (isProse(literal)) {
      if (BANNED_WORD_MATCHERS.some((matcher) => matcher.test(literal.text))) {
        report("banned-word", literal);
      }

      if (literal.text.includes("!")) {
        report("exclamation", literal);
      }
    }

    if (options.emDash && literal.text.includes("—") && !TRACKLIST_SEPARATOR.test(literal.text)) {
      report("prose-em-dash", literal);
    }
  }

  return violations;
}

function formatViolation(violation: Violation): string {
  return `${violation.rail} ${violation.file}:${violation.line} ${JSON.stringify(violation.text)}`;
}

function scanEverything(): { files: string[]; violations: Violation[] } {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(root, files);
  }

  const violations: Violation[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    violations.push(...scanSource(file, source, { emDash: emDashApplies(file) }));
  }

  return { files, violations };
}

describe("voice lint", () => {
  it("finds no banned word, prose em dash, or exclamation mark in a user-facing literal", () => {
    const { violations } = scanEverything();
    expect(violations.map(formatViolation)).toEqual([]);
  });

  it("draws its net where it says: the public surfaces in, the operator workstation out", () => {
    const { files } = scanEverything();
    const scanned = new Set(files);

    expect(scanned.has("apps/web/src/routes/privacy.tsx")).toBe(true);
    expect(scanned.has("apps/web/src/components/search/search-command.tsx")).toBe(true);
    expect(scanned.has("apps/mobile/src/lib/feed-state.ts")).toBe(true);
    expect(scanned.has("apps/mobile/app/(tabs)/archive.tsx")).toBe(true);
    expect(scanned.has("apps/extension/src/copy.ts")).toBe(true);
    expect(scanned.has("apps/cli/src/cli.ts")).toBe(true);
    expect(scanned.has("apps/cli/scripts/build-npm.ts")).toBe(true);
    expect(scanned.has("apps/web/src/game/game.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/tool-specs.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/agent-discovery.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/identity.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/log-prose.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/telegram.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/bluesky.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/push.ts")).toBe(true);

    const strays = [...scanned].filter(
      (file) =>
        file.includes(".test.") ||
        SKIPPED_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)),
    );
    expect(strays).toEqual([]);

    expect(emDashApplies("apps/cli/src/cli.ts")).toBe(false);
    expect(emDashApplies("apps/cli/src/commands/admin-tracks.ts")).toBe(false);
    expect(emDashApplies("apps/cli/src/commands/recent.ts")).toBe(true);
    expect(emDashApplies("apps/web/src/routes/privacy.tsx")).toBe(true);
  });
});

const FIXTURE_FILE = "fixture.tsx";

const FIXTURE_SOURCE = `export function Fixture() {
  const separator = " — ";
  const bannedWord = "The signal came back clean from out there tonight";
  const proseDash = "Two things happened tonight — the second one was louder";
  const shouty = "Three findings landed on the log tonight!";
  const contentType = "Content-Type";
  const cssClass = "search-note search-note--degraded";
  const keyValue = "Curation: off";
  const midSentenceColon = "Two things tonight: the curated shelf went quiet";
  const curated = "The curated selection landed on the log tonight";
  const transmission = "A transmission arrived from out there tonight";
  return (
    <p>
      Body text with a dash — right here
      <span>An anomaly landed on the log here tonight</span>
    </p>
  );
}

export const fixtureCopy = {
  empty: { title: "Lost the signal" },
  footer: "Curated by hand",
};
`;

describe("voice lint rails", () => {
  const fired = scanSource(FIXTURE_FILE, FIXTURE_SOURCE, { emDash: true });
  const textsFor = (rail: Rail) =>
    fired.filter((violation) => violation.rail === rail).map((violation) => violation.text);

  it("fires on a banned identity word in prose", () => {
    expect(textsFor("banned-word")).toEqual([
      "The signal came back clean from out there tonight",

      "Two things tonight: the curated shelf went quiet",
      "The curated selection landed on the log tonight",
      "A transmission arrived from out there tonight",
      "An anomaly landed on the log here tonight",

      "Lost the signal",

      "Curated by hand",
    ]);
  });

  it("fires on a prose em dash, in a quoted string and in JSX text alike", () => {
    expect(textsFor("prose-em-dash")).toEqual([
      "Two things happened tonight — the second one was louder",
      "Body text with a dash — right here",
    ]);
  });

  it("fires on an exclamation mark in prose", () => {
    expect(textsFor("exclamation")).toEqual(["Three findings landed on the log tonight!"]);
  });

  it("holds the separator, real `Key: value` pairs, and code strings", () => {
    const texts = fired.map((violation) => violation.text);
    expect(texts).not.toContain(" — ");
    expect(texts).not.toContain("Curation: off");
    expect(texts).not.toContain("Content-Type");
    expect(texts).not.toContain("search-note search-note--degraded");
  });

  it("holds every em dash when the file is in the CLI admin carve-out", () => {
    const cli = scanSource(FIXTURE_FILE, FIXTURE_SOURCE, { emDash: false });
    expect(cli.some((violation) => violation.rail === "prose-em-dash")).toBe(false);
    expect(cli.some((violation) => violation.rail === "banned-word")).toBe(true);
  });
});

const SERVICE_PROBE_MARKER = /service `([a-z0-9-]+)`/;

function publicRegistryStrings(): { text: string; where: string }[] {
  const strings: { text: string; where: string }[] = [];

  for (const surface of liveSurfaces()) {
    if (surface.title !== undefined) {
      strings.push({ text: surface.title, where: `${surface.name}.title` });
    }

    if (surface.statusDescription !== undefined) {
      strings.push({ text: surface.statusDescription, where: `${surface.name}.statusDescription` });
    }

    const label = surface.exposedContent[0];
    if (label !== undefined && SERVICE_PROBE_MARKER.test(surface.operatorNotes ?? "")) {
      strings.push({ text: label, where: `${surface.name}.exposedContent[0]` });
    }
  }

  return strings;
}

describe("voice lint over the surfaces registry", () => {
  it("finds no banned word, em dash, or exclamation mark in a public-rendering string", () => {
    const violations = publicRegistryStrings()
      .filter(
        ({ text }) =>
          text.includes("—") ||
          text.includes("!") ||
          BANNED_WORD_MATCHERS.some((matcher) => matcher.test(text)),
      )
      .map(({ text, where }) => `${where} ${JSON.stringify(text)}`);

    expect(violations).toEqual([]);
  });

  it("reads a non-empty set of public strings, including the /status service notes", () => {
    const strings = publicRegistryStrings();

    expect(strings.length).toBeGreaterThan(0);
    expect(strings.some(({ where }) => where.endsWith(".statusDescription"))).toBe(true);
    expect(strings.some(({ where }) => where.endsWith(".exposedContent[0]"))).toBe(true);
  });
});
