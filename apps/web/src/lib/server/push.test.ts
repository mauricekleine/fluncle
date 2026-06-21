import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit coverage for the Expo push fan-out (lib/server/push.ts; docs/rfcs/mobile-app.md
// §7). The load-bearing, easy-to-get-wrong bits are pinned here:
//   - chunking ≤100 (Expo's hard per-request ceiling),
//   - the per-category mute filter (a muted device is dropped from that fan-out),
//   - the NO-OP-when-unset property (EXPO_ACCESS_TOKEN absent ⇒ nothing happens —
//     the whole feature ships dark, never touching a publish),
//   - DeviceNotRegistered pruning (immediate, off the send tickets).
//
// `cloudflare:workers` resolves to the inert test stub (vitest.config.ts), whose
// `waitUntil` runs the promise synchronously — so the scheduled fan-out completes
// within the test. `./env` and `./db` are mocked so no real secret or DB is touched.

const readOptionalEnv = vi.fn();
const execute = vi.fn();
const batch = vi.fn();

vi.mock("./env", () => ({
  readOptionalEnv: (...args: unknown[]) => readOptionalEnv(...args),
}));

vi.mock("./db", () => ({
  getDb: async () => ({
    batch: (...args: unknown[]) => batch(...args),
    execute: (...args: unknown[]) => execute(...args),
  }),
  typedRows: <T>(rows: T[]): T[] => rows,
}));

import { chunkMessages, notifyNewFinding, sweepPushReceipts, tokensForCategory } from "./push";

const FETCH = vi.fn();

beforeEach(() => {
  readOptionalEnv.mockReset();
  execute.mockReset();
  batch.mockReset();
  FETCH.mockReset();
  batch.mockResolvedValue([]);
  vi.stubGlobal("fetch", FETCH);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Drain the microtask queue so the fire-and-forget `waitUntil` fan-out (run
// synchronously by the test stub, but still async internally) settles before the
// assertions read the fetch/db spies.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("chunkMessages", () => {
  it("never exceeds the 100-message Expo ceiling", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkMessages(items);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
    // No data lost or duplicated across the split.
    expect(chunks.flat()).toEqual(items);
  });

  it("returns one chunk for a list at or under the ceiling, none for empty", () => {
    expect(chunkMessages(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(1);
    expect(chunkMessages([])).toHaveLength(0);
  });
});

describe("tokensForCategory", () => {
  const rows = [
    { muted_json: null, token: "ExponentPushToken[a]" },
    { muted_json: '["mixtapes"]', token: "ExponentPushToken[b]" },
    { muted_json: '["findings"]', token: "ExponentPushToken[c]" },
    { muted_json: '["findings","mixtapes"]', token: "ExponentPushToken[d]" },
    { muted_json: "not json", token: "ExponentPushToken[e]" },
  ];

  it("drops devices that muted the findings category", () => {
    // a (no mutes), b (muted mixtapes only), e (malformed ⇒ no mutes) get findings.
    expect(tokensForCategory(rows, "findings")).toEqual([
      "ExponentPushToken[a]",
      "ExponentPushToken[b]",
      "ExponentPushToken[e]",
    ]);
  });

  it("drops devices that muted the mixtapes category", () => {
    expect(tokensForCategory(rows, "mixtapes")).toEqual([
      "ExponentPushToken[a]",
      "ExponentPushToken[c]",
      "ExponentPushToken[e]",
    ]);
  });

  it("treats a malformed mutedJson as no mutes (never silently swallows a push)", () => {
    const malformed = [{ muted_json: "{oops", token: "ExponentPushToken[x]" }];

    expect(tokensForCategory(malformed, "findings")).toEqual(["ExponentPushToken[x]"]);
  });
});

describe("notifyNewFinding — the no-op-when-unset property", () => {
  it("sends NOTHING and touches no DB when EXPO_ACCESS_TOKEN is unset", async () => {
    readOptionalEnv.mockResolvedValue(undefined);

    notifyNewFinding({ artists: ["Teddy Killerz"], title: "Gate" }, "2026.A.01");
    await flush();

    expect(readOptionalEnv).toHaveBeenCalledWith("EXPO_ACCESS_TOKEN");
    expect(execute).not.toHaveBeenCalled();
    expect(FETCH).not.toHaveBeenCalled();
  });

  it("no-ops without a logId (nothing to deep-link to)", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");

    notifyNewFinding({ artists: ["Teddy Killerz"], title: "Gate" }, undefined);
    await flush();

    expect(readOptionalEnv).not.toHaveBeenCalled();
    expect(FETCH).not.toHaveBeenCalled();
  });
});

describe("notifyNewFinding — configured fan-out", () => {
  it("reads tokens, filters mutes, and POSTs the chunk to Expo /send", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");
    execute.mockResolvedValue({
      rows: [
        { muted_json: null, token: "ExponentPushToken[a]" },
        { muted_json: '["findings"]', token: "ExponentPushToken[b]" },
      ],
    });
    FETCH.mockResolvedValue({
      json: async () => ({ data: [{ id: "receipt-1", status: "ok" }] }),
      ok: true,
    });

    notifyNewFinding({ artists: ["Teddy Killerz"], title: "Gate" }, "2026.A.01");
    await flush();

    expect(FETCH).toHaveBeenCalledTimes(1);
    const [url, init] = FETCH.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer expo_token");

    const sent = JSON.parse(init.body as string) as {
      body: string;
      data: { url: string };
      to: string;
    }[];
    // Only the un-muted device (a); b muted "findings".
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ExponentPushToken[a]");
    expect(sent[0].data.url).toContain("/log/2026.A.01");
    // The receipt id is parked for the later receipts sweep.
    expect(batch).toHaveBeenCalled();
  });

  it("never sends when every device muted the category", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");
    execute.mockResolvedValue({
      rows: [{ muted_json: '["findings"]', token: "ExponentPushToken[b]" }],
    });

    notifyNewFinding({ artists: ["X"], title: "Y" }, "2026.A.01");
    await flush();

    expect(FETCH).not.toHaveBeenCalled();
  });

  it("prunes a DeviceNotRegistered token reported on the send ticket", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");
    execute.mockResolvedValue({
      rows: [{ muted_json: null, token: "ExponentPushToken[dead]" }],
    });
    FETCH.mockResolvedValue({
      json: async () => ({
        data: [{ details: { error: "DeviceNotRegistered" }, status: "error" }],
      }),
      ok: true,
    });

    notifyNewFinding({ artists: ["X"], title: "Y" }, "2026.A.01");
    await flush();

    // The dead token is deleted from push_tokens (the immediate-ticket reap path).
    const deleteCall = execute.mock.calls.find(
      ([arg]) =>
        typeof arg === "object" && /delete from push_tokens/.test((arg as { sql: string }).sql),
    );
    const deleteArgs = (deleteCall?.[0] as { args?: string[] } | undefined)?.args ?? [];
    expect(deleteArgs).toContain("ExponentPushToken[dead]");
  });

  it("never throws when the Expo send fails (a push can't sink a publish)", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");
    execute.mockResolvedValue({ rows: [{ muted_json: null, token: "ExponentPushToken[a]" }] });
    FETCH.mockRejectedValue(new Error("network down"));

    // The notify itself is synchronous (schedules waitUntil); the fan-out swallows.
    expect(() => notifyNewFinding({ artists: ["X"], title: "Y" }, "2026.A.01")).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });
});

