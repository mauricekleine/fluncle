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
// THE THREE RAILS. Only mechanically unambiguous rules land here.
//   (a) BANNED WORDS — VOICE.md §3, whole-word and case-insensitive, from the ONE
//       shared list in ./voice-words.ts (the runtime gates read the same array).
//       PROSE ONLY: `Content-Type`, `AbortSignal`, `contentEditable` and friends
//       are the large false-positive surface, so `isProse` below decides.
//   (b) PROSE EM DASH — VOICE.md §6 sanctions exactly one em dash, the
//       `Artist — Title` tracklist separator. That separator is always written as
//       a literal that is ONLY the separator (`" — "`), so a literal matching
//       `^\s*—\s*$` is allowed and every other `—` is prose. Applies to ALL
//       literal kinds, not just prose (a title or an aria-label is copy too).
//   (c) EXCLAMATION MARKS — the Dry Rule, prose only (`!` is everywhere in code).
//
// WHAT IS SCANNED. See SCAN_ROOTS: the public web, mobile, and extension
// surfaces, the Galaxy game, the CLI and the npm packaging copy it publishes, and
// the individually-named modules out of `apps/web/src/lib` whose strings reach a
// PUBLIC audience (below).
//
// WHAT IS NOT, AND WHY. Every edge is a deliberate register or tooling boundary:
//   - `/admin` under the web roots is skipped ENTIRELY (see SKIPPED_DIRECTORIES):
//     the operator workstation is a different register, and it is where the
//     engine-room vocabulary belongs.
//   - THE ONE ASYMMETRY, stated on purpose: the web `/admin` tree is skipped
//     outright, while the CLI's admin tree IS scanned for banned words and only
//     exempted from the em-dash rail. They differ because the exemptions have
//     different causes — the web `/admin` register is settled canon (operator
//     chrome, engine-room words allowed), whereas the CLI em dash is an OPEN
//     canon question with the banned-word list never in dispute on any surface.
//     A banned identity word is wrong in operator CLI output too, so it stays
//     caught there; if the CLI register is ever ruled full-voice, delete
//     EM_DASH_EXEMPT_PREFIXES rather than widening the web skip.
//   - `*.test.*` files are skipped — a test's fixtures deliberately contain the
//     violations it asserts on (this file included).
//   - `*.d.ts` files are skipped: declarations carry no copy.
//   - TanStack's `-*` route-helper files ARE scanned. They are excluded from
//     ROUTING, not from copy (`-docs-page.tsx` renders UI, `-findings-data.ts` carries
//     page strings), and including them measured clean.
//
// OUT OF SCOPE — each a real boundary with a real cost, not a claim that nothing
// there matters:
//   - The REST of `apps/web/src/lib`. These are
//     overwhelmingly operator/DB/API strings (status reasons, query builders,
//     vendor payloads) where the register question is unsettled, so scanning the
//     tree wholesale would bury the gate in a judgment call it cannot make. The
//     modules whose strings reach a PUBLIC audience are pulled into SCAN_ROOTS
//     individually instead — the MCP specs and agent-discovery, the entity strings (`identity.ts`), the log page's
//     definitional prose (`log-prose.ts`), and the two CREW FEEDS (`telegram.ts`,
//     `bluesky.ts`), which carry the most voice-load-bearing hand-written copy in
//     the repo and were outside the net only because of where they live. Drawing
//     the real `lib/**` boundary is a follow-up, and it is a canon question before
//     it is a code one.
//   - `apps/ssh/main.go` — Go, so oxc cannot parse it. Its em dashes are
//     `Artist — Title` separators today; a Go-side scan is its own slice.
//   - `apps/web/public/*.txt` — `llms.txt` and `humans.txt` are hand-written,
//     voice-governed prose and DO belong under these rails; they are skipped only
//     because oxc parses JavaScript, not plain text. A text-file scanner is a
//     separate, worthwhile slice.
//   - `packages/**` as a SOURCE SCAN — a deliberate boundary, not an empty one: a
//     literal in a package is never re-typed in the app, so e.g. `packages/registry`
//     surface titles render on `/status`, the SSH menu, and MCP unchecked, and that
//     the source boundary can otherwise leave public `fluncle status` strings unchecked.
//     `packages/registry` is now covered instead by the "registry" describe below,
//     which applies these same rails to the IMPORTED catalog rather than its source
//     — a data check, so it can be scoped to the three fields a non-operator reads
//     without dragging in a catalog whose bulk is operator notes. The rest of
//     `packages/**` is still unscanned; extending the roots there is cheap and
//     wanted.
//
// THE ESCAPE HATCH. Put `// voice-lint-allow: <reason>` (or, inside JSX,
// `{/* voice-lint-allow: <reason> */}`) on the line DIRECTLY ABOVE the offending
// line. The reason must be non-empty — a bare marker suppresses nothing, so an
// exemption always says why it earned one.

