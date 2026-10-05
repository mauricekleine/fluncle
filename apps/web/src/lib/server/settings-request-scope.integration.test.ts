import { type Client, type InStatement } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb } from "./integration-db";

let client: Client;
let directory: string;

vi.mock("@libsql/client/web", () => ({ createClient: () => client }));
vi.mock("./env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env")>();
  return {
    ...actual,
    readEnvs: async () => ({ TURSO_AUTH_TOKEN: "test", TURSO_DATABASE_URL: ":memory:" }),
  };
});

const { getDb } = await import("./db");
const { runWithDatabaseRequestScope } = await import("./database-request-scope");
const { deleteSetting, getSetting, getSettings, setSetting } = await import("./settings");
const { getSpotifyAnchorBreakerState } = await import("./spotify-anchor-breaker");

function sqlOf(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

function observeReads() {
  const execute = vi.spyOn(client, "execute");
  return {
    execute,
    reads: () =>
      execute.mock.calls.filter(([statement]) =>
        /^\s*select\b[\s\S]*\bfrom\s+settings\b/i.test(sqlOf(statement)),
      ),
  };
}

function barrier() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

async function seed(key: string, value: string): Promise<void> {
  await client.execute({
    args: [key, value],
    sql: "insert into settings (key, value) values (?, ?)",
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fluncle-settings-scope-"));
  client = await createIntegrationDb({ url: `file:${join(directory, "settings.db")}` });
});

afterEach(async () => {
  vi.restoreAllMocks();
  client.close();
  await rm(directory, { force: true, recursive: true });
});

describe("request-scoped settings reads", () => {
  it("shares sequential and concurrent reads per key within each independent request", async () => {
    await seed("a", "alpha");
    await seed("b", "beta");
    const { reads } = observeReads();

    for (let request = 0; request < 2; request += 1) {
      await runWithDatabaseRequestScope(async () => {
        expect(await Promise.all(Array.from({ length: 8 }, () => getSetting("a")))).toEqual(
          Array.from({ length: 8 }, () => "alpha"),
        );
        expect(await getSetting("a")).toBe("alpha");
        expect(await getSetting("b")).toBe("beta");
        expect(await getSetting("b")).toBe("beta");
      });
      expect(reads()).toHaveLength((request + 1) * 2);
    }
  });

  it("reads on every call outside a request scope", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    expect(await getSetting("a")).toBe("alpha");
    expect(await Promise.all([getSetting("a"), getSetting("a")])).toEqual(["alpha", "alpha"]);
    expect(reads()).toHaveLength(3);
  });

  it("observes another request's setting change on the next request", async () => {
    await seed("a", "alpha");
    const firstRead = barrier();
    const written = barrier();
    const { reads } = observeReads();
    const firstRequest = runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      firstRead.release();
      await written.promise;
      expect(await getSetting("a")).toBe("alpha");
    });
    await firstRead.promise;
    await runWithDatabaseRequestScope(() => setSetting("a", "new"));
    written.release();
    await firstRequest;
    expect(await runWithDatabaseRequestScope(() => getSetting("a"))).toBe("new");
    expect(reads()).toHaveLength(2);
  });

  it("does not restore an invalidated memo when an older read settles", async () => {
    await seed("a", "alpha");
    const rawExecute = client.execute.bind(client);
    const started = barrier();
    const settle = barrier();
    const { execute, reads } = observeReads();
    execute.mockImplementationOnce(async (statement) => {
      const result = await rawExecute(statement);
      started.release();
      await settle.promise;
      return result;
    });
    await runWithDatabaseRequestScope(async () => {
      const olderRead = getSetting("a");
      await started.promise;
      await (await getDb()).execute("update settings set value = 'new' where key = 'a'");
      expect(await getSetting("a")).toBe("new");
      settle.release();
      expect(await olderRead).toBe("alpha");
      expect(await getSetting("a")).toBe("new");
      expect(reads()).toHaveLength(2);
    });
  });

  it("does not evict a newer memoized read when an older read rejects", async () => {
    await seed("a", "alpha");
    const rawExecute = client.execute.bind(client);
    const started = barrier();
    const settle = barrier();
    const { execute, reads } = observeReads();
    execute.mockImplementationOnce(async (statement) => {
      await rawExecute(statement);
      started.release();
      await settle.promise;
      throw new Error("older read failed");
    });
    await runWithDatabaseRequestScope(async () => {
      const olderRead = getSetting("a").catch((error: unknown) => error);
      await started.promise;
      await setSetting("a", "new");
      expect(await getSetting("a")).toBe("new");
      settle.release();
      expect(await olderRead).toEqual(new Error("older read failed"));
      expect(await getSetting("a")).toBe("new");
      expect(reads()).toHaveLength(2);
    });
  });

  it.each(["set", "delete"] as const)(
    "does not overwrite a newer raw write when an older %s response arrives late",
    async (operation) => {
      await seed("a", "alpha");
      const rawExecute = client.execute.bind(client);
      const started = barrier();
      const settle = barrier();
      const { execute, reads } = observeReads();
      execute.mockImplementationOnce(async (statement) => {
        const result = await rawExecute(statement);
        started.release();
        await settle.promise;
        return result;
      });
      await runWithDatabaseRequestScope(async () => {
        const olderWrite = operation === "set" ? setSetting("a", "older") : deleteSetting("a");
        await started.promise;
        await (await getDb()).execute("replace into settings (key, value) values ('a', 'newer')");
        settle.release();
        await olderWrite;
        expect(await getSetting("a")).toBe("newer");
        expect(reads()).toHaveLength(1);
      });
    },
  );

  it("keeps absent keys distinct from a stored empty value", async () => {
    await seed("empty", "");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("absent")).toBeUndefined();
      expect(await getSetting("empty")).toBe("");
      expect(await getSetting("absent")).toBeUndefined();
      expect(await getSetting("empty")).toBe("");
      expect(reads()).toHaveLength(2);
    });
  });

  it("re-reads once after successful sets and deletes within the request", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      await setSetting("a", "new");
      expect(await getSetting("a")).toBe("new");
      expect(await getSetting("a")).toBe("new");
      expect(reads()).toHaveLength(2);
      await deleteSetting("a");
      expect(await getSetting("a")).toBeUndefined();
      expect(await getSetting("a")).toBeUndefined();
      expect(reads()).toHaveLength(3);
    });
  });

  it("retries a rejected read instead of caching its failure", async () => {
    await seed("a", "alpha");
    const { execute, reads } = observeReads();
    execute.mockRejectedValueOnce(new Error("settings unavailable"));
    await runWithDatabaseRequestScope(async () => {
      await expect(getSetting("a")).rejects.toThrow("settings unavailable");
      expect(await getSetting("a")).toBe("alpha");
      expect(await getSetting("a")).toBe("alpha");
      expect(reads()).toHaveLength(2);
    });
  });

  it.each(["set", "delete"] as const)(
    "evicts memoized values after a failed %s",
    async (operation) => {
      await seed("a", "alpha");
      const { execute, reads } = observeReads();
      await runWithDatabaseRequestScope(async () => {
        expect(await getSetting("a")).toBe("alpha");
        execute.mockRejectedValueOnce(new Error("write unavailable"));
        await expect(
          operation === "set" ? setSetting("a", "new") : deleteSetting("a"),
        ).rejects.toThrow("write unavailable");
        expect(await getSetting("a")).toBe("alpha");
        expect(reads()).toHaveLength(2);
      });
    },
  );
});

