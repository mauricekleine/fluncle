import assert from "node:assert/strict";

import { DevicePlatformSchema, ExpoPushTokenSchema, PushCategorySchema } from "./devices";

{
  for (const token of [
    "ExponentPushToken[abc-123]",
    "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    "ExponentPushToken[a]",
  ]) {
    assert.equal(ExpoPushTokenSchema.safeParse(token).success, true, `accept ${token}`);
  }
}

{
  for (const token of [
    "ExponentPushToken[]",
    "abc-123",
    "PushToken[abc-123]",
    "ExponentPushToken[abc-123]extra",
    "ExponentPushToken[abc-123",
    "exponentpushtoken[abc-123]",
    "",
    "ExponentPushTokenabc-123]",
  ]) {
    assert.equal(
      ExpoPushTokenSchema.safeParse(token).success,
      false,
      `reject ${JSON.stringify(token)}`,
    );
  }
}

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
