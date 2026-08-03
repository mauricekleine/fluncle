import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE has_isrc MIRROR RAIL (schema.ts § `has_isrc`) — the `embedding-mirror.test.ts` net applied
// to the ISRC-presence mirror.
//
// `tracks.has_isrc` is a MAINTAINED mirror of `isrc is not null and trim(isrc) <> ''`, and its one
// consumer is the anchor worklist's drain order: `ANCHOR_ORDER` leads with it so anchorability is
// an index walk of `tracks_anchor_order_idx` rather than a materialise-and-sort of the growing
// un-anchored catalogue. A mirror is only worth having if it cannot drift, so the invariant is:
// EVERY statement that assigns `isrc` assigns `has_isrc` in the same statement — the fill-empty
// writers through the shared `FILL_ISRC_SQL` fragment (isrc.ts), the inserts and the generic
// update through `hasIsrc()`. This scans the server source and fails on any writer that skips
// both; the complement — that the mirror's VALUE is right, not merely present — is proven on live
// rows by the anchor worklist integration tests and `backfill-has-isrc.test.ts`.

const SERVER = fileURLToPath(new URL("./", import.meta.url));

/** Every non-test `.ts` under `lib/server`, recursively, as paths relative to the server root. */
function serverSources(dir = SERVER, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...serverSources(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(rel);
    }
  }

  return out;
}

/**
 * One SQL `isrc = …` assignment and the statement it sits in (approximated as a ±400-char window —
 * deliberately crude: a false ALARM is a reviewer reading one line, a false pass is a drifted
 * mirror in production). The pattern matches only the SQL spellings (`isrc = ?` /
 * `isrc = coalesce(…)`), never a JS `const isrc = …` binding, and the lookbehind keeps
 * `has_isrc =` and `anchor_queue_isrc =` out of the writer set.
 */
type Assignment = { file: string; statement: string };

function assignments(): Assignment[] {
  const found: Assignment[] = [];

  for (const file of serverSources()) {
    // Skip the shared fragment's own definition — it IS the mirror pairing, not a bare write.
    if (file === "isrc.ts") {
      continue;
    }

    const source = readFileSync(join(SERVER, file), "utf8");

    for (const match of source.matchAll(/(?<![\w])isrc\s*=\s*(\?|coalesce)/g)) {
      const start = Math.max(0, match.index - 400);
      found.push({ file, statement: source.slice(start, match.index + 400) });
    }
  }

  return found;
}

/** Every `insert into tracks` statement that names the `isrc` column, with its column list. */
function isrcInserts(): Assignment[] {
  const found: Assignment[] = [];

  for (const file of serverSources()) {
    const source = readFileSync(join(SERVER, file), "utf8");

    for (const match of source.matchAll(/insert(?:\s+or\s+ignore)?\s+into\s+tracks/g)) {
      const statement = source.slice(match.index, match.index + 900);

      if (/[(,\s]isrc\s*[,)]/.test(statement)) {
        found.push({ file, statement });
      }
    }
  }

  return found;
}

/** Statements that fill the ISRC through the shared fragment rather than spelling it out. */
function sharedFills(): string[] {
  return serverSources().filter(
    (file) =>
      file !== "isrc.ts" && readFileSync(join(SERVER, file), "utf8").includes("${FILL_ISRC_SQL}"),
  );
}

describe("the has_isrc mirror cannot drift", () => {
  it("finds the isrc writers at all (the scanner still works)", () => {
    // A guard on the guard: if a refactor moves these writes somewhere this test cannot see, the
    // suite must fail loudly rather than pass by finding nothing to check. Both spellings count —
    // the generic-update `isrc = ?` arm plus the fill-empty writers through the shared fragment,
    // and the three insert paths that mint a row with its ISRC.
    expect(assignments().length + sharedFills().length).toBeGreaterThanOrEqual(3);
    expect(isrcInserts().length).toBeGreaterThanOrEqual(3);
  });

  it("pairs every SQL isrc assignment with its has_isrc mirror", () => {
    const unpaired = assignments()
      .filter(
        ({ statement }) => !statement.includes("has_isrc") && !statement.includes("FILL_ISRC_SQL"),
      )
      .map(({ file }) => file);

    expect(unpaired).toEqual([]);
  });

  it("pairs every tracks insert that names isrc with its has_isrc mirror", () => {
    const unpaired = isrcInserts()
      .filter(({ statement }) => !statement.includes("has_isrc"))
      .map(({ file }) => file);

    expect(unpaired).toEqual([]);
  });

  it("keeps the shared fill fragment carrying both halves", () => {
    const isrc = readFileSync(join(SERVER, "isrc.ts"), "utf8");

    expect(isrc).toContain("isrc = coalesce(isrc, ?)");
    expect(isrc).toContain("has_isrc = (trim(coalesce(isrc, ?, '')) <> '')");
  });
});
