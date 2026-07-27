// The static VOICE LINT: a build-time scan of hand-written user-facing string
// literals, on the deploy boundary (it runs in `apps/web`'s vitest suite, which
// `deploy:gate` runs before `wrangler deploy`).
//
// WHY IT EXISTS. The Voice canon was enforced on AGENT-authored text at write
// time and on nothing else: `gateVoice`/`gateNoteText`/`gateBioText`/
// `gateLogbookBody` mean a model can never write "signal" onto a public surface,
// while the thousands of HAND-WRITTEN literals across the web, mobile, extension,
// and CLI surfaces had no check at all. Every canon ratification (the Chrome Rule,
// the Engine-Room Rule) then needed a manual cross-surface sweep, and each sweep
// demonstrably missed surfaces. This is the mechanical half of that sweep, run on
// every build. The judgment half — is this line said, not written; does it turn to
// the crew — stays with the `copywriting-fluncle` skill and the `canon-reviewer`.
//
// THE THREE RAILS. Only mechanically unambiguous rules land here. Measured over
// the scanned roots (276 files / ~13k literals): 7 true positives, 0 false
// positives, all 7 fixed in the commit that added this file.
//   (a) BANNED WORDS — VOICE.md §3, whole-word and case-insensitive, from the ONE
//       shared list in ./voice-words.ts (the runtime gates read the same array).
//       PROSE ONLY: `Content-Type`, `AbortSignal`, `contentEditable` and friends
//       are the large false-positive surface, and the prose heuristic below cuts
//       48 raw hits down to the 3 real ones.
//   (b) PROSE EM DASH — VOICE.md §6 sanctions exactly one em dash, the
//       `Artist — Title` tracklist separator. That separator is always written as
//       a literal that is ONLY the separator (`" — "`), so a literal matching
//       `^\s*—\s*$` is allowed and every other `—` is prose. Applies to ALL
//       literal kinds, not just prose (a title or an aria-label is copy too).
//   (c) EXCLAMATION MARKS — the Dry Rule, prose only (`!` is everywhere in code).
//
// WHAT IS SCANNED, AND WHAT IS NOT. Every skip is a deliberate register or
// tooling boundary, written down here so the net's edges are explicit:
//   - `apps/web/src/routes`, `apps/web/src/components`, `apps/mobile/src`,
//     `apps/extension/src` — the public web, mobile, and extension surfaces.
//   - `apps/cli/src` — scanned for rails (a) and (c) only. Rail (b) is EXCLUDED
//     there: the operator-tier CLI register uses `—` as a clause separator as one
//     systematic house style (~35 instances in `cli.ts`), and whether the prose
//     discipline reaches operator tool output is an open CANON question, not
//     drift. See the 2026-07-18 `audit/20260717-voice` row in
//     docs/audit-backlog.md; when a human rules on it, flip `emDash` below.
//   - `/admin` is SKIPPED entirely (`routes/admin`, `routes/api/admin`,
//     `routes/api/v1/admin`, `components/admin`): the operator workstation is a
//     different register, and it is where the engine-room vocabulary belongs.
//   - `*.test.*` files are skipped — a test's fixtures deliberately contain the
//     violations it asserts on (this file included).
//   - `*.d.ts` files are skipped: declarations carry no copy.
//   - TanStack's `-*` route-helper files ARE scanned. They are excluded from
//     ROUTING, not from copy (`-docs-page.tsx` renders UI, `-home-data.ts` carries
//     page strings), and including them measured clean.
//
// OUT OF SCOPE, deliberately:
//   - `apps/ssh/main.go` — Go, so oxc cannot parse it. Its em dashes are `Artist —
//     Title` separators today; a Go-side scan is its own slice.
//   - `apps/web/public/*.txt` — robots.txt comments and the standard
//     Content-Signal header are not Fluncle's prose.
//   - `packages/**` — shared libraries; their user-facing strings reach a surface
//     through one of the scanned apps.
//   - `/admin`, per the register boundary above.
//
// THE ESCAPE HATCH. Put `// voice-lint-allow: <reason>` (or, inside JSX,
// `{/* voice-lint-allow: <reason> */}`) on the line DIRECTLY ABOVE the offending
// line. The reason must be non-empty — a bare marker suppresses nothing, so an
// exemption always says why it earned one.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { BANNED_WORDS } from "./voice-words";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Each scanned root, and whether the prose-em-dash rail applies to it. */
const SCAN_ROOTS: { emDash: boolean; path: string }[] = [
  { emDash: true, path: "apps/web/src/routes" },
  { emDash: true, path: "apps/web/src/components" },
  { emDash: true, path: "apps/mobile/src" },
  { emDash: true, path: "apps/extension/src" },
  // The operator CLI register: banned words + the Dry Rule, no em-dash rail.
  { emDash: false, path: "apps/cli/src" },
];