import { liveSurfaces } from "@fluncle/registry";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { BANNED_WORDS } from "./voice-words";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Directories walked in full, plus two individually-named files (see header). */
const SCAN_ROOTS = [
  "apps/web/src/routes",
  "apps/web/src/components",
  "apps/mobile/src",
  // The Expo Router SCREENS. `apps/mobile/src` holds the app's components and state, but
  // every routed screen — the feed, the archive, the decks, the radio, submit, account —
  // lives here, so the mobile UI's own copy sat outside the net while its parts were in it.
  "apps/mobile/app",
  "apps/extension/src",
  "apps/cli/src",
  // The npm PACKAGING copy. `build-npm.ts` authors the published package's `description`
  // and its README, which is the listing a stranger reads on npmjs.com/package/fluncle —
  // as public as the web, and outside the net purely because it sits beside `src/` rather
  // than in it. (Its Homebrew twin is Ruby, so it stays out of an oxc scan.)
  "apps/cli/scripts",
  // The Galaxy game. A public surface with its own copy (its gate screen, its empty
  // state), sitting outside `routes/` + `components/` only because the canvas app is
  // booted by a dynamic import from its route.
  "apps/web/src/game",
  // The MCP tool descriptions: a PUBLIC agent surface — an assistant reads these
  // strings out to a stranger, so they are copy even though they live in lib/.
  "apps/web/src/lib/server/tools/specs.ts",
  // Renders the markdown home that agents and crawlers read.
  "apps/web/src/lib/server/agent-discovery.ts",
  // The canonical entity strings, reused verbatim by every meta/OG/JSON-LD surface.
  "apps/web/src/lib/identity.ts",
  // The log page's definitional prose — the visible block, the meta description, and
  // the MusicRecording JSON-LD description all read from it.
  "apps/web/src/lib/log-prose.ts",
  // The two CREW FEEDS. These are the most voice-load-bearing hand-written strings
  // Fluncle ships (a post lands in a stranger's Telegram and on Bluesky), and they
  // sat outside the net purely because they live under lib/.
  "apps/web/src/lib/server/telegram.ts",
  "apps/web/src/lib/server/bluesky.ts",
];

/** The operator workstation — a different register, out of the public net. */
const SKIPPED_DIRECTORIES = [
  "apps/web/src/components/admin",
  "apps/web/src/routes/admin",
  "apps/web/src/routes/api/admin",
  "apps/web/src/routes/api/v1/admin",
];

/**
 * The em-dash rail (b) only. The operator-tier CLI uses `—` as a clause separator
 * as one systematic house style, and whether the prose discipline reaches operator
 * tool output is an OPEN CANON QUESTION — see the voice audit
 * row in docs/audit-backlog.md, which also blesses the `—` null-cell glyph. Scoped
 * to the ADMIN tree only: `cli.ts` (where every admin command's description is
 * registered, and where the ledger measured ~35 instances) and the `admin-*`
 * command modules. The PUBLIC CLI commands are held to the rail like any other
 * surface. Rails (a) and (c) apply everywhere; a banned identity word is never
 * in dispute.
 */
const EM_DASH_EXEMPT_PREFIXES = ["apps/cli/src/cli.ts", "apps/cli/src/commands/admin-"];

