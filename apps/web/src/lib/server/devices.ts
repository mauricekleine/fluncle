import { getDb } from "./db";

export type RegisterDeviceInput = {
  appVersion?: string;
  mutedCategories?: ("findings" | "mixtapes")[];
  platform: "android" | "ios";
  token: string;
};

export async function registerDevice(input: RegisterDeviceInput): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const mutedJson =
    input.mutedCategories && input.mutedCategories.length > 0
      ? JSON.stringify(input.mutedCategories)
      : null;

  await db.execute({
    args: [input.token, input.platform, input.appVersion ?? null, mutedJson, now, now],
    sql: `insert into push_tokens (token, platform, app_version, muted_json, created_at, last_seen_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(token) do update set
        platform = excluded.platform,
        app_version = excluded.app_version,
        muted_json = excluded.muted_json,
        last_seen_at = excluded.last_seen_at`,
  });
}

export async function deregisterDevice(token: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [token],
    sql: `delete from push_tokens where token = ?`,
  });
}
