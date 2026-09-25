export const REPLICA_SYNC_INTERVAL_MS = 15 * 60 * 1000;

export type SyncTrigger = "bootstrap" | "foreground" | "interval";

export type SyncDecisionInput = {
  inFlight: boolean;

  lastSyncedAt: number | undefined;
  now: number;
};

export function shouldSync({ inFlight, lastSyncedAt, now }: SyncDecisionInput): boolean {
  if (inFlight) {
    return false;
  }
  if (lastSyncedAt === undefined) {
    return true;
  }
  if (now < lastSyncedAt) {
    return true;
  }
  return now - lastSyncedAt >= REPLICA_SYNC_INTERVAL_MS;
}

export function clearsDarkLatch(trigger: SyncTrigger): boolean {
  return trigger === "foreground";
}
