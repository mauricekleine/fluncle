import { adminApiPost } from "../api";

export type ReachCollectedPlatform = { metrics: string[]; platform: string };

export type ReachSkippedPlatform = {
  kind: "empty" | "unconfigured";
  platform: string;
  reason: string;
};

export type ReachFailedPlatform = { platform: string; reason: string };

export type ReachCollectResult = {
  collected: ReachCollectedPlatform[];
  failed: ReachFailedPlatform[];
  inserted: number;
  ok: true;
  skipped: ReachSkippedPlatform[];
};

export async function reachCollectCommand(): Promise<ReachCollectResult> {
  return adminApiPost<ReachCollectResult>("/api/v1/admin/reach/collect", {});
}