describe("batched settings reads", () => {
  it("batches unique missing keys and shares both present and absent results with single reads", async () => {
    await seed("a", "alpha");
    await seed("b", "beta");
    await seed("d", "delta");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSettings(["a", "b", "c", "a"])).toEqual(
        new Map([
          ["a", "alpha"],
          ["b", "beta"],
          ["c", undefined],
        ]),
      );
      expect(reads()).toHaveLength(1);
      expect(await getSetting("a")).toBe("alpha");
      expect(await getSetting("c")).toBeUndefined();
      expect(await getSettings(["b", "d", "c"])).toEqual(
        new Map([
          ["b", "beta"],
          ["d", "delta"],
          ["c", undefined],
        ]),
      );
      expect(reads()).toHaveLength(2);
      const statement = reads()[1]?.[0] as InStatement | undefined;
      expect(typeof statement === "object" ? statement.args : undefined).toEqual(["d"]);
      expect(await getSettings([])).toEqual(new Map());
      expect(await getSettings(["a", "d"])).toEqual(
        new Map([
          ["a", "alpha"],
          ["d", "delta"],
        ]),
      );
      expect(reads()).toHaveLength(2);
    });
  });

  it("shares in-flight keys across overlapping batch and single reads", async () => {
    await seed("a", "alpha");
    await seed("b", "beta");
    await seed("c", "gamma");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      const first = getSettings(["a", "b"]);
      const single = getSetting("a");
      const second = getSettings(["b", "c"]);
      expect(await first).toEqual(
        new Map([
          ["a", "alpha"],
          ["b", "beta"],
        ]),
      );
      expect(await single).toBe("alpha");
      expect(await second).toEqual(
        new Map([
          ["b", "beta"],
          ["c", "gamma"],
        ]),
      );
      expect(reads()).toHaveLength(2);
    });
  });

  it("does one query per nonempty batch outside a scope and none for an empty batch", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    expect(await getSettings(["a", "a", "b"])).toEqual(
      new Map([
        ["a", "alpha"],
        ["b", undefined],
      ]),
    );
    expect(await getSettings(["a", "b"])).toEqual(
      new Map([
        ["a", "alpha"],
        ["b", undefined],
      ]),
    );
    expect(await getSettings([])).toEqual(new Map());
    expect(reads()).toHaveLength(2);
  });

  it("evicts every failed batch key so a later batch can retry", async () => {
    await seed("a", "alpha");
    const { execute, reads } = observeReads();
    execute.mockRejectedValueOnce(new Error("settings unavailable"));
    await runWithDatabaseRequestScope(async () => {
      await expect(getSettings(["a", "b"])).rejects.toThrow("settings unavailable");
      expect(await getSettings(["a", "b"])).toEqual(
        new Map([
          ["a", "alpha"],
          ["b", undefined],
        ]),
      );
      expect(await getSetting("b")).toBeUndefined();
      expect(reads()).toHaveLength(2);
    });
  });

  it("reads the Spotify breaker state in one settings query", async () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    const stamp = new Date(now - 60_000).toISOString();
    await seed("spotify_anchor_breaker_tripped_at", stamp);
    await seed("spotify_anchor_breaker_failures", "3");
    await seed("spotify_anchor_breaker_reason", "throttled");
    await seed("spotify_anchor_breaker_last_failure_at", stamp);
    const { reads } = observeReads();
    expect(await getSpotifyAnchorBreakerState(now)).toMatchObject({
      reason: "throttled",
      throttlesInWindow: 3,
      tripped: true,
      trippedAt: stamp,
    });
    expect(reads()).toHaveLength(1);
  });
});

