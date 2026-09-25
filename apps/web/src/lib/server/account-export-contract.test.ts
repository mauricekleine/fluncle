import { deletePrivateAccount, exportPrivateAccountData } from "@fluncle/contracts/orpc";
import { describe, expect, it } from "vitest";

type Parseable = { "~standard": { validate: (value: unknown) => unknown } };

async function parse(schema: unknown, value: unknown): Promise<Record<string, unknown>> {
  const result = (await (schema as Parseable)["~standard"].validate(value)) as {
    issues?: unknown;
    value?: Record<string, unknown>;
  };

  expect(JSON.stringify(result.issues ?? null)).toBe("null");

  return result.value ?? {};
}

describe("the account export and delete contracts carry the follow data", () => {
  it("keeps follows and the follows-email state in the export", async () => {
    const output = await parse(exportPrivateAccountData["~orpc"].outputSchema, {
      export: {
        account: {
          createdAt: "2026-09-25T00:00:00.000Z",
          email: "dave@example.com",
          emailVerified: true,
          id: "user-1",
          name: "Dave",
        },
        followDigest: {
          lastReleaseCount: 3,
          lastSentAt: "2026-09-25T15:00:00.000Z",
          lastWeekKey: "2026-W39",
          unsubscribedAt: null,
          updatedAt: "2026-09-25T15:00:00.000Z",
        },
        follows: [
          {
            createdAt: "2026-09-20T00:00:00.000Z",
            entityId: "label-1",
            id: "follow-1",
            includeSimilar: false,
            kind: "label",
            name: "Hospital Records",
            slug: "hospital-records",
          },
        ],
        generatedAt: "2026-09-25T00:00:00.000Z",
        id: "export-1",
        preferences: {},
        privacyNotes: [],
        progress: { collectedLogIds: [], deaths: 0, ok: true, wins: 0 },
        savedFindings: [],
        submissions: [],
      },
      ok: true,
    });
    const exported = output.export as Record<string, unknown>;

    expect(exported.follows).toHaveLength(1);
    expect(exported.followDigest).toMatchObject({ lastWeekKey: "2026-W39" });
  });

  it("keeps the follow lines in the deletion summary", async () => {
    const output = await parse(deletePrivateAccount["~orpc"].outputSchema, {
      ok: true,
      summary: {
        credentials: "deleted",
        followDigest: "deleted",
        follows: "deleted",
        galaxyProgress: "deleted",
        savedFindings: "deleted",
        sessions: "revoked",
        submissions: "anonymized",
        user: "marked_deleted",
        verifications: "deleted",
      },
    });

    expect(output.summary).toMatchObject({ followDigest: "deleted", follows: "deleted" });
  });
});