/**
 * Keys whose value is COPY by construction, so the four-word floor is waived for
 * them. Without this the gate misses exactly the violation that motivated it:
 * `title: "Lost the signal"` is three words, so the floor alone would let the
 * mobile Stories slip through again.
 */
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

/** VOICE.md §6: the `Artist — Title` separator is written as its own literal. */
const TRACKLIST_SEPARATOR = /^\s*—\s*$/;

/**
 * A real `Key: value` string ("Log ID: 241.7.3A", "Content-Type: text/calendar"):
 * at most two words before the colon. Deliberately NOT a bare `": "` test — a
 * colon is one of the canon's own prescribed replacements for a prose em dash, so
 * excluding every string containing one would blind the gate to the very copy the
 * em-dash rail pushes authors toward writing.
 */
const KEY_VALUE_PREFIX = /^[A-Za-z][\w-]*(?: [\w-]+)?: /;

/** A copy module, or an object named `…Copy` — every string inside is copy. */
const COPY_MODULE = /(?:^|\/)(?:copy|[\w-]+-copy)\.tsx?$/;
const COPY_IDENTIFIER = /copy$/i;

const ALLOW_MARKER = /voice-lint-allow:(.*)$/;

// Whole-word so "signature"/"contention" don't false-positive, case-insensitive
// because a banned word is banned in a heading too.
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

/**
 * Every string the source ships: JSX text (whitespace-collapsed, the way a reader
 * sees it), string literals, and template chunks. Line numbers are the node's
 * START line, which is the line the escape hatch sits above. Each literal also
 * carries whether it sits in a COPY position — under a copy-shaped key, inside a
 * `…Copy` object, or in a copy module — which waives the word floor in `isProse`.
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
    const line = lineOf(typeof record.start === "number" ? record.start : 0);

    if (record.type === "JSXText" && typeof record.value === "string") {
      const text = record.value.replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        literals.push({ isCopy: true, isJsxText: true, line, text });
      }
    } else if (record.type === "Literal" && typeof record.value === "string") {
      literals.push({ isCopy: isCopy || inCopyModule, isJsxText: false, line, text: record.value });
    } else if (record.type === "TemplateElement") {
      const cooked = (record.value as { cooked?: unknown } | undefined)?.cooked;
      if (typeof cooked === "string" && cooked.trim().length > 0) {
        literals.push({ isCopy: isCopy || inCopyModule, isJsxText: false, line, text: cooked });
      }
    }

    // `const feedCopy = { … }` — every string inside is copy, whatever its key.
    if (record.type === "VariableDeclarator") {
      const id = record.id as Record<string, unknown> | undefined;
      if (typeof id?.name === "string" && COPY_IDENTIFIER.test(id.name)) {
        visit(record.init, true);
        return;
      }
    }

    // A copy-shaped key marks its whole value subtree as copy.
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

/**
 * Is this literal PROSE a reader meets, rather than a class name, a header, a
 * selector, or a code fragment? Rendered JSX text always is. A quoted string
 * qualifies when it carries no markup/code punctuation, is not a `Key: value`
 * pair, holds no URL/comment `//`, and then either sits in a COPY position (a
 * copy-shaped key, a `…Copy` object, a copy module) or reads as a sentence at
 * four words or more. This keeps `Content-Type`, `AbortSignal`, and
 * `contentEditable` out of rail (a) without an allowlist per identifier.
 */
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

    // One real copy-carrying file per scanned root, so a root that quietly stops
    // resolving fails loudly instead of passing with an empty file list.
    expect(scanned.has("apps/web/src/routes/privacy.tsx")).toBe(true);
    expect(scanned.has("apps/web/src/components/search/search-command.tsx")).toBe(true);
    expect(scanned.has("apps/mobile/src/lib/feed-state.ts")).toBe(true);
    expect(scanned.has("apps/mobile/app/(tabs)/archive.tsx")).toBe(true);
    expect(scanned.has("apps/extension/src/copy.ts")).toBe(true);
    expect(scanned.has("apps/cli/src/cli.ts")).toBe(true);
    expect(scanned.has("apps/cli/scripts/build-npm.ts")).toBe(true);
    expect(scanned.has("apps/web/src/game/game.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/tools/specs.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/agent-discovery.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/identity.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/log-prose.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/telegram.ts")).toBe(true);
    expect(scanned.has("apps/web/src/lib/server/bluesky.ts")).toBe(true);

    const strays = [...scanned].filter(
      (file) =>
        file.includes(".test.") ||
        SKIPPED_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)),
    );
    expect(strays).toEqual([]);

    // The em-dash carve-out is the CLI ADMIN tree only, never a public surface.
    expect(emDashApplies("apps/cli/src/cli.ts")).toBe(false);
    expect(emDashApplies("apps/cli/src/commands/admin-tracks.ts")).toBe(false);
    expect(emDashApplies("apps/cli/src/commands/recent.ts")).toBe(true);
    expect(emDashApplies("apps/web/src/routes/privacy.tsx")).toBe(true);
  });
});

