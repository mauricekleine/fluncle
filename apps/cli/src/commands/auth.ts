import { type SpotifyAuthStartResponse } from "@fluncle/contracts";
import { adminApiGet } from "../api";

export async function authSpotifyCommand(): Promise<void> {
  const response = await adminApiGet<SpotifyAuthStartResponse>("/api/v1/admin/spotify/auth/start");

  console.log(`Open this Spotify authorization URL:

${response.authUrl}

After approving access, Spotify will return to the Fluncle admin callback and store auth server-side.`);
}