/** The operator workstation — a different register, out of the public net. */
const SKIPPED_DIRECTORIES = [
  "apps/web/src/components/admin",
  "apps/web/src/routes/admin",
  "apps/web/src/routes/api/admin",
  "apps/web/src/routes/api/v1/admin",
];

const SCANNED_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

/** VOICE.md §6: the `Artist — Title` separator is written as its own literal. */
const TRACKLIST_SEPARATOR = /^\s*—\s*$/;

const ALLOW_MARKER = /voice-lint-allow:(.*)$/;

// Whole-word so "signature"/"contention" don't false-positive, case-insensitive
// because a banned word is banned in a heading too.
const BANNED_WORD_MATCHERS = BANNED_WORDS.map((word) => new RegExp(`\\b${word}\\b`, "i"));

type Rail = "banned-word" | "exclamation" | "prose-em-dash";

type Violation = { file: string; line: number; rail: Rail; text: string };

type Literal = { isJsxText: boolean; line: number; text: string };

function collectFiles(root: string, files: string[]): void {
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

/**
 * Every string the source ships: JSX text (whitespace-collapsed, the way a reader
 * sees it), string literals, and template chunks. Line numbers are the node's
 * START line, which is the line the escape hatch sits above.
 */
function collectLiterals(file: string, source: string): Literal[] {
  const parsed = parseSync(file, source);

  if (parsed.errors.length > 0) {
    throw new Error(
      `voice lint could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  const lineOf = (offset: number): number => {
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
  };

  const literals: Literal[] = [];

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    const line = lineOf(typeof record.start === "number" ? record.start : 0);

    if (record.type === "JSXText" && typeof record.value === "string") {
      const text = record.value.replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        literals.push({ isJsxText: true, line, text });
      }
    } else if (record.type === "Literal" && typeof record.value === "string") {
      literals.push({ isJsxText: false, line, text: record.value });
    } else if (record.type === "TemplateElement") {
      const cooked = (record.value as { cooked?: unknown } | undefined)?.cooked;
      if (typeof cooked === "string" && cooked.trim().length > 0) {
        literals.push({ isJsxText: false, line, text: cooked });
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== "type" && key !== "start" && key !== "end") {
        visit(record[key]);
      }
    }
  };

  visit(parsed.program as unknown);
  return literals;
}

/**
 * Is this literal PROSE a reader meets, rather than a class name, a header, a
 * selector, or a code fragment? Rendered JSX text always is. A quoted string
 * qualifies on four cheap signals: it reads as a sentence (four words or more),
 * carries no markup/code punctuation, is not a `Key: value` pair, and holds no
 * URL/comment `//`. This is what keeps `Content-Type`, `AbortSignal`, and
 * `contentEditable` out of rail (a) without an allowlist per identifier.
 */
function isProse(literal: Literal): boolean {
  if (literal.isJsxText) {
    return true;
  }

  if (/[<>{};=]/.test(literal.text) || literal.text.includes(": ")) {
    return false;
  }

  if (literal.text.includes("//")) {
    return false;
  }

  return literal.text.trim().split(/\s+/).filter(Boolean).length >= 4;
}

/** A `voice-lint-allow: <reason>` marker with a real reason on the line above. */
function isExcused(sourceLines: string[], line: number): boolean {
  const previous = sourceLines[line - 2];
  if (previous === undefined) {
    return false;
  }

  const marker = ALLOW_MARKER.exec(previous);
  if (marker === null) {
    return false;
  }

  // Trim the JSX comment's closing `*/}` so the reason is what the author wrote.
  return (marker[1] ?? "").replace(/\*\/\s*\}?\s*$/, "").trim().length > 0;
}

function scanSource(file: string, source: string, options: { emDash: boolean }): Violation[] {
  const sourceLines = source.split("\n");
  const violations: Violation[] = [];

  const report = (rail: Rail, literal: Literal): void => {
    if (!isExcused(sourceLines, literal.line)) {
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

describe("voice lint", () => {
  it("finds no banned word, prose em dash, or exclamation mark in a user-facing literal", () => {
    const violations: Violation[] = [];

    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      collectFiles(root.path, files);
      expect(files.length, `no files found under ${root.path}`).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(join(REPO_ROOT, file), "utf8");
        violations.push(...scanSource(file, source, { emDash: root.emDash }));
      }
    }

    expect(violations.map(formatViolation)).toEqual([]);
  });

  it("draws its net where it says: the public surfaces in, the operator workstation out", () => {
    const scanned = new Set<string>();
    for (const root of SCAN_ROOTS) {
      const files: string[] = [];
      collectFiles(root.path, files);
      for (const file of files) {
        scanned.add(file);
      }
    }

    // One real copy-carrying file per scanned root, so a root that quietly stops
    // resolving fails loudly instead of passing with an empty file list.
    expect(scanned.has("apps/web/src/routes/privacy.tsx")).toBe(true);
    expect(scanned.has("apps/web/src/components/search/search-command.tsx")).toBe(true);
    expect(scanned.has("apps/mobile/src/lib/feed-state.ts")).toBe(true);
    expect(scanned.has("apps/extension/src/copy.ts")).toBe(true);
    expect(scanned.has("apps/cli/src/cli.ts")).toBe(true);

    const strays = [...scanned].filter(
      (file) =>
        file.includes(".test.") ||
        SKIPPED_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)),
    );
    expect(strays).toEqual([]);
  });
});

// A detector is unproven until a synthetic failure makes it fire. This fixture
// carries one violation per rail plus the two things that must NOT fire: the
// `Artist — Title` separator literal and an excused line.
const FIXTURE_FILE = "fixture.tsx";

const FIXTURE_SOURCE = `export function Fixture() {
  const separator = " — ";
  const bannedWord = "The signal came back clean from out there tonight";
  const proseDash = "Two things happened tonight — the second one was louder";
  const shouty = "Three findings landed on the log tonight!";
  const contentType = "Content-Type";
  const cssClass = "search-note search-note--degraded";
  // voice-lint-allow: proving the escape hatch suppresses a real hit
  const excused = "The curated selection landed on the log tonight";
  // voice-lint-allow:
  const bareMarker = "A transmission arrived from out there tonight";
  return (
    <p>
      Body text with a dash — right here
      {/* voice-lint-allow: proving the JSX form of the escape hatch */}
      <span>An anomaly landed on the log here tonight</span>
    </p>
  );
}
`;

describe("voice lint rails", () => {
  const fired = scanSource(FIXTURE_FILE, FIXTURE_SOURCE, { emDash: true });

  it("fires on a banned identity word in prose", () => {
    const hits = fired.filter((violation) => violation.rail === "banned-word");
    expect(hits.map((violation) => violation.text)).toEqual([
      "The signal came back clean from out there tonight",
      "A transmission arrived from out there tonight",
    ]);
  });

  it("fires on a prose em dash, in a quoted string and in JSX text alike", () => {
    const hits = fired.filter((violation) => violation.rail === "prose-em-dash");
    expect(hits.map((violation) => violation.text)).toEqual([
      "Two things happened tonight — the second one was louder",
      "Body text with a dash — right here",
    ]);
  });

  it("fires on an exclamation mark in prose", () => {
    const hits = fired.filter((violation) => violation.rail === "exclamation");
    expect(hits.map((violation) => violation.text)).toEqual([
      "Three findings landed on the log tonight!",
    ]);
  });

  it("holds the `Artist — Title` separator, code strings, and excused lines", () => {
    const texts = fired.map((violation) => violation.text);
    expect(texts).not.toContain(" — ");
    expect(texts).not.toContain("Content-Type");
    expect(texts).not.toContain("search-note search-note--degraded");
    expect(texts).not.toContain("The curated selection landed on the log tonight");
    expect(texts).not.toContain("An anomaly landed on the log here tonight");
  });

  it("holds every em dash when the root is the operator CLI register", () => {
    const cli = scanSource(FIXTURE_FILE, FIXTURE_SOURCE, { emDash: false });
    expect(cli.some((violation) => violation.rail === "prose-em-dash")).toBe(false);
    expect(cli.some((violation) => violation.rail === "banned-word")).toBe(true);
  });
});
