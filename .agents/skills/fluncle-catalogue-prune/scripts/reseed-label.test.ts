import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { main, resolverNodeId, retiredNote, splitLabelNodes } from "./reseed-label";

// Same rail as the rest of this suite: nothing here touches a real database. The stub routes rows
// by SQL so one `main()` call can be given a whole frontier, and the assertions pin the refusals
// (no label row / not enabled / no mb_label_id), the namesake classification, and that a dry-run
// performs ZERO writes.

type Row = Record<string, unknown>;
type Statement = { args?: unknown[]; sql: string };

type Stub = { client: Client; executed: Statement[] };

const isWrite = (sql: string): boolean => /^\s*(delete|insert|replace|update)\b/i.test(sql);

const writes = (s: Stub): Statement[] => s.executed.filter((st) => isWrite(st.sql));

// Redirect the rollback snapshot before ANY test runs. The script defaults `PRUNE_OUT_DIR` to `.`,
// so a confirm-path test without this writes a `*-rollback.json` into the repo — and in a real run
// that file is verbatim production rows. Set once, at the top, so a future test cannot forget.
const PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "reseed-label-"));
process.env.PRUNE_OUT_DIR = PRUNE_OUT_DIR;

afterAll(() => {
  rmSync(PRUNE_OUT_DIR, { force: true, recursive: true });
});

function stub(rowsFor: (sql: string) => Row[] = () => []): Stub {
  const executed: Statement[] = [];
  const client = {
    batch: async (stmts: Statement[]) => stmts.map(() => ({ rows: [], rowsAffected: 1 })),
    execute: async (stmt: Statement | string) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      executed.push({ args: typeof stmt === "string" ? undefined : stmt.args, sql });

      return { rows: rowsFor(sql), rowsAffected: 1 };
    },
  };

  return { client: client as unknown as Client, executed };
}

const SLUG = "radar-records";
const RIGHT_MBID = "11111111-1111-1111-1111-111111111111";
const WRONG_MBID = "99999999-9999-9999-9999-999999999999";

const labelRow = (over: Row = {}): Row => ({
  id: "lbl_1",
  mb_label_id: RIGHT_MBID,
  name: "Radar Records",
  seed_state: "enabled",
  slug: SLUG,
  ...over,
});

const node = (over: Row): Row => ({
  cursor: 0,
  external_id: "",
  hop: 0,
  kind: "label",
  label_slug: SLUG,
  note: null,
  source: "musicbrainz",
  state: "done",
  ...over,
});

/** A frontier holding the resolver node plus one right and one wrong-namesake MusicBrainz node. */
const FRONTIER: Row[] = [
  node({ external_id: SLUG, id: resolverNodeId(SLUG), source: "fluncle", state: "done" }),
  node({ cursor: 25, external_id: RIGHT_MBID, id: `musicbrainz:label:${RIGHT_MBID}` }),
  node({ cursor: 400, external_id: WRONG_MBID, id: `musicbrainz:label:${WRONG_MBID}` }),
];

/** Route the two reads `main` issues: the label row, then the frontier nodes. */
const frontierStub = (label: Row | undefined, nodes: Row[] = FRONTIER) =>
  stub((sql) => {
    if (sql.includes("from labels")) {
      return label ? [label] : [];
    }

    return sql.includes("from crawl_frontier") ? nodes : [];
  });

async function run(argv: string[], s: Stub): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await main(argv, async () => s.client);

    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("the resolver node id", () => {
  test("is the crawl's deterministic `<source>:<kind>:<external_id>`", () => {
    expect(resolverNodeId(SLUG)).toBe("fluncle:label:radar-records");
  });
});

describe("splitLabelNodes", () => {
  test("mb_label_id is the authority: a different MBID is the namesake", () => {
    const nodes = FRONTIER.map((r) => ({
      cursor: Number(r.cursor),
      external_id: String(r.external_id),
      hop: 0,
      id: String(r.id),
      label_slug: SLUG,
      note: null,
      source: String(r.source),
      state: String(r.state),
    }));
    const split = splitLabelNodes(nodes, SLUG, RIGHT_MBID);

    expect(split.resolver?.id).toBe(resolverNodeId(SLUG));
    expect(split.correct.map((n) => n.external_id)).toEqual([RIGHT_MBID]);
    expect(split.wrongNamesake.map((n) => n.external_id)).toEqual([WRONG_MBID]);
  });

  test("the fluncle resolver node is never classified as a namesake", () => {
    const resolver = {
      cursor: 0,
      external_id: SLUG,
      hop: 0,
      id: resolverNodeId(SLUG),
      label_slug: SLUG,
      note: null,
      source: "fluncle",
      state: "done",
    };
    const split = splitLabelNodes([resolver], SLUG, RIGHT_MBID);

    expect(split.wrongNamesake).toEqual([]);
    expect(split.resolver).toBe(resolver);
  });
});

