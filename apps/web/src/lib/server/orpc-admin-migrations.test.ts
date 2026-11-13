import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmOrpcRouter } from "./orpc-test-kit";

const migratePreviewArchive = vi.fn();

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: () => Promise.resolve({}),
}));

vi.mock("./preview-bucket-migration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview-bucket-migration")>()),
  migratePreviewArchive: (...args: unknown[]) => migratePreviewArchive(...args),
}));

const OPERATOR_TOKEN = "test-token-admin-operator";
const AGENT_TOKEN = "test-token-admin-agent";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

warmOrpcRouter();

beforeEach(() => {
  migratePreviewArchive.mockReset();
});

function post(path: string): Request {
  return new Request(`https://www.fluncle.com/api/v1${path}`, {
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
    method: "POST",
  });
}

describe("oRPC migrate_preview_archive (POST /admin/migrations/preview-archive)", () => {
  it("refuses an unknown mode instead of running a copy pass", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/admin/migrations/preview-archive?mode=delete-public&dryRun=false"),
    );

    expect(response?.status).toBe(400);
    expect(migratePreviewArchive).not.toHaveBeenCalled();
  });

  it("defaults an absent mode to a dry-run copy pass", async () => {
    migratePreviewArchive.mockResolvedValueOnce({
      blocked: null,
      copied: [],
      copiedCount: 0,
      deleted: [],
      deletedCount: 0,
      dryRun: true,
      mode: "copy",
      nextCursor: null,
      skipped: [],
      skippedCount: 0,
    });

    const { handleOrpc } = await import("./orpc");
    await handleOrpc(post("/admin/migrations/preview-archive"));

    expect(migratePreviewArchive).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, mode: "copy" }),
    );
  });
});
