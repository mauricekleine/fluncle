import { adminApiGet } from "../api";

type SpotifyAuthStartResponse = {
  ok: true;
  authUrl: string;
};

export async function authSpotifyCommand(): Promise<void> {
  const response = await adminApiGet<SpotifyAuthStartResponse>("/api/admin/spotify/auth/start");

  console.log(`Open this Spotify authorization URL:

${response.authUrl}

After approving access, Spotify will return to the Fluncle admin callback and store auth server-side.`);
}