describe("the refusals", () => {
  test("no mb_label_id — there is no authority to tell impostor from original", async () => {
    const s = frontierStub(labelRow({ mb_label_id: null }));
    const { code, out } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(1);
    expect(out).toContain("no mb_label_id");
    expect(out).toContain("ABORTED");
    expect(writes(s)).toEqual([]);
  });

  test("an mb_label_id that is not text (a NULL cell) refuses the same way", async () => {
    const s = frontierStub(labelRow({ mb_label_id: undefined }));
    const { code } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(1);
    expect(writes(s)).toEqual([]);
  });

  test("no labels row at all", async () => {
    const s = frontierStub(undefined);
    const { code, out } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(1);
    expect(out).toContain("no labels row");
    expect(writes(s)).toEqual([]);
  });

  test("a non-enabled seed is not this tool's problem", async () => {
    const s = frontierStub(labelRow({ seed_state: "disabled" }));
    const { code, out } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(1);
    expect(out).toContain("ENABLED seed");
    expect(writes(s)).toEqual([]);
  });

  test("no --slug is a no-op that never opens the database", async () => {
    let opened = false;
    const original = console.log;
    console.log = () => {};
    try {
      const code = await main([], async () => {
        opened = true;

        return stub().client;
      });

      expect(code).toBe(0);
      expect(opened).toBe(false);
    } finally {
      console.log = original;
    }
  });
});

describe("the dry run", () => {
  test("performs ZERO writes and flags the namesake node", async () => {
    const s = frontierStub(labelRow());
    const { code, out } = await run(["--slug", SLUG], s);

    expect(code).toBe(0);
    expect(out).toContain("WRONG NAMESAKE");
    expect(out).toContain(WRONG_MBID);
    expect(out).toContain("to retire 1");
    expect(out).toContain("DRY RUN — nothing written");
    expect(writes(s)).toEqual([]);
    // It DID read the frontier — no writes is not no work.
    expect(s.executed.some((st) => st.sql.includes("from crawl_frontier"))).toBe(true);
  });

  test("a clean seed with nothing to repair reports it and stops", async () => {
    const s = frontierStub(labelRow(), []);
    const { code, out } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(0);
    expect(out).toContain("Nothing to repair");
    expect(writes(s)).toEqual([]);
  });
});

describe("--confirm", () => {
  test("re-arms the resolver to pending/cursor 0 and stamps ONLY the namesake node", async () => {
    const s = frontierStub(labelRow());
    const { code } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(0);
    const w = writes(s).map((st) => ({
      args: st.args,
      sql: st.sql.replaceAll(/\s+/g, " ").trim(),
    }));
    expect(w).toHaveLength(2);
    expect(w[0]?.sql).toBe(
      "update crawl_frontier set state = 'pending', cursor = 0, updated_at = ? where id = ?",
    );
    expect(w[0]?.args?.[1]).toBe(resolverNodeId(SLUG));
    // The namesake node is NOTED, never deleted — the row is the record of what was walked.
    expect(w[1]?.sql).toBe("update crawl_frontier set note = ?, updated_at = ? where id = ?");
    expect(w[1]?.args?.[0]).toBe(retiredNote(new Date()));
    expect(w[1]?.args?.[2]).toBe(`musicbrainz:label:${WRONG_MBID}`);
    // The CORRECT MB node is untouched.
    expect(w.some((st) => st.args?.includes(`musicbrainz:label:${RIGHT_MBID}`))).toBe(false);
  });

  test("nothing is ever deleted from the frontier", async () => {
    const s = frontierStub(labelRow());
    await run(["--slug", SLUG, "--confirm"], s);

    expect(s.executed.some((st) => /^\s*delete/i.test(st.sql))).toBe(false);
  });

  test("an absent resolver node retires the namesake without inventing a re-arm", async () => {
    const s = frontierStub(
      labelRow(),
      FRONTIER.filter((r) => r.source === "musicbrainz"),
    );
    const { code, out } = await run(["--slug", SLUG, "--confirm"], s);

    expect(code).toBe(0);
    expect(out).toContain("absent");
    expect(writes(s)).toHaveLength(1);
    expect(writes(s)[0]?.sql).toContain("set note = ?");
  });
});

describe("the retired note", () => {
  test("names the class and dates itself", () => {
    expect(retiredNote(new Date("2026-07-27T12:00:00.000Z"))).toBe(
      "wrong namesake; retired 2026-07-27",
    );
  });
});
