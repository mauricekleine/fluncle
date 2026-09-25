import { type RevokeAdminGrantsResponse } from "@fluncle/contracts";
import { adminApiPost } from "../api";

export async function authRevokeGrantsCommand(options: { json?: boolean } = {}): Promise<void> {
  const response = await adminApiPost<RevokeAdminGrantsResponse>(
    "/api/v1/admin/auth/revoke-grants",
  );

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));

    return;
  }

  console.log(`Every admin browser session is out. Grant epoch is now ${response.epoch}.

Sign back in at /admin/login. Your CLI and the agent box are unaffected.`);
}