// A detector is unproven until a synthetic failure makes it fire. This fixture
// carries one violation per rail, the two copy positions that waive the word
// floor, and everything that must NOT fire: the `Artist — Title` separator, a
// real `Key: value` pair, code strings, and the escape hatch in both forms.
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
      // The colon is mid-sentence, so the `Key: value` exclusion must not swallow it.
      "Two things tonight: the curated shelf went quiet",
      "A transmission arrived from out there tonight",
      // Three words: caught only because `title` is a copy-shaped key.
      "Lost the signal",
      // Three words under a NON-copy key: caught only because the object is `…Copy`.
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

  it("holds the separator, real `Key: value` pairs, code strings, and excused lines", () => {
    const texts = fired.map((violation) => violation.text);
    expect(texts).not.toContain(" — ");
    expect(texts).not.toContain("Curation: off");
    expect(texts).not.toContain("Content-Type");
    expect(texts).not.toContain("search-note search-note--degraded");
    expect(texts).not.toContain("The curated selection landed on the log tonight");
    expect(texts).not.toContain("An anomaly landed on the log here tonight");
  });

  it("holds every em dash when the file is in the CLI admin carve-out", () => {
    const cli = scanSource(FIXTURE_FILE, FIXTURE_SOURCE, { emDash: false });
    expect(cli.some((violation) => violation.rail === "prose-em-dash")).toBe(false);
    expect(cli.some((violation) => violation.rail === "banned-word")).toBe(true);
  });
});

// The surfaces registry's PUBLIC-rendering strings, checked as DATA rather than
// source. `packages/**` is outside SCAN_ROOTS (see the header), and scanning the
// catalog's source would drag in operator notes and a hundred catalog descriptions
// nobody outside the operator reads; importing it instead lets the rails land on
// exactly the three fields a STRANGER meets:
//
//   - `title` + `statusDescription`  → the /status health board, a public console page.
//   - `exposedContent[0]` of a surface whose `operatorNotes` names a /status service
//     → the note column of the public `fluncle status` command
//       (apps/cli/src/commands/status.ts) and the MCP `get_status` service labels
//       (apps/web/src/lib/server/tools/registry.ts), both of which mine that marker.
//
// It lives here, not in packages/registry's own test, so BANNED_WORDS stays a single
// array with a single reader — a second copy in a leaf package is the exact drift
// ./voice-words.ts was created to prevent. The precedent for an apps/web test
// guarding a registry field is already set (registry/src/index.test.ts notes the
// /status infra aliases are "guarded there by the apps/web coverage test").
const SERVICE_PROBE_MARKER = /service `([a-z0-9-]+)`/;

/** Every registry string a non-operator reads, labelled by where it came from. */
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
  // No registry label is ever an `Artist — Title` line, so the tracklist carve-out
  // does not apply here: every em dash in one of these strings is prose.
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

  // A detector over live data is only proven if the data is actually there: an empty
  // catalog read would pass the assertion above while checking nothing.
  it("reads a non-empty set of public strings, including the /status service notes", () => {
    const strings = publicRegistryStrings();

    expect(strings.length).toBeGreaterThan(0);
    expect(strings.some(({ where }) => where.endsWith(".statusDescription"))).toBe(true);
    expect(strings.some(({ where }) => where.endsWith(".exposedContent[0]"))).toBe(true);
  });
});
