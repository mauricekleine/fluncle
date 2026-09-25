import { labelFold } from "@fluncle/contracts/util/galaxy-slug";

export const DISTRIBUTOR_DENYLIST = [
  "Believe",
  "AEI",
  "Kontor New Media",
  "The Orchard",
  "Absolute",
  "FUGA",
  "Ingrooves",
  "Symphonic",
  "ADA",
  "Horus Music",
] as const;

const DISTRIBUTOR_DENYLIST_FOLDED = new Set(DISTRIBUTOR_DENYLIST.map((name) => labelFold(name)));

export function isDistributorLabel(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") {
    return false;
  }

  return DISTRIBUTOR_DENYLIST_FOLDED.has(labelFold(raw));
}
