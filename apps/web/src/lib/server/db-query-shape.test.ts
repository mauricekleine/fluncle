import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The DB query-shape GUARDRAIL (docs/db-scale-backlog.md § Guardrail, mechanism A).
//
// The scale audit's whole thesis is that this debt accrues SILENTLY: a query that
// full-scans a growing table is not an error, it is a query that gets slower every
// week. So the shapes the audit retired are made STRUCTURALLY un-reintroducible here,
// exactly the way orpc-coverage.test.ts makes an uncovered public route
// un-mergeable. This file is executed by `bun run test`, which `deploy:gate` runs in
// the Cloudflare build — a violation ABORTS the prod deploy.
//
// It statically scans the SQL-bearing server surface (`src/lib/server/**`, `src/db/**`,
// tests excluded) as TEXT for a small set of forbidden shapes on the growing tables
// (`tracks`, `track_artists`, `crawl_frontier`, and `findings`-as-anti-join), and
// compares each file's occurrence count against an explicit ALLOWLIST.
//
// Enforcement runs BOTH directions, which is the whole design:
//   - actual > allowed  ⇒ a NEW forbidden shape landed. Fix it, or consciously extend
//                         the allowlist with a reason.
//   - actual < allowed  ⇒ the entry is STALE. Shrink it (or delete it) so the list
//                         keeps shrinking as the backlog retires.
// The list can therefore only move by deliberate edit — nobody drifts past it.
//
// WHAT THIS IS NOT: a proof of scale. It is a tripwire on shapes we have already paid
// for. A grep cannot see a recompute-by-scan reached through a helper, and it cannot
// see whether an index is actually picked — the nightly `db-query-shape` audit domain
// (mechanism B) is the judgment half, and any index still carrying "needs hosted proof"
// must be validated against a scratch HOSTED Turso DB (`scripts/bench-db-scale.ts`),
// never local green, before its allowlist entry comes off.

// ── The scanner ────────────────────────────────────────────────────────────────────
//
// Comments are BLANKED before matching. Half of these files document the very shapes
// they avoid ("the anti-join `findings.track_id is null` is the catalogue's
// definition"), so scanning raw text would count prose, and a doc reword would then
// fail the deploy. Blanking preserves offsets so reported line numbers stay true.

type SqlRegion = { readonly start: number; readonly text: string };

type ScannedSource = {
  /** The source with every comment blanked out (newlines preserved). */
  readonly code: string;
  /** Every string / template literal in the file — the "statement" unit. */
  readonly regions: readonly SqlRegion[];
};

/**
 * One pass that both blanks comments and collects string/template literals. A literal is
 * the closest thing to a "statement" a text scan gets: the SQL in this codebase lives in
 * `db.execute({ sql: \`…\` })` template literals, so a region is what a predicate's
 * accompanying clauses can be looked for in.
 */
function scanSource(source: string): ScannedSource {
  const chars = source.split("");
  const regions: SqlRegion[] = [];
  // A stack so `${…}` inside a template literal is scanned as code again (and a nested
  // template inside a substitution still terminates correctly).
  const stack: Array<{ braces: number; kind: "code" | "template"; start: number }> = [
    { braces: 0, kind: "code", start: 0 },
  ];

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (chars[index] !== "\n") {
        chars[index] = " ";
      }
    }
  };

  let i = 0;

  while (i < source.length) {
    const frame = stack.at(-1);

    if (!frame) {
      break;
    }

    const char = source[i];

    if (frame.kind === "template") {
      if (char === "\\") {
        i += 2;
        continue;
      }

      if (char === "$" && source[i + 1] === "{") {
        stack.push({ braces: 0, kind: "code", start: i + 2 });
        i += 2;
        continue;
      }

      if (char === "`") {
        regions.push({ start: frame.start, text: source.slice(frame.start, i + 1) });
        stack.pop();
        i += 1;
        continue;
      }

      i += 1;
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      let end = i;

      while (end < source.length && source[end] !== "\n") {
        end += 1;
      }

      blank(i, end);
      i = end;
      continue;
    }

    if (char === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;

      blank(i, end);
      i = end;
      continue;
    }

    if (char === "'" || char === '"') {
      let end = i + 1;

      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }

        if (source[end] === char || source[end] === "\n") {
          break;
        }

        end += 1;
      }

      regions.push({ start: i, text: source.slice(i, Math.min(end + 1, source.length)) });
      i = end + 1;
      continue;
    }

    if (char === "`") {
      stack.push({ braces: 0, kind: "template", start: i });
      i += 1;
      continue;
    }

    if (char === "{") {
      frame.braces += 1;
      i += 1;
      continue;
    }

    if (char === "}") {
      if (frame.braces === 0 && stack.length > 1) {
        stack.pop();
        i += 1;
        continue;
      }

      frame.braces -= 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  return { code: chars.join(""), regions };
}

