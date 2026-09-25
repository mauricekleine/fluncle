export type KeyValueSource = {
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
};

async function readOrNull(source: KeyValueSource, key: string): Promise<string | null> {
  try {
    return await source.getItem(key);
  } catch {
    return null;
  }
}

export async function readWithMigration({
  key,
  kv,
  legacy,
}: {
  key: string;
  kv: KeyValueSource;
  legacy: KeyValueSource;
}): Promise<string | null> {
  const current = await readOrNull(kv, key);
  if (current !== null) {
    return current;
  }

  const carried = await readOrNull(legacy, key);
  if (carried === null) {
    return null;
  }

  try {
    await kv.setItem(key, carried);
  } catch {
    return carried;
  }

  try {
    await legacy.removeItem(key);
  } catch {}

  return carried;
}
