import { type PublishAdvanceResponse, type PublishAdvanceStateResponse } from "@fluncle/contracts";
import { adminApiPost, adminApiPut } from "../api";

export async function publishAdvanceCommand(): Promise<PublishAdvanceResponse> {
  return adminApiPost<PublishAdvanceResponse>("/api/v1/admin/social/publish/advance", {});
}

export async function publishAdvancePauseCommand(paused: boolean): Promise<boolean> {
  const response = await adminApiPut<PublishAdvanceStateResponse>(
    "/api/v1/admin/social/publish/advance/state",
    { paused },
  );

  return response.paused;
}
