import { type TikTokAuthStartResponse } from "@fluncle/contracts";
import { adminApiGet } from "../api";

// A thin trigger (like `auth youtube` / `auth mixcloud`): GET the admin start route and
// print the link it returns. That link is a FLUNCLE handoff, not TikTok's authorize URL
// — a Bearer-carried start hands back a short-lived ticket, and the browser that opens
// it is where the OAuth state is minted and pinned (docs/admin-shell.md § Auth). The
// operator approves @fluncle there and TikTok redirects to the admin callback, which
// stores the refresh token server-side.
export async function authTikTokCommand(): Promise<void> {
  const response = await adminApiGet<TikTokAuthStartResponse>("/api/v1/admin/tiktok/auth/start");

  console.log(`Open this link in the browser you're logged into /admin with:

${response.authUrl}

It hands you off to TikTok. Signed out? Log in there and it resumes on its own.
The link is good for 10 minutes; run this again if it expires.
After approving access, TikTok returns to the Fluncle admin callback and stores the refresh token server-side.`);
}
