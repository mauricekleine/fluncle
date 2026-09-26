import { adminApiGet, adminApiPost, adminApiPut } from "../api";

export type FollowDigestResponse = {
  capped: boolean;
  considered: number;
  dryRun: boolean;
  empty: number;
  nextCursor?: string;
  ok: true;
  paused: boolean;
  sent: number;
  skipped: number;
  weekKey: string;
};

export async function sendFollowDigestsCommand(options: {
  cursor?: string;
  dryRun?: boolean;
  limit?: number;
}): Promise<FollowDigestResponse> {
  return adminApiPost<FollowDigestResponse>("/api/v1/admin/follow-digests/send", options);
}

export async function getFollowDigestStateCommand(): Promise<boolean> {
  const result = await adminApiGet<{ ok: true; paused: boolean }>(
    "/api/v1/admin/follow-digests/state",
  );
  return result.paused;
}

export async function setFollowDigestStateCommand(paused: boolean): Promise<boolean> {
  const result = await adminApiPut<{ ok: true; paused: boolean }>(
    "/api/v1/admin/follow-digests/state",
    { paused },
  );
  return result.paused;
}
