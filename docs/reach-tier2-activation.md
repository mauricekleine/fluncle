# /reach Tier-2 activation — Twitch, TikTok, Instagram

The public /reach page ships its Tier-1 platforms live (Mixcloud, Bluesky, GitHub, npm, Last.fm, App Store, Telegram, newsletter, Spotify playlist, YouTube — every one keyless or on a credential Fluncle already holds). **Tier 2 is three platforms that each need a per-account USER OAuth with refresh for one number apiece** — Twitch's follower total, TikTok's followers + likes, Instagram's follower count. The plumbing is built and merged **DORMANT**: the collectors are wired into `PLATFORM_FETCHERS`, but every one throws a clean reason (and the collector turns that into an honest `{ platform, reason }` skip) until its client creds are set AND the operator connects the account. This doc is the per-platform activation runbook.

## How the plumbing works (all three)

Each platform mirrors the existing Spotify/YouTube/Mixcloud token discipline exactly — no new token store was invented:

- **Client creds** ride optional env (`TWITCH_CLIENT_ID`/`_SECRET`, `TIKTOK_CLIENT_KEY`/`_SECRET`, `INSTAGRAM_CLIENT_ID`/`_SECRET`). Absent → the start route answers a clean "not configured" 400, never a crash; the collector skips.
- **The durable token lives Worker-side**, one row per platform (`twitch_auth` / `tiktok_auth` / `instagram_auth`), minted server-side and refreshed on demand. The CLI/box never holds it.
- **The redirect URI is derived from the request origin** (like Mixcloud), so there is no `*_REDIRECT_URI` var — but the operator MUST register that exact callback URL in each platform's app console: `<origin>/api/admin/<platform>/auth/callback`.
- **Connect flow:** the operator visits `/api/admin/<platform>/auth/start` (admin-gated) from a logged-in admin session; it returns `{ authUrl }`, the operator follows it, grants, and the callback stores the token and bounces to `/admin?<platform>=connected`.
- **Verify:** run the reach collect (`fluncle admin reach collect`, or the daily `fluncle-stats` cron). The platform leaves the `skipped` list and appears under `collected` with its metric(s). That transition is the activation signal.

## Morning-clickability — the honest verdict

The three platforms are NOT equal on how fast the operator can go from zero to a stored token. In order of pain:

| Platform      | App creation                                                                                                                | Same-morning clickable?                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Twitch**    | Twitch developer console — register an app, get client id/secret instantly, add the redirect URL.                           | **YES.** Fully self-serve, no review. Create the app, set the two envs, connect, done in one sitting.                                                                                                                                                                                                        |
| **TikTok**    | TikTok for Developers — create an app, add the Login Kit + Display API products, request `user.info.stats`.                 | **NO — plan for a wait.** The app and Login Kit are self-serve, but the scopes/products that expose follower + likes stats go through TikTok app review (days, sometimes longer). Everything up to "submit for review" is same-morning; the grant is not.                                                    |
| **Instagram** | Meta app dashboard — add "Instagram" product, use "Instagram API with Instagram Login", request `instagram_business_basic`. | **NO — the slowest.** Meta requires business verification and app review for the Instagram permissions on a live app. In development mode you can connect the app's own test/role accounts immediately, but the real public account needs the review + verification pass (the longest latency of the three). |

**Recommendation:** wire Twitch first (it is a clean win that morning), submit the TikTok and Instagram app reviews the same day so their clocks start, and let each platform leave the `skipped` list whenever its grant lands. Nothing is blocked meanwhile — the reach page keeps working and simply shows those three as not-yet-connected.

## Per-platform detail

### Twitch — follower total

- **App:** Twitch developer console. Scope requested: `moderator:read:followers` (an app token no longer suffices for the follower total; it must be the broadcaster's own user token — Twitch change-log 2023-09-06).
- **Envs:** `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`.
- **Connect:** `/api/admin/twitch/auth/start` → grant as the Fluncle broadcaster account.
- **Metric:** `followers`. The collector resolves the authenticated broadcaster id via Helix `users`, then reads Helix `channels/followers?broadcaster_id=…` → `total`.

### TikTok — followers + likes

- **App:** TikTok for Developers app with Login Kit + Display API. Scopes: `user.info.basic`, `user.info.stats` (stats is own-account-only; Postiz exposes no analytics, which is why this needs its own OAuth). `user.info.stats` goes through app review.
- **Envs:** `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (TikTok calls it `client_key`, not `client_id`).
- **Connect:** `/api/admin/tiktok/auth/start` → grant as the Fluncle TikTok account.
- **Metrics:** `followers` (`follower_count`), `likes` (`likes_count`), from Display API `user/info`.

### Instagram — follower count

- **App:** Meta app, "Instagram API with Instagram Login" (the Instagram-Login business flow, NOT the Facebook-Login variant — no Page/Business-Manager linkage; the operator logs in with the Instagram account directly). Scope: `instagram_business_basic`. Requires business verification + app review for a live public account.
- **Envs:** `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` (the Instagram App ID / App Secret from the Meta dashboard).
- **Token model — different from the others:** there is NO refresh token. The callback exchanges the code for a short-lived token, immediately upgrades it to a 60-day LONG-lived token, and stores that; the collector refreshes it in place (`graph.instagram.com/refresh_access_token`) when it nears expiry. So `instagram_auth` carries just the token + its expiry, no refresh/scope columns. On a daily collector cadence the token is refreshed comfortably inside the ≥24h-old / unexpired band the refresh endpoint requires.
- **Connect:** `/api/admin/instagram/auth/start` → grant as the Fluncle Instagram business account.
- **Metric:** `followers` (`followers_count`), from the Graph API `me` read.

## What is deliberately NOT here

Concrete secret paths, hostnames, and the exact 1Password items live in the private companion repo, not this file — this doc is architecture-level. Setting the six envs and registering the three callback URLs is the operator's act; the code is ready and waits for it.
