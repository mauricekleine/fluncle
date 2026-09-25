import { getDb, typedRows } from "./db";
import { readProjectedAggregateBuckets } from "./public-projection-cutover";

export type KeyHistogramRow = { count: number; key: string | null };

const KEY_HISTOGRAM_TTL_MS = 600_000;

let cache: { at: number; rows: readonly KeyHistogramRow[] } | null = null;
let inFlight: Promise<readonly KeyHistogramRow[]> | null = null;

let generation = 0;

export async function readKeyHistogram(): Promise<readonly KeyHistogramRow[]> {
  const warm = cache;

  if (warm) {
    if (Date.now() - warm.at >= KEY_HISTOGRAM_TTL_MS) {
      refresh().catch(() => undefined);
    }

    return warm.rows;
  }

  return refresh();
}

function refresh(): Promise<readonly KeyHistogramRow[]> {
  const outstanding = inFlight;

  if (outstanding !== null) {
    return outstanding;
  }

  const startedAt = generation;
  const settle = (): void => {
    if (generation === startedAt) {
      inFlight = null;
    }
  };
  const read = readHistogramRows().then(
    (rows) => {
      if (generation === startedAt) {
        cache = { at: Date.now(), rows };
      }

      settle();

      return rows;
    },
    (error: unknown) => {
      settle();

      throw error;
    },
  );

  inFlight = read;

  return read;
}

async function readHistogramRows(): Promise<readonly KeyHistogramRow[]> {
  const db = await getDb();
  const projected = await readProjectedAggregateBuckets(db, "key");

  if (projected !== undefined) {
    return projected.map(({ bucket, count }) => ({ count, key: bucket }));
  }

  const result = await db.execute(
    `select key, count(*) as count from tracks where key is not null group by key`,
  );

  return typedRows<KeyHistogramRow>(result.rows);
}

export function resetKeyHistogramCache(): void {
  cache = null;
  inFlight = null;
  generation += 1;
}