// Words that can follow a table name without being an alias. Without this,
// `from tracks where …` would register `where` as an alias for `tracks`.
const SQL_KEYWORDS = new Set([
  "and",
  "as",
  "asc",
  "by",
  "case",
  "cross",
  "desc",
  "else",
  "end",
  "for",
  "from",
  "full",
  "group",
  "having",
  "indexed",
  "inner",
  "into",
  "is",
  "join",
  "left",
  "limit",
  "natural",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "returning",
  "right",
  "select",
  "set",
  "then",
  "union",
  "using",
  "values",
  "when",
  "where",
  "window",
  "with",
]);

const looksLikeSql = (text: string): boolean =>
  /\b(?:select|from|join|update|insert\s+into|delete\s+from)\b/i.test(text);

/**
 * Every identifier a table is reachable by in this file — the table name plus each alias
 * bound to it in a SQL literal (`from tracks t`, `left join findings cf on …`).
 *
 * This is what keeps the anti-join pattern honest in BOTH directions: it catches the
 * aliased spellings the codebase actually uses (`f.track_id is null` in funnel.ts,
 * `cf.track_id is null` in catalogue.ts) while leaving `ta.track_id is null` — the
 * `track_artists` edge-less-track worklists in the backfill sweeps — alone, because `ta`
 * is never bound to `findings`. Add `left join findings ff` tomorrow and
 * `ff.track_id is null` is caught with no edit here.
 *
 * File-scoped on purpose: fragments are assembled from module constants
 * (`REC_ELIGIBLE_WHERE`, `ANCHOR_BACKOFF_WHERE`) that hold the predicate while the join
 * that binds the alias lives in a different literal.
 */
function tableAliases(scanned: ScannedSource, table: string): ReadonlySet<string> {
  const aliases = new Set([table]);
  const pattern = new RegExp(`\\b${table}\\s+(?:as\\s+)?([a-z][a-z0-9_]*)\\b`, "gi");

  for (const region of scanned.regions) {
    if (!looksLikeSql(region.text)) {
      continue;
    }

    for (const match of region.text.matchAll(pattern)) {
      const alias = match[1]?.toLowerCase();

      if (alias && !SQL_KEYWORDS.has(alias)) {
        aliases.add(alias);
      }
    }
  }

  return aliases;
}

// ── The forbidden shapes ───────────────────────────────────────────────────────────

/** A pattern's id — the allowlist key, and what a failure message names. */
type PatternId =
  | "anti-join:findings-is-null"
  | "anti-join:not-exists-findings"
  | "fn-wrapped:leading-wildcard-like"
  | "fn-wrapped:lower-tracks"
  | "fn-wrapped:substr-release-date"
  | "hub-group-by:having-over-growing-tables"
  | "select-star:tracks"
  | "vector-index:libsql_vector_idx";

type Occurrence = { readonly line: number; readonly pattern: PatternId; readonly snippet: string };

const lineAt = (code: string, index: number): number => {
  let line = 1;

  for (let i = 0; i < index; i += 1) {
    if (code[i] === "\n") {
      line += 1;
    }
  }

  return line;
};

/** The literal a match sits inside — the innermost enclosing one wins. */
function enclosingRegion(scanned: ScannedSource, index: number): string {
  let best = "";

  for (const region of scanned.regions) {
    if (region.start <= index && index < region.start + region.text.length) {
      if (best === "" || region.text.length <= best.length) {
        best = region.text;
      }
    }
  }

  return best;
}

/**
 * Every forbidden shape in one file.
 *
 * Each pattern is anchored to a table name (directly or through {@link tableAliases}) so
 * it cannot fire on an unrelated string — the cost of a false positive here is a blocked
 * deploy for everyone, so precision beats reach every time.
 */
