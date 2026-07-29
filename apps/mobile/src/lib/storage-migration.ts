// One-shot key migration between two key-value stores — the pure half of the device
// stores' move from AsyncStorage to `expo-sqlite/kv-store` (RFC: offline-first mobile,
// slice 1). Phones in the field hold real saves and a real set-in-progress under the old
// keys; a bare import swap would silently lose them on update, so the first read after
// the swap carries the value across.
//
// Deliberately framework-free: both stores arrive as structural `{ getItem, setItem,
// removeItem }` sources, so this file imports neither expo-sqlite nor AsyncStorage and
// the truth table below is unit-testable under plain `bun test`.
//
// THE CONTRACT — every branch degrades to "serve what we can, never throw":
//   kv has a value                  → serve it; the legacy store is never touched.
//   kv empty, legacy has a value    → copy up, drop the legacy key, serve the value.
//   both empty                      → null (a first launch, or an already-drained key).
//   a read fails                    → treated as empty; the other store still answers.
//   the copy-up fails               → serve the legacy value anyway and KEEP the legacy
//                                     key, so the next launch retries the migration.

/** The slice of a key-value store this migration needs — AsyncStorage's shape, which
 * `expo-sqlite/kv-store`'s default export mirrors alias for alias. */
export type KeyValueSource = {
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
};

// A store that is missing, wedged, or mid-upgrade reads as empty rather than throwing:
// the caller's job is to hand the app a value or nothing, never an exception.
async function readOrNull(source: KeyValueSource, key: string): Promise<string | null> {
  try {
    return await source.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Read `key`, migrating it out of `legacy` and into `kv` the first time it is found there.
 * Returns the value the app should use, or null when neither store holds one. Never throws
 * — see the contract above for what each failure degrades to.
 */
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
    // The new store would not take it. Serve the value this launch and leave the legacy
    // key standing so the next launch tries again — losing it here would lose it forever.
    return carried;
  }

  // Copied. Drop the legacy key so the migration is one-shot and the value is not
  // double-held; a failed removal is harmless (the kv read wins from now on).
  try {
    await legacy.removeItem(key);
  } catch {
    // Nothing to do — the next launch reads from kv and never consults legacy again.
  }

  return carried;
}
