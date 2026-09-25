import { getDb, typedRow } from "./db";

export async function getSetting(key: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [key],
    sql: `select value from settings where key = ? limit 1`,
  });

  return typedRow<{ value: string }>(result.rows)?.value;
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