function findOccurrences(source: string): readonly Occurrence[] {
  const scanned = scanSource(source);
  const { code } = scanned;
  const found: Occurrence[] = [];

  const push = (pattern: PatternId, index: number, snippet: string): void => {
    found.push({ line: lineAt(code, index), pattern, snippet: snippet.replace(/\s+/g, " ") });
  };

  // (1) THE UNMATERIALIZED CATALOGUE ANTI-JOIN — the audit's single most-repeated shape,
  // and the reason Keystone 1 exists (#859). `findings` is a strict 1:1 subtype of
  // `tracks`, so `findings.track_id is null` means "a catalogue row", and asking it as an
  // anti-join forces a full left-join scan of the growing table. The maintained
  // `is_catalogue` discriminator answers it as a seek — so a statement that also names
  // `is_catalogue` is EXEMPT (it has already been converted; the residual join is there
  // for other columns).
  for (const alias of tableAliases(scanned, "findings")) {
    const pattern = new RegExp(`\\b${alias}\\.track_id\\s+is\\s+null\\b`, "gi");

    for (const match of code.matchAll(pattern)) {
      if (!/\bis_catalogue\b/i.test(enclosingRegion(scanned, match.index))) {
        push("anti-join:findings-is-null", match.index, match[0]);
      }
    }
  }

  for (const match of code.matchAll(/not\s+exists\s*\(\s*select\s+1\s+from\s+findings\b/gi)) {
    if (!/\bis_catalogue\b/i.test(enclosingRegion(scanned, match.index))) {
      push("anti-join:not-exists-findings", match.index, match[0]);
    }
  }

  const trackTables = [
    ...tableAliases(scanned, "tracks"),
    ...tableAliases(scanned, "track_artists"),
  ];

  // (2) FUNCTION-WRAPPED FILTER COLUMNS — wrapping a column in `lower()` / `substr()`, or
  // matching it with a leading-wildcard LIKE, means no btree can ever be seeked: the
  // predicate becomes a residual over every row. `lower(tracks.label)` and
  // `substr(tracks.release_date, 1, 4)` each have an index sitting right there, unused.
  for (const alias of trackTables) {
    for (const match of code.matchAll(new RegExp(`\\blower\\s*\\(\\s*${alias}\\.`, "gi"))) {
      push("fn-wrapped:lower-tracks", match.index, match[0]);
    }

    for (const match of code.matchAll(
      new RegExp(`\\bsubstr\\s*\\(\\s*${alias}\\.release_date\\b`, "gi"),
    )) {
      push("fn-wrapped:substr-release-date", match.index, match[0]);
    }

    // A leading `%` makes the LIKE unsargable no matter what index exists. Anchored to a
    // qualified growing-table column, so a LIKE over `labels.name` (a small table) is not
    // this shape. The optional `)` absorbs the common `lower(tracks.x) like '%…'` nesting.
    for (const match of code.matchAll(
      new RegExp(`\\b${alias}\\.[a-z_]+\\s*\\)?\\s*(?:not\\s+)?like\\s+'%`, "gi"),
    )) {
      push("fn-wrapped:leading-wildcard-like", match.index, match[0]);
    }
  }

  // (3) THE ANN-INDEX WEDGE (docs/local-database.md). `create index … libsql_vector_idx`
  // against a populated table errored `database is locked` and wedged hosted Turso's WRITE
  // path for 20+ minutes; locally it silently builds an EMPTY index, so dev never warns
  // you. The ratified vector shape is an exact `vector_distance_cos` scan behind a btree
  // pre-filter. Never in app code, in any form.
  for (const match of code.matchAll(/libsql_vector_idx/gi)) {
    push("vector-index:libsql_vector_idx", match.index, match[0]);
  }

  // (4) THE ENTITY-HUB GROUP-BY — the audit's shape (B), retired by Keystone 2's stored
  // `renderable_track_count` / `certified_finding_count` (#880/#886). Its signature is a
  // grouped scan of the growing tables whose INCLUSION decision is an aggregate in a
  // `having`, which is what makes the cost O(tracks) per hub page. Deliberately narrow:
  // the sitemap readers still `group by` an entity id over the same join for `lastmod` +
  // cover, and that is fine — their gate is now a stored-column `where`, no `having`.
  for (const region of scanned.regions) {
    const sql = region.text.toLowerCase();
    const isHubGroupBy =
      /\bgroup\s+by\b/.test(sql) &&
      /\bhaving\b/.test(sql) &&
      /\btracks\b|\btrack_artists\b/.test(sql) &&
      /\blabels\b|\balbums\b|\bartists\b/.test(sql) &&
      /\bcount\s*\(|\bsum\s*\(/.test(sql);

    if (isHubGroupBy) {
      push("hub-group-by:having-over-growing-tables", region.start, "group by … having");
    }
  }

  // (5) `select *` FROM THE FAT TABLE. `tracks` carries the 4KB inline `embedding_blob`
  // and `features_json`; a star select drags both into a 128MB Worker isolate for every
  // row. Column lists only (`LEAN_TRACK_SELECT` is the shape).
  for (const match of code.matchAll(/select\s+\*\s+from\s+tracks\b/gi)) {
    push("select-star:tracks", match.index, match[0]);
  }

  return found;
}

// ── The allowlist ──────────────────────────────────────────────────────────────────
//
// Seeded from the tree as it stands, one justification per survivor. Every entry is a
// shape that is either DELIBERATE (bounded by a seek, or reading truth on purpose) or
// OWNED by a named backlog item. Nothing here is "we did not get to it".
//
// To remove an entry: retire the shape, drop the count. To add one: say why, in a line
// the next person can argue with.

type AllowlistEntry = {
  /** Exact number of occurrences expected. Enforced as equality, both directions. */
  readonly count: number;
  /** Path relative to `apps/web/src`. */
  readonly file: string;
  readonly pattern: PatternId;
  readonly reason: string;
};

const ALLOWLIST: readonly AllowlistEntry[] = [
  // ── the catalogue anti-join, `<findings alias>.track_id is null` ────────────────
  {
    count: 1,
    file: "lib/server/capture-budget.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "readCatalogueCaptureSpend — the catalogue half of the metered spend window. Bounded by `source_audio_attempted_at >= ?`: only rows the budget actually paid for, which is a metered handful per window, not the catalogue.",
  },
  {
    count: 3,
    file: "lib/server/catalogue-groups.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "The `/artist` + `/label` catalogue group walks. Entity-SEEKED first (`ta.artist_id = ?` / `tracks.label_id = ?` over their indexes), so the anti-join is a residual on one entity's rows.",
  },
  {
    count: 7,
    file: "lib/server/catalogue.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "Two shapes: readRowBuckets + readRowBucketsBatch (2) are PK point reads where the anti-join is the CORRECTNESS guard — it returns nothing for a certified row, so a stray id contributes no summary delta; the five `/admin/catalogue` lenses (ear/quarantine/unmatched-failed/dismissed/capture-queue) are backlog item 14, DEFERRED (the capture_status composite was proven not to be selected). Flagged as Keystone-1 conversion candidates in the PR — CATALOGUE_SELECT reads only `ct.`, so the `cf` join exists purely for this predicate.",
  },
  {
    count: 1,
    file: "lib/server/fresh-entity.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "The unlit half of a per-entity `/fresh` window. Entity-seeked plus a `release_date` range, so the anti-join is a residual on one entity's window (the growing-table risk here is backlog Wave-1 item 15, which was proven out and dropped).",
  },
  {
    count: 6,
    file: "lib/server/funnel.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "DELIBERATE (backlog Wave-2 Keystone 1, explicit): the five STAGE_SCAN_SELECT conditional aggregates + ANCHOR_BACKOFF_WHERE. The findings join is PINNED by the `certified` arm of the same one-pass scan, so materializing the null-check buys nothing — the join has to happen either way.",
  },
  {
    count: 1,
    file: "lib/server/recommendations.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "REC_ELIGIBLE_WHERE — OWNED by backlog Wave 3-1 (per-user candidate cache off the request hot path + a partial index over the rec-eligible slice). Do not convert piecemeal; the shape is one half of that design call.",
  },
  {
    count: 1,
    file: "lib/server/search.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "CERTIFIED_FIRST — an ORDER BY expression (`case when … then 1 else 0 end asc`), not a filter. It sorts a page that other clauses already bounded; there is no anti-join scan to retire.",
  },
  {
    count: 3,
    file: "lib/server/track-work.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "The worklist scope + capture/analyze kindClauses. The findings join is load-bearing for the certified-first WORK_ORDER (`f.track_id is not null desc`), so it cannot be dropped; the residual scans are backlog items 12 / 14 / Wave-2 6 / Wave-3 4, all DEFERRED or gated on the operator opening catalogue capture.",
  },
  {
    count: 1,
    file: "lib/server/tracks.ts",
    pattern: "anti-join:findings-is-null",
    reason:
      "The `/album/<slug>` unlit slice. Album-SEEKED (`tracks.album_id = ?` over tracks_album_id_idx), so the anti-join is a residual on one album's rows.",
  },

  // ── the catalogue anti-join, `not exists (select 1 from findings …)` ────────────
  {
    count: 6,
    file: "lib/server/catalogue.ts",
    pattern: "anti-join:not-exists-findings",
    reason:
      "Write guards. Four (clearQuarantine, clearDuplicate, setTrackDismissed ×2) are PK-keyed `update tracks … where track_id = ?` — the `not exists` is a self-verifying probe on ONE row, refusing to mutate a certified track. Two (requeueUnmatchedCaptures' veto count + update) sit behind `capture_status = 'unmatched'`, backlog item 14 (DEFERRED).",
  },
  {
    count: 1,
    file: "lib/server/crawl.ts",
    pattern: "anti-join:not-exists-findings",
    reason:
      "The anchor gauge in getCrawlStatus. Deliberately kept on the `tracks_anchor_queue_idx` PARTIAL index (`isrc is not null and spotify_uri is null`) so it stays cheap as the table grows; the `not exists` is a residual on that indexed slice. Documented in-file as an indexed lower-bound gauge, not the full drain set.",
  },

  // ── function-wrapped filter columns ────────────────────────────────────────────
  {
    count: 4,
    file: "lib/server/search.ts",
    pattern: "fn-wrapped:lower-tracks",
    reason:
      "compileFilters' artist / label / album / key clauses — OWNED by backlog Wave 3-2 (resolve the name filters to indexed `label_id`/`album_id`/`artist_id`, store a canonical key form). A design change that threads resolved ids through compileFilters; the year clause was the cheap half and already shipped as a sargable range.",
  },
  {
    count: 1,
    file: "lib/server/track-work.ts",
    pattern: "fn-wrapped:lower-tracks",
    reason:
      "The anchor worklist's unanchorable-credit filter (`lower(t.artists_json) not in (…)`) — a residual on a worklist the surrounding clauses already narrowed, and an exclusion list rather than a lookup key, so no btree could serve it in any spelling.",
  },
  {
    count: 4,
    file: "lib/server/tracks.ts",
    pattern: "fn-wrapped:lower-tracks",
    reason:
      "The FINDINGS-pinned reads (searchArtistFindings' pre-backfill fallback + searchTracks). Both drive from FINDINGS_FROM (`findings join tracks`), so the scan is bounded by the certified corpus — the small table — never by the growing catalogue.",
  },
  {
    count: 1,
    file: "lib/server/tracks-hub.ts",
    pattern: "fn-wrapped:substr-release-date",
    reason:
      "tracksHubYearLaneQuery's `group by substr(tracks.release_date, 1, 4)` — OWNED by backlog Wave-2 item 5 (a maintained year→renderable-count rollup). Held behind a 60s memo today.",
  },
  {
    count: 1,
    file: "lib/server/search.ts",
    pattern: "fn-wrapped:leading-wildcard-like",
    reason:
      "The artist substring filter — the same clause as the Wave 3-2 entry above, counted once more under the leading-wildcard shape. It is the single hottest search shape and the one the design call exists for.",
  },
  {
    count: 4,
    file: "lib/server/tracks.ts",
    pattern: "fn-wrapped:leading-wildcard-like",
    reason:
      "The FINDINGS-pinned reads again (title / track_id / artists_json needles). Bounded by the certified corpus via FINDINGS_FROM, so the leading wildcard costs a scan of the small table.",
  },

  // ── the entity-hub grouped `having` ────────────────────────────────────────────
  {
    count: 1,
    file: "lib/server/catalogue.ts",
    pattern: "hub-group-by:having-over-growing-tables",
    reason:
      "readArchiveAffinity's weighted qualified-artist ladder (The Ear's capture-priority input), NOT a hub inclusion gate. Bounded by the enabled-label lane: it walks only tracks on `labels.seed_state = 'enabled'` via tracks_label_id_idx, and the Wave-1 hoist already made it once-per-call.",
  },
];

// ── The scan surface ───────────────────────────────────────────────────────────────

const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_ROOTS = ["lib/server", "db"];

/** Every non-test `.ts` file under a scan root, as a path relative to `src`. */
function listSourceFiles(root: string, prefix = root): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(`${SRC_DIR}/${prefix}`, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      out.push(...listSourceFiles(root, rel));
      continue;
    }

    // `*.integration.test.ts` ends in `.test.ts`, so one suffix covers both.
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }

    out.push(rel);
  }

  return out;
}

