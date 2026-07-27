import { type SpotifyAuthStartResponse } from "@fluncle/contracts";
import { adminApiGet } from "../api";

// The URL this prints is a FLUNCLE link, not Spotify's: a Bearer-carried start hands
// back a short-lived handoff ticket instead of an authorize URL, and the browser that
// opens it is where the OAuth state is minted and pinned (docs/admin-shell.md § Auth).
export async function authSpotifyCommand(): Promise<void> {
  const response = await adminApiGet<SpotifyAuthStartResponse>("/api/v1/admin/spotify/auth/start");

  console.log(`Open this link in the browser you're logged into /admin with:

${response.authUrl}

It hands you off to Spotify. Signed out? Log in there and it resumes on its own.
The link is good for 10 minutes; run this again if it expires.
After approving access, Spotify returns to the Fluncle admin callback and stores auth server-side.`);
}
