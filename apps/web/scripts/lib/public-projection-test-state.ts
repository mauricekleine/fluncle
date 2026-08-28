import { type Client } from "@libsql/client";

import { ensurePublicProjectionState } from "../../src/lib/server/public-projection-source-maintenance";

export type PublicProjectionMaintenanceSnapshot = {
  aggregate: { projectionEpoch: number; ready: boolean; sourceEpoch: number };
  artists: { projectionEpoch: number; ready: boolean; sourceEpoch: number };
  repairs: Array<{
    projection: string;
    sourceEpoch: number;
    subjectId: string;
    subjectType: string;
  }>;
};

function textCell(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be text`);
  }
  return value;
}

export async function initializePublicProjectionTestState(client: Client): Promise<void> {
  await ensurePublicProjectionState(client, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

export async function readPublicProjectionMaintenanceSnapshot(
  client: Client,
): Promise<PublicProjectionMaintenanceSnapshot> {
  const state = await client.execute(`select
    (select source_epoch from public_aggregate_state where scope = 'tracks') as aggregate_source,
    (select aggregate_epoch from public_aggregate_state where scope = 'tracks') as aggregate_projection,
    (select state = 'complete' and aggregate_epoch = source_epoch
       and not exists (select 1 from projection_repairs where projection = 'public_aggregates')
     from public_aggregate_state where scope = 'tracks') as aggregate_ready,
    (select source_epoch from artist_qualification_state where scope = 'artists') as artist_source,
    (select projection_epoch from artist_qualification_state where scope = 'artists') as artist_projection,
    (select state = 'complete' and projection_epoch = source_epoch
       and not exists (select 1 from projection_repairs where projection = 'artist_qualification')
     from artist_qualification_state where scope = 'artists') as artist_ready`);
  const row = state.rows[0];
  if (!row) {
    throw new Error("public projection maintenance state query returned no row");
  }
  const repairs = await client.execute(`select projection, subject_type, subject_id, source_epoch
    from projection_repairs
    order by projection, subject_type, subject_id`);

  return {
    aggregate: {
      projectionEpoch: Number(row.aggregate_projection),
      ready: Number(row.aggregate_ready) === 1,
      sourceEpoch: Number(row.aggregate_source),
    },
    artists: {
      projectionEpoch: Number(row.artist_projection),
      ready: Number(row.artist_ready) === 1,
      sourceEpoch: Number(row.artist_source),
    },
    repairs: repairs.rows.map((repair) => ({
      projection: textCell(repair.projection, "projection repair projection"),
      sourceEpoch: Number(repair.source_epoch),
      subjectId: textCell(repair.subject_id, "projection repair subject id"),
      subjectType: textCell(repair.subject_type, "projection repair subject type"),
    })),
  };
}

export async function settlePublicProjectionTestState(client: Client): Promise<void> {
  await client.batch(
    [
      `update public_aggregate_state set aggregate_epoch = source_epoch where scope = 'tracks'`,
      `update artist_qualification_state set projection_epoch = source_epoch where scope = 'artists'`,
      `delete from projection_repairs`,
    ],
    "write",
  );
}
