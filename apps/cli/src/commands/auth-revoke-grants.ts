import { type RevokeAdminGrantsResponse } from "@fluncle/contracts";
import { adminApiPost } from "../api";

// `fluncle admin auth revoke-grants` — the admin browser-session kill switch.
//
// The grant cookie the web board carries is a signed, stateless credential, so there
// was no way to pull one back short of rotating the signing secret. This bumps the
// grant EPOCH baked into every grant, which makes every outstanding cookie stop
// verifying at once. It rides the Bearer carrier, so it still works when the browser
// session is precisely the thing being cut.
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
