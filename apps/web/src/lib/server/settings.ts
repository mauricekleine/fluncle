import { getRequestScopedSettingsMemo } from "./database-request-scope";
import { getDb, typedRow, typedRows } from "./db";

function memoizeSettingRead(
  memo: Map<string, Promise<string | undefined>> | undefined,
  key: string,
  read: Promise<string | undefined>,
): Promise<string | undefined> {
  const pending = read.catch((error: unknown) => {
    if (memo?.get(key) === pending) {
      memo.delete(key);
    }
    throw error;
  });
  memo?.set(key, pending);
  return pending;
}

export async function getSetting(key: string): Promise<string | undefined> {
  const memo = getRequestScopedSettingsMemo();
  const existing = memo?.get(key);
  if (existing !== undefined) {
    return existing;
  }

  return memoizeSettingRead(
    memo,
    key,
    Promise.resolve().then(async () => {
      const db = await getDb();
      const result = await db.execute({
        args: [key],
        sql: `select value from settings where key = ? limit 1`,
      });
      return typedRow<{ value: string }>(result.rows)?.value;
    }),
  );
}

export async function getSettings(
  keys: readonly string[],
): Promise<Map<string, string | undefined>> {
  const uniqueKeys = [...new Set(keys)];
  const memo = getRequestScopedSettingsMemo();
  const reads = new Map<string, Promise<string | undefined>>();
  const missing = uniqueKeys.filter((key) => {
    const existing = memo?.get(key);
    if (existing === undefined) {
      return true;
    }
    reads.set(key, existing);
    return false;
  });

  if (missing.length > 0) {
    const batch = Promise.resolve().then(async () => {
      const db = await getDb();
      const result = await db.execute({
        args: missing,
        sql: `select key, value from settings where key in (${missing.map(() => "?").join(", ")})`,
      });
      return new Map(
        typedRows<{ key: string; value: string }>(result.rows).map((row) => [row.key, row.value]),
      );
    });
    for (const key of missing) {
      reads.set(
        key,
        memoizeSettingRead(
          memo,
          key,
          batch.then((values) => values.get(key)),
        ),
      );
    }
  }

  return new Map(
    await Promise.all(uniqueKeys.map(async (key) => [key, await reads.get(key)] as const)),
  );
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [key, value, value],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = ?`,
  });
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [key],
    sql: `delete from settings where key = ?`,
  });
}
