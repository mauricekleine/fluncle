// Self-running check for the Expo push-token contract — no framework. The rare
// load-bearing REJECTING contract: a malformed token must 400 at the edge before
// it can bloat the registry or break a fan-out. Assert the regex shape and the
// platform/category enums. Run: `bun src/orpc/devices.test.ts`.

import assert from "node:assert/strict";

import { DevicePlatformSchema, ExpoPushTokenSchema, PushCategorySchema } from "./devices";

// 1. A well-formed ExponentPushToken[…] is accepted (opaque bracketed body).
{
  for (const token of [
    "ExponentPushToken[abc-123]",
    "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    "ExponentPushToken[a]",
  ]) {
    assert.equal(ExpoPushTokenSchema.safeParse(token).success, true, `accept ${token}`);
  }
}

// 2. Malformed tokens are rejected.
{
  for (const token of [
    "ExponentPushToken[]", // empty brackets
    "abc-123", // missing prefix + brackets
    "PushToken[abc-123]", // wrong prefix
    "ExponentPushToken[abc-123]extra", // trailing junk
    "ExponentPushToken[abc-123", // unclosed bracket
    "exponentpushtoken[abc-123]", // wrong case
    "", // empty
    "ExponentPushTokenabc-123]", // missing open bracket
  ]) {
    assert.equal(
      ExpoPushTokenSchema.safeParse(token).success,
      false,
      `reject ${JSON.stringify(token)}`,
    );
  }
}

// 3. Platform enum: only ios/android.
{
  assert.equal(DevicePlatformSchema.safeParse("ios").success, true);
  assert.equal(DevicePlatformSchema.safeParse("android").success, true);
  assert.equal(
    DevicePlatformSchema.safeParse("web").success,
    false,
    "web is not a device platform",
  );
  assert.equal(DevicePlatformSchema.safeParse("IOS").success, false, "enum is case-sensitive");
}

// 4. Push-category enum: only findings/mixtapes.
{
  assert.equal(PushCategorySchema.safeParse("findings").success, true);
  assert.equal(PushCategorySchema.safeParse("mixtapes").success, true);
  assert.equal(
    PushCategorySchema.safeParse("everything").success,
    false,
    "unknown category rejected",
  );
}

console.log(
  "✓ devices: ExpoPushToken regex (accept opaque body, reject empty/prefix/junk) + platform/category enums",
);
