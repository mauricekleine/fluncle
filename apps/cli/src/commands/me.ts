import { type GalaxyProgress, type MeResponse, type PublicUser } from "@fluncle/contracts";
import { userApiGet } from "../api";

// `fluncle me` — the authed read that proves the login worked. It presents the
// USER session token (stored by `fluncle login`) as a Bearer header and reads the
// signed-in user's own account: their identity + their Galaxy lifetime markers.
// This is a USER-tier read; it never touches the admin API. The wire shapes
// (`MeResponse`, `GalaxyProgress`, the signed-in `PublicUser`) are the single
// source of truth in `@fluncle/contracts`, so this thin client can't drift.

export type Me = {
  collectedCount: number;
  deaths: number;
  joinedAt: string;
  name: string;
  userId: string;
  wins: number;
};

export async function meCommand(): Promise<Me> {
  const [me, progress] = await Promise.all([
    userApiGet<MeResponse>("/api/me"),
    userApiGet<GalaxyProgress>("/api/me/galaxy-progress"),
  ]);

  if (!me.user) {
    // A stored-but-stale/revoked token resolves no user. Surface it as a
    // re-login prompt rather than a confusing empty read.
    throw new Error("Your sign-in expired. Run `fluncle login` to link this device again.");
  }

  const user: PublicUser = me.user;

  return {
    collectedCount: progress.collectedLogIds.length,
    deaths: progress.deaths,
    joinedAt: user.createdAt,
    name: user.displayUsername ?? user.username ?? "cosmonaut",
    userId: user.id,
    wins: progress.wins,
  };
}