type FileScan = { readonly file: string; readonly occurrences: readonly Occurrence[] };

function scanSurface(): readonly FileScan[] {
  return SCAN_ROOTS.flatMap((root) => listSourceFiles(root)).map((file) => ({
    file,
    occurrences: findOccurrences(readFileSync(`${SRC_DIR}/${file}`, "utf8")),
  }));
}

const allowanceKey = (file: string, pattern: PatternId): string => `${file}${pattern}`;

describe("DB query-shape guardrail (growing tables)", () => {
  const scans = scanSurface();
  const allowed = new Map<string, AllowlistEntry>(
    ALLOWLIST.map((entry) => [allowanceKey(entry.file, entry.pattern), entry]),
  );

  it("scans a real surface (the scan roots resolve)", () => {
    // A path typo would make every other assertion vacuously pass, so pin the shape of
    // the surface itself: both roots present, and the known SQL-heavy files reached.
    expect(scans.length).toBeGreaterThan(100);
    expect(scans.map((scan) => scan.file)).toContain("lib/server/catalogue.ts");
    expect(scans.map((scan) => scan.file)).toContain("db/schema.ts");
  });

  it("has no forbidden query shape beyond its allowance", () => {
    for (const { file, occurrences } of scans) {
      const byPattern = new Map<PatternId, Occurrence[]>();

      for (const occurrence of occurrences) {
        const bucket = byPattern.get(occurrence.pattern) ?? [];

        bucket.push(occurrence);
        byPattern.set(occurrence.pattern, bucket);
      }

      for (const [pattern, hits] of byPattern) {
        const entry = allowed.get(allowanceKey(file, pattern));
        const allowance = entry?.count ?? 0;
        const where = hits.map((hit) => `${file}:${hit.line} (${hit.snippet})`).join(", ");

        expect(
          hits.length,
          `${file}: ${hits.length} occurrence(s) of the forbidden shape "${pattern}" but only ${allowance} allowed — ${where}.\n` +
            `This shape full-scans a growing table (docs/db-scale-backlog.md). Fix the query, or — if it is deliberately bounded or owned by a backlog item — raise the ALLOWLIST entry in ${"apps/web/src/lib/server/db-query-shape.test.ts"} with a reason.`,
        ).toBeLessThanOrEqual(allowance);
      }
    }
  });

  it("has no stale allowlist entry (the list only shrinks)", () => {
    const byFile = new Map(scans.map((scan) => [scan.file, scan.occurrences]));

    for (const entry of ALLOWLIST) {
      const occurrences = byFile.get(entry.file);

      expect(
        occurrences,
        `allowlist entry "${entry.file}" / "${entry.pattern}" names a file that is not in the scan surface — delete or repoint it`,
      ).toBeDefined();

      const actual = (occurrences ?? []).filter((hit) => hit.pattern === entry.pattern).length;

      expect(
        actual,
        `${entry.file}: the allowlist still reserves ${entry.count} occurrence(s) of "${entry.pattern}" but only ${actual} remain — SHRINK the entry (or delete it at 0). The allowance is a debt ceiling, not a budget to spend.`,
      ).toBe(entry.count);
    }
  });

  it("keeps every allowlist entry justified", () => {
    for (const entry of ALLOWLIST) {
      expect(
        entry.reason.length,
        `${entry.file} / ${entry.pattern}: an allowlist entry needs a real reason — why is this shape bounded, or which backlog item owns it?`,
      ).toBeGreaterThan(40);
      expect(entry.count, `${entry.file} / ${entry.pattern}: a zero entry is dead`).toBeGreaterThan(
        0,
      );
    }
  });
});

