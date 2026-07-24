import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// SLICE 3 — the APIFY KILL-FLAG's read/write semantics, against the REAL `settings` KV. This is the
// exact contract the `set_anchor_apify` operator op is a thin wrapper over: `setAnchorApifyEnabled`
// writes the real `settings` row and `isAnchorApifyEnabled` reads it back — so one op call both writes
// and reads back the flag. The load-bearing difference from the DEFAULT-OFF dark flags is proven here:
// this flag is DEFAULT ON, so only the literal string "false" disables it and a lost/unknown row reads
// as ENABLED (the paid rung is never silently starved). The database is the real thing (in-memory
// libSQL with the generated migrations), reached through the same `getDb` mock the sibling anchor
// integration tests use.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("anchor_apify_enabled — the default-ON kill-flag", () => {
  it("reads ON when the row is unset (an empty database defaults to the paid rung ENABLED)", async () => {
    const { isAnchorApifyEnabled } = await import("./anchor-apify");

    expect(await isAnchorApifyEnabled()).toBe(true);
  });

  it("write false → reads back false; write true → reads back true (the op's write+read-back)", async () => {
    const { isAnchorApifyEnabled, setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    expect(await isAnchorApifyEnabled()).toBe(false);

    await setAnchorApifyEnabled(true);
    expect(await isAnchorApifyEnabled()).toBe(true);
  });

  it("reads ON for any value that is not the literal 'false' (default-ALLOW, never default-deny)", async () => {
    const { ANCHOR_APIFY_ENABLED_KEY, isAnchorApifyEnabled } = await import("./anchor-apify");
    const { setSetting } = await import("./settings");

    // A malformed/unrecognised value must NOT silently disable the paid rung — only "false" does.
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "yes");
    expect(await isAnchorApifyEnabled()).toBe(true);

    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "");
    expect(await isAnchorApifyEnabled()).toBe(true);

    // Only the exact string "false" is the OFF signal.
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "false");
    expect(await isAnchorApifyEnabled()).toBe(false);
  });
});
