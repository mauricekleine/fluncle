import { fnv1a, sectorDay } from "../log-id-shared";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type LogIdInput = {
  foundAt: string;

  isrc?: string | null;

  trackId: string;
};

export function sector(foundAt: string): string {
  return String(sectorDay(foundAt)).padStart(3, "0");
}

function tail(seed: string, attempt: number): string {
  const hash = fnv1a(attempt === 0 ? seed : `${seed}#${attempt}`);
  const orbit = hash % 10;
  const markNumber = (hash >>> 8) % 10;
  const markLetter = LETTERS[(hash >>> 16) % LETTERS.length];

  return `${orbit}.${markNumber}${markLetter}`;
}

function logIdCandidate(input: LogIdInput, attempt = 0): string {
  const seed = input.isrc?.trim() || input.trackId;

  return `${sector(input.foundAt)}.${tail(seed, attempt)}`;
}

export async function resolveLogId(
  input: LogIdInput,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = logIdCandidate(input, attempt);

    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error("log-id: exhausted attempts resolving a unique coordinate");
}
