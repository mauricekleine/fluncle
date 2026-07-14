# /reach Tier-2 activation — Twitch (TikTok + Instagram now ride Postiz)

The public /reach page ships its Tier-1 platforms live. **2026-07-14 update: TikTok and Instagram no longer need their own OAuth apps** — both accounts are already connected to Postiz for publishing, and Postiz's public analytics endpoint (`GET /analytics/{integration}?date=N`) exposes per-label daily series through the `POSTIZ_API_KEY` the Worker already holds. The live probe of the real account settled what each carries:

- **TikTok — fully covered, better than its own Display API**: `Followers`, `Total Likes`, `Views` (plus Following/Videos/Recent-*, deliberately unmapped). The TikTok user-OAuth leg (routes, token store, envs) is **retired**; no TikTok developer app, no scope review.
- **Instagram — engagement only**: `Reach` / `Views` / `Likes` / `Saves` / `Comments`, **no follower count** (the standalone-Instagram connection does not expose audience). The reach page carries Instagram `views` via Postiz today; the follower count stays honestly absent. The Instagram-Login OAuth leg (instagram.ts + its auth routes + `INSTAGRAM_CLIENT_ID`/`_SECRET`) **stays built and DORMANT** as the someday-followers path — activate it only if Meta's business verification + app review is ever worth one number.

**The one remaining activation is Twitch**, below.

## How the Twitch plumbing works

Mirrors the existing Spotify/YouTube/Mixcloud token discipline exactly:

- **Client creds** ride optional env (`TWITCH_CLIENT_ID`/`_SECRET`). Absent → the start route answers a clean "not configured" 400; the collector skips.
- **The durable token lives Worker-side** (`twitch_auth`, one row), minted server-side and refreshed on demand. The CLI/box never holds it.
- **The redirect URI is derived from the request origin**, so there is no `*_REDIRECT_URI` var — but the callback URL MUST be registered in the Twitch app console: `<origin>/api/admin/twitch/auth/callback`.
- **Connect flow:** visit `/api/admin/twitch/auth/start` from a logged-in admin session → it returns `{ authUrl }` → follow it, grant **as the broadcaster account** (the follower total needs the broadcaster's own user token + `moderator:read:followers` — an app token no longer suffices; Twitch change-log 2023-09-06) → the callback stores the token and bounces to `/admin?twitch=connected`.
- **Verify:** `fluncle admin reach collect` — twitch leaves the `skipped` list and appears under `collected` with `followers`.

## What is deliberately NOT here

Concrete secret paths, hostnames, and the exact 1Password items live in the private companion repo, not this file — this doc is architecture-level. Setting the envs and registering the callback URL is the operator's act; the code is ready and waits for it.
