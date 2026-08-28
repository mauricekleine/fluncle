import { type Client, type InValue } from "@libsql/client";

export const TRACK_DUE_AUDIT_FENCE_KEY = "projection_fence_track_due_work_v1";
export const CRAWL_DUE_AUDIT_FENCE_KEY = "projection_fence_crawl_due_work_v1";

type ProjectionFenceClient = Pick<Client, "execute">;

export function advanceProjectionFenceStatement(key: string): { args: InValue[]; sql: string } {
  return {
    args: [key],
    sql: `insert into settings (key, value)
      select ?, '1' where changes() > 0
      on conflict(key) do update set value = cast(settings.value as integer) + 1`,
  };
}

export async function readProjectionFence(
  client: ProjectionFenceClient,
  key: string,
): Promise<number> {
  const result = await client.execute({
    args: [key],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = result.rows[0]?.value;
  const fence = typeof value === "string" ? Number(value) : 0;
  return Number.isSafeInteger(fence) && fence >= 0 ? fence : -1;
}
