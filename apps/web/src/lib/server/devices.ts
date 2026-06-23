// The push-device registry write path. The mobile
// app registers its Expo push token here (an idempotent upsert on the token), and
// deregisters to opt out. Anonymous-compatible: the V1 app has no account, so
// `userId` is null until accounts arrive.
//
// Storage discipline mirrors the rest of the server: the runtime upsert is RAW
// SQL via `getDb()` (the `@libsql/client`), not drizzle's query builder — the
// `setMixtapeSoundcloud` precedent. The schema lives in db/schema.ts (`push_tokens`)
// for migrations + the GDPR sweep; this module never imports drizzle.

import { getDb } from "./db";

/** A device-registration request (the `register_device` contract input). */
export type RegisterDeviceInput = {
  appVersion?: string;
  mutedCategories?: ("findings" | "mixtapes")[];
  platform: "android" | "ios";
  token: string;
};

/**
 * Register (or refresh) a device's push token. Idempotent upsert keyed on the
 * token: a re-register from the same device bumps `last_seen_at` and refreshes the
 * app version + mute set (so a token re-acquired after a rotation, or a changed
 * notification preference, is reflected) without ever creating a duplicate row.
 */
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

/**
 * Deregister a device — opt out of push. Idempotent: deleting an absent token
 * still succeeds, so a re-tap on "turn off notifications" never errors.
 */
export async function deregisterDevice(token: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [token],
    sql: `delete from push_tokens where token = ?`,
  });
}
