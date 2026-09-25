# /reach Tier-2 activation — Twitch

TikTok and Instagram reach metrics come from Postiz. TikTok exposes followers, likes, and views. Instagram exposes engagement metrics but not follower count. Direct TikTok OAuth is unnecessary; Instagram OAuth remains inactive unless follower access justifies Meta verification.

If Instagram OAuth is activated, its Instagram Login flow exchanges the callback code for a short-lived token and upgrades it to a long-lived token immediately. Instagram provides no refresh token for this flow; the Worker refreshes the stored long-lived token in place before expiry. The code-exchange response may be a flat token object or a `data` array, and the callback URL must match the registered request origin.

**The one remaining activation is Twitch**, below.

## How the Twitch plumbing works

Mirrors the existing Spotify/YouTube/Mixcloud token discipline exactly:

- **Client creds** ride optional env (`TWITCH_CLIENT_ID`/`_SECRET`). Absent → the start route answers a clean "not configured" 400; the collector skips.
- **The durable token lives Worker-side** (`twitch_auth`, one row), minted server-side and refreshed on demand. The CLI/box never holds it.
- **The redirect URI is derived from the request origin**, so there is no `*_REDIRECT_URI` var — but the callback URL MUST be registered in the Twitch app console: `<origin>/api/admin/twitch/auth/callback`.
- **Connect flow:** visit `/api/admin/twitch/auth/start` from a logged-in admin session → it returns `{ authUrl }` → follow it and grant as the broadcaster account → the callback stores the token and bounces to `/admin?twitch=connected`. The follower total requires the broadcaster's user token with `moderator:read:followers`; an app token is insufficient.
- **Finish in the same browser you started in.** Complete the connect flow in the browser that owns the short-lived OAuth nonce cookie. Bearer-started flows return a Fluncle handoff link that establishes state in the logged-in admin browser.
- **Verify:** `fluncle admin reach collect` — twitch leaves the `skipped` list and appears under `collected` with `followers`.

## What is deliberately NOT here

Concrete secret paths, hostnames, and the exact 1Password items live in the private companion repo, not this file — this doc is architecture-level. Setting the envs and registering the callback URL is the operator's act; the code is ready and waits for it.
