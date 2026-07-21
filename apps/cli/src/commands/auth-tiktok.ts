import { type TikTokAuthStartResponse } from "@fluncle/contracts";
import { adminApiGet } from "../api";

// A thin trigger (like `auth youtube` / `auth mixcloud`): GET the admin start route for
// the signed authorize URL and print it. The operator opens it, approves @fluncle, and
// TikTok redirects to the admin callback, which stores the refresh token server-side.
export async function authTikTokCommand(): Promise<void> {
  const response = await adminApiGet<TikTokAuthStartResponse>("/api/v1/admin/tiktok/auth/start");

  console.log(`Open this TikTok authorization URL:

${response.authUrl}

After approving access, TikTok returns to the Fluncle admin callback and stores the refresh token server-side.`);
}