describe("instrumented settings write invalidation", () => {
  it.each(["insert", "update", "delete", "replace"] as const)(
    "invalidates the whole settings memo after a raw %s",
    async (operation) => {
      await seed("a", "alpha");
      await seed("b", "beta");
      const { reads } = observeReads();
      await runWithDatabaseRequestScope(async () => {
        const db = await getDb();
        expect(await getSetting("a")).toBe("alpha");
        expect(await getSetting("b")).toBe("beta");
        const statements = {
          delete: "delete from settings where key = 'a'",
          insert:
            "insert into settings (key, value) values ('a', 'new') on conflict(key) do update set value = excluded.value",
          replace: "replace into settings (key, value) values ('a', 'new')",
          update: "update settings set value = 'new' where key = 'a'",
        };
        await db.execute(statements[operation]);
        expect(await getSetting("a")).toBe(operation === "delete" ? undefined : "new");
        expect(await getSetting("b")).toBe("beta");
        expect(await getSetting("a")).toBe(operation === "delete" ? undefined : "new");
        expect(await getSetting("b")).toBe("beta");
        expect(reads()).toHaveLength(4);
      });
    },
  );

  it("invalidates after a settings write in a mixed client batch", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      await (
        await getDb()
      ).batch(
        ["select 1", { args: ["new", "a"], sql: "update settings set value = ? where key = ?" }],
        "write",
      );
      expect(await getSetting("a")).toBe("new");
      expect(reads()).toHaveLength(2);
    });
  });

  it("invalidates after a failed raw settings write", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      await expect(
        (await getDb()).execute("update settings set missing_column = 'new' where key = 'a'"),
      ).rejects.toThrow();
      expect(await getSetting("a")).toBe("alpha");
      expect(reads()).toHaveLength(2);
    });
  });

  it("invalidates after a settings write in a failed mixed batch", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      await expect(
        (await getDb()).batch(
          [
            "update settings set value = 'new' where key = 'a'",
            "select missing_column from settings",
          ],
          "write",
        ),
      ).rejects.toThrow();
      expect(await getSetting("a")).toBe("alpha");
      expect(reads()).toHaveLength(2);
    });
  });

  it("invalidates after a failed transaction settings write and rollback", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      const transaction = await (await getDb()).transaction("write");
      try {
        await expect(
          transaction.execute("update settings set missing_column = 'new' where key = 'a'"),
        ).rejects.toThrow();
        expect(await getSetting("a")).toBe("alpha");
        await transaction.rollback();
        expect(await getSetting("a")).toBe("alpha");
        expect(reads()).toHaveLength(3);
      } finally {
        transaction.close();
      }
    });
  });

  it.each(["execute", "batch", "executeMultiple"] as const)(
    "invalidates after a committed transaction using %s",
    async (method) => {
      await seed("a", "alpha");
      const { reads } = observeReads();
      await runWithDatabaseRequestScope(async () => {
        expect(await getSetting("a")).toBe("alpha");
        const transaction = await (await getDb()).transaction("write");
        try {
          const statement = "update settings set value = 'new' where key = 'a'";
          if (method === "batch") {
            await transaction.batch([statement]);
          } else {
            await transaction[method](statement);
          }
          expect(await getSetting("a")).toBe("alpha");
          await transaction.commit();
          expect(await getSetting("a")).toBe("new");
          expect(reads()).toHaveLength(3);
        } finally {
          transaction.close();
        }
      });
    },
  );

  it("invalidates transaction-local memo values when a settings write rolls back", async () => {
    await seed("a", "alpha");
    const { reads } = observeReads();
    await runWithDatabaseRequestScope(async () => {
      expect(await getSetting("a")).toBe("alpha");
      const transaction = await (await getDb()).transaction("write");
      try {
        await transaction.execute("update settings set value = 'new' where key = 'a'");
        expect(await getSetting("a")).toBe("alpha");
        await transaction.rollback();
        expect(await getSetting("a")).toBe("alpha");
        expect(reads()).toHaveLength(3);
      } finally {
        transaction.close();
      }
    });
  });
});
