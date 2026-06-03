import { buildSpotifyAuthUrl, exchangeCodeForToken, extractCodeFromCallbackUrl } from "../spotify";

export async function authSpotifyCommand(): Promise<void> {
  console.log(`Open this Spotify authorization URL:

${buildSpotifyAuthUrl()}

After approving access, your browser will land on a 127.0.0.1 callback URL that may not load.
Paste the full callback URL here and press Enter:`);

  const callbackUrl = prompt("> ");

  if (!callbackUrl) {
    throw new Error("No callback URL provided");
  }

  const code = extractCodeFromCallbackUrl(callbackUrl.trim());
  await exchangeCodeForToken(code);

  console.log("Spotify auth stored in Turso.");
}
