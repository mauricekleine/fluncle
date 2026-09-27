import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { takeLockDir, truncateCheckpoint } from "./device-mirror";

const scratch: string[] = [];

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "device-mirror-lock-"));
  scratch.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("the device mirror's lock", () => {
  test("waits out a short holder instead of skipping its tick", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    setTimeout(() => rmdirSync(lockDir), 120);

    const taken = await takeLockDir(lockDir, { pollMs: 20, staleMs: 60_000, waitMs: 5_000 });

    expect(taken).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("gives up only after its wait window when the holder never lets go", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    let clock = Date.now();
    const sleeps: number[] = [];

    const taken = await takeLockDir(lockDir, {
      now: () => clock,
      pollMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      staleMs: 15 * 60_000,
      waitMs: 120_000,
    });

    expect(taken).toBe(false);
    expect(sleeps.length).toBe(120);
  });

  test("takes over a lock left by a dead tick", async () => {
    const lockDir = join(scratchDir(), ".device-mirror.lock");
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockDir, old, old);

    expect(await takeLockDir(lockDir, { pollMs: 20, staleMs: 15 * 60_000, waitMs: 0 })).toBe(true);
  });
});

describe("the replica checkpoint", () => {
  function walDatabase(): { path: string; writer: Database } {
    const path = join(scratchDir(), "source-replica.db");
    const writer = new Database(path, { create: true, strict: true });
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("create table tracks (track_id text primary key)");
    writer.run("insert into tracks values ('a')");

    return { path, writer };
  }

  test("fails loudly while a reader keeps the WAL from truncating", () => {
    const { path, writer } = walDatabase();
    const reader = new Database(path, { readonly: true, strict: true });
    reader.run("BEGIN");
    reader.query("select count(*) from tracks").get();
    writer.run("insert into tracks values ('b')");

    expect(() => truncateCheckpoint(writer, { attempts: 3, sleep: () => {} })).toThrow(
      "checkpoint stayed busy",
    );

    reader.run("COMMIT");
    reader.close();
    writer.close();
  });

  test("retries until the reader lets go, then completes", () => {
    const { path, writer } = walDatabase();
    const reader = new Database(path, { readonly: true, strict: true });
    reader.run("BEGIN");
    reader.query("select count(*) from tracks").get();
    writer.run("insert into tracks values ('b')");
    let waits = 0;

    truncateCheckpoint(writer, {
      attempts: 5,
      sleep: () => {
        waits += 1;
        if (reader.inTransaction) {
          reader.run("COMMIT");
        }
      },
    });

    expect(waits).toBe(1);
    reader.close();
    writer.close();
  });
});
