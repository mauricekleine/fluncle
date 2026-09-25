import { type KeyValueSource, readWithMigration } from "@/lib/storage-migration";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

type Recorder = {
  removed: string[];
  written: { key: string; value: string }[];
};

function memoryStore(
  seed: Record<string, string> = {},
  fail: { get?: boolean; remove?: boolean; set?: boolean } = {},
): { recorder: Recorder; source: KeyValueSource; values: Record<string, string> } {
  const values: Record<string, string> = { ...seed };
  const recorder: Recorder = { removed: [], written: [] };
  const source: KeyValueSource = {
    getItem: async (key) => {
      if (fail.get === true) {
        throw new Error("read failed");
      }
      return values[key] ?? null;
    },
    removeItem: async (key) => {
      if (fail.remove === true) {
        throw new Error("remove failed");
      }
      recorder.removed.push(key);
      delete values[key];
    },
    setItem: async (key, value) => {
      if (fail.set === true) {
        throw new Error("write failed");
      }
      recorder.written.push({ key, value });
      values[key] = value;
    },
  };
  return { recorder, source, values };
}

const KEY = "fluncle.saved.v1";

{
  const kv = memoryStore({ [KEY]: "from-kv" });
  const legacy = memoryStore({ [KEY]: "from-legacy" });
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, "from-kv", "kv wins when it holds a value");
  assertEqual(kv.recorder.written.length, 0, "no migration write when kv already has it");
  assertEqual(legacy.recorder.removed.length, 0, "the legacy key is left alone");
  assertEqual(legacy.values[KEY], "from-legacy", "the legacy value is untouched");
}

{
  const kv = memoryStore();
  const legacy = memoryStore({ [KEY]: "carried" });
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, "carried", "the legacy value is served");
  assertEqual(kv.values[KEY], "carried", "the value landed in kv");
  assertEqual(kv.recorder.written.length, 1, "copied up exactly once");
  assertEqual(legacy.recorder.removed[0], KEY, "the legacy key is removed after the copy");
  assertEqual(legacy.values[KEY], undefined, "the value is no longer double-held");
}

{
  const kv = memoryStore();
  const legacy = memoryStore({ [KEY]: "carried" });
  await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  const again = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(again, "carried", "the second read still serves the value");
  assertEqual(kv.recorder.written.length, 1, "no second copy-up");
  assertEqual(legacy.recorder.removed.length, 1, "no second removal");
}

{
  const kv = memoryStore();
  const legacy = memoryStore();
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, null, "nothing stored anywhere → null");
  assertEqual(kv.recorder.written.length, 0, "nothing is written when there is nothing to carry");
  assertEqual(legacy.recorder.removed.length, 0, "nothing is removed either");
}

{
  const kv = memoryStore();
  const legacy = memoryStore({ [KEY]: "unreachable" }, { get: true });
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, null, "a legacy read failure reads as empty");
  assertEqual(kv.recorder.written.length, 0, "and carries nothing up");
}

{
  const kv = memoryStore({ [KEY]: "unreachable" }, { get: true });
  const legacy = memoryStore({ [KEY]: "carried" });
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, "carried", "a kv read failure falls back to the legacy value");
}

{
  const kv = memoryStore({}, { set: true });
  const legacy = memoryStore({ [KEY]: "carried" });
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, "carried", "the value is served even when the copy-up fails");
  assertEqual(legacy.values[KEY], "carried", "the legacy key survives so the retry can find it");
  assertEqual(legacy.recorder.removed.length, 0, "nothing is removed on a failed copy-up");
}

{
  const kv = memoryStore();
  const legacy = memoryStore({ [KEY]: "carried" }, { remove: true });
  const value = await readWithMigration({ key: KEY, kv: kv.source, legacy: legacy.source });
  assertEqual(value, "carried", "a removal failure never fails the read");
  assertEqual(kv.values[KEY], "carried", "the copy-up still stands, so kv answers next launch");
}

console.log("storage-migration.test.ts: all assertions passed");
