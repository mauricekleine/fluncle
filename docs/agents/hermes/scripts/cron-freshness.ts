export const MAX_TIMER_JITTER_MS = 90_000;

export type CronDef = { cadenceMs: number; match: string; service: string };

export function cronStaleBudgetMs(cron: Pick<CronDef, "cadenceMs">): number {
  return Math.max(cron.cadenceMs * 3, 90_000) + MAX_TIMER_JITTER_MS;
}
