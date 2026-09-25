import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AttemptRecord = { attempts: number; lastAttemptEpoch: number };

export type AttemptLedger = Map<string, AttemptRecord>;

export function attemptLedgerPath(stateDir: string): string {
  return join(stateDir, "attempts");
}

export function defaultStateDir(name: string): string {
  return join(process.env.HOME ?? "/opt/data/home", `.${name}`);
}

export function parseAttemptLedger(text: string): AttemptLedger {
  const ledger: AttemptLedger = new Map();

  for (const line of text.split("\n")) {
    const [key, attempts, epoch] = line.split("\t");
    const parsed = Number.parseInt(attempts ?? "", 10);

    if (!key || !Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }

    const parsedEpoch = Number.parseInt(epoch ?? "", 10);

    ledger.set(key, {
      attempts: parsed,
      lastAttemptEpoch: Number.isFinite(parsedEpoch) ? parsedEpoch : 0,
    });
  }

  return ledger;
}

export function formatAttemptLedger(ledger: AttemptLedger): string {
  return [...ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, record]) => `${key}\t${record.attempts}\t${record.lastAttemptEpoch}`)
    .join("\n");
}

export function planAttempt(
  ledger: AttemptLedger,
  key: string,
  maxAttempts: number,
): { attempt: number; exhausted: boolean; spent: number } {
  const spent = ledger.get(key)?.attempts ?? 0;

  return { attempt: spent + 1, exhausted: spent >= maxAttempts, spent };
}

export function recordAttempt(ledger: AttemptLedger, key: string, nowEpoch: number): AttemptLedger {
  ledger.set(key, {
    attempts: (ledger.get(key)?.attempts ?? 0) + 1,
    lastAttemptEpoch: nowEpoch,
  });

  return ledger;
}

export function clearAttempts(ledger: AttemptLedger, key: string): AttemptLedger {
  ledger.delete(key);

  return ledger;
}

export function selectWork<T>(
  queue: readonly T[],
  ledger: AttemptLedger,
  keyOf: (row: T) => string | null,
  cap: number,
  maxAttempts: number,
): { exhausted: T[]; work: T[] } {
  const exhausted: T[] = [];
  const workable: T[] = [];

  for (const row of queue) {
    const key = keyOf(row);

    if (key !== null && planAttempt(ledger, key, maxAttempts).exhausted) {
      exhausted.push(row);
      continue;
    }

    workable.push(row);
  }

  return { exhausted, work: workable.slice(0, cap) };
}

export function readAttemptLedger(path: string): AttemptLedger {
  try {
    return parseAttemptLedger(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

export function writeAttemptLedger(
  path: string,
  ledger: AttemptLedger,
  log: (message: string) => void,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${formatAttemptLedger(ledger)}\n`, "utf8");
  } catch (error) {
    log(
      `could not persist the attempt ledger (${error instanceof Error ? error.message : String(error)}) — the budget may be re-spent next tick`,
    );
  }
}

export function exhaustedRecapLine(
  noun: string,
  keys: readonly string[],
  maxAttempts: number,
): string {
  return `not working ${keys.length} exhausted ${noun}${keys.length === 1 ? "" : "s"} — ${maxAttempts} drafts spent each (${keys.slice(0, 10).join(", ")})`;
}

export function remainingQueueDepth(
  queueLength: number,
  finished: number,
  exhausted: number,
): number {
  return Math.max(0, queueLength - finished - exhausted);
}
