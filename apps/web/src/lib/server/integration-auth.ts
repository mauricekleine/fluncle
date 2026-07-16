import { betterAuth } from "better-auth";
import { type BetterAuthOptions } from "better-auth";
import { type drizzle } from "drizzle-orm/libsql";
import * as schema from "../../db/schema";
import { createPublicAuthOptions } from "./public-auth";

/**
 * The auth instance integration suites sign up through — the REAL production
 * options (`createPublicAuthOptions`) with ONE deviation: `sendOnSignUp` is off.
 *
 * The verification branch makes better-auth call `ctx.request.clone()` mid-sign-up,
 * and on Node's undici that clone intermittently throws `TypeError: unusable` (a
 * teed body-stream race) — it 500'd sign-ups in the password-reset suite and then
 * the device-auth suite on consecutive Cloudflare builds while passing locally.
 * Prod runs on workerd, where sign-ups verifiably work, and the sendOnSignUp
 * CONFIG itself is pinned by public-auth.test.ts — so no suite that performs live
 * sign-ups keeps the clone in its path.
 */
export function createIntegrationAuth(
  db: ReturnType<typeof drizzle<typeof schema>>,
): ReturnType<typeof betterAuth> {
  const options = createPublicAuthOptions(db);

  const testOptions: BetterAuthOptions = {
    ...options,
    emailVerification: { ...options.emailVerification, sendOnSignUp: false },
  };

  return betterAuth(testOptions);
}
