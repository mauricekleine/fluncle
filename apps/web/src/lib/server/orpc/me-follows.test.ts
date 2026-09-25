import { describe, expect, it, vi } from "vitest";

const listFollows = vi.fn();
const saveFollow = vi.fn();
const deleteFollow = vi.fn();

vi.mock("../account-data", () => ({ deleteFollow, listFollows, saveFollow }));
vi.mock("../orpc-auth", () => ({
  privateUserAuth: {},
  privateUserMutation: () => ({}),
}));

describe("deprecated private watch handlers", () => {
  it("uses the follow operations while keeping the v1 watch response shapes", async () => {
    const { meFollowsHandlers } = await import("./me-follows");
    const procedure = { use: () => ({ handler: (callback: unknown) => callback }) };
    const os = Object.fromEntries(
      [
        "delete_private_follow",
        "delete_private_watch",
        "list_private_follows",
        "list_private_watches",
        "revoke_private_follow_link_access",
        "save_private_follow",
        "save_private_watch",
      ].map((name) => [name, procedure]),
    ) as unknown as Parameters<typeof meFollowsHandlers>[0];
    const handlers = meFollowsHandlers(os);
    const user = { id: "user-a" };
    const watch = {
      createdAt: "2026-09-25T00:00:00.000Z",
      entityId: "artist-a",
      id: "watch-a",
      includeSimilar: false,
      kind: "artist",
      name: "Artist A",
      slug: "artist-a",
    };
    const listWatch = handlers.list_private_watches as unknown as (
      args: unknown,
    ) => Promise<unknown>;
    const saveWatch = handlers.save_private_watch as unknown as (args: unknown) => Promise<unknown>;
    const deleteWatch = handlers.delete_private_watch as unknown as (
      args: unknown,
    ) => Promise<unknown>;

    listFollows.mockResolvedValue({ follows: [watch], ok: true });
    saveFollow.mockResolvedValue({ follow: watch, followsEmail: true, ok: true });
    deleteFollow.mockResolvedValue({ ok: true });

    expect(await listWatch({ context: { user } })).toEqual({ ok: true, watches: [watch] });
    expect(
      await saveWatch({ context: { user }, input: { entityId: "artist-a", kind: "artist" } }),
    ).toEqual({
      ok: true,
      watch: {
        createdAt: watch.createdAt,
        entityId: watch.entityId,
        id: watch.id,
        includeSimilar: watch.includeSimilar,
        kind: watch.kind,
      },
    });
    expect(await deleteWatch({ context: { user }, input: { id: "watch-a" } })).toEqual({
      ok: true,
    });
    expect(listFollows).toHaveBeenCalledWith(user);
    expect(saveFollow).toHaveBeenCalledWith(user, { entityId: "artist-a", kind: "artist" });
    expect(deleteFollow).toHaveBeenCalledWith(user, "watch-a");
  });
});
