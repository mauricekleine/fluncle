import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { deleteArtistCascade } from "./lib";

const PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "prune-edge-cache-"));
process.env.PRUNE_OUT_DIR = PRUNE_OUT_DIR;

afterAll(() => {
  rmSync(PRUNE_OUT_DIR, { force: true, recursive: true });
});

type Statement = { args?: unknown; sql: string };

function catalogue(): Client {
  const deleted = new Set<string>();
  const rowsFor = (sql: string) => {
    if (deleted.size > 0) {
      return [];
    }
    if (/from artists where id in/.test(sql)) {
      return [{ slug: "crooner" }];
    }
    if (/from albums where id in/.test(sql)) {
      return [{ slug: "merry-christmas" }];
    }
    if (/join albums/.test(sql)) {
      return [{ slug: "merry-christmas" }, { slug: "swing-bass-vol-1" }];
    }
    if (/join labels/.test(sql)) {
      return [{ slug: "penny-black" }];
    }
    return [];
  };
  const execute = async (stmt: Statement | string) => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    if (/^\s*delete/i.test(sql)) {
      deleted.add(sql);
      return { rows: [], rowsAffected: 1 };
    }
    return { rows: rowsFor(sql), rowsAffected: 0 };
  };

  return {
    batch: async (stmts: Statement[]) => stmts.map(() => ({ rows: [], rowsAffected: 1 })),
    execute,
  } as unknown as Client;
}

test("a cascade delete purges every page it removed or changed from the edge cache", async () => {
  const purged: string[][] = [];

  await deleteArtistCascade(catalogue(), ["A_CROONER"], ["t_solo"], ["al_xmas"], async (urls) => {
    purged.push(urls);
  });

  expect(purged).toHaveLength(1);
  expect(purged[0]?.sort()).toEqual([
    "https://www.fluncle.com/album/merry-christmas",
    "https://www.fluncle.com/album/swing-bass-vol-1",
    "https://www.fluncle.com/artist/crooner",
    "https://www.fluncle.com/label/penny-black",
    "https://www.fluncle.com/track/t_solo",
  ]);
});

test("a failed purge leaves the URLs in a file for cache:purge instead of failing the delete", async () => {
  await deleteArtistCascade(catalogue(), [], ["t_solo"], [], async () => {
    throw new Error("CF_CACHE_PURGE_TOKEN is not set");
  });

  expect(readFileSync(join(PRUNE_OUT_DIR, "edge-cache-purge-urls.txt"), "utf8")).toContain(
    "https://www.fluncle.com/track/t_solo",
  );
});
