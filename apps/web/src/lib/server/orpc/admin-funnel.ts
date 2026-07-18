// The `admin-funnel` domain router module — the catalogue pipeline on one admin page
// (docs/rfcs/catalogue-funnel-rfc.md).
//
//   - `record_catalogue_snapshot` — POST /admin/funnel/snapshot on `adminAuth` ONLY (no
//     `operatorGuard`): agent tier, like `record_platform_stats`/`record_health`. The box's
//     daily funnel-snapshot cron POSTs a bare trigger; the handler computes the live counts
//     and upserts one idempotent row for the UTC day, acking the row written.
//   - `get_funnel` — GET /admin/funnel on `adminAuth`: the live pipeline + the bounded series
//     in one call. `windowDays` is a tolerant optional query string parsed + clamped in the
//     funnel module; the handler forwards it through.

import { getFunnel, recordCatalogueSnapshot } from "../funnel";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-funnel` domain's handlers. */
export function adminFunnelHandlers(os: Implementer) {
  // POST /admin/funnel/snapshot — agent tier (`adminAuth` only). Compute + upsert one daily
  // snapshot and ack the row written. Internal write (catalogue_snapshots); no public moves.
  const recordCatalogueSnapshotHandler = os.record_catalogue_snapshot
    .use(adminAuth)
    .handler(async () => {
      try {
        const snapshot = await recordCatalogueSnapshot();

        return { ok: true as const, snapshot };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // GET /admin/funnel — admin tier. The live pipeline + the day-by-day series in one read.
  const getFunnelHandler = os.get_funnel.use(adminAuth).handler(async ({ input }) => {
    try {
      const parsed = input.windowDays ? Number.parseInt(input.windowDays, 10) : undefined;
      const windowDays = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;

      return await getFunnel(windowDays);
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_funnel: getFunnelHandler,
    record_catalogue_snapshot: recordCatalogueSnapshotHandler,
  };
}
