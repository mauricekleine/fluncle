import { hasBearerHeader, signOauthHandoff, verifyOauthHandoff } from "./env";
import { apiErrorResponse } from "./http-errors";
import { buildInstagramAuthUrl, instagramRedirectUri } from "./instagram";
import { buildMixcloudAuthUrl, mixcloudRedirectUri } from "./mixcloud";
import { mintOauthState } from "./oauth-state";
import { buildSpotifyAuthUrl } from "./spotify";
import { buildTikTokAuthUrl } from "./tiktok";
import { buildTwitchAuthUrl, twitchRedirectUri } from "./twitch";
import { buildYouTubeAuthUrl } from "./youtube";

const OAUTH_HANDOFF_PATH = "/api/v1/admin/oauth/handoff";

const HANDOFF_FLOWS = {
  "instagram-auth": (state: string, origin: string) =>
    buildInstagramAuthUrl(state, instagramRedirectUri(origin)),
  "mixcloud-auth": (state: string, origin: string) =>
    buildMixcloudAuthUrl(state, mixcloudRedirectUri(origin)),
  "spotify-auth": (state: string) => buildSpotifyAuthUrl(state),
  "tiktok-auth": (state: string) => buildTikTokAuthUrl(state),
  "twitch-auth": (state: string, origin: string) =>
    buildTwitchAuthUrl(state, twitchRedirectUri(origin)),
  "youtube-auth": (state: string) => buildYouTubeAuthUrl(state),
} satisfies Record<string, (state: string, origin: string) => Promise<string>>;

export type OauthConnectPurpose = keyof typeof HANDOFF_FLOWS;

function isConnectPurpose(value: unknown): value is OauthConnectPurpose {
  return typeof value === "string" && Object.hasOwn(HANDOFF_FLOWS, value);
}

export async function mintHandoffTicket(purpose: OauthConnectPurpose): Promise<string> {
  return signOauthHandoff({ iat: Date.now(), purpose });
}

export async function readHandoffTicket(
  token: string | null,
): Promise<OauthConnectPurpose | undefined> {
  if (!token) {
    return undefined;
  }

  try {
    const purpose = (await verifyOauthHandoff(token)).purpose;

    return isConnectPurpose(purpose) ? purpose : undefined;
  } catch {
    return undefined;
  }
}

export function handoffUrl(origin: string, ticket: string): string {
  return `${origin}${OAUTH_HANDOFF_PATH}?token=${encodeURIComponent(ticket)}`;
}

export async function providerRedirect(
  purpose: OauthConnectPurpose,
  origin: string,
): Promise<Response> {
  const { setCookie, state } = await mintOauthState(purpose);
  const authUrl = await HANDOFF_FLOWS[purpose](state, origin);

  return new Response(null, {
    headers: { Location: authUrl, "Set-Cookie": setCookie },
    status: 302,
  });
}

export async function startOauthConnect(
  request: Request,
  purpose: OauthConnectPurpose,
): Promise<Response> {
  const origin = new URL(request.url).origin;

  try {
    if (hasBearerHeader(request)) {
      await HANDOFF_FLOWS[purpose]("", origin);

      return Response.json({
        authUrl: handoffUrl(origin, await mintHandoffTicket(purpose)),
        ok: true,
      });
    }

    const { setCookie, state } = await mintOauthState(purpose);

    return Response.json(
      { authUrl: await HANDOFF_FLOWS[purpose](state, origin), ok: true },
      { headers: { "Set-Cookie": setCookie } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