describe("sweepPushReceipts — receipts-driven dead-token reaping", () => {
  it("no-ops when EXPO_ACCESS_TOKEN is unset", async () => {
    readOptionalEnv.mockResolvedValue(undefined);
    execute.mockResolvedValue({ rows: [{ c: 0 }] });

    const result = await sweepPushReceipts({ dryRun: false, limit: 100 });

    expect(result).toEqual({ checked: 0, pending: 0, pruned: 0 });
    expect(FETCH).not.toHaveBeenCalled();
  });

  it("prunes tokens Expo reports DeviceNotRegistered via receipts and clears the ledger", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");
    execute
      // count(*) pending
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      // the parked receipt batch
      .mockResolvedValueOnce({
        rows: [
          { id: "r-dead", token: "ExponentPushToken[dead]" },
          { id: "r-ok", token: "ExponentPushToken[ok]" },
        ],
      })
      // delete push_tokens
      .mockResolvedValueOnce({ rows: [] })
      // delete push_receipts
      .mockResolvedValueOnce({ rows: [] });
    FETCH.mockResolvedValue({
      json: async () => ({
        data: {
          "r-dead": { details: { error: "DeviceNotRegistered" }, status: "error" },
          "r-ok": { status: "ok" },
        },
      }),
      ok: true,
    });

    const result = await sweepPushReceipts({ dryRun: false, limit: 100 });

    expect(result).toEqual({ checked: 2, pending: 2, pruned: 1 });
    const tokenDelete = execute.mock.calls.find(
      ([arg]) =>
        typeof arg === "object" && /delete from push_tokens/.test((arg as { sql: string }).sql),
    );
    const tokenDeleteArgs = (tokenDelete?.[0] as { args?: string[] } | undefined)?.args ?? [];
    expect(tokenDeleteArgs).toEqual(["ExponentPushToken[dead]"]);
  });

  it("dry-run reports the would-prune count without deleting", async () => {
    readOptionalEnv.mockResolvedValue("expo_token");
    execute
      .mockResolvedValueOnce({ rows: [{ c: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "r-dead", token: "ExponentPushToken[dead]" }] });
    FETCH.mockResolvedValue({
      json: async () => ({
        data: { "r-dead": { details: { error: "DeviceNotRegistered" }, status: "error" } },
      }),
      ok: true,
    });

    const result = await sweepPushReceipts({ dryRun: true, limit: 100 });

    expect(result).toEqual({ checked: 1, pending: 1, pruned: 1 });
    const deleted = execute.mock.calls.some(
      ([arg]) => typeof arg === "object" && /delete from/.test((arg as { sql: string }).sql),
    );
    expect(deleted).toBe(false);
  });
});
