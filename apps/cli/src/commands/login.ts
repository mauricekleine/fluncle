import { getApiBaseUrl } from "../env";
import { openExternal } from "../open-external";
import { CliError } from "../output";
import { clearUserToken, readUserToken, writeUserToken } from "../user-token";

// `fluncle login` / `fluncle logout` — the cross-surface account login.
//
// This is the OAuth 2.0 Device Authorization Grant (RFC 8628), driven by the
// Worker's framework-native better-auth `deviceAuthorization` plugin. The CLI
// never holds a password and never sees the admin token:
//
//   1. POST /api/auth/device/code → a device_code (secret, for the CLI) + a
//      user_code (short, for the human) + the /device verification URL.
//   2. The CLI prints the code + opens the browser at /device?user_code=…; the
//      user — signed in to their OWN Fluncle account — approves there.
//   3. The CLI polls POST /api/auth/device/token until it gets a session token,
//      which it stores in the USER token store (./user-token.ts), HARD-SEPARATE
//      from the admin FLUNCLE_API_TOKEN.
//
// The minted token is a normal user session token. It can read the signed-in
// user's own `/me` resources (Galaxy progress, saved findings) and nothing more —
// it is never an admin credential.

// The first-party CLI client id. Must match the server's `validateClient`
// (apps/web/src/lib/server/public-auth.ts → cliDeviceClientId).
const CLI_CLIENT_ID = "fluncle-cli";
const DEVICE_SCOPE = "galaxy-sync";

type DeviceCodeResponse = {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
};

type DeviceTokenSuccess = {
  access_token: string;
  expires_in?: number;
  token_type: string;
};

type DeviceTokenPending = {
  error: "access_denied" | "authorization_pending" | "expired_token" | "slow_down";
  error_description?: string;
};

type SessionUser = {
  id: string;
  name?: string;
  username?: string;
};

export async function loginCommand(): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const existing = readUserToken();

  if (existing) {
    const who = existing.user?.username ?? existing.user?.name ?? "your account";
    console.log(`Already signed in as ${who}. Run \`fluncle logout\` first to switch accounts.`);
    return;
  }

  const device = await requestDeviceCode(baseUrl);
  const verificationUrl = device.verification_uri_complete ?? device.verification_uri;

  console.log("Linking this device to your Fluncle account.\n");
  console.log(`  Code:  ${device.user_code}`);
  console.log(`  Open:  ${verificationUrl}\n`);
  console.log("Opening your browser to approve… (sign in if you aren't already)");

  try {
    await openExternal(verificationUrl);
  } catch {
    // A headless box / unsupported platform can't auto-open. The URL is printed
    // above; the user opens it by hand. Keep polling either way.
    console.log("Couldn't open a browser automatically. Visit the URL above to approve.");
  }

  const token = await pollForToken(baseUrl, device);
  const user = await fetchSessionUser(baseUrl, token.access_token);

  writeUserToken({
    baseUrl,
    token: token.access_token,
    user,
  });

  const who = user?.username ?? user?.name ?? "cosmonaut";
  console.log(`\nAboard, ${who}. This device is linked to your Galaxy.`);
  console.log("Try `fluncle me` to see your progress.");
}

export async function logoutCommand(): Promise<void> {
  const stored = readUserToken();

  if (stored) {
    // Best-effort server-side revoke so the session token can't be reused even if
    // the local file were recovered. A network failure still clears it locally.
    await revokeSession(stored.baseUrl, stored.token).catch(() => undefined);
  }

  const cleared = clearUserToken();

  console.log(
    cleared
      ? "Signed out. This device is no longer linked to your account."
      : "Not signed in. Nothing to do.",
  );
}

async function requestDeviceCode(baseUrl: string): Promise<DeviceCodeResponse> {
  const response = await fetch(`${baseUrl}/api/auth/device/code`, {
    body: JSON.stringify({ client_id: CLI_CLIENT_ID, scope: DEVICE_SCOPE }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  const data = (await response.json().catch(() => undefined)) as DeviceCodeResponse | undefined;

  if (!response.ok || !data?.device_code || !data.user_code) {
    throw new CliError(
      "device_code_failed",
      `Couldn't start the login flow (${response.status}). Try again in a moment.`,
    );
  }

  return data;
}

// The polling loop (RFC 8628 §3.5). Poll at the server's interval; back off on
// `slow_down`; bail on `access_denied`/`expired_token`. The overall deadline is
// the device code's own lifetime.
async function pollForToken(
  baseUrl: string,
  device: DeviceCodeResponse,
): Promise<DeviceTokenSuccess> {
  let intervalMs = Math.max(device.interval, 1) * 1000;
  const deadline = Date.now() + Math.max(device.expires_in, 1) * 1000;

  // First wait before the first poll — the user hasn't had a chance to approve yet.
  await sleep(intervalMs);

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/auth/device/token`, {
      body: JSON.stringify({
        client_id: CLI_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const data = (await response.json().catch(() => undefined)) as
      | DeviceTokenPending
      | DeviceTokenSuccess
      | undefined;

    if (response.ok && data && "access_token" in data && data.access_token) {
      return data;
    }

    const pending = data && "error" in data ? data : undefined;

    switch (pending?.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += 5000;
        break;
      case "access_denied":
        throw new CliError("access_denied", "Sign-in was denied in the browser. Nothing linked.");
      case "expired_token":
        throw new CliError(
          "expired_token",
          "The login request timed out. Run `fluncle login` again.",
        );
      default:
        throw new CliError(
          "device_token_failed",
          pending?.error_description ?? `Login failed (${response.status}).`,
        );
    }

    await sleep(intervalMs);
  }

  throw new CliError("expired_token", "The login request timed out. Run `fluncle login` again.");
}

async function fetchSessionUser(baseUrl: string, token: string): Promise<SessionUser | undefined> {
  // The Worker's `/api/v1/me` returns the user-or-null envelope; with the bearer
  // plugin it resolves the just-minted session token. Best-effort: a miss here
  // doesn't fail the login (the token is still good), it just skips the cached name.
  const response = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json().catch(() => undefined)) as
    | { user?: SessionUser | null }
    | undefined;

  return data?.user ?? undefined;
}

async function revokeSession(baseUrl: string, token: string): Promise<void> {
  await fetch(`${baseUrl}/api/auth/sign-out`, {
    headers: { Authorization: `Bearer ${token}` },
    method: "POST",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
