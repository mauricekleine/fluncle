import { betterAuth } from "better-auth";
import { type BetterAuthOptions } from "better-auth";
import { type drizzle } from "drizzle-orm/libsql";
import * as schema from "../../db/schema";
import { createPublicAuthOptions } from "./public-auth";

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
