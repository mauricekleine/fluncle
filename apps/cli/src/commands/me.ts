import { type GalaxyProgress, type MeResponse, type PublicUser } from "@fluncle/contracts";
import { userApiGet } from "../api";

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
    userApiGet<MeResponse>("/api/v1/me"),
    userApiGet<GalaxyProgress>("/api/v1/me/galaxy-progress"),
  ]);

  if (!me.user) {
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
