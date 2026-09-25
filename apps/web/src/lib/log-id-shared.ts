import { fnv1a32 as fnv1a } from "@fluncle/contracts/util/hash";

export { fnv1a };

const EPOCH_MS = Date.UTC(2026, 4, 30);
const DAY_MS = 86_400_000;

export function sectorDay(foundAt: string): number {
  const found = new Date(foundAt).getTime();

  return Number.isNaN(found) ? 0 : Math.max(0, Math.floor((found - EPOCH_MS) / DAY_MS));
}

export function sectorRange(sector: number): { endMs: number; startMs: number } {
  const startMs = EPOCH_MS + sector * DAY_MS;

  return { endMs: startMs + DAY_MS, startMs };
}

export function sectorDateISO(sector: number): string {
  return new Date(sectorRange(sector).startMs).toISOString();
}

export function formatSector(sector: number): string {
  return String(sector).padStart(3, "0");
}

export function parseSectorParam(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const sector = Number.parseInt(value, 10);

  return Number.isSafeInteger(sector) && sector >= 0 ? sector : null;
}