// ── The detector's own proof ───────────────────────────────────────────────────────
//
// A guardrail nobody has watched fail is not a guardrail. These pin the behaviour that
// makes the scan trustworthy: it fires on the real shapes, and it does NOT fire on the
// three things that would make it a nuisance (prose, a materialized query, and the
// `track_artists` anti-join that shares the `.track_id is null` spelling).

const patternsIn = (source: string): PatternId[] =>
  findOccurrences(source).map((occurrence) => occurrence.pattern);

describe("DB query-shape guardrail — detector", () => {
  it("fires on a bare catalogue anti-join, aliased or not", () => {
    expect(
      patternsIn(
        "const q = `select t.track_id from tracks t left join findings f on f.track_id = t.track_id where f.track_id is null and t.bpm > 170`;",
      ),
    ).toEqual(["anti-join:findings-is-null"]);
    expect(
      patternsIn(
        "const q = `select count(*) from tracks where not exists (select 1 from findings where findings.track_id = tracks.track_id)`;",
      ),
    ).toEqual(["anti-join:not-exists-findings"]);
  });

  it("does not fire once the statement reads the materialized discriminator", () => {
    expect(
      patternsIn(
        "const q = `select t.track_id from tracks t left join findings f on f.track_id = t.track_id where t.is_catalogue = 1 and f.track_id is null`;",
      ),
    ).toEqual([]);
  });

  it("does not fire on prose about the shape", () => {
    expect(
      patternsIn(
        "// A catalogue row is `findings.track_id is null`; never `select * from tracks`.\n/* lower(tracks.label) defeats the btree; libsql_vector_idx wedges hosted Turso. */\n",
      ),
    ).toEqual([]);
  });

  it("does not fire on the track_artists anti-join that shares the spelling", () => {
    expect(
      patternsIn(
        "const q = `select t.track_id from tracks t left join track_artists ta on ta.track_id = t.track_id where ta.track_id is null`;",
      ),
    ).toEqual([]);
  });

  it("fires on function-wrapped and unsargable filter columns", () => {
    expect(patternsIn("const q = `select 1 from tracks where lower(tracks.label) = ?`;")).toEqual([
      "fn-wrapped:lower-tracks",
    ]);
    expect(
      patternsIn(
        "const q = `select substr(tracks.release_date, 1, 4) as year from tracks group by year`;",
      ),
    ).toEqual(["fn-wrapped:substr-release-date"]);
    expect(
      patternsIn("const q = `select 1 from tracks where tracks.title like '%' || ? || '%'`;"),
    ).toEqual(["fn-wrapped:leading-wildcard-like"]);
    // A LIKE over a small table's column is not this shape.
    expect(
      patternsIn("const q = `select 1 from labels where labels.name like '%' || ? || '%'`;"),
    ).toEqual([]);
  });

  it("fires on the ANN index wedge and a star select of the fat table", () => {
    expect(
      patternsIn('await db.execute("create index tv on tracks (libsql_vector_idx(embedding))");'),
    ).toEqual(["vector-index:libsql_vector_idx"]);
    expect(patternsIn("const q = `select * from tracks where bpm > ?`;")).toEqual([
      "select-star:tracks",
    ]);
  });

  it("fires on a resurrected hub gate but not on the sitemap's lastmod group-by", () => {
    expect(
      patternsIn(
        "const q = `select l.slug from labels l join tracks t on t.label_id = l.id left join findings f on f.track_id = t.track_id group by l.id having count(t.track_id) >= ?`;",
      ),
    ).toContain("hub-group-by:having-over-growing-tables");
    expect(
      patternsIn(
        "const q = `select l.slug, max(f.added_at) as lastmod from labels l join tracks t on t.label_id = l.id left join findings f on f.track_id = t.track_id where l.renderable_track_count >= ? group by l.id`;",
      ),
    ).toEqual([]);
  });
});
